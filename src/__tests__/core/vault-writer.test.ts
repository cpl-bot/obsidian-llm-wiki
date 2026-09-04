// Phase 5 (F-08) — filesystem write-gate.
//
// Every vault write in the plugin goes through `VaultWriter`. These tests
// pin the two halves of the contract:
//
//   1. `assertWithinScope` — the path rules (syntax + folder containment).
//   2. `VaultWriter.*`      — forwarding: exactly one underlying call when a
//      path is accepted, zero when it is rejected.
//
// The Obsidian test stub makes `normalizePath` the identity function, so a
// gate that leaned on it would pass here and fail nowhere. Every rule below
// is therefore enforced by `vault-writer.ts` itself.

import { describe, it, expect, vi } from 'vitest';
import {
  VaultWriter,
  VaultWriteScopeError,
  assertWithinScope,
  scopeFromSettings,
  pluginConfigDirFor,
  type VaultWriteScope,
} from '../../core/vault-writer';

const WIKI: VaultWriteScope = { wikiFolder: 'wiki' };

function expectRejected(fn: () => unknown, reason: string): VaultWriteScopeError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(VaultWriteScopeError);
  const err = caught as VaultWriteScopeError;
  expect(err.reason).toBe(reason);
  return err;
}

function makeFakeVault() {
  return {
    create: vi.fn(async (path: string) => ({ path })),
    modify: vi.fn(async () => undefined),
    createFolder: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    adapter: {
      write: vi.fn(async () => undefined),
      writeBinary: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  };
}

function makeFakeFileManager() {
  return { trashFile: vi.fn(async () => undefined) };
}

function makeWriter(scope: VaultWriteScope = WIKI) {
  const vault = makeFakeVault();
  const fileManager = makeFakeFileManager();
  const writer = new VaultWriter({ vault, fileManager, scope });
  return { writer, vault, fileManager };
}

describe('assertWithinScope — syntactic rejections', () => {
  it('rejects a parent-traversal segment that escapes the wiki folder', () => {
    const err = expectRejected(
      () => assertWithinScope('wiki/../secrets.md', WIKI, 'create'),
      'parent-traversal'
    );
    expect(err.path).toBe('wiki/../secrets.md');
    expect(err.operation).toBe('create');
  });

  it('rejects a traversal hidden mid-path', () => {
    expectRejected(() => assertWithinScope('wiki/a/../../etc/x.md', WIKI), 'parent-traversal');
  });

  it('rejects a bare `..`', () => {
    expectRejected(() => assertWithinScope('..', WIKI), 'parent-traversal');
  });

  it('rejects a POSIX absolute path', () => {
    expectRejected(() => assertWithinScope('/etc/passwd', WIKI), 'absolute-path');
  });

  it('rejects an absolute path that would otherwise be in scope', () => {
    expectRejected(() => assertWithinScope('/wiki/page.md', WIKI), 'absolute-path');
  });

  it('rejects a Windows drive-letter path', () => {
    expectRejected(() => assertWithinScope('C:/Users/me/x.md', WIKI), 'absolute-path');
  });

  it('rejects a home-relative path', () => {
    expectRejected(() => assertWithinScope('~/x.md', WIKI), 'absolute-path');
  });

  it('rejects a NUL byte', () => {
    expectRejected(() => assertWithinScope('wiki/page\u0000.md', WIKI), 'nul-byte');
  });

  it('rejects a backslash (never a vault path separator)', () => {
    expectRejected(() => assertWithinScope('wiki\\page.md', WIKI), 'backslash');
  });

  it('rejects an empty path', () => {
    expectRejected(() => assertWithinScope('', WIKI), 'empty-path');
  });

  it('rejects a whitespace-only path', () => {
    expectRejected(() => assertWithinScope('   ', WIKI), 'empty-path');
  });

  it('rejects a path that normalises away to nothing', () => {
    expectRejected(() => assertWithinScope('./', WIKI), 'empty-path');
  });
});

describe('assertWithinScope — folder containment', () => {
  it('accepts a file directly inside the wiki folder', () => {
    expect(assertWithinScope('wiki/x.md', WIKI)).toBe('wiki/x.md');
  });

  it('accepts a nested file inside the wiki folder', () => {
    expect(assertWithinScope('wiki/entities/a/b.md', WIKI)).toBe('wiki/entities/a/b.md');
  });

  it('accepts the wiki folder itself (createFolder target)', () => {
    expect(assertWithinScope('wiki', WIKI)).toBe('wiki');
  });

  it('denies a sibling folder that shares the wiki folder as a name prefix', () => {
    expectRejected(() => assertWithinScope('wiki-backup/x.md', WIKI), 'out-of-scope');
  });

  it('denies a file sitting next to the wiki folder with the same stem', () => {
    expectRejected(() => assertWithinScope('wiki.md', WIKI), 'out-of-scope');
  });

  it('denies an unrelated vault path', () => {
    expectRejected(() => assertWithinScope('Inbox/note.md', WIKI), 'out-of-scope');
  });

  it('collapses redundant separators and `.` segments before matching', () => {
    expect(assertWithinScope('wiki//entities/./x.md', WIKI)).toBe('wiki/entities/x.md');
  });

  it('strips a trailing slash from a folder target', () => {
    expect(assertWithinScope('wiki/entities/', WIKI)).toBe('wiki/entities');
  });

  it('tolerates a trailing slash on the configured folder', () => {
    expect(assertWithinScope('wiki/x.md', { wikiFolder: 'wiki/' })).toBe('wiki/x.md');
  });
});

describe('assertWithinScope — schema folder', () => {
  it('accepts the derived `<wikiFolder>/schema` subtree', () => {
    expect(assertWithinScope('wiki/schema/config.md', WIKI)).toBe('wiki/schema/config.md');
  });

  it('accepts an explicitly configured schema folder outside the wiki folder', () => {
    const scope: VaultWriteScope = { wikiFolder: 'wiki', schemaFolder: 'meta/schema' };
    expect(assertWithinScope('meta/schema/config.md', scope)).toBe('meta/schema/config.md');
  });

  it('still denies a sibling of an explicit schema folder', () => {
    const scope: VaultWriteScope = { wikiFolder: 'wiki', schemaFolder: 'meta/schema' };
    expectRejected(() => assertWithinScope('meta/schema-old/config.md', scope), 'out-of-scope');
  });
});

describe('assertWithinScope — plugin config dir', () => {
  const scope: VaultWriteScope = {
    wikiFolder: 'wiki',
    pluginConfigDir: '.obsidian/plugins/karpathywiki',
  };

  it('accepts the plugin cache directory', () => {
    expect(assertWithinScope('.obsidian/plugins/karpathywiki/pdf-cache/a.json', scope))
      .toBe('.obsidian/plugins/karpathywiki/pdf-cache/a.json');
  });

  it('denies another plugin s directory', () => {
    expectRejected(
      () => assertWithinScope('.obsidian/plugins/other-plugin/data.json', scope),
      'out-of-scope'
    );
  });

  it('denies the Obsidian config root itself', () => {
    expectRejected(() => assertWithinScope('.obsidian/app.json', scope), 'out-of-scope');
  });

  it('pluginConfigDirFor builds `<configDir>/plugins/<id>`', () => {
    expect(pluginConfigDirFor('.obsidian')).toBe('.obsidian/plugins/karpathywiki');
    expect(pluginConfigDirFor('.config-vault', 'other')).toBe('.config-vault/plugins/other');
  });
});

describe('assertWithinScope — extra folders', () => {
  it('accepts an explicitly listed extra root', () => {
    const scope: VaultWriteScope = { wikiFolder: 'wiki', extraFolders: ['Papers'] };
    expect(assertWithinScope('Papers/a.pdf.md', scope)).toBe('Papers/a.pdf.md');
  });

  it('does not widen beyond the listed root', () => {
    const scope: VaultWriteScope = { wikiFolder: 'wiki', extraFolders: ['Papers'] };
    expectRejected(() => assertWithinScope('Papers-old/a.md', scope), 'out-of-scope');
  });
});

describe('assertWithinScope — vault root as the wiki folder', () => {
  // Documented behaviour: configuring the vault root as the wiki folder means
  // the containment boundary IS the vault. Every vault-relative path is then
  // in scope — but the syntactic rules (traversal / absolute / NUL /
  // backslash), which are what actually stop a write from leaving the vault,
  // still apply. See the module docblock in `vault-writer.ts`.
  const rootScopes: Array<[string, VaultWriteScope]> = [
    ['empty string', { wikiFolder: '' }],
    ['single slash', { wikiFolder: '/' }],
  ];

  for (const [label, scope] of rootScopes) {
    it(`accepts any vault-relative path when wikiFolder is the vault root (${label})`, () => {
      expect(assertWithinScope('Inbox/note.md', scope)).toBe('Inbox/note.md');
      expect(assertWithinScope('a.md', scope)).toBe('a.md');
    });

    it(`still rejects traversal at the vault root (${label})`, () => {
      expectRejected(() => assertWithinScope('../outside.md', scope), 'parent-traversal');
    });

    it(`still rejects absolute paths at the vault root (${label})`, () => {
      expectRejected(() => assertWithinScope('/etc/passwd', scope), 'absolute-path');
    });

    it(`still rejects NUL bytes at the vault root (${label})`, () => {
      expectRejected(() => assertWithinScope('a\u0000.md', scope), 'nul-byte');
    });
  }

  it('a scope with no roots at all denies everything', () => {
    expectRejected(() => assertWithinScope('anything.md', {}), 'out-of-scope');
  });
});

describe('assertWithinScope — Unicode NFC/NFD folder names', () => {
  // macOS APFS hands back NFD filenames while JS string literals are NFC.
  // `wiki-engine.ts` already re-resolves files across that mismatch; the gate
  // must not deny a legitimate write just because the two forms differ.
  const nfc = 'wiki-caf\u00e9';        // é as U+00E9
  const nfd = 'wiki-cafe\u0301';       // e + U+0301

  it('accepts an NFD path against an NFC-configured folder', () => {
    expect(assertWithinScope(`${nfd}/x.md`, { wikiFolder: nfc })).toBe(`${nfd}/x.md`);
  });

  it('accepts an NFC path against an NFD-configured folder', () => {
    expect(assertWithinScope(`${nfc}/x.md`, { wikiFolder: nfd })).toBe(`${nfc}/x.md`);
  });

  it('returns the path in the caller s own Unicode form, not re-normalised', () => {
    // Rewriting NFD to NFC here would make the writer target a different file
    // than the caller resolved.
    expect(assertWithinScope(`${nfd}/x.md`, { wikiFolder: nfc })).not.toBe(`${nfc}/x.md`);
  });

  it('still denies a sibling prefix across normalisation forms', () => {
    expectRejected(() => assertWithinScope(`${nfd}-backup/x.md`, { wikiFolder: nfc }), 'out-of-scope');
  });
});

describe('scopeFromSettings', () => {
  it('derives the wiki folder, its schema subfolder and the plugin config dir', () => {
    const scope = scopeFromSettings({ wikiFolder: 'wiki' }, '.obsidian');
    expect(scope.wikiFolder).toBe('wiki');
    expect(scope.pluginConfigDir).toBe('.obsidian/plugins/karpathywiki');
    expect(assertWithinScope('wiki/schema/config.md', scope)).toBe('wiki/schema/config.md');
    expect(assertWithinScope('.obsidian/plugins/karpathywiki/pdf-cache/a.json', scope))
      .toBe('.obsidian/plugins/karpathywiki/pdf-cache/a.json');
    expectRejected(() => assertWithinScope('Inbox/n.md', scope), 'out-of-scope');
  });
});

describe('VaultWriter — forwards exactly once on allow', () => {
  it('create', async () => {
    const { writer, vault } = makeWriter();
    await writer.create('wiki/x.md', 'body');
    expect(vault.create).toHaveBeenCalledTimes(1);
    expect(vault.create).toHaveBeenCalledWith('wiki/x.md', 'body');
  });

  it('create forwards the normalised path, not the raw one', async () => {
    const { writer, vault } = makeWriter();
    await writer.create('wiki//entities/./x.md', 'body');
    expect(vault.create).toHaveBeenCalledWith('wiki/entities/x.md', 'body');
  });

  it('modify', async () => {
    const { writer, vault } = makeWriter();
    const file = { path: 'wiki/x.md' };
    await writer.modify(file, 'body');
    expect(vault.modify).toHaveBeenCalledTimes(1);
    expect(vault.modify).toHaveBeenCalledWith(file, 'body');
  });

  it('createFolder', async () => {
    const { writer, vault } = makeWriter();
    await writer.createFolder('wiki/entities');
    expect(vault.createFolder).toHaveBeenCalledTimes(1);
    expect(vault.createFolder).toHaveBeenCalledWith('wiki/entities');
  });

  it('delete', async () => {
    const { writer, vault } = makeWriter();
    const file = { path: 'wiki/x.md' };
    await writer.delete(file);
    expect(vault.delete).toHaveBeenCalledTimes(1);
  });

  it('trash', async () => {
    const { writer, fileManager } = makeWriter();
    const file = { path: 'wiki/x.md' };
    await writer.trash(file);
    expect(fileManager.trashFile).toHaveBeenCalledTimes(1);
    expect(fileManager.trashFile).toHaveBeenCalledWith(file);
  });

  it('adapterWrite', async () => {
    const { writer, vault } = makeWriter();
    await writer.adapterWrite('wiki/x.md', 'body');
    expect(vault.adapter.write).toHaveBeenCalledTimes(1);
    expect(vault.adapter.write).toHaveBeenCalledWith('wiki/x.md', 'body');
  });

  it('adapterWriteBinary', async () => {
    const { writer, vault } = makeWriter();
    const bytes = new ArrayBuffer(4);
    await writer.adapterWriteBinary('wiki/x.bin', bytes);
    expect(vault.adapter.writeBinary).toHaveBeenCalledTimes(1);
    expect(vault.adapter.writeBinary).toHaveBeenCalledWith('wiki/x.bin', bytes);
  });

  it('adapterMkdir', async () => {
    const { writer, vault } = makeWriter();
    await writer.adapterMkdir('wiki/sub');
    expect(vault.adapter.mkdir).toHaveBeenCalledTimes(1);
    expect(vault.adapter.mkdir).toHaveBeenCalledWith('wiki/sub');
  });

  it('adapterRemove', async () => {
    const { writer, vault } = makeWriter();
    await writer.adapterRemove('wiki/x.md');
    expect(vault.adapter.remove).toHaveBeenCalledTimes(1);
    expect(vault.adapter.remove).toHaveBeenCalledWith('wiki/x.md');
  });
});

describe('VaultWriter — never forwards on deny', () => {
  const outOfScope = 'wiki/../secrets.md';

  it('create', async () => {
    const { writer, vault } = makeWriter();
    await expect(writer.create(outOfScope, 'body')).rejects.toBeInstanceOf(VaultWriteScopeError);
    expect(vault.create).not.toHaveBeenCalled();
  });

  it('modify', async () => {
    const { writer, vault } = makeWriter();
    await expect(writer.modify({ path: outOfScope }, 'body')).rejects.toBeInstanceOf(VaultWriteScopeError);
    expect(vault.modify).not.toHaveBeenCalled();
  });

  it('createFolder', async () => {
    const { writer, vault } = makeWriter();
    await expect(writer.createFolder('../evil')).rejects.toBeInstanceOf(VaultWriteScopeError);
    expect(vault.createFolder).not.toHaveBeenCalled();
  });

  it('delete', async () => {
    const { writer, vault } = makeWriter();
    await expect(writer.delete({ path: '/etc/passwd' })).rejects.toBeInstanceOf(VaultWriteScopeError);
    expect(vault.delete).not.toHaveBeenCalled();
  });

  it('trash', async () => {
    const { writer, fileManager } = makeWriter();
    await expect(writer.trash({ path: 'Inbox/n.md' })).rejects.toBeInstanceOf(VaultWriteScopeError);
    expect(fileManager.trashFile).not.toHaveBeenCalled();
  });

  it('adapterWrite', async () => {
    const { writer, vault } = makeWriter();
    await expect(writer.adapterWrite('wiki\\x.md', 'body')).rejects.toBeInstanceOf(VaultWriteScopeError);
    expect(vault.adapter.write).not.toHaveBeenCalled();
  });

  it('adapterWriteBinary', async () => {
    const { writer, vault } = makeWriter();
    await expect(writer.adapterWriteBinary('C:/x.bin', new ArrayBuffer(1)))
      .rejects.toBeInstanceOf(VaultWriteScopeError);
    expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
  });

  it('adapterMkdir', async () => {
    const { writer, vault } = makeWriter();
    await expect(writer.adapterMkdir('wiki-backup')).rejects.toBeInstanceOf(VaultWriteScopeError);
    expect(vault.adapter.mkdir).not.toHaveBeenCalled();
  });

  it('adapterRemove', async () => {
    const { writer, vault } = makeWriter();
    await expect(writer.adapterRemove('wiki/x\u0000.md')).rejects.toBeInstanceOf(VaultWriteScopeError);
    expect(vault.adapter.remove).not.toHaveBeenCalled();
  });
});

describe('VaultWriter — construction', () => {
  it('reads the scope at call time when given a getter', async () => {
    const vault = makeFakeVault();
    const settings = { wikiFolder: 'wiki' };
    const writer = new VaultWriter({ vault, scope: () => ({ wikiFolder: settings.wikiFolder }) });

    await writer.create('wiki/a.md', 'x');
    settings.wikiFolder = 'notes';
    await expect(writer.create('wiki/b.md', 'x')).rejects.toBeInstanceOf(VaultWriteScopeError);
    await writer.create('notes/b.md', 'x');
    expect(vault.create).toHaveBeenCalledTimes(2);
  });

  it('`scoped()` widens by exactly one explicitly named root', async () => {
    const { writer, vault } = makeWriter();
    await expect(writer.create('Papers/a.pdf.md', 'x')).rejects.toBeInstanceOf(VaultWriteScopeError);

    const widened = writer.scoped('Papers');
    await widened.create('Papers/a.pdf.md', 'x');
    expect(vault.create).toHaveBeenCalledTimes(1);

    // Widening does not relax the syntactic rules, nor leak to the original.
    await expect(widened.create('Papers/../etc.md', 'x')).rejects.toBeInstanceOf(VaultWriteScopeError);
    await expect(writer.create('Papers/b.md', 'x')).rejects.toBeInstanceOf(VaultWriteScopeError);
    expect(vault.create).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when the needed capability was not supplied', async () => {
    const writer = new VaultWriter({ scope: WIKI });
    await expect(writer.create('wiki/a.md', 'x')).rejects.toThrow(/vault/i);
  });

  it('accepts a bare adapter with no vault (disk-cache shape)', async () => {
    const adapter = {
      write: vi.fn(async () => undefined),
      writeBinary: vi.fn(async () => undefined),
      mkdir: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const writer = new VaultWriter({ adapter, scope: { extraFolders: ['.obsidian/plugins/karpathywiki/pdf-cache'] } });
    await writer.adapterWrite('.obsidian/plugins/karpathywiki/pdf-cache/a.json', '{}');
    expect(adapter.write).toHaveBeenCalledTimes(1);
    await expect(writer.adapterWrite('.obsidian/plugins/karpathywiki/data.json', '{}'))
      .rejects.toBeInstanceOf(VaultWriteScopeError);
    expect(adapter.write).toHaveBeenCalledTimes(1);
  });
});

describe('VaultWriteScopeError', () => {
  it('carries the operation, path and reason, and is an Error', () => {
    const err = expectRejected(() => assertWithinScope('wiki-backup/x.md', WIKI, 'adapterWrite'), 'out-of-scope');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('VaultWriteScopeError');
    expect(err.operation).toBe('adapterWrite');
    expect(err.path).toBe('wiki-backup/x.md');
    expect(err.message).toContain('wiki-backup/x.md');
    expect(err.message).toContain('vault-writer.ts');
  });
});
