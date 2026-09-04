// Phase 5 (F-08) — building the real write-gate for test fixtures.
//
// A fixture must not hand production code a *stub* `VaultWriter`: the gate is
// the thing under test at every migrated call site, and a stub whose
// `createFolder` resolves to `undefined` proves only that the call site
// compiles. Every helper here returns a real `VaultWriter` wired to the
// fixture's own in-memory vault, so:
//
//   * a write that the gate permits still lands in the fake vault, and the
//     existing assertions (`vault.read(...)`, `written.get(...)`, the
//     `adapter.write` spies) keep observing real writes;
//   * a path the gate would refuse in production — traversal, absolute,
//     sibling-prefix folder — is refused in the tests too, for free.
//
// The scope is deliberately the same shape production uses (`wikiFolder` plus
// the plugin config dir), read through a getter so a fixture that mutates
// `settings.wikiFolder` after construction re-scopes exactly like the real
// `createVaultWriter` does.

import { VaultWriter, pluginConfigDirFor, type VaultWriteScope } from '../../core/vault-writer';

/** The slice of a fake vault the gate needs to write through. */
export interface FakeVaultStore {
  read(path: string): string | null;
  write(path: string, content: string): void;
  remove?(path: string): void;
}

/** Adapts the plain `Map<path, content>` that most fixtures already hold. */
export function mapStore(files: Map<string, string>): FakeVaultStore {
  return {
    read: (path) => files.get(path) ?? null,
    write: (path, content) => { files.set(path, content); },
    remove: (path) => { files.delete(path); },
  };
}

/** The same, for the plain object literal the lint-phase fixtures hold. */
export function recordStore(files: Record<string, string>): FakeVaultStore {
  return {
    read: (path) => files[path] ?? null,
    write: (path, content) => { files[path] = content; },
    remove: (path) => { delete files[path]; },
  };
}

/** A real gate plus the side effects a fixture wants to assert on. */
export interface TestVaultWriterHandle {
  /** The gate itself — a genuine `VaultWriter`, not a stub. */
  writer: VaultWriter;
  /** Folder paths created through the gate, in call order. */
  folders: string[];
  /** Paths deleted or trashed through the gate, in call order. */
  removed: string[];
  /** `[from, to]` for every rename that passed the gate, in call order. */
  renamed: Array<[string, string]>;
}

/**
 * A `VaultWriter` that writes into `store`, scoped to `scope`.
 *
 * `scope` may be a getter, matching `VaultWriterOptions.scope`, so a fixture
 * can point it at a live settings object.
 */
export function createTestVaultWriter(
  store: FakeVaultStore,
  scope: VaultWriteScope | (() => VaultWriteScope),
): TestVaultWriterHandle {
  const folders: string[] = [];
  const removed: string[] = [];
  const renamed: Array<[string, string]> = [];
  const writeThrough = async (path: string, data: string): Promise<void> => {
    store.write(path, data);
  };
  const dropPath = async (path: string): Promise<void> => {
    removed.push(path);
    store.remove?.(path);
  };

  const writer = new VaultWriter({
    vault: {
      create: async (path, data) => { await writeThrough(path, data); return { path }; },
      modify: async (file, data) => { await writeThrough(file.path, data); },
      // Obsidian's atomic read-modify-write: the fixture must see the real
      // read, so a gated `process` observes the content the gate let through.
      process: async (file, fn) => {
        const next = fn(store.read(file.path) ?? '');
        store.write(file.path, next);
        return next;
      },
      createFolder: async (path) => { folders.push(path); return undefined; },
      delete: async (file) => { await dropPath(file.path); },
    },
    adapter: {
      write: async (path, data) => { await writeThrough(path, data); },
      writeBinary: async () => {},
      mkdir: async (path) => { folders.push(path); },
      remove: async (path) => { await dropPath(path); },
    },
    fileManager: {
      trashFile: async (file) => { await dropPath(file.path); },
      renameFile: async (file, newPath) => {
        renamed.push([file.path, newPath]);
        store.write(newPath, store.read(file.path) ?? '');
        store.remove?.(file.path);
      },
    },
    scope,
  });

  return { writer, folders, removed, renamed };
}

/**
 * The production-shaped scope for a fixture: its wiki folder, the schema
 * subtree the gate derives from it, and the plugin's own config directory.
 * Permissive enough that every legitimate fixture write lands, narrow enough
 * that traversal and sibling-prefix folders are still refused.
 */
export function testScopeFor(wikiFolder: string, configDir = '.obsidian'): VaultWriteScope {
  return { wikiFolder, pluginConfigDir: pluginConfigDirFor(configDir) };
}
