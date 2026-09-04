// Phase 5 (security finding F-08) — the filesystem write-gate.
//
// Before this module every vault write went straight to the Obsidian API:
// `vault.create`, `vault.modify`, `vault.createFolder`, `vault.delete`,
// `vault.adapter.write/mkdir/remove` and `fileManager.trashFile`, spread over
// a dozen files. Path *construction* was safe by convention (`slugify` strips
// `/ \ .` and control characters — `core/slug.ts`), but nothing asserted that
// the final path was inside a folder the user had configured. That is
// "correct by construction, not correct by contract": one new call site that
// interpolates a model-supplied string is enough to break it, and prompt
// injection in an ingested document is a live way to supply such a string.
//
// `VaultWriter` is the single enforcement point. Every write in `src/` goes
// through it, and an ESLint `no-restricted-syntax` rule (see
// `eslint.config.mjs`) rejects any new direct call so the property cannot
// quietly regress.
//
// ── The two halves of the check ──────────────────────────────────────────
//
// 1. Syntactic rules, applied to the raw caller-supplied string. These are
//    what actually stop a write from leaving the vault:
//      * NUL byte            — truncation tricks against the host filesystem
//      * backslash           — never a vault separator; a Windows-shaped path
//      * absolute path       — leading `/`, leading `~`, or a drive letter
//      * `..` segment        — traversal, checked after `.`/`//` collapsing
//    A path is then collapsed (`//`, `.`, trailing slash) in BOTH of the two
//    forms that can reach the filesystem, and both must land inside the same
//    configured root:
//      * the caller's own string — what this function returns, and therefore
//        what actually gets written;
//      * `normalizePath(raw)` — what Obsidian's vault API may resolve to
//        internally. The real implementation also NFC-normalises and rewrites
//        non-breaking spaces, so it is NOT the identity function it is stubbed
//        as in tests, and it is not documented as a security boundary. Neither
//        form is trusted alone: a path only Obsidian's rewrite would pull into
//        scope is refused, and so is one only the raw form would.
//
// 2. Folder containment, via `isAtOrInFolderScope` from `folder-scope.ts` —
//    the same primitive the ingest-source pickers use, so "inside a folder"
//    means one thing in this codebase. It anchors on a trailing slash, which
//    is what makes `wiki-backup/x.md` NOT a member of `wiki/`.
//
// ── The vault root ───────────────────────────────────────────────────────
//
// A `wikiFolder` of `''` or `'/'` names the vault root. Documented, deliberate
// behaviour: the containment boundary is then the vault itself, so every
// vault-relative path is in scope. The syntactic rules above still apply, and
// they are the half that keeps a write inside the vault at all. A scope with
// no roots configured at all (`{}`) denies everything — "unconfigured" must
// not read as "unrestricted".
//
// ── Unicode ──────────────────────────────────────────────────────────────
//
// macOS APFS returns NFD filenames while JavaScript literals are NFC;
// `wiki-engine.ts` already re-resolves files across that mismatch. Containment
// is therefore compared in NFC on both sides, but the path handed back to the
// caller keeps its original form — re-normalising it here would silently
// retarget the write at a different file than the caller resolved. That is
// also why the returned path is built from the caller's string rather than
// from `normalizePath`'s output, which NFC-folds it.
//
// ── Case ─────────────────────────────────────────────────────────────────
//
// Containment is compared CASE-SENSITIVELY, after the NFC fold. `Wiki/x.md`
// is therefore out of scope when `wikiFolder` is `wiki`, on every platform.
// That is the deliberate choice: Obsidian's own path index is case-sensitive
// (`getAbstractFileByPath('Wiki/x')` does not find `wiki/x`), so a
// case-folding gate would be *more* permissive than the API it guards —
// on a case-insensitive macOS volume `Wiki/` and `wiki/` are the same
// directory, and case-folding here would additionally admit `WIKI-BACKUP/`
// style near-misses that no configured root names. A mismatched case is a
// caller bug, and the gate reports it as one instead of guessing.
//
// ── Absolute-looking paths and a vault-root `wikiFolder` ─────────────────
//
// A leading `/` is refused (`absolute-path`) even though Obsidian's own
// `normalizePath` would strip it. Consequence, pinned by test: configuring
// `wikiFolder` as the vault root makes the callers that build
// `` `${wikiFolder}/schema` `` produce `/schema`, which this gate refuses.
// A root `wikiFolder` is therefore not a supported configuration — the
// setting names a folder. The root *scope* below still exists because
// `folder-scope.ts` models it, and because refusing every path is the wrong
// answer for a scope that deliberately names the whole vault.

import { normalizePath } from 'obsidian';
import { isAtOrInFolderScope } from './folder-scope';

/**
 * Fallback plugin id, used only when no caller supplies one.
 *
 * The real id is `manifest.id`, which `main.ts` passes to `createVaultWriter`
 * (`this.manifest.id`) — Phase 7 changes it to `karpathywiki-hardened`, and
 * the config-dir root has to follow it rather than be pinned to a literal.
 * This constant is what the default-constructed writers inside
 * `wiki-engine` / `schema-manager` / `auto-maintain` fall back to; those are
 * only reached from tests and non-plugin hosts, which have no manifest.
 */
export const DEFAULT_PLUGIN_ID = 'karpathywiki';

export type VaultWriteRejectReason =
  | 'empty-path'
  | 'nul-byte'
  | 'backslash'
  | 'absolute-path'
  | 'parent-traversal'
  | 'out-of-scope';

const REASON_TEXT: Record<VaultWriteRejectReason, string> = {
  'empty-path': 'path is empty',
  'nul-byte': 'path contains a NUL byte',
  'backslash': 'path contains a backslash',
  'absolute-path': 'path is absolute (vault paths are relative)',
  'parent-traversal': 'path contains a `..` segment',
  'out-of-scope': 'path is outside every configured write folder',
};

/** Thrown instead of performing a write the scope does not permit. */
export class VaultWriteScopeError extends Error {
  readonly operation: string;
  readonly path: string;
  readonly reason: VaultWriteRejectReason;

  constructor(operation: string, path: string, reason: VaultWriteRejectReason) {
    super(
      `Refusing ${operation}("${path}"): ${REASON_TEXT[reason]}. ` +
        'Vault writes are gated by src/core/vault-writer.ts — widen the write ' +
        'scope explicitly if this target is legitimate.'
    );
    this.name = 'VaultWriteScopeError';
    this.operation = operation;
    this.path = path;
    this.reason = reason;
  }
}

/**
 * The folders a writer may write into. Every field is optional so a test can
 * build the narrowest scope it needs; a scope with no roots denies everything.
 */
export interface VaultWriteScope {
  /** Root of generated wiki content (`settings.wikiFolder`). */
  wikiFolder?: string;
  /** Schema folder. Defaults to `<wikiFolder>/schema`, which is where the
   *  plugin actually keeps `config.md` / `suggestions.md` and their backups. */
  schemaFolder?: string;
  /** The plugin's own config directory — `data.json`, the PDF cache. */
  pluginConfigDir?: string;
  /** Further roots the caller names explicitly (see `VaultWriter.scoped`). */
  extraFolders?: readonly string[];
}

/** `<configDir>/plugins/<pluginId>` — where `data.json` and the caches live. */
export function pluginConfigDirFor(
  configDir: string,
  pluginId: string = DEFAULT_PLUGIN_ID
): string {
  return `${configDir}/plugins/${pluginId}`;
}

/** The production scope: the wiki folder, its schema subtree, the plugin dir. */
export function scopeFromSettings(
  settings: { wikiFolder: string },
  configDir: string,
  pluginId: string = DEFAULT_PLUGIN_ID
): VaultWriteScope {
  return {
    wikiFolder: settings.wikiFolder,
    pluginConfigDir: pluginConfigDirFor(configDir, pluginId),
  };
}

/** True when a configured root names the vault root rather than a subfolder. */
function isVaultRoot(folder: string): boolean {
  return folder.replace(/\/+/g, '').length === 0;
}

/** Every root a scope permits, in declaration order. */
function scopeRoots(scope: VaultWriteScope): string[] {
  const roots: string[] = [];
  if (scope.wikiFolder !== undefined) roots.push(scope.wikiFolder);
  if (scope.schemaFolder !== undefined) {
    roots.push(scope.schemaFolder);
  } else if (scope.wikiFolder !== undefined && !isVaultRoot(scope.wikiFolder)) {
    // The schema folder is a subtree of the wiki folder in the shipped
    // layout, so this adds nothing there — it is listed so an explicitly
    // relocated schema folder is a one-field change, not a code change.
    roots.push(`${scope.wikiFolder.replace(/\/+$/, '')}/schema`);
  }
  if (scope.pluginConfigDir !== undefined) roots.push(scope.pluginConfigDir);
  if (scope.extraFolders) {
    // An extra root that names the vault root would turn the gate off for
    // every path — `VaultWriter.scoped()` rejects that outright, and the
    // constructor path must not be the way around it. Dropping it leaves a
    // scope built ONLY from such an entry with no roots at all, which denies
    // everything: "unconfigured" must not read as "unrestricted".
    roots.push(...scope.extraFolders.filter(folder => !isVaultRoot(folder)));
  }
  return roots;
}

/**
 * Collapse `//`, `.` and trailing-slash noise into a clean relative path,
 * rejecting any `..` segment on the way. `rawPath` is carried through only so
 * a rejection names the string the caller actually passed.
 */
function collapseSegments(path: string, rawPath: string, operation: string): string {
  const kept: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw new VaultWriteScopeError(operation, rawPath, 'parent-traversal');
    }
    kept.push(segment);
  }
  const collapsed = kept.join('/');
  if (collapsed.length === 0) {
    throw new VaultWriteScopeError(operation, rawPath, 'empty-path');
  }
  return collapsed;
}

/**
 * Validate `rawPath` against `scope` and return the normalised path to write.
 * Throws `VaultWriteScopeError` — never returns a rejected path.
 *
 * Cost is O(path length): a handful of scans plus one prefix comparison per
 * configured root (at most four in production).
 */
export function assertWithinScope(
  rawPath: string,
  scope: VaultWriteScope,
  operation = 'write'
): string {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new VaultWriteScopeError(operation, String(rawPath), 'empty-path');
  }
  if (rawPath.includes('\u0000')) {
    throw new VaultWriteScopeError(operation, rawPath, 'nul-byte');
  }
  if (rawPath.includes('\\')) {
    throw new VaultWriteScopeError(operation, rawPath, 'backslash');
  }
  if (/^[/~]/.test(rawPath) || /^[A-Za-z]:/.test(rawPath)) {
    throw new VaultWriteScopeError(operation, rawPath, 'absolute-path');
  }

  // Collapse `//`, `.` and a trailing slash — our own pass, so `..` detection
  // cannot be fooled by any of them regardless of what `normalizePath` does.
  // Done twice: once over the caller's string (`target` — the value returned,
  // and therefore the path that is written) and once over `normalizePath`'s
  // output (`resolved` — what the vault API may resolve to internally).
  const target = collapseSegments(rawPath, rawPath, operation);
  const resolved = collapseSegments(normalizePath(rawPath), rawPath, operation);

  // Both forms must be inside the SAME root, each compared against that root
  // under the same transformation and in NFC. Requiring both is what keeps
  // `normalizePath` out of the trust boundary in either direction: it can
  // neither pull an out-of-scope path in nor push an in-scope one out.
  for (const root of scopeRoots(scope)) {
    if (isVaultRoot(root)) return target;
    const inRawRoot = isAtOrInFolderScope(
      target.normalize('NFC'),
      root.normalize('NFC'),
      false
    );
    const inResolvedRoot = isAtOrInFolderScope(
      resolved.normalize('NFC'),
      normalizePath(root).normalize('NFC'),
      false
    );
    if (inRawRoot && inResolvedRoot) return target;
  }
  throw new VaultWriteScopeError(operation, rawPath, 'out-of-scope');
}

/** The `.path`-bearing shape the file-taking write APIs need. */
export interface VaultWriterFile {
  path: string;
}

/** The subset of Obsidian's `DataAdapter` that writes. */
export interface VaultWriteAdapter {
  write(path: string, data: string, options?: unknown): Promise<void>;
  writeBinary(path: string, data: ArrayBuffer, options?: unknown): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/**
 * The read-modify-write callback `Vault.process` takes. Synchronous, like
 * Obsidian's own signature — the whole point of `process` over `modify` is
 * that the read and the write are one atomic step.
 */
export type VaultProcessFn = (data: string) => string;

/** The subset of Obsidian's `Vault` that writes. */
export interface VaultWriteVault {
  adapter: VaultWriteAdapter;
  create(path: string, data: string): Promise<VaultWriterFile>;
  modify(file: VaultWriterFile, data: string): Promise<void>;
  process(file: VaultWriterFile, fn: VaultProcessFn): Promise<string>;
  createFolder(path: string): Promise<unknown>;
  delete(file: VaultWriterFile, force?: boolean): Promise<void>;
}

/** The subset of Obsidian's `FileManager` that writes. */
export interface VaultWriteFileManager {
  trashFile(file: VaultWriterFile): Promise<void>;
  renameFile(file: VaultWriterFile, newPath: string): Promise<void>;
}

export interface VaultWriterOptions {
  /** The vault to write through. Optional so a caller that only holds a
   *  `DataAdapter` (the on-disk caches) can still be gated. */
  vault?: Partial<VaultWriteVault>;
  /** Defaults to `vault.adapter`. */
  adapter?: Partial<VaultWriteAdapter>;
  fileManager?: Partial<VaultWriteFileManager>;
  /** A scope object, or a getter read fresh on every call so a settings
   *  change (a new `wikiFolder`) takes effect without reconstruction. */
  scope: VaultWriteScope | (() => VaultWriteScope);
}

function missing(capability: string, operation: string): Error {
  return new Error(
    `VaultWriter.${operation} requires a ${capability}, but none was supplied at construction.`
  );
}

/**
 * The single gate every vault write in `src/` passes through.
 *
 * Constructing one needs nothing but a write target and a plain scope object,
 * so a test can drive it with a handful of spies — it deliberately does not
 * depend on the plugin, its settings type, or the Obsidian `App`.
 */
export class VaultWriter {
  private readonly vault?: Partial<VaultWriteVault>;
  private readonly adapter?: Partial<VaultWriteAdapter>;
  private readonly fileManager?: Partial<VaultWriteFileManager>;
  private readonly getScope: () => VaultWriteScope;

  constructor(opts: VaultWriterOptions) {
    this.vault = opts.vault;
    this.adapter = opts.adapter ?? opts.vault?.adapter;
    this.fileManager = opts.fileManager;
    this.getScope = typeof opts.scope === 'function' ? opts.scope : () => opts.scope as VaultWriteScope;
  }

  /** The scope in force right now. */
  get scope(): VaultWriteScope {
    return this.getScope();
  }

  /**
   * A writer over the same target with one additional explicitly-named root.
   *
   * The one production user is the opt-in PDF markdown sidecar, which lands
   * next to the source document the user themselves chose to ingest — a
   * legitimate target that is not under `wikiFolder`. Widening is per-call and
   * by name; it never relaxes the syntactic rules and never mutates this
   * writer's own scope.
   */
  scoped(extraFolder: string): VaultWriter {
    // Widening by the vault root would turn the gate off silently — every
    // path is inside the root — so an empty or slash-only widening is a
    // programming error, not a permissive default.
    if (typeof extraFolder !== 'string' || extraFolder.trim().length === 0 || isVaultRoot(extraFolder)) {
      throw new VaultWriteScopeError('scoped', String(extraFolder), 'empty-path');
    }
    return new VaultWriter({
      vault: this.vault,
      adapter: this.adapter,
      fileManager: this.fileManager,
      scope: () => {
        const base = this.getScope();
        return { ...base, extraFolders: [...(base.extraFolders ?? []), extraFolder] };
      },
    });
  }

  /** Validate `path` against the current scope; returns the path to write. */
  assertWithinScope(path: string, operation = 'write'): string {
    return assertWithinScope(path, this.getScope(), operation);
  }

  async create(path: string, data: string): Promise<VaultWriterFile> {
    const target = this.assertWithinScope(path, 'create');
    if (!this.vault?.create) throw missing('vault', 'create');
    return this.vault.create(target, data);
  }

  async modify(file: VaultWriterFile, data: string): Promise<void> {
    this.assertWithinScope(file?.path, 'modify');
    if (!this.vault?.modify) throw missing('vault', 'modify');
    await this.vault.modify(file, data);
  }

  /**
   * Obsidian's atomic read-modify-write. It is `modify` with the read folded
   * in, not a read: `createOrUpdateFile` updates every existing page through
   * it, so leaving it out of the gate would have left the plugin's primary
   * write path — the one that takes a model-influenced path — ungated for
   * every file that already exists.
   */
  async process(file: VaultWriterFile, fn: VaultProcessFn): Promise<string> {
    this.assertWithinScope(file?.path, 'process');
    if (!this.vault?.process) throw missing('vault', 'process');
    return this.vault.process(file, fn);
  }

  /**
   * Obsidian's link-safe move. BOTH ends are asserted: the source, because a
   * rename is a delete of that path, and the destination, because it is where
   * the bytes end up.
   */
  async rename(file: VaultWriterFile, newPath: string): Promise<void> {
    this.assertWithinScope(file?.path, 'rename');
    const target = this.assertWithinScope(newPath, 'rename');
    if (!this.fileManager?.renameFile) throw missing('fileManager', 'rename');
    await this.fileManager.renameFile(file, target);
  }

  /**
   * Whether this writer can perform a link-safe rename at all.
   *
   * `path-resolution.ts` has a documented fallback for a host that offers no
   * link-safe rename (it marks the classification conflict instead of moving
   * the page). That branch has to be decidable without attempting the write,
   * so the capability is exposed rather than discovered by catching.
   */
  get canRename(): boolean {
    return typeof this.fileManager?.renameFile === 'function';
  }

  async createFolder(path: string): Promise<unknown> {
    const target = this.assertWithinScope(path, 'createFolder');
    if (!this.vault?.createFolder) throw missing('vault', 'createFolder');
    return this.vault.createFolder(target);
  }

  async delete(file: VaultWriterFile, force?: boolean): Promise<void> {
    this.assertWithinScope(file?.path, 'delete');
    if (!this.vault?.delete) throw missing('vault', 'delete');
    await this.vault.delete(file, force);
  }

  /** Obsidian's recoverable delete — moves the file to the configured trash. */
  async trash(file: VaultWriterFile): Promise<void> {
    this.assertWithinScope(file?.path, 'trash');
    if (!this.fileManager?.trashFile) throw missing('fileManager', 'trash');
    await this.fileManager.trashFile(file);
  }

  async adapterWrite(path: string, data: string, options?: unknown): Promise<void> {
    const target = this.assertWithinScope(path, 'adapterWrite');
    if (!this.adapter?.write) throw missing('vault adapter', 'adapterWrite');
    await (options === undefined
      ? this.adapter.write(target, data)
      : this.adapter.write(target, data, options));
  }

  async adapterWriteBinary(path: string, data: ArrayBuffer, options?: unknown): Promise<void> {
    const target = this.assertWithinScope(path, 'adapterWriteBinary');
    if (!this.adapter?.writeBinary) throw missing('vault adapter', 'adapterWriteBinary');
    await (options === undefined
      ? this.adapter.writeBinary(target, data)
      : this.adapter.writeBinary(target, data, options));
  }

  async adapterMkdir(path: string): Promise<void> {
    const target = this.assertWithinScope(path, 'adapterMkdir');
    if (!this.adapter?.mkdir) throw missing('vault adapter', 'adapterMkdir');
    await this.adapter.mkdir(target);
  }

  async adapterRemove(path: string): Promise<void> {
    const target = this.assertWithinScope(path, 'adapterRemove');
    if (!this.adapter?.remove) throw missing('vault adapter', 'adapterRemove');
    await this.adapter.remove(target);
  }
}

/** The shape `createVaultWriter` needs — satisfied by Obsidian's `App`. */
export interface VaultWriterHost {
  vault: Partial<VaultWriteVault> & { configDir: string };
  fileManager?: Partial<VaultWriteFileManager>;
}

/**
 * The production writer: scoped to the configured wiki folder, its schema
 * subtree, and the plugin's own config directory. `settings` is read on every
 * call, so changing `wikiFolder` in settings re-scopes the gate immediately.
 */
export function createVaultWriter(
  app: VaultWriterHost,
  settings: { wikiFolder: string },
  /** `this.manifest.id` from `main.ts`. Defaults to `DEFAULT_PLUGIN_ID` for
   *  the non-plugin hosts (tests, CLI) that have no manifest to read. */
  pluginId: string = DEFAULT_PLUGIN_ID
): VaultWriter {
  return new VaultWriter({
    vault: app.vault,
    fileManager: app.fileManager,
    scope: () => scopeFromSettings(settings, app.vault.configDir, pluginId),
  });
}
