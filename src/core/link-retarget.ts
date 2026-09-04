// Issue #386 — retarget every link that points at a page before that page is
// deleted.
//
// `mergeDuplicatePages` merges a duplicate into its target and then deletes the
// duplicate. Every link still pointing at the deleted page is dead from that
// moment on, and the deletion is what makes it unfindable afterwards: no scan
// can report a reference to a file that no longer exists.
//
// The rewrite this replaces looked only inside the wiki folder, and searched
// only for the wiki-relative form (`[[entities/Foo]]`). Measured on a vault
// with 2824 wiki pages and 473 notes outside the wiki: of the links pointing
// from outside into the wiki, 1762 (across 340 notes) were written as a bare
// title `[[Foo]]` and none carried a folder prefix — the bare form is what
// Obsidian's own autocomplete inserts. Widening the radius without widening
// the link form would therefore have changed nothing at all.
//
// Two properties this module is built around:
//
//   * Resolve before replacing. A bare `[[Foo]]` is not evidence that this
//     page is meant: another note named `Foo` elsewhere in the vault owns that
//     link. Every candidate is resolved through the same resolver the app uses
//     (`getFirstLinkpathDest`, which is source-file relative), and only a link
//     that actually lands on the page being deleted is touched. Frontmatter
//     aliases are deliberately NOT consulted, because Obsidian's resolver does
//     not consult them either — a bare link matching only an alias does not
//     resolve today, and pretending otherwise here would rewrite links that
//     were never pointing at this page.
//
//   * Write surgically. Foreign notes are the user's own files. Replacements
//     are applied at the offsets the metadata cache reports, so nothing else
//     in the file is reformatted, and links inside code blocks are left alone
//     because the cache does not report them as links. This is also why the
//     write goes through `vault.process` rather than the wiki's own write gate
//     (`createOrUpdateFile`), which normalizes `sources:` frontmatter and
//     corrects link pollution on every write — appropriate for a generated
//     wiki page, not for someone's own note.
//
// The module is deliberately free of wiki vocabulary (no `wikiFolder`, no page
// types) so the same primitive serves a rename or a redirect feature later.

/** The subset of `TFile` this module needs. */
export interface RetargetFile {
  path: string;
}

/** The subset of `Reference` (link and embed cache entries) this module needs. */
export interface RetargetReference {
  /** Link destination as written, including any `#subpath`. */
  link: string;
  /** The reference exactly as it appears in the document, e.g. `[[a/b|c]]`. */
  original: string;
  position: { start: { offset: number }; end: { offset: number } };
}

/** The subset of `MetadataCache` this module needs. */
export interface RetargetMetadataCache {
  getFileCache(file: RetargetFile): {
    links?: RetargetReference[];
    embeds?: RetargetReference[];
  } | null;
  getFirstLinkpathDest(linkpath: string, sourcePath: string): RetargetFile | null;
}

/** The subset of `Vault` this module needs. */
export interface RetargetVault {
  getMarkdownFiles(): RetargetFile[];
  /**
   * Phase 5 (F-08): a PORT, not Obsidian's `Vault.process` — hence the
   * distinct name. Issue #386 makes this rewrite vault-wide on purpose (an
   * ordinary user note outside the wiki folder may link to the merged page),
   * so the caller supplies the gated write it wants; this module never
   * reaches for `app.vault` itself. See `merge-duplicates.ts` for the
   * production wiring and the scope it grants.
   */
  processFile(file: RetargetFile, fn: (data: string) => string): Promise<string>;
}

export interface RetargetDeps {
  vault: RetargetVault;
  metadataCache: RetargetMetadataCache;
}

export interface RetargetResult {
  /** Files whose content was rewritten. */
  filesChanged: number;
  /** Individual references rewritten. */
  linksRewritten: number;
  /**
   * References that resolved to the page but could not be rewritten because
   * the file on disk no longer matched the cached position. Non-zero means
   * those links are about to go dead — the caller should surface it.
   */
  stale: number;
}

/**
 * Every linkpath under which `filePath` is addressable, shortest first:
 * `Foo`, `entities/Foo`, `wiki/entities/Foo`. Which of them actually resolves
 * to this file depends on the linking file and is decided by the resolver.
 */
function addressableForms(filePath: string): string[] {
  const withoutExt = filePath.replace(/\.md$/, '');
  const segments = withoutExt.split('/');
  const forms: string[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    forms.push(segments.slice(i).join('/'));
  }
  return forms;
}

/**
 * Pick the linkpath to write for a link that lived in `fromFile` and pointed at
 * the page now being replaced by `toPath`.
 *
 * Preference order is *shape first*: a link written with two segments is
 * rewritten with two segments where that resolves. The wiki writes its own
 * internal links folder-prefixed and a user note writes bare titles; a rewrite
 * that silently converted between the two would be a second, unasked-for change
 * to the file. Only when the original's shape does not resolve does this fall
 * back to the shortest form that does, and finally to the full path, which
 * always resolves.
 */
function chooseLinkpath(
  metadataCache: RetargetMetadataCache,
  linkingFilePath: string,
  originalLinkpath: string,
  toPath: string
): string {
  const forms = addressableForms(toPath);
  const resolvesToTarget = (candidate: string): boolean =>
    metadataCache.getFirstLinkpathDest(candidate, linkingFilePath)?.path === toPath;

  const originalDepth = originalLinkpath.split('/').length;
  const sameShape = forms.find(f => f.split('/').length === originalDepth);
  if (sameShape && resolvesToTarget(sameShape)) return sameShape;

  const shortestResolving = forms.find(resolvesToTarget);
  if (shortestResolving) return shortestResolving;

  return forms[forms.length - 1];
}

/**
 * Rewrite every link in the vault that resolves to `fromPath` so it points at
 * `toPath` instead. Call this BEFORE deleting `fromPath` — resolution depends
 * on the file still existing.
 *
 * `fromPath` itself is skipped: its own links are about to disappear with it.
 */
export async function retargetLinksToPage(
  deps: RetargetDeps,
  fromPath: string,
  toPath: string
): Promise<RetargetResult> {
  const result: RetargetResult = { filesChanged: 0, linksRewritten: 0, stale: 0 };
  if (fromPath === toPath) return result;

  for (const file of deps.vault.getMarkdownFiles()) {
    if (file.path === fromPath) continue;

    const cache = deps.metadataCache.getFileCache(file);
    const references = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
    if (references.length === 0) continue;

    const edits: Array<{ start: number; end: number; original: string; replacement: string }> = [];
    for (const ref of references) {
      const hashIndex = ref.link.indexOf('#');
      const linkpath = hashIndex >= 0 ? ref.link.slice(0, hashIndex) : ref.link;
      const subpath = hashIndex >= 0 ? ref.link.slice(hashIndex) : '';
      // `[[#Heading]]` addresses the current file and has no linkpath.
      if (!linkpath) continue;

      const dest = deps.metadataCache.getFirstLinkpathDest(linkpath, file.path);
      if (!dest || dest.path !== fromPath) continue;

      const newLinkpath = chooseLinkpath(deps.metadataCache, file.path, linkpath, toPath);
      // Rebuild from `original` so display text (`|…`), the embed marker (`!`)
      // and the subpath survive verbatim; only the destination changes.
      const replacement = ref.original.replace(`[[${ref.link}`, `[[${newLinkpath}${subpath}`);
      if (replacement === ref.original) continue;

      edits.push({
        start: ref.position.start.offset,
        end: ref.position.end.offset,
        original: ref.original,
        replacement,
      });
    }
    if (edits.length === 0) continue;

    let applied = 0;
    let stale = 0;
    await deps.vault.processFile(file, data => {
      let next = data;
      // Descending, so an earlier edit's offsets stay valid.
      for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
        // The cache can lag the file. Splicing on a stale offset would corrupt
        // the note, so a position that no longer holds what the cache promised
        // is reported instead of guessed at.
        if (next.slice(edit.start, edit.end) !== edit.original) {
          stale++;
          continue;
        }
        next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
        applied++;
      }
      return next;
    });

    result.stale += stale;
    if (applied > 0) {
      result.filesChanged++;
      result.linksRewritten += applied;
    }
  }

  return result;
}
