/**
 * #425 Bedrock Stage 2 — pure UI-control helpers for the Bedrock SSO
 * auth section. Keeps the settings tab thin and the async/abort/busy
 * semantics unit-tested.
 */

export interface BedrockAuthUiInput {
  isBusy: boolean;
  isSignedIn: boolean;
}

export interface BedrockAuthUiState {
  showLogin: boolean;
  showSignOut: boolean;
}

export function getBedrockAuthUiState(input: BedrockAuthUiInput): BedrockAuthUiState {
  if (input.isBusy) return { showLogin: false, showSignOut: false };
  if (input.isSignedIn) return { showLogin: false, showSignOut: true };
  return { showLogin: true, showSignOut: false };
}

export interface BedrockDevicePrompt {
  userCode: string;
  verificationUri: string;
  /** Pre-fills the code in the browser — preferred over verificationUri. */
  verificationUriComplete?: string;
  complete: Promise<unknown>;
  cancel(): void;
}

export interface BedrockAsyncControlInput {
  showError(error: unknown): void;
  setBusy(value: boolean): void;
  setReady(value: boolean): void;
  render(): void;
}

export interface BedrockDeviceAuthInput extends BedrockAsyncControlInput {
  beginLogin(): Promise<BedrockDevicePrompt>;
  openExternal(url: string): void | Promise<void>;
  setPrompt(prompt: BedrockDevicePrompt | null): void;
}

/**
 * Drive one device login: begin → surface prompt → open browser →
 * await completion. Cancellation and aborts are silent; everything
 * else reports through showError. On a failure to even OPEN the
 * browser, the pending poll is cancelled so no zombie loop remains.
 */
export async function runBedrockDeviceAuth(input: BedrockDeviceAuthInput): Promise<void> {
  let prompt: BedrockDevicePrompt | null = null;
  let opened = false;
  input.setBusy(true);
  input.render();
  try {
    prompt = await input.beginLogin();
    input.setPrompt(prompt);
    input.render();
    await input.openExternal(prompt.verificationUriComplete ?? prompt.verificationUri);
    opened = true;
    await prompt.complete;
    input.setReady(false);
  } catch (error) {
    if (prompt && !opened) {
      prompt.cancel();
      void prompt.complete.catch(() => undefined);
    }
    if (!(error instanceof DOMException && error.name === 'AbortError')) input.showError(error);
  } finally {
    input.setPrompt(null);
    input.setBusy(false);
    input.render();
  }
}

/**
 * Minimal view of the window object used to hand a URL to the user's
 * browser. Hardening Phase 2.B: this helper and its `noopener,noreferrer`
 * hardening moved here from the removed OAuth module's controls, which used
 * to be its home; the SSO device flow is now the only caller, and the URL
 * check below was added with the move (see `openExternalUrl`).
 */
export interface ExternalNavigationTarget {
  open(url: string, target: string, features: string): unknown;
}

/**
 * Hand a URL to the user's browser.
 *
 * `noopener,noreferrer` is not cosmetic: without `noopener` the opened page
 * gets a live `window.opener` handle back into the Obsidian renderer.
 *
 * The URL is validated first, because it is not ours. The only caller is the
 * SSO device flow above, and the string it passes is
 * `verificationUriComplete` — a field lifted straight out of an OIDC
 * response body. Handing an unvalidated remote string to `window.open` is
 * how a compromised or spoofed authorization server turns a sign-in button
 * into arbitrary navigation; `javascript:` and `data:` URLs in particular
 * execute in whatever context the host hands the window.
 *
 * Two rules, and deliberately only two:
 *   - the scheme must be `https:` — the same floor `assertAllowedEgress`
 *     puts under every request that carries a credential;
 *   - the URL must not embed `user:pass@`, the classic way to disguise the
 *     real host in the address bar of the window we just opened.
 *
 * Notably NOT an egress-allowlist check: an Identity Center device page
 * lives on `device.sso.<region>.amazonaws.com` or on the tenant's own
 * `d-*.awsapps.com` start domain, and `egress-hosts.json` deliberately
 * keeps `.awsapps.com` out of the fetch allowlist because anyone can
 * self-register under it. Requiring an allowlisted host here would break
 * the sign-in it is meant to protect; the browser, not the plugin, is what
 * loads this page, and no plugin credential rides along.
 *
 * @throws Error when the URL is unparsable or fails either rule. The caller
 * (`runBedrockDeviceAuth`) already treats an `openExternal` throw as a
 * failed login: it cancels the device prompt and surfaces the message.
 */
export function openExternalUrl(target: ExternalNavigationTarget, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Refusing to open a URL that could not be parsed');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing to open a non-https URL (scheme "${parsed.protocol}")`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Refusing to open a URL that embeds credentials (user:pass@host)');
  }
  target.open(parsed.href, '_blank', 'noopener,noreferrer');
}

export interface BedrockClipboard {
  writeText(value: string): Promise<void>;
}

export async function copyBedrockUserCode(code: string, clipboard: BedrockClipboard): Promise<void> {
  await clipboard.writeText(code);
}

export interface BedrockSignOutInput extends BedrockAsyncControlInput {
  isBusy(): boolean;
  isSignedIn(): boolean;
  confirm(): Promise<boolean>;
  signOut(): Promise<void>;
}

/**
 * Drive one sign-out: busy lock → async confirm → sign out.
 *
 * Hardening Phase 2.B: this used to delegate to the removed OAuth
 * module's identical helper. The behaviour is unchanged — the body was
 * moved here verbatim when that module was deleted.
 *
 * v1.25.2 PATCH: `confirm()` returns a Promise — Obsidian `ConfirmModal`
 * is intrinsically async, so we await it before deciding to sign out.
 * Busy is locked immediately so a second click during the modal wait
 * does not call `confirm` a second time. The first click drives the
 * action; the second click is dropped.
 */
export async function runBedrockSignOut(input: BedrockSignOutInput): Promise<void> {
  if (input.isBusy()) return;
  input.setBusy(true);
  input.render();
  let confirmed = false;
  try {
    confirmed = await input.confirm();
  } catch (error) {
    input.setBusy(false);
    input.render();
    input.showError(error);
    return;
  }
  if (!confirmed) {
    input.setBusy(false);
    input.render();
    return;
  }
  try {
    await input.signOut();
  } catch (error) {
    input.showError(error);
  } finally {
    if (!input.isSignedIn()) input.setReady(false);
    input.setBusy(false);
    input.render();
  }
}
