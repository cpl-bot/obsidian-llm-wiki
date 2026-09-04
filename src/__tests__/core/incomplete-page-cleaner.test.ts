// #170 — Incomplete-page cleaner.
// Pure logic for detecting and cleaning wiki pages whose `generation_complete`
// frontmatter flag is stuck at `false` (an interrupted or failed ingest).
// Pages WITHOUT the field are treated as legacy (preserved) to avoid wiping
// existing wikis on upgrade.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  findIncompletePages,
  isIncomplete,
  cleanIncompletePages,
} from '../../core/incomplete-page-cleaner';
import { VaultWriter, VaultWriteScopeError } from '../../core/vault-writer';

interface FakeFile {
  path: string;
  content: string;
}

function buildFakeVault(files: FakeFile[]) {
  const map = new Map<string, string>();
  for (const f of files) map.set(f.path, f.content);

  const trashed: string[] = [];
  return {
    vault: {
      getMarkdownFiles: () =>
        [...map.keys()].map(p => ({
          path: p,
          basename: p.split('/').pop()?.replace(/\.md$/, '') ?? p,
        })),
      read: async (f: { path: string }) => map.get(f.path) ?? '',
      getAbstractFileByPath: (p: string) =>
        map.has(p) ? ({ path: p, basename: p.split('/').pop() ?? p }) : null,
      trashFile: async (f: { path: string }) => {
        trashed.push(f.path);
      },
    },
    fileManager: {
      trashFile: async (f: { path: string }) => {
        trashed.push(f.path);
      },
    },
    trashed,
    deleted: [] as string[],
  };
}

/** Phase 5 (F-08): the cleaner trashes through the write-gate, so the tests
 *  drive it through a real `VaultWriter` scoped to the wiki folder. */
function writerFor(vault: ReturnType<typeof buildFakeVault>, wikiFolder = 'wiki'): VaultWriter {
  return new VaultWriter({ fileManager: vault.fileManager, scope: { wikiFolder } });
}

describe('isIncomplete (#170)', () => {
  it('returns true when frontmatter has generation_complete: false', () => {
    expect(isIncomplete('---\ngeneration_complete: false\n---\nbody')).toBe(true);
  });

  it('returns false when frontmatter has generation_complete: true', () => {
    expect(isIncomplete('---\ngeneration_complete: true\n---\nbody')).toBe(false);
  });

  it('returns false (legacy / preserve) when the field is missing entirely', () => {
    // Existing v1.20.x pages do NOT have this field — they MUST be preserved.
    expect(isIncomplete('---\ntype: entity\n---\nbody')).toBe(false);
    expect(isIncomplete('# No frontmatter at all')).toBe(false);
  });

  it('returns false for the literal string "false" inside body (only frontmatter counts)', () => {
    expect(isIncomplete('no frontmatter\nbody mentions generation_complete: false here')).toBe(false);
  });

  it('handles frontmatter where the field is on a later line', () => {
    expect(isIncomplete('---\ntype: entity\nauthor: x\ngeneration_complete: false\n---\nbody')).toBe(true);
  });
});

describe('findIncompletePages (#170)', () => {
  let vault: ReturnType<typeof buildFakeVault>;

  beforeEach(() => {
    vault = buildFakeVault([
      { path: 'wiki/entities/a.md', content: '---\ngeneration_complete: false\n---\npartial' },
      { path: 'wiki/entities/b.md', content: '---\ngeneration_complete: true\n---\ncomplete' },
      { path: 'wiki/entities/c.md', content: '---\ntype: entity\n---\nlegacy' },
      { path: 'wiki/concepts/d.md', content: '---\ngeneration_complete: false\n---\npartial' },
      { path: 'wiki/sources/e.md', content: '---\ngeneration_complete: true\n---\ncomplete' },
      { path: 'outside/folder.md', content: '---\ngeneration_complete: false\n---\npartial' },
    ]);
  });

  it('returns only files under wiki/{entities,concepts,sources} with the false flag', async () => {
    const found = await findIncompletePages(vault as never, 'wiki');
    const paths = found.map(f => f.path);
    expect(paths).toContain('wiki/entities/a.md');
    expect(paths).toContain('wiki/concepts/d.md');
    expect(paths).not.toContain('wiki/entities/b.md');
    expect(paths).not.toContain('wiki/entities/c.md'); // legacy preserved
    expect(paths).not.toContain('wiki/sources/e.md');
    expect(paths).not.toContain('outside/folder.md');
  });

  it('returns empty array when no incomplete pages exist', async () => {
    const cleanVault = buildFakeVault([
      { path: 'wiki/entities/a.md', content: '---\ngeneration_complete: true\n---\ncomplete' },
      { path: 'wiki/entities/b.md', content: '---\ntype: entity\n---\nlegacy' },
    ]);
    const found = await findIncompletePages(cleanVault as never, 'wiki');
    expect(found).toEqual([]);
  });
});

describe('cleanIncompletePages (#170)', () => {
  it('archives (trashes) pages by default', async () => {
    const vault = buildFakeVault([
      { path: 'wiki/entities/a.md', content: '---\ngeneration_complete: false\n---\n' },
    ]);
    const files = [{ path: 'wiki/entities/a.md', basename: 'a' } as never];

    const cleaned = await cleanIncompletePages(writerFor(vault), files);
    expect(cleaned).toBe(1);
    expect(vault.trashed).toContain('wiki/entities/a.md');
    expect(vault.deleted).toEqual([]);
  });

  it('returns 0 when given an empty list', async () => {
    const vault = buildFakeVault([]);
    const cleaned = await cleanIncompletePages(writerFor(vault), []);
    expect(cleaned).toBe(0);
  });

  it('Phase 5 (F-08): refuses to trash a page outside the wiki folder', async () => {
    // The scan is prefix-filtered, so this can only arise from a caller
    // handing over a file it did not scan for — exactly what the gate is for.
    const vault = buildFakeVault([{ path: 'Inbox/note.md', content: '' }]);
    const cleaned = await cleanIncompletePages(writerFor(vault), [
      { path: 'Inbox/note.md', basename: 'note' } as never,
    ]);
    expect(cleaned).toBe(0);
    expect(vault.trashed).toEqual([]);
  });

  it('Phase 5 (F-08): the gate rejects a traversal path with a typed error', async () => {
    const vault = buildFakeVault([]);
    await expect(writerFor(vault).trash({ path: 'wiki/../secrets.md' }))
      .rejects.toBeInstanceOf(VaultWriteScopeError);
    expect(vault.trashed).toEqual([]);
  });

  it('continues past individual failures and reports successful count', async () => {
    const vault = buildFakeVault([
      { path: 'wiki/entities/a.md', content: '' },
      { path: 'wiki/entities/b.md', content: '' },
    ]);
    // Make fileManager.trashFile throw for the first file only
    let callCount = 0;
    vault.fileManager.trashFile = async (f: { path: string }) => {
      callCount++;
      if (callCount === 1) throw new Error('boom');
      vault.trashed.push(f.path);
    };

    const cleaned = await cleanIncompletePages(writerFor(vault), [
      { path: 'wiki/entities/a.md', basename: 'a' } as never,
      { path: 'wiki/entities/b.md', basename: 'b' } as never,
    ]);
    expect(cleaned).toBe(1); // only b succeeded
    expect(vault.trashed).toContain('wiki/entities/b.md');
  });
});
