/**
 * v1.25.1 Phase C-PR2: Provider section renderer.
 *
 * Extracted from `LLMWikiSettingTab.display()`. Renders the LLM
 * Provider configuration block:
 *
 *   - Provider dropdown
 *   - API key input (hidden for ollama/lmstudio; lmstudio shows hint)
 *   - Base URL input (always shown for custom/anthropic-compatible;
 *     otherwise only when override differs from default)
 *   - Page Generation Concurrency slider
 *   - Batch Delay slider
 *
 * Why extracted:
 *   - 130 LOC of provider-config side effects. Splitting into its own
 *     module makes the provider-specific rendering path inspectable
 *     without scrolling through unrelated Model / Advanced / Wiki code.
 *
 * Invariants preserved:
 *   - Switching provider resets llmReady + availableModels + model +
 *     useCustomModel (clears stale-client state).
 *   - Switching to a native-PDF provider (anthropic / openai)
 *     auto-resets forcePdfSupport to false (v1.25.0 PR3 universal
 *     escape hatch UX invariant).
 *   - baseUrl is set to PREDEFINED_PROVIDERS.baseUrl when switching to
 *     a known provider; user can override afterwards.
 *   - API key input is hidden for ollama / lmstudio (no key needed).
 *   - Concurrency description swaps between singular/plural based on
 *     the live value (UX nicety preserved).
 */

import { Notice, Setting } from 'obsidian';
import type { LLMWikiSettingTab } from '../settings';
import { PREDEFINED_PROVIDERS } from '../../types';
import { NATIVE_PDF_PROVIDER_IDS, MAX_BATCH_DELAY_MS, NOTICE_ERROR } from '../../constants';
import { renderRangeSlider, egressReasonTextKey } from '../settings-helpers';
import { assertAllowedEgress, EgressDeniedError } from '../../core/egress-policy';
import { resolveInitialApiKey } from '../../llm-sdk/provider-api-key-resolver';
import { isProviderSecretStorageError } from '../../llm-sdk/provider-secret-store';
import { redactSecrets } from '../../core/redact';

export function renderProviderSection(tab: LLMWikiSettingTab, containerEl: HTMLElement): void {
  const { tempSettings } = tab;
  const providerConfig = PREDEFINED_PROVIDERS[tempSettings.provider];
  const isOllama = tempSettings.provider === 'ollama';
  const isLmStudio = tempSettings.provider === 'lmstudio';

  // LLM Provider (highest priority - must configure first).
  // v1.25.1 Phase C-PR2 fix: this heading was previously emitted from
  // LLMWikiSettingTab.display() and lost when the section was extracted.
  // Restoring it preserves the pre-PR2 Settings tab layout users have
  // muscle memory for.
  new Setting(containerEl).setName(tab.getText('providerSection')).setHeading();

  // Provider dropdown
  new Setting(containerEl)
    .setName(tab.getText('providerName'))
    .setDesc(tab.getText('providerDesc'))
    .addDropdown(dropdown => {
      Object.values(PREDEFINED_PROVIDERS).forEach(config => {
        const lang = tempSettings.language;
        const displayName = lang === 'zh' ? config.nameZh : config.nameEn;
        dropdown.addOption(config.id, displayName);
      });
      dropdown.setValue(tempSettings.provider);
      dropdown.onChange((value) => {
        tempSettings.provider = value;
        tempSettings.llmReady = false;
        tempSettings.availableModels = [];
        tempSettings.useCustomModel = false;
        tempSettings.model = '';
        const config = PREDEFINED_PROVIDERS[value];
        if (config && value !== 'custom') tempSettings.baseUrl = config.baseUrl;
        // v1.25.0 PR3: if the user just switched to a native-PDF provider
        // (anthropic / openai), reset forcePdfSupport so they
        // don't carry a stale escape-hatch value that no longer applies.
        if ((NATIVE_PDF_PROVIDER_IDS as readonly string[]).includes(value)) {
          tempSettings.forcePdfSupport = false;
        }
        tab.display();
      });
    });

  // API Key (or hint for ollama/lmstudio)
  if (!isOllama && !isLmStudio) {
    // v1.25.3 #182: read the key through the tested ProviderSecretStore
    // helper. The text component
    // is an in-memory buffer; the actual SecretStorage write happens
    // once on settings-tab close (in LLMWikiSettingTab.hide → flushApiKey),
    // so a user typing 30 characters does NOT trigger 30 OS keychain
    // writes — only the final value is persisted. This preserves the
    // pre-PR2 in-memory-edit-then-flush-on-save UX.
    //
    // v1.25.7 PATCH: respect the in-memory buffer (tab.pendingApiKey)
    // as the FIRST source of truth. Without this precedence swap, the
    // pending edit typed after a provider switch gets silently overwritten
    // by the OLD SecretStorage value on every tab.display() re-render
    // (e.g. when switching providers via the dropdown above, or after
    // Fetch Models / Test Connection triggers display()). The previous
    // behavior used `?? tempSettings.apiKey` as a fallback, but `??`
    // only triggers when load() returns null — SecretStorage always has
    // the last-flushed key, so the fallback never ran and the user's
    // pending edit was clobbered.
    new Setting(containerEl)
      .setName(tab.getText('apiKeyName'))
      .setDesc(tab.getText('apiKeyDesc'))
      .addText(text => {
        // v1.25.7 PATCH: delegate to resolveInitialApiKey so the input
        // honors the in-memory tab.pendingApiKey buffer across re-renders
        // instead of clobbering the user's pending edit with the stale
        // SecretStorage value left over from the previously-active provider.
        //
        // Hardening Phase 3 (F-03): an unreadable keychain throws instead of
        // painting a blank box. A blank box here reads as "your key is
        // gone" and invites the user to paste it again into a keychain that
        // cannot store it, so say what actually happened and leave the
        // field empty.
        let initial: string;
        try {
          initial = resolveInitialApiKey(tab.pendingApiKey, tempSettings, tab.plugin.app.secretStorage);
        } catch (error: unknown) {
          if (!isProviderSecretStorageError(error)) throw error;
          initial = '';
          new Notice(tab.getText('keychainUnavailableNotice').replace('{}', redactSecrets(error.message)), NOTICE_ERROR);
        }
        text.setPlaceholder(tab.getText('apiKeyPlaceholder'))
          .setValue(initial)
          .onChange((value) => {
            // In-memory only — the actual setSecret happens on tab close.
            // tab.pendingApiKey carries the pending value until the
            // tab's hide() runs flushApiKey() against ProviderSecretStore.
            tab.pendingApiKey = value;
            tempSettings.llmReady = false;
          });
        text.inputEl.type = 'password';
      });
  } else if (isLmStudio) {
    containerEl.createEl('p', {
      text: tab.getText('lmstudioHint'),
      cls: 'llm-wiki-ollama-hint'
    });
  } else {
    containerEl.createEl('p', {
      text: tab.getText('ollamaHint'),
      cls: 'llm-wiki-ollama-hint'
    });
  }

  // Base URL
  if (tempSettings.provider === 'custom' || tempSettings.provider === 'anthropic-compatible' || (providerConfig && tempSettings.baseUrl !== providerConfig.baseUrl)) {
    // Phase 4.3 (F-04): the Base URL is where finding F-04 actually bites —
    // a `http://` endpoint here sends `Authorization: Bearer <key>` in the
    // clear. Validate against the same policy the transport enforces and
    // refuse to store a value that violates it, keeping the previous one.
    //
    // The candidate is validated WITH ITSELF installed as `baseUrl`: clause
    // (b) of the policy trusts the host the user configured, so what this
    // check really enforces is scheme (https, or http for loopback), no
    // embedded credentials, and no private / link-local target. That keeps
    // legitimate self-hosted endpoints configurable while closing the
    // cleartext and SSRF-shaped holes.
    let baseUrlWarningEl: HTMLElement | null = null;
    const clearBaseUrlWarning = (): void => {
      baseUrlWarningEl?.remove();
      baseUrlWarningEl = null;
    };
    const showBaseUrlWarning = (denial: EgressDeniedError): void => {
      const message = tab.getText('egressBaseUrlRejected')
        .replace('{reason}', tab.getText(egressReasonTextKey(denial.reason)));
      if (baseUrlWarningEl) baseUrlWarningEl.setText(message);
      else baseUrlWarningEl = containerEl.createEl('p', { text: message, cls: 'llm-wiki-egress-warning' });
    };
    new Setting(containerEl)
      .setName(tab.getText('baseUrlName'))
      .setDesc(tempSettings.provider === 'custom' || tempSettings.provider === 'anthropic-compatible'
        ? tab.getText('baseUrlDescCustom') : tab.getText('baseUrlDescOverride'))
      .addText(text => text
        .setPlaceholder(providerConfig?.baseUrl || 'https://api.example.com/v1')
        .setValue(tempSettings.baseUrl)
        .onChange((value) => {
          const trimmed = value.trim();
          // Empty clears the override — always allowed, nothing is sent.
          if (trimmed !== '') {
            try {
              assertAllowedEgress(trimmed, { ...tempSettings, baseUrl: trimmed });
            } catch (error) {
              if (error instanceof EgressDeniedError) {
                showBaseUrlWarning(error);
                return; // previous value survives; nothing is persisted
              }
              throw error;
            }
          }
          clearBaseUrlWarning();
          tempSettings.baseUrl = value;
          tempSettings.llmReady = false;
        }));
  }

  // Phase 4.4 (F-04): strict egress toggle. Default on; off is the documented
  // escape hatch for a corporate proxy / gateway, and is flagged in red
  // because it removes the allowlist (never the https requirement).
  new Setting(containerEl)
    .setName(tab.getText('strictEgressName'))
    .setDesc(tab.getText('strictEgressDesc'))
    .addToggle(toggle => toggle
      .setValue(tempSettings.strictEgress !== false)
      .onChange((value) => {
        tempSettings.strictEgress = value;
        tab.display();
      }));
  if (tempSettings.strictEgress === false) {
    containerEl.createEl('p', {
      text: tab.getText('strictEgressWarning'),
      cls: 'llm-wiki-strict-egress-warning',
    });
  }

  // Page Generation Concurrency + Batch Delay — both rendered via the
  // shared renderRangeSlider helper (v1.25.1 Phase C-PR2 simplify pass).
  renderRangeSlider(containerEl, {
    name: tab.getText('pageGenerationConcurrencyName'),
    desc: tab.getText('pageGenerationConcurrencyDesc'),
    initialValue: tempSettings.pageGenerationConcurrency ?? 3,
    min: 1,
    max: 5,
    step: 1,
    formatDesc: (v) => tab.getText(v === 1 ? 'concurrencyValueSingular' : 'concurrencyValuePlural').replace('{}', String(v)),
    onChange: (v) => { tempSettings.pageGenerationConcurrency = v; },
  });

  renderRangeSlider(containerEl, {
    name: tab.getText('batchDelayName'),
    desc: tab.getText('batchDelayDesc'),
    initialValue: tempSettings.batchDelayMs ?? 300,
    min: 100,
    max: MAX_BATCH_DELAY_MS,
    step: 50,
    formatDesc: (v) => tab.getText('batchDelayDesc').replace('{}', String(v)),
    onChange: (v) => { tempSettings.batchDelayMs = v; },
  });
}
