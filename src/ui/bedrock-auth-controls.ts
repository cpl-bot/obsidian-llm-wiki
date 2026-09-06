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
 * hardening moved here verbatim from the removed OAuth module's controls,
 * which used to be its home; the SSO device flow is now the only caller.
 */
export interface ExternalNavigationTarget {
  open(url: string, target: string, features: string): unknown;
}

/**
 * `noopener,noreferrer` is not cosmetic: without `noopener` the opened page
 * gets a live `window.opener` handle back into the Obsidian renderer.
 */
export function openExternalUrl(target: ExternalNavigationTarget, url: string): void {
  target.open(url, '_blank', 'noopener,noreferrer');
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
