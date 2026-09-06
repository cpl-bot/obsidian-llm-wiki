import { Plugin, Notice, Platform } from 'obsidian';

import {
  LLMWikiSettings,
  LLMClient,
  IngestReport,
} from './types';
import { NOTICE_NORMAL, NOTICE_ABORT, NOTICE_ERROR } from './constants';
import { preloadLLMClientModules } from './llm-sdk/create-llm-client';
import { isProviderConfigured } from './core/provider-auth';
import { resolveProviderApiKey } from './llm-sdk/provider-api-key-resolver';
import { isProviderSecretStorageError } from './llm-sdk/provider-secret-store';
import { redactError, redactSecrets } from './core/redact';
import { createLLMClient } from './core/create-plugin-llm-client';
import { registerEgressSettings } from './core/egress-policy';
import { setActivePluginId } from './core/plugin-runtime-id';

// v1.23.0 P1-7: AI-SDK migration. Eagerly preload SDK modules on plugin
// load so sync `createLLMClient` works without blocking. Failure is
// non-fatal: falls back to legacy llm-client at createLLMClient time.
const aiSdkModulesLoaded: Promise<void> = preloadLLMClientModules().catch((err) => {
  console.warn('[v1.23.0 LLM migration] Failed to preload AI-SDK modules:', redactError(err));
});

export async function initializeLLMClientAfterModules(modulesLoaded: Promise<void>, initialize: () => void): Promise<void> {
  try {
    await modulesLoaded;
  } catch (error) {
    console.warn('[v1.23.0 LLM migration] Failed to preload AI-SDK modules:', redactError(error));
  }
  initialize();
}

export { createLLMClient };
import { TEXTS } from './texts';
import { getText } from './core/i18n';
import { applySettingsMigrations, adoptScrubbedPlaintextApiKey, scrubRemovedConversionBackendSecret, scrubRemovedOAuthProviderSecret, scrubRemovedProviderSecrets, REMOVED_PROVIDER_SCRUB_MARKER } from './core/settings-migrations';
import { normalizeVocabularyCsv } from './core/tag-vocab';
import { detectStaleWikiFolders } from './core/query-history-migration-check';
import { BatchProgress } from './core/status-bar';
import { IngestQueue } from './core/ingest-queue';
import { decideProgressDisplay, ProgressScope } from './core/progress-notification';
import { WikiEngine } from './wiki/wiki-engine';
import { QueryView, VIEW_TYPE_QUERY } from './wiki/query-engine';
import { IngestReportModal, ConfirmModal } from './ui/modals';
import { SchemaManager } from './schema/schema-manager';
import { AutoMaintainManager } from './schema/auto-maintain';
import { createVaultWriter, type VaultWriter } from './core/vault-writer';

// v1.25.1 Phase C-PR3: Mixin method implementations.
import { pdfCacheCommands } from './main-commands/pdf-cache-commands';
import type { PdfCacheMethods } from './main-commands/pdf-cache-commands';
import { connectionCommands } from './main-commands/connection-commands';
import type { ConnectionCommandsMethods } from './main-commands/connection-commands';
import { schemaCommands } from './main-commands/schema-commands';
import type { SchemaCommandsMethods } from './main-commands/schema-commands';
import { queryLintCommands } from './main-commands/query-lint-commands';
import type { QueryLintMethods } from './main-commands/query-lint-commands';
import { ingestCommands } from './main-commands/ingest-commands';
import type { IngestMethods } from './main-commands/ingest-commands';
import { registerWikiCommands } from './main-commands/command-registry';

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- C-PR3: intentional interface+class merge for mixin pattern
export class LLMWikiPlugin extends Plugin {
  settings: LLMWikiSettings;
  llmClient: LLMClient | null = null;
  /**
   * Phase 5 (F-08): the one vault write-gate, built once after settings load
   * and handed to every module that writes. Scope is read from `this.settings`
   * on each call, so changing `wikiFolder` re-scopes it immediately.
   */
  vaultWriter: VaultWriter;
  wikiEngine: WikiEngine;
  schemaManager: SchemaManager;
  autoMaintainManager: AutoMaintainManager;
  ingestQueue: IngestQueue = new IngestQueue();
  progressNotice: Notice | null = null;
  ingestStatusBar: HTMLElement | null = null;
  batchProgress: BatchProgress | null = null;
  /**
   * Hardening Phase 3 (F-03): one-shot guard for the keychain Notice.
   * `initializeLLMClient` runs on every settings save, so an unreadable
   * keychain would otherwise fire a Notice per keystroke-flush.
   */
  private keychainNoticeShown = false;
  async onload() {
    // Hardening Phase 3 (F-03/3.7): platform gate, first statement, before
    // `loadData()` touches the vault. The plaintext `data.json` fallback
    // this phase removed existed for exactly one reason — Windows 10
    // Credential Manager failing under Obsidian (#339). With the fallback
    // gone the hardened build has no safe behaviour to offer that platform,
    // so it refuses to run rather than degrading into "your key is gone"
    // on every load. Target platforms are macOS (Keychain) and Linux
    // (Secret Service); see README "Secret storage prerequisites".
    //
    // The Notice is English-only by construction: `settings.language` is
    // read from data.json, and reading it is precisely what this gate
    // prevents.
    if (Platform.isWin) {
      new Notice(getText('en', 'unsupportedPlatform'), NOTICE_ERROR);
      return;
    }

    // Hardened-fork Phase 7: record this install's actual manifest.id
    // before anything touches the plugin's own folder (e.g. the PDF cache
    // in core/pdf-cache.ts). Must run before any such access — see
    // core/plugin-runtime-id.ts for why this exists.
    setActivePluginId(this.manifest.id);
    await this.loadSettings();
    // Phase 4.2 (F-04): publish the live settings to the egress policy
    // before ANY component that can make a request is constructed. The
    // fetch chokepoints are free functions shared by every SDK client, so
    // there is no constructor to thread settings through; until this runs
    // the policy sees `{}` and is therefore strict (fail closed).
    registerEgressSettings(() => this.settings);
    this.cleanupVocabularyTags();
    await initializeLLMClientAfterModules(aiSdkModulesLoaded, () => this.initializeLLMClient());

    // The config-dir root follows `manifest.id`, not a literal: Phase 7
    // renames the plugin to `karpathywiki-hardened`, and a pinned literal
    // would then scope the gate at a directory the plugin does not use.
    this.vaultWriter = createVaultWriter(this.app, this.settings, this.manifest.id);

    this.schemaManager = new SchemaManager(
      this.app,
      this.settings,
      () => this.llmClient,
      this.vaultWriter
    );

    this.wikiEngine = new WikiEngine(
      this.app,
      this.settings,
      () => this.llmClient,
      this.schemaManager,
      // Delayed evaluation: this closure captures autoMaintainManager by reference,
      // but the variable is assigned below. By the time wikiEngine calls
      // this callback (during file writes), autoMaintainManager is guaranteed
      // to exist. This is intentional — reordering the assignments would break it.
      (path: string) => this.autoMaintainManager.watchWrite(path),
      (msg: string) => {
        if (this.ingestStatusBar) {
          this.ingestStatusBar.setText(msg);
          this.ingestStatusBar.removeClass('llm-wiki-status-bar-hidden');
        }
        this.showProgressFor(ProgressScope.IngestAutoWatch, msg);
      },
      (report: IngestReport) => this.onIngestDoneDispatch(report),
      (typeof activeWindow !== 'undefined' ? activeWindow.crypto : undefined)?.subtle,
      this.vaultWriter
    );

    // #164: when an interactive ingest hits a duplicate, ask the user whether to
    // re-ingest. Folder/watcher ingests leave this unused and auto-skip.
    this.wikiEngine.onConfirmReingest = (file) => new Promise<boolean>((resolve) => {
      const lang = this.settings.language;
      new ConfirmModal(this.app, {
        title: getText(lang, 'reingestConfirmTitle'),
        body: getText(lang, 'reingestConfirmBody').replace('{filename}', file.basename),
        confirmText: getText(lang, 'reingestConfirmYes'),
        cancelText: getText(lang, 'reingestConfirmNo'),
        onChoice: resolve,
      }).open();
    });

    this.autoMaintainManager = new AutoMaintainManager(
      this.app,
      this.settings,
      this.wikiEngine,
      this,
      () => this.lintWiki('auto'),
      this.vaultWriter
    );

    void this.performPdfCacheHousekeeping();

    if (this.settings.autoWatchSources) {
      this.autoMaintainManager.startWatching();
    }
    this.autoMaintainManager.schedulePeriodicLint();
    void this.autoMaintainManager.runStartupCheck();

    this.registerView(
      VIEW_TYPE_QUERY,
      (leaf) => new QueryView(leaf, this)
    );

    // v1.25.1 Phase C-PR3: command registration, ribbon icons, status
    // bar, and wiki-engine callbacks extracted to command-registry.ts.
    registerWikiCommands(this);

    this.checkQueryHistoryForStaleFolders();

    console.debug('LLM Wiki Plugin loaded - Karpathy implementation');
  }

  private checkQueryHistoryForStaleFolders(): void {
    const history = this.settings.queryHistory;
    if (!Array.isArray(history) || history.length === 0) return;
    const detection = detectStaleWikiFolders(history, this.settings.wikiFolder);
    if (!detection || !detection.hasStale) return;
    new Notice(getText(this.settings.language, 'queryHistoryMigrationNotice'), NOTICE_NORMAL);
  }

  onunload() {
    // Drop the settings getter so a stale plugin instance can never
    // authorize egress for the next one.
    registerEgressSettings(null);
    this.autoMaintainManager?.stop();
    console.debug('LLM Wiki Plugin unloaded');
  }

  async loadSettings() {
    const savedData = await this.loadData() as Partial<LLMWikiSettings> | null;
    const { settings, applied } = applySettingsMigrations(savedData);

    // Hardening Phase 3 (F-03): the plaintext `apiKey` field is scrubbed
    // out of `data.json` on first load. `applySettingsMigrations` is pure
    // and cannot touch IO, so it stashes the value on a transient field
    // and deletes the key; this block owns the keychain write, the
    // user-facing Notice, and the cleanup of the transient field.
    //
    // Ordering matters: the field is already gone from `settings` by the
    // time we get here, so the scrub cannot be undone by a keychain
    // failure. That is the intended trade — the key has been sitting in a
    // synced file and must be rotated regardless of where it ends up, so
    // "removed but not adopted" is strictly better than "left on disk".
    // No saveData() call: the shared `applied.length > 0` write below
    // persists the whole pass in one serialization.
    const legacyPlaintextKey = (settings as unknown as { _legacyPlaintextApiKey?: string })._legacyPlaintextApiKey;
    delete (settings as unknown as { _legacyPlaintextApiKey?: string })._legacyPlaintextApiKey;
    if (applied.includes('harden-plaintext-api-key-removed') && typeof legacyPlaintextKey === 'string' && legacyPlaintextKey.length > 0) {
      try {
        const adopted = adoptScrubbedPlaintextApiKey(
          this.app.secretStorage,
          settings.providerApiKeySecretId,
          legacyPlaintextKey,
        );
        console.debug(adopted
          ? '[main.loadSettings] Plaintext API key adopted into SecretStorage and removed from data.json'
          : '[main.loadSettings] Plaintext API key removed from data.json; keychain slot already held a key');
      } catch (error) {
        // Drop the marker before the shared saveData() below persists it,
        // so disk never records a keychain write that did not happen —
        // mirrors the Phase 2.A conversion-backend scrub. The plaintext
        // itself stays deleted (the scrub is unconditional), so the next
        // load has nothing left to adopt; what the dropped marker buys is
        // an honest record, not a second attempt at the key. The user was
        // told to rotate on this load either way.
        delete settings._migrated_harden_plaintext_api_key_removed;
        console.error('[main.loadSettings] Failed to adopt the plaintext API key into SecretStorage; key removed from data.json anyway:', redactError(error));
      }
      // Same Notice on every path: the key touched disk inside a synced
      // vault, so it is disclosed whether or not the keychain took it.
      new Notice(getText(settings.language, 'plaintextApiKeyScrubbedNotice'), NOTICE_ERROR);
    }

    this.settings = settings;

    // Hardening Phase 2.A (F-06): the third-party document-conversion backend
    // is gone. `applySettingsMigrations` has already deleted its keys from the
    // settings object; the paired keychain slot is blanked here because the
    // migration helper is pure. No saveData() call: the shared
    // `applied.length > 0` write below persists the whole pass, so an upgrade
    // still serializes data.json exactly once.
    if (applied.includes('harden-conversion-backend-removed')) {
      try {
        if (scrubRemovedConversionBackendSecret(this.app.secretStorage)) {
          console.debug('[main.loadSettings] Cleared the removed conversion backend token from SecretStorage');
        }
      } catch (error) {
        // Best-effort: a keychain failure must not block startup. The
        // settings keys are already gone, so the backend cannot be used
        // either way. Drop the marker again before the shared saveData()
        // below persists it, so the next load retries the slot — otherwise
        // the marker records a scrub that never happened and the stale
        // token would sit in the keychain forever.
        delete this.settings._migrated_harden_conversion_backend_removed;
        console.error('[main.loadSettings] Failed to clear the removed conversion backend token; retrying on next load:', redactError(error));
      }
    }

    // Hardening Phase 2.B: the AWS Bedrock SSO/IAM provider surface is
    // gone. `applySettingsMigrations` has already deleted its settings keys
    // and reset the active provider when it was one of the removed ids; the
    // two paired keychain slots (SSO session token / static IAM keys) are
    // blanked here because the migration helper is pure. No saveData() call:
    // the shared `applied.length > 0` write below persists the whole pass.
    if (applied.includes('harden-removed-provider-scrubbed')) {
      try {
        scrubRemovedProviderSecrets(this.app.secretStorage);
        console.debug('[main.loadSettings] Cleared the removed provider credentials from SecretStorage');
      } catch (error) {
        // Best-effort: a keychain failure must not block startup. The
        // settings keys are already gone and the provider cannot be
        // selected either way. Drop the marker before the shared saveData()
        // below persists it, so the next load retries the two slots —
        // otherwise the marker would record a scrub that never happened and
        // live cloud credentials would sit in the keychain forever.
        delete (this.settings as unknown as Record<string, unknown>)[REMOVED_PROVIDER_SCRUB_MARKER];
        console.error('[main.loadSettings] Failed to clear the removed provider credentials; retrying on next load:', redactError(error));
      }
    }

    // A vault configured against the removed provider is now pointing at a
    // provider this build does not have, so the migration reset it. Say so
    // once — silently switching the provider under the user would look like
    // data loss the next time a wiki build used the wrong model.
    if (applied.includes('harden-removed-provider-reset')) {
      new Notice(getText(this.settings.language, 'removedProviderResetNotice'), NOTICE_ERROR);
    }

    // Hardening Phase 2.B: the ChatGPT-subscription OAuth provider is gone.
    // `applySettingsMigrations` has already deleted its settings keys and
    // reset the active provider; the OAuth credential blob in the keychain is
    // blanked here because the migration helper is pure. No saveData() call:
    // the shared `applied.length > 0` write below persists the whole pass.
    if (applied.includes('harden-oauth-provider-removed')) {
      try {
        if (scrubRemovedOAuthProviderSecret(this.app.secretStorage)) {
          console.debug('[main.loadSettings] Cleared the removed OAuth provider credential from SecretStorage');
        }
      } catch (error) {
        // Drop the marker before the shared saveData() below persists it so
        // the next load retries the slot. The refresh token in there outlives
        // the session that minted it, so "the marker says we cleared it" must
        // never be recorded for a clear that did not happen.
        delete this.settings._migrated_harden_codex_removed;
        console.error('[main.loadSettings] Failed to clear the removed OAuth provider credential; retrying on next load:', redactError(error));
      }
    }

    // One-time Notice: the user had the removed provider selected, so their
    // next action would otherwise fail with an unexplained "no provider".
    if (applied.includes('harden-oauth-provider-reset')) {
      new Notice(getText(this.settings.language, 'removedOAuthProviderNotice'), NOTICE_ERROR);
    }

    if (savedData && !savedData.wikiLanguage) {
      this.settings.wikiLanguage = this.settings.language;
      await this.saveData(this.settings);
    }

    if (!Array.isArray(this.settings.watchedFolders)) {
      this.settings.watchedFolders = [];
      console.debug('loadSettings: watchedFolders was not an array, reset to []');
    }

    if (applied.length > 0) {
      console.debug(`loadSettings: applied migrations: ${applied.join(', ')}`);
      await this.saveData(this.settings);
    }

    console.debug(
      '[main.loadSettings] settings.queryHistory =',
      Array.isArray(this.settings.queryHistory) ? `${this.settings.queryHistory.length} messages` : 'NOT an array'
    );

    if (savedData && !('llmReady' in savedData)) {
      // v1.25.3 #182: resolve the live key from SecretStorage — the OS
      // keychain is the only source there has ever been a second one of.
      // Hardening Phase 3 (F-03): an unreadable keychain resolves to null,
      // which is NOT "no key" — the readiness answer is simply unknown, so
      // leave `llmReady` alone rather than persisting a false negative that
      // would survive the keychain coming back.
      const resolvedKey = this.resolveKeyOrNotify();
      if (resolvedKey === null) return;
      const hasConfig = isProviderConfigured({
        provider: this.settings.provider,
        apiKey: resolvedKey,
        model: this.settings.model,
      });
      this.settings.llmReady = hasConfig;
      if (hasConfig) {
        console.debug('loadSettings: existing user with config detected, llmReady = true');
      }
    }
  }

  private cleanupVocabularyTags(): void {
    const fields: ('customEntityTags' | 'customConceptTags')[] = [
      'customEntityTags',
      'customConceptTags',
    ];
    let changed = false;
    for (const field of fields) {
      const current = this.settings[field];
      if (!current) continue;
      const cleaned = normalizeVocabularyCsv(current);
      if (cleaned !== current) {
        this.settings[field] = cleaned;
        changed = true;
      }
    }
    if (changed) void this.saveSettings();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.initializeLLMClient();
    this.schemaManager?.updateSettings(this.settings);
    if (this.wikiEngine) {
      const wikiFolderChanged = this.wikiEngine.updateSettings(this.settings);
      console.debug('[saveSettings] wikiEngine provider updated to:', this.settings.provider);
      if (wikiFolderChanged) {
        this.invalidateAllQueryGraphs();
        this.checkQueryHistoryForStaleFolders();
      }
    }
    if (this.autoMaintainManager) {
      this.autoMaintainManager.settings = this.settings;
      this.autoMaintainManager.stop();
      if (this.settings.autoWatchSources) {
        this.autoMaintainManager.startWatching();
      }
      this.autoMaintainManager.schedulePeriodicLint();
    }
  }

  /**
   * Hardening Phase 3 (F-03): the single keychain read seam for the plugin
   * object, with the UI boundary attached.
   *
   * Returns the resolved key (`''` = no key configured, a normal state) or
   * `null` when the keychain could not be read at all. `null` is where the
   * fail-closed contract becomes visible to the user: LLM features stay
   * off and a Notice says why, instead of the old behaviour of silently
   * reading the plaintext mirror out of `data.json`.
   *
   * The Notice fires once per plugin load — `initializeLLMClient` runs on
   * every settings save, and a broken keychain is a standing condition,
   * not an event.
   */
  private resolveKeyOrNotify(): string | null {
    try {
      return resolveProviderApiKey(
        { providerApiKeySecretId: this.settings.providerApiKeySecretId },
        this.app.secretStorage,
      );
    } catch (error: unknown) {
      if (!isProviderSecretStorageError(error)) throw error;
      console.error('[main] SecretStorage read failed; LLM features disabled:', redactError(error));
      if (!this.keychainNoticeShown) {
        this.keychainNoticeShown = true;
        new Notice(
          getText(this.settings.language, 'keychainUnavailableNotice').replace('{}', redactSecrets(error.message)),
          NOTICE_ERROR,
        );
      }
      return null;
    }
  }

  initializeLLMClient(): void {
    // v1.25.3 #182: resolve from SecretStorage — the only place the key
    // has ever lived since v1.25.3, and since hardening Phase 3 (F-03) the
    // only place it CAN live. A null answer means the keychain itself is
    // unreadable: fail closed with no client rather than falling back to
    // anything on disk.
    const resolvedKey = this.resolveKeyOrNotify();
    if (resolvedKey === null) {
      this.llmClient = null;
      return;
    }
    if (!isProviderConfigured({
      provider: this.settings.provider,
      apiKey: resolvedKey,
      model: this.settings.model,
    })) {
      this.llmClient = null;
      return;
    }
    try {
      // v1.25.3 #182: pass `app.secretStorage` so the SDK factory reads
      // the live key from the OS keychain.
      this.llmClient = createLLMClient(this.settings, this.app.secretStorage);
      console.debug('LLM Client initialized:', this.settings.provider);
    } catch (error) {
      // Hardening Phase 3 (F-03/3.5): the SDK factory's throw can carry a
      // provider error body.
      console.error('LLM Client initialization failed:', redactError(error));
      this.llmClient = null;
    }
  }

  // ==================== Progress helpers ====================

  private showProgress(msg: string): void {
    this.showProgressFor(ProgressScope.IngestManual, msg);
  }

  private showProgressFor(scope: ProgressScope, msg: string): void {
    const decision = decideProgressDisplay(scope, false, true);
    if (decision.display === 'notice+status-bar') {
      if (this.progressNotice) {
        this.progressNotice.setMessage(msg);
      } else {
        this.progressNotice = new Notice(msg, 0);
      }
    }
    this.ingestStatusBar?.removeClass('llm-wiki-status-bar-hidden');
  }

  private dismissProgress(): void {
    if (this.progressNotice) {
      this.progressNotice.hide();
      this.progressNotice = null;
    }
  }

  // ==================== Ingest dispatch ====================

  private onIngestDoneDispatch(report: IngestReport): void {
    this.invalidateAllQueryGraphs();
    if (report.trigger === 'auto') {
      this.onAutoIngestDone(report);
    } else {
      this.dismissProgress();
      new IngestReportModal(this.app, report, this.settings.language).open();
    }
  }

  private onAutoIngestDone(report: IngestReport): void {
    this.dismissProgress();
    const level = this.settings.autoIngestNotificationLevel;
    if (level === 'modal') {
      new IngestReportModal(this.app, report, this.settings.language).open();
      return;
    }
    const texts = TEXTS[this.settings.language];
    const summary = report.createdPages?.length > 0
      ? texts.ingestionCreatedPages.replace('{count}', String(report.createdPages.length))
      : texts.ingestionUpdatedPages.replace('{count}', String(report.updatedPages.length));
    const hint = getText(this.settings.language, 'ingestionNoticeHistoryHint');
    new Notice(`✅ ${report.sourceFile}: ${summary}. ${hint}`, NOTICE_ABORT);
  }
}

// v1.25.1 Phase C-PR3: Interface merge — makes tsc see mixed-in
// method signatures on the LLMWikiPlugin instance type.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- C-PR3 mixin pattern
export interface LLMWikiPlugin extends PdfCacheMethods, ConnectionCommandsMethods,
  SchemaCommandsMethods, QueryLintMethods, IngestMethods {}

// v1.25.1 Phase C-PR3: prototype injection — copies runtime
// implementations from each mixin module onto the class prototype.
Object.assign(LLMWikiPlugin.prototype, pdfCacheCommands, connectionCommands,
  schemaCommands, queryLintCommands, ingestCommands);

export default LLMWikiPlugin;
