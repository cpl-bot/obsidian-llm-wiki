// Phase 5 (F-08) — `createOrUpdateFile` is gated on BOTH branches.
//
// `createOrUpdateFile` is the plugin's primary write path and the one that
// takes a model-influenced path: every generated page, every merge, every
// lint fix lands through it. It has two branches, and only one of them was
// ever a `vault.create`:
//
//   * the file does not exist  → `vault.create`  (gated from the start)
//   * the file already exists  → `vault.process` (Obsidian's atomic
//     read-modify-write — `modify` with the read folded in)
//
// Leaving `process` out of the gate would have meant the gate only applied
// to paths that named a file nobody had created yet: a prompt-injected
// document that steered a page path at an EXISTING note anywhere in the
// vault would have overwritten it, gate and all. These tests pin both
// branches, and pin that a legitimate in-scope update still works.

import { describe, it, expect } from 'vitest';
import { createWikiEngineHarness } from '../__support__/wiki-engine-harness';
import { VaultWriteScopeError } from '../../core/vault-writer';

describe('WikiEngine.createOrUpdateFile — the write gate covers both branches', () => {
  it('refuses to UPDATE an existing file outside the wiki folder, and leaves it intact', async () => {
    const victim = 'Notizen/Privat.md';
    const h = createWikiEngineHarness({ files: { [victim]: 'my own note\n' } });

    await expect(h.engine.createOrUpdateFile(victim, 'overwritten by the model'))
      .rejects.toBeInstanceOf(VaultWriteScopeError);

    expect(h.files.get(victim)).toBe('my own note\n');
    expect(h.writtenPaths).not.toContain(victim);
  });

  it('refuses to CREATE a file outside the wiki folder', async () => {
    const h = createWikiEngineHarness();

    await expect(h.engine.createOrUpdateFile('Notizen/New.md', 'body'))
      .rejects.toBeInstanceOf(VaultWriteScopeError);

    expect(h.files.has('Notizen/New.md')).toBe(false);
  });

  it('refuses a traversal target even when the resolved file exists', async () => {
    const h = createWikiEngineHarness({ files: { 'wiki/entities/A.md': 'a' } });

    await expect(h.engine.createOrUpdateFile('wiki/entities/../../Notizen/A.md', 'x'))
      .rejects.toBeInstanceOf(VaultWriteScopeError);
  });

  it('still updates an existing page inside the wiki folder (behaviour preserved)', async () => {
    const page = 'wiki/entities/Karpathy.md';
    const h = createWikiEngineHarness({ files: { [page]: 'old body\n' } });

    await h.engine.createOrUpdateFile(page, 'new body\n');

    expect(h.files.get(page)).toBe('new body\n');
    expect(h.writtenPaths).toContain(page);
  });

  it('still creates a new page inside the wiki folder (behaviour preserved)', async () => {
    const h = createWikiEngineHarness();

    await h.engine.createOrUpdateFile('wiki/concepts/RAG.md', 'body\n');

    expect(h.files.get('wiki/concepts/RAG.md')).toBe('body\n');
  });
});
