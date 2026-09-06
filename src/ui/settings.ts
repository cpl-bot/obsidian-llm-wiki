// Settings panel UI for LLM Wiki Plugin

import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import LLMWikiPlugin from '../main';
import { LLMWikiSettings } from '../types';
import { TEXTS } from '../texts';
import {
  resolveDisplayedModelForTask,
  shouldRenderModelDropdown,
  type ModelFieldKey,
} from './settings-per-task-helpers';
import { renderLanguageSection } from './settings-sections/language-section';
import { renderStatusSection } from './settings-sections/status-section';
import { renderProviderSection } from './settings-sections/provider-section';
import { renderModelSection } from './settings-sections/model-section';
import { renderAdvancedSection } from './settings-sections/advanced-section';
import { renderTestConnectionSection } from './settings-sections/test-connection-section';
import { renderWikiConfigSection } from './settings-sections/wiki-config-section';
import { renderAutoMaintainSection } from './settings-sections/auto-maintain-section';
import { renderAdvancedSettingsSection } from './settings-sections/advanced-settings-section';
import { NOTICE_ERROR } from '../constants';
import { ProviderSecretStore } from '../llm-sdk/provider-secret-store';
import { redactSecrets } from '../core/redact';

// v1.25.5: getSettingDefinitions() implemented as a no-op stub for
// Obsidian 1.13+ declarative settings API compatibility. The real
// declarative schema migration is tracked for when minAppVersion >= 1.13.0.
// See Issue #328 (Schema Phase 2/3) for the full declarative-settings plan.
export class LLMWikiSettingTab extends PluginSettingTab {
  plugin: LLMWikiPlugin;
  tempSettings: LLMWikiSettings;
  /**
   * Hardening Phase 3 (F-03): in-memory buffer for the API-key textbox.
   *
   * This used to be `tempSettings.apiKey`, i.e. a field of the settings
   * object — which meant the typed key was one stray `saveData(tempSettings)`
   * away from landing in `data.json` as plaintext. `LLMWikiSettings` has no
   * `apiKey` field any more, so the buffer lives here instead: typed value
   * held in memory, flushed to the OS keychain once on tab close, zeroed
   * immediately after the write succeeds. It is never serialized.
   */
  public pendingApiKey = '';

  constructor(app: App, plugin: LLMWikiPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.tempSettings = {
      ...plugin.settings,
      watchedFolders: [...(plugin.settings.watchedFolders || [])]
    };
  }

  // v1.25.5: getSettingDefinitions() no-op stub for Obsidian 1.13+ settings
  // search compatibility. Full declarative migration tracked for minAppVersion >= 1.13.0.
  getSettingDefinitions(): unknown[] {
    return [];
  }

  // Issue #137: merge tempSettings → plugin.settings, preserving any
  // fields the form does not track but Test Connection mutates.
  // v1.23.0: thinkingControlCache is @deprecated (AI-SDK v6 handles
  // internally) but still preserved here for data.json forward-compat.
  // Called by hide() (auto-save) and the explicit Save button. Adding
  // a new probe-mutated field only requires extending this one helper,
  // not every save site.
  /**
   * Flush the typed apiKey into SecretStorage, then merge
   * `tempSettings` → `plugin.settings`. Returns false if the flush
   * failed (caller must skip saveSettings so the typed key survives
   * for retry — see flushApiKey for failure semantics).
   *
   * Contract: this is a pure write-through. It MUST NOT cascade,
   * auto-correct, or otherwise mutate `tempSettings` beyond the
   * post-flush `apiKey` wipe. Per-task model ownership lives in
   * `setFieldValue` (which fires `cascadeUnifiedModelChange`).
   */
  public commitTempSettings(): boolean {
    // Flush before wipe — see flushApiKey for failure semantics.
    const flushSucceeded = this.flushApiKey();
    if (!flushSucceeded) return false;
    // Defensive: flushApiKey already zeroes pendingApiKey on success.
    // Belt-and-suspenders so a future caller bypassing flushApiKey can't
    // carry a typed key into the object that gets serialized.
    this.pendingApiKey = '';
    // Pure write-through: commit MUST NOT cascade. Per-task model
    // ownership lives in setFieldValue → cascadeUnifiedModelChange.
    this.plugin.settings = {
      ...this.tempSettings,
      watchedFolders: [...(this.tempSettings.watchedFolders || [])],
      thinkingControlCache: this.plugin.settings.thinkingControlCache,
    };
    return true;
  }

  // Auto-save when user navigates away from settings tab
  hide(): void {
    // Hardening Phase 3 (F-03): the typed key is no longer a field of
    // tempSettings, so a session whose ONLY change is a freshly-typed key
    // would compare equal and never reach flushApiKey. Check the buffer
    // explicitly.
    const hasChanges = this.pendingApiKey.trim().length > 0
      || JSON.stringify(this.tempSettings) !== JSON.stringify(this.plugin.settings);
    if (hasChanges) {
      // commitTempSettings owns the flush; skip saveSettings on failure
      // so the typed apiKey survives for retry (v1.25.4 #339 invariant).
      const commitSucceeded = this.commitTempSettings();
      if (!commitSucceeded) return;
      void this.plugin.saveSettings();
      console.debug('Settings auto-saved on tab close');
    }
  }

  /**
   * v1.25.3 #182: flush the pending apiKey textbox value into Obsidian
   * SecretStorage and zero the in-memory buffer. ONLY writes
   * when the user actually typed a new value — never overwrites an
   * existing SecretStorage entry with an empty string on a no-op close
   * (would silently destroy the user's key).
   *
   * v1.25.4 #339: wraps save() in try/catch. On Windows 10 Credential
   * Manager failure, the previous version threw silently and the tab
   * hide aborted before commitTempSettings — but `hide()` would then
   * have aborted the user-visible save flow (no Notice, no progress),
   * which was worse UX. Now we surface a recoverable Notice AND return
   * `false` so `hide()` skips commitTempSettings entirely; otherwise the
   * unconditional buffer wipe in commitTempSettings would drop the
   * freshly-typed key on the floor — the original #339 failure mode.
   *
   * Returns true when the SecretStorage write succeeded (or there was
   * nothing to write). Returns false when SecretStorage IO failed and
   * the caller must NOT commit.
   */
  public flushApiKey(): boolean {
    const pending = this.pendingApiKey;
    if (pending.trim().length === 0) return true;  // nothing to flush
    const store = new ProviderSecretStore(this.app.secretStorage, this.tempSettings.providerApiKeySecretId);
    try {
      store.save(pending);
      this.pendingApiKey = '';
      return true;
    } catch (error: unknown) {
      // Keep pendingApiKey populated so the user can retry on next save.
      // Surface a recoverable Notice (error.message only — no PII).
      // Hardening Phase 3 (F-03/3.5): the platform error is raised while
      // handling the key itself, so it is exactly the message that must
      // not quote it back on screen.
      const detail = error instanceof Error ? error.message : 'Unknown error';
      new Notice(this.getText('apiKeyMigrationFailedNotice').replace('{}', redactSecrets(detail)), NOTICE_ERROR);
      return false;
    }
  }

  getText(key: keyof typeof TEXTS.en): string {
    // v1.25.1 Phase C-PR2: signature restored to `keyof typeof TEXTS.en`.
    // The earlier widening to `string` removed compile-time protection
    // from ~173 literal call sites for the sake of 1 dynamic site
    // (model-section: `fetchError${category}`). Dynamic keys now route
    // through `getTextDynamic` instead.
    const texts = TEXTS[this.tempSettings.language];
    return (texts[key] as string) ?? TEXTS.en[key] ?? key;
  }

  /**
   * v1.25.1 Phase C-PR2: dynamic-key variant of getText. Use only when
   * the key is constructed at runtime (e.g. `fetchError${category}`).
   * Literal keys must go through `getText` so tsc can catch typos.
   */
  getTextDynamic(key: string): string {
    const texts = TEXTS[this.tempSettings.language];
    return (texts[key as keyof typeof texts] as string) ?? TEXTS.en[key as keyof typeof TEXTS.en] ?? key;
  }

  /**
   * v1.24.0 #208: shared model-picker renderer for all 4 model fields
   * (unified `model` + per-task `ingestModel` / `lintModel` / `queryModel`).
   *
   * Renders either a dropdown (when a fetched list is available AND the
   * field's `*UseCustom` flag is false) or a free-form text input (in
   * all other cases). The dropdown carries a sentinel option that, when
   * picked, either switches to text input mode (unified: `__custom__` →
   * `useCustomModel=true`) or clears the per-task value to fall back to
   * `settings.model` (per-task: `__unified__` → `field = ''`).
   *
   * Why a shared helper: the existing unified picker and the new
   * per-task pickers share identical dropdown↔input switching logic.
   * Implementing it inline 4 times would diverge over time (every
   * pre-existing bug in the unified picker would reappear in the new
   * pickers). One helper, four call sites — see settings-per-task-helpers.ts
   * for the pure rendering policy (`shouldRenderModelDropdown`).
   */
  // v1.25.1 Phase C-PR2: made public so section renderers (model-section,
  // wiki-config-section, advanced-section) can invoke it. The helper is
  // logically a section-level concern but is also used as a dispatch
  // hook from the class. Public exposure keeps the section modules from
  // needing to subclass or duplicate the renderer.
  renderModelField(
    containerEl: HTMLElement,
    field: ModelFieldKey,
    options: {
      name: string;
      desc: string;
      dropdownSentinel: string;
      dropdownSentinelLabel: string;
      allowCustom?: boolean;
    },
  ): void {
    const setting = new Setting(containerEl)
      .setName(options.name)
      .setDesc(options.desc);
    const useDropdown = shouldRenderModelDropdown(this.tempSettings, field);
    if (useDropdown) {
      setting.addDropdown(dropdown => {
        (this.tempSettings.availableModels || []).forEach(model => {
          dropdown.addOption(model, model);
        });
        if (options.allowCustom !== false) dropdown.addOption(options.dropdownSentinel, options.dropdownSentinelLabel);
        const currentVal = this.getCurrentModelValue(field);
        // If the current value is empty OR not in the fetched list, default
        // the dropdown to the sentinel option. This covers two cases:
        //   1. User hasn't picked a per-task value yet (field === '') →
        //      shows sentinel so user can choose "Custom input..." or
        //      pick from the list.
        //   2. User previously typed a custom model ID that isn't in the
        //      fetched list → showing the sentinel matches the actual
        //      state (the value is preserved in the field, just not in
        //      the dropdown's visible options).
        const displayVal = currentVal.trim() && (this.tempSettings.availableModels || []).includes(currentVal.trim())
          ? currentVal.trim()
          : options.allowCustom === false ? this.tempSettings.availableModels?.[0] ?? '' : options.dropdownSentinel;
        dropdown.setValue(displayVal);
        dropdown.onChange((value) => {
          if (options.allowCustom !== false && value === options.dropdownSentinel) {
            // Unified picker: switch to text input (preserves field value).
            // Per-task picker: also switch to text input — same UX. The
            // "use unified model" semantic is expressed by *leaving the
            // text input blank*, not by a separate sentinel option.
            // (v1.24.0 #208 UX fix: previously per-task pickers cleared
            // the field on sentinel pick, which made "use unified model"
            // accidental — user couldn't tell the two states apart.)
            if (field === 'model') {
              this.tempSettings.useCustomModel = true;
            } else {
              this.setUseCustomFlag(field, true);
            }
            this.display();
          } else {
            // Pick a real model from the fetched list.
            if (field === 'model') {
              this.tempSettings.useCustomModel = false;
            } else {
              this.setUseCustomFlag(field, false);
            }
            this.setFieldValue(field, value);
          }
        });
      });
    } else {
      // Free-form text input. Show "use dropdown" button only when a
      // fetched list exists — otherwise there is no dropdown to switch to.
      const hasFetched = (this.tempSettings.availableModels?.length ?? 0) > 0;
      setting.addText(text => text
        .setPlaceholder(this.getText('modelInputPlaceholder'))
        .setValue(this.getCurrentModelValue(field))
        .onChange((value) => { this.setFieldValue(field, value); }));
      if (hasFetched && options.allowCustom !== false) {
        setting.addExtraButton(button => button
          .setIcon('list')
          .setTooltip(this.getText('useDropdownButton'))
          .onClick(() => {
            if (field === 'model') {
              this.tempSettings.useCustomModel = false;
            } else {
              this.setUseCustomFlag(field, false);
            }
            this.display();
          }));
      }
    }
  }

  /** Read the current model string for any of the 4 model fields. */
  public getCurrentModelValue(field: ModelFieldKey): string {
    if (field === 'model') return this.tempSettings.model;
    const task = field === 'ingestModel' ? 'ingest' : field === 'lintModel' ? 'lint' : 'query';
    return resolveDisplayedModelForTask(this.tempSettings, task);
  }

  /**
   * Write a model string into any of the 4 model fields.
   *
   * v1.24.1 PATCH Phase 5.5.0 hotfix: when the user changes the
   * unified `model` field, cascade-clear the per-task override fields
   * (`ingestModel` / `lintModel` / `queryModel`) so all tasks
   * immediately use the new unified model. Prior behavior left the
   * per-task values untouched, so a unified-model edit could change
   * the displayed picker while leaving live task routing still pinned
   * to the old per-task model. UX bug reported 2026-07-13.
   *
   * Cascade only fires when:
   *  - `field === 'model'`, AND
   *  - the new value is non-empty (don't cascade-clear on blank-edit).
   *
   * Edge case: if a user explicitly opts into per-task mode later, they
   * can re-populate the per-task fields via the per-task pickers. The
   * cascade ensures UNIFIED → UNIFIED is atomic. PER_TASK editing is
   * not affected (those calls go through this same setter but bypass
   * the cascade block via the `field === 'model'` guard).
   */
  public setFieldValue(field: ModelFieldKey, value: string): void {
    if (field === 'model') {
      this.tempSettings.model = value;
      if (value.trim()) {
        this.cascadeUnifiedModelChange();
      }
    } else {
      (this.tempSettings as unknown as Record<string, string | undefined>)[field] = value;
    }
    // v1.24.1 PATCH Phase 5.5.0 hotfix: ANY model-field edit marks the
    // LLM config stale so the user must re-run Test Connection before
    // the next LLM call. Without this, the user could change model
    // in the UI but the existing llmClient would still use the old
    // model (no rebuild until saveSettings → initializeLLMClient).
    this.markLLMConfigStale();
  }

  /**
   * v1.24.1 PATCH Phase 5.5.0 hotfix: reset all per-task model override
   * fields so unified-model edits propagate to every task. Fires one
   * Notice to inform the user about the reset. Idempotent — calling
   * repeatedly with the overrides already empty is a no-op for both
   * the field writes and the Notice guard.
   */
  public cascadeUnifiedModelChange(): void {
    const fields: Array<'ingestModel' | 'lintModel' | 'queryModel'> = [
      'ingestModel',
      'lintModel',
      'queryModel',
    ];
    for (const f of fields) {
      const current = (this.tempSettings as unknown as Record<string, string | undefined>)[f];
      if (current !== undefined && current !== '') {
        (this.tempSettings as unknown as Record<string, string | undefined>)[f] = '';
        // Per-task *UseCustom flag also cleared so the per-task dropdown
        // re-anchors on the unified model instead of stale free-form text.
        this.setUseCustomFlag(f, false);
      }
    }
    // v1.24.1 PATCH Phase 5.5.0 hotfix: silent cascade. The fact that
    // per-task values were cleared is already visible in the Settings UI
    // (the per-task fields become empty), so a toast would add noise.
  }

  /**
   * v1.24.1 PATCH Phase 5.5.0 hotfix: prefill the 3 per-task model
   * fields with the current unified model. Triggered when the user
   * switches UI mode from unified → per-task so the per-task pickers
   * open with consistent starting state. The user can then edit
   * individual tasks without first having to type or pick each one.
   *
   * Behavior:
   *  - All 3 per-task fields are set to the unified model string
   *    (NOT cleared) so fallback indirection is unnecessary.
   *  - All 3 `*UseCustom` flags are reset to false so the dropdown
   *    re-anchors on the unified value (instead of stale free-form
   *    text from a previous session).
   *  - Idempotent — re-running is a no-op when the per-task fields
   *    already match the unified value.
   */
  public prefillPerTaskFromUnified(): void {
    const unified = this.tempSettings.model.trim();
    const fields: Array<'ingestModel' | 'lintModel' | 'queryModel'> = [
      'ingestModel',
      'lintModel',
      'queryModel',
    ];
    for (const f of fields) {
      (this.tempSettings as unknown as Record<string, string | undefined>)[f] = unified;
      this.setUseCustomFlag(f, false);
    }
  }

  /**
   * v1.24.1 PATCH Phase 5.5.0 hotfix: mark the LLM config as
   * unverified whenever the user changes the provider, the unified
   * model, or any per-task model. This forces the user to re-run
   * Test Connection so the underlying `llmClient` is rebuilt with
   * the new settings — preventing stale-client bugs where a model
   * edit silently went out with the previous model.
   *
   * Also clears `availableModels` since the fetched list is per-
   * provider; the next Test Connection will re-fetch.
   */
  public markLLMConfigStale(): void {
    this.tempSettings.llmReady = false;
  }

  /** Toggle the <field>UseCustom flag for per-task fields; no-op for unified. */
  public setUseCustomFlag(field: ModelFieldKey, value: boolean): void {
    if (field === 'model') return; // useCustomModel is owned by the unified picker
    const flagKey = `${field}UseCustom`;
    (this.tempSettings as unknown as Record<string, boolean | undefined>)[flagKey] = value;
  }

  /**
   * Check if wiki folder structure exists (entities, concepts, sources, schema).
   * Uses IO inspection — no persistent flag.
   */
  public isWikiInitialized(): boolean {
    const wikiFolder = this.tempSettings.wikiFolder || 'wiki';
    return !!(
      this.app.vault.getAbstractFileByPath(`${wikiFolder}/entities`) &&
      this.app.vault.getAbstractFileByPath(`${wikiFolder}/concepts`) &&
      this.app.vault.getAbstractFileByPath(`${wikiFolder}/sources`) &&
      this.app.vault.getAbstractFileByPath(`${wikiFolder}/schema`)
    );
  }

  display() {
    // v1.25.1 Phase C-PR2: split the monolithic display() into 8 focused
    // section renderers under src/ui/settings-sections/. Each section
    // owns a self-contained slice of the Settings tab UI. The orchestrator
    // here only:
    //   - clears containerEl
    //   - invokes each section in user-visible order
    //   - delegates to the shared helpers on this class (renderModelField,
    //     cascadeUnifiedModelChange, etc.) which the section modules need.
    //
    // Why orchestrator ordering matters:
    //   - Status section (Section 2.5) must come BEFORE LLM Provider
    //     (Section 3) so the user sees the ready indicator when reading
    //     about provider config.
    //   - Test Connection sits inside Section 3 right after the Advanced
    //     block, NOT at the end of the tab - matching pre-PR2 layout
    //     users have muscle memory for.
    const { containerEl } = this;
    containerEl.empty();

    renderLanguageSection(this, containerEl);
    renderStatusSection(this, containerEl);
    renderProviderSection(this, containerEl);
    renderModelSection(this, containerEl);
    renderAdvancedSection(this, containerEl);
    renderTestConnectionSection(this, containerEl);
    // The "Wiki Configuration" H2 heading is rendered INSIDE
    // renderWikiConfigSection (matches pre-PR2 layout - the heading
    // lived in the same Settings row block as the wiki folder input).
    // Avoid double-rendering the heading here.
    renderWikiConfigSection(this, containerEl);
    renderAutoMaintainSection(this, containerEl);
    // v1.26.0 (#382 item 2): bottom-most section — generic advanced-user
    // settings (lint thresholds, Welcome note) with a section-level toggle.
    renderAdvancedSettingsSection(this, containerEl);
  }
}
