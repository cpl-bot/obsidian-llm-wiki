// Categorize fetch-model errors so the Notice can give specific guidance
// (check API Key, check BaseURL, try again, or enter model ID manually).
// Pure function — extracted from settings.ts to enable unit testing without
// the heavy Obsidian module graph.
export type FetchErrorCategory = 'Auth' | 'Endpoint' | 'Server' | 'Empty' | 'Network';

export function classifyFetchError(msg: string): FetchErrorCategory {
  if (msg === 'empty model list') return 'Empty';

  // B1 (v1.26.3 PATCH, DocT CR): when the message carries a leading HTTP
  // status (e.g. the "HTTP 401: …" thrown by fetchOneUrl in model-section.ts),
  // classify by status FIRST. The keyword regexes below are auth-first, so a
  // 5xx whose body happens to mention "unauthorized" would otherwise be
  // misread as Auth. Statuses without a dedicated branch (2xx, odd statuses)
  // fall through to the keyword scan → Network.
  const statusMatch = /^HTTP\s+(\d{3})/.exec(msg);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 401 || status === 403) return 'Auth';
    if (status === 404 || status === 405 || status === 410 || status === 421) return 'Endpoint';
    if (status >= 500 && status < 600) return 'Server';
  }

  // Auth: any 401/403, or keywords like "unauthorized"/"forbidden"/"invalid key".
  // Case-insensitive to match varying server error formats.
  // \b word boundaries prevent partial matches inside other identifiers.
  if (/\b(401|403)\b/.test(msg)
      || /\bunauthor\w*|\bforbidden\b|\binvalid[_\s-]?(api[_\s-]?)?key\b|\binvalid[_\s-]?token\b|\bauth(entication|orization)?[_\s-]?fail/i.test(msg)) {
    return 'Auth';
  }

  // Endpoint: 404/405/410/421, or "not found"/"method not allowed".
  // The "not found" pattern uses a word boundary on both sides to avoid
  // false-positive matches like "ENOTFOUND" (DNS error code).
  if (/\b(404|405|410|421)\b/.test(msg)
      || /\bnot[_\s-]?found\b|\bmethod[_\s-]?not[_\s-]?allowed\b/i.test(msg)) {
    return 'Endpoint';
  }

  // Server: any 5xx status code, or server error keywords.
  if (/\b5\d\d\b/.test(msg)
      || /\bserver[_\s-]?error\b|\bbad[_\s-]?gateway\b|\bservice[_\s-]?unavailable\b|\b\d*rate[_\s-]?limit/i.test(msg)) {
    return 'Server';
  }

  return 'Network';
}

// ============================================================================
// v1.25.1 Phase C-PR2 simplify pass — shared Settings UI helpers extracted from
// the 8 section renderers. Two patterns were triplicated across sections:
//   1. Range slider with dynamic tooltip + dynamic desc rewriteback
//      (used in provider-section: pageGenerationConcurrency, batchDelayMs)
//   2. Setting visibility toggling based on a mode value
//      (used in wiki-config: extractionGranularity + tagVocabularyMode)
//
// Numeric-input clamp + chip-tag builders were considered but kept inline
// in their respective sections — the per-site config (placeholder text,
// field-key path, onSetting capture) diverges enough that extracting them
// would force the helpers to grow callback parameters that defeat the
// purpose. Documented in the simplify log so future maintainers don't
// re-attempt the extraction.
// ============================================================================

import { Setting } from 'obsidian';

export interface RangeSliderOptions {
  /** Pre-resolved localized name for the Setting row. */
  name: string;
  /** Pre-resolved localized desc; the live value is appended via formatDesc. */
  desc: string;
  /** Initial numeric value. */
  initialValue: number;
  min: number;
  max: number;
  step: number;
  /** Formats the live value text appended after `desc`. */
  formatDesc: (value: number) => string;
  /** Called when the user moves the slider. */
  onChange: (value: number) => void;
}

/**
 * Render a range slider with dynamic tooltip + dynamic desc rewriteback.
 * Used by provider-section for pageGenerationConcurrency + batchDelayMs.
 *
 * Why extracted: the two slider sites were byte-identical except for
 * limits, default, and desc-format logic. Centralizing the
 * `setDynamicTooltip` UX + desc rewriteback via the captured Setting
 * reference (via `Setting.then(s => ...)`) eliminates 30 LOC of
 * copy-paste and prevents future drift.
 */
/**
 * Build the full desc text for a range slider:
 *   - If `opts.desc` contains `{}`, replace it with the live value
 *     (batchDelayDesc pattern: "... {}ms ...").
 *   - Otherwise, append `formatDesc` as a suffix
 *     (concurrencyValueSingular/Plural pattern).
 * This prevents double-rendering when the desc itself carries the `{}`
 * placeholder AND the caller also passes a formatDesc that re-reads
 * the same i18n key (v1.25.1 regression, v1.25.3 fix).
 */
function buildRangeSliderDesc(opts: RangeSliderOptions, value: number): string {
  if (opts.desc.includes('{}')) {
    return opts.desc.replace('{}', String(value));
  }
  return opts.desc + ' ' + opts.formatDesc(value);
}

export function renderRangeSlider(
  containerEl: HTMLElement,
  opts: RangeSliderOptions,
): void {
  let captured: Setting;
  new Setting(containerEl)
    .setName(opts.name)
    .setDesc(buildRangeSliderDesc(opts, opts.initialValue))
    .addSlider(slider => slider
      .setLimits(opts.min, opts.max, opts.step)
      .setValue(opts.initialValue)
      .setDynamicTooltip()
      .onChange((value) => {
        opts.onChange(value);
        captured.setDesc(buildRangeSliderDesc(opts, value));
      }))
    .then(s => { captured = s; });
}

/**
 * Toggle the `settingEl.style.display` of every Setting in the list. Pass
 * `visible=true` to show (`'flex'`) and `false` to hide (`'none'`).
 *
 * Each Setting may be `null` if it hasn't been constructed yet — common
 * when called from the dropdown's onChange before the gated Settings are
 * created (e.g. granularity dropdown before customEntityLimit Setting).
 */
export function setSettingsVisible(
  settings: Array<Setting | null>,
  visible: boolean,
): void {
  const display = visible ? 'flex' : 'none';
  for (const s of settings) {
    if (s) s.settingEl.style.display = display;
  }
}

// ============================================================================
// Phase 4 (F-04) — egress denial → localized reason key.
//
// `EgressDeniedError.reason` is a machine code precisely so the UI never has
// to string-match an error message. This map is the single translation point
// between the policy's vocabulary and the i18n bundles; the return type is a
// literal union so `tab.getText(...)` still type-checks the key.
// ============================================================================

import type { EgressDenialReason } from '../core/egress-policy';

export type EgressReasonTextKey =
  | 'egressReasonInvalidUrl'
  | 'egressReasonScheme'
  | 'egressReasonUserinfo'
  | 'egressReasonPrivateAddress'
  | 'egressReasonHostNotAllowed';

const EGRESS_REASON_TEXT_KEYS: Record<EgressDenialReason, EgressReasonTextKey> = {
  'invalid-url': 'egressReasonInvalidUrl',
  'unsupported-scheme': 'egressReasonScheme',
  'cleartext-scheme': 'egressReasonScheme',
  'userinfo': 'egressReasonUserinfo',
  'private-address': 'egressReasonPrivateAddress',
  'host-not-allowed': 'egressReasonHostNotAllowed',
};

export function egressReasonTextKey(reason: EgressDenialReason): EgressReasonTextKey {
  return EGRESS_REASON_TEXT_KEYS[reason];
}
