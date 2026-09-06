/**
 * v1.25.1 Phase C-PR3: Connection test commands.
 *
 * Extracted from main.ts. Probes the live LLM endpoint and checks
 * wiki structure readiness.
 *
 * `testLLMConnection` is directly called by tests
 * (test-connection-gate.test.ts) and settings test-connection-section
 * via `plugin.testLLMConnection()` — the mixin pattern preserves
 * this call surface with zero sites changed.
 */

import { Notice } from 'obsidian';
import type { App } from 'obsidian';
import type {
  LLMWikiSettings,
  LLMClient,
} from '../types';
import {
  PREDEFINED_PROVIDERS,
} from '../types';
import type { LLMTask } from '../core/model-resolver';
import { TEXTS } from '../texts';
import { getText } from '../core/i18n';
import { createLLMClient } from '../core/create-plugin-llm-client';
import { providerRequiresApiKey, usesBedrockAwsCredentials } from '../core/provider-auth';
import { resolveProviderApiKey } from '../llm-sdk/provider-api-key-resolver';
import { isProviderSecretStorageError } from '../llm-sdk/provider-secret-store';
import { redactError, redactSecrets } from '../core/redact';
import { resolveModelForTask } from '../core/model-resolver';
import { TOKENS_QUERY_MODEL_DETECT, NOTICE_ERROR } from '../constants';

/**
 * Host interface: fields/methods these commands need from the Plugin
 * instance. Declares the class-side methods they call so mixin
 * `this: ConnectionCommandsHost` compiles correctly.
 */
export interface ConnectionCommandsHost {
  app: App;
  settings: LLMWikiSettings;
  llmClient: LLMClient | null;
  wikiEngine: import('../wiki/wiki-engine').WikiEngine;
  /** #425 Bedrock Stage 2 — plugin-owned credential orchestrator. */
  bedrockAuthManager: import('../llm-sdk/bedrock-sso/credential-manager').BedrockAuthManager | null;
  manifest: { version: string };
  initializeLLMClient(): void;
  saveSettings(): Promise<void>;
  isWikiInitialized(): Promise<boolean>;
}

/** Method signatures merged into LLMWikiPlugin via interface augmentation. */
export interface ConnectionCommandsMethods {
  testLLMConnection(pendingApiKey?: string): Promise<{ success: boolean; message: string }>;
  requireLLMReady(): boolean;
  isWikiInitialized(): Promise<boolean>;
}

export const connectionCommands = {
  async testLLMConnection(
    this: ConnectionCommandsHost,
    pendingApiKey?: string,
  ): Promise<{ success: boolean; message: string }> {
    const t = TEXTS[this.settings.language] || TEXTS.en;

    // #425 Bedrock Stage 2: in sso/iam modes AWS credentials replace the
    // bearer key (single predicate in core/provider-auth), so the
    // credential-presence gate runs BEFORE the API-key gate and never
    // surfaces a misleading missing-key error.
    const awsCredMode = usesBedrockAwsCredentials(this.settings.provider, this.settings.bedrockAuthMethod);
    if (awsCredMode) {
      const method = this.settings.bedrockAuthMethod!;
      if (method === 'sso' && this.bedrockAuthManager?.hasSsoToken() !== true) {
        return { success: false, message: t.bedrockSsoRequired };
      }
      if (method === 'iam' && this.bedrockAuthManager?.hasIamKeys() !== true) {
        return { success: false, message: t.bedrockIamRequired };
      }
    }
    // v1.25.7 PATCH: accept an optional pendingApiKey so the Test
    // Connection button can forward the in-memory typed key from
    // tab.pendingApiKey, bypassing the stale SecretStorage value.
    // Production callers (initializeLLMClient etc.) pass undefined.
    //
    // Hardening Phase 3 (F-03): this is the UI boundary where a
    // missing key is already reported, so it is also where an unreadable
    // keychain gets its own message. Failing closed here keeps the probe
    // from reporting a provider-side auth error for a local problem.
    if (!awsCredMode && providerRequiresApiKey(this.settings.provider)) {
      let resolvedKey: string;
      try {
        resolvedKey = resolveProviderApiKey(
          { providerApiKeySecretId: this.settings.providerApiKeySecretId },
          this.app.secretStorage,
          pendingApiKey,
        );
      } catch (error: unknown) {
        if (!isProviderSecretStorageError(error)) throw error;
        return { success: false, message: t.keychainUnavailableNotice.replace('{}', redactSecrets(error.message)) };
      }
      if (!resolvedKey) {
        return { success: false, message: t.errorNoApiKey || 'API Key is not configured' };
      }
    }

    const tasksToProbe: LLMTask[] = this.settings.usePerTaskModels === true
      ? ['ingest', 'lint', 'query']
      : [];
    const probePlan: Array<{ label: string; model: string }> = tasksToProbe.length === 0
      ? [{ label: 'unified', model: this.settings.model }]
      : tasksToProbe.map(task => ({ label: task, model: resolveModelForTask(this.settings, task) }));

    console.debug('[testLLMConnection] probe plan:', probePlan.map(p => `${p.label}=${p.model}`).join(', '));

    // A blank model still goes on the wire as `"model": ""`, and the
    // provider answers with its own routing error: OpenRouter returns
    // HTTP 502 `Invalid URL:`, which the AI SDK retries three times and
    // the catch below then reports verbatim — so a model that was never
    // selected reads as a broken Base URL. `model` has no default
    // (DEFAULT_SETTINGS.model is ''), so this is the state of every
    // fresh install: pick the provider, paste the key, press the button.
    if (probePlan.some(probe => (probe.model ?? '').trim() === '')) {
      return { success: false, message: t.errorNoModel };
    }

    try {
      const testClient = createLLMClient(this.settings, this.app.secretStorage, pendingApiKey, this.bedrockAuthManager ?? undefined);

      // Hardening Phase 2.B: a 404-driven "try the next model in the
      // catalogue" retry used to wrap this probe. It existed solely for the
      // removed OAuth provider, whose per-account model catalogue could list
      // models the account was not entitled to. Every remaining provider
      // reports an unusable model as an error the user has to act on, so the
      // probe now surfaces it directly.
      for (const probe of probePlan) {
        await testClient.createMessage({
          model: probe.model,
          max_tokens: TOKENS_QUERY_MODEL_DETECT,
          messages: [{
            role: 'user',
            content: 'Test connection. Please reply "Connection successful".'
          }]
        });
      }

      this.settings.llmReady = true;
      void this.saveSettings();

      // Auto-initialize wiki structure after first successful connection.
      // Preserved from original main.ts — defensive: ensures the expected
      // folder tree exists before the user attempts their first ingest.
      if (this.wikiEngine) {
        const isInit = await this.isWikiInitialized();
        if (!isInit) {
          try {
            await this.wikiEngine.ensureWikiStructure();
            console.debug('Wiki structure auto-initialized');
          } catch (initError) {
            console.warn('Auto wiki init failed:', redactError(initError));
          }
        }
      }

      const providerName = (PREDEFINED_PROVIDERS[this.settings.provider]?.nameEn || this.settings.provider);

      this.initializeLLMClient();

      const probeSummary = probePlan.length === 1
        ? `${providerName} (${probePlan[0].model})`
        : `${providerName} (ingest=${probePlan[0].model}, lint=${probePlan[1].model}, query=${probePlan[2].model})`;

      return {
        success: true,
        message: `✅ ${t.testConnectionSuccessful || 'Connection successful'}: ${probeSummary}`
      };
    } catch (error) {
      // Hardening Phase 3 (F-03/3.5): Test Connection is the single most
      // likely place for a provider to answer with a body quoting the
      // request — it is the one call made specifically to see what the
      // provider says. Both the log and the returned Notice text are
      // redacted.
      console.error('Connection test failed:', redactError(error));
      this.settings.llmReady = false;
      await this.saveSettings();
      const errorMsg = redactError(error);
      return {
        success: false,
        message: `❌ ${t.testConnectionFailed || 'Connection failed'}: ${errorMsg || t.errorUnknown || 'Unknown error'}`
      };
    }
  },

  requireLLMReady(this: ConnectionCommandsHost): boolean {
    if (this.settings.llmReady) return true;
    new Notice(getText(this.settings.language, 'llmNotReady'), NOTICE_ERROR);
    return false;
  },

  async isWikiInitialized(this: ConnectionCommandsHost): Promise<boolean> {
    const wikiFolder = this.settings.wikiFolder || 'wiki';
    const requiredFolders = [
      `${wikiFolder}/entities`,
      `${wikiFolder}/concepts`,
      `${wikiFolder}/sources`,
      `${wikiFolder}/schema`
    ];
    for (const folder of requiredFolders) {
      const folderObj = this.app.vault.getAbstractFileByPath(folder);
      if (!folderObj) return false;
    }
    return true;
  },
};
