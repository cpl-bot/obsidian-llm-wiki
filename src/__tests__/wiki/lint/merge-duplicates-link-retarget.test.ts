import { describe, it, expect } from 'vitest';
import { mergeDuplicatePages } from '../../../wiki/lint/merge-duplicates';
import { createFakeLinkVault } from '../../__support__/link-vault';
import type { EngineContext } from '../../../types';
import { VaultWriter } from '../../../core/vault-writer';
import { testScopeFor } from '../../__support__/vault-writer';

// Issue #386 at the call site. PR #389 deliberately left the merge-duplicates
// site without leak-direction coverage because this issue replaces the filter
// outright — this is that coverage.
//
// The LLM client is absent on purpose: `mergeDuplicatePages` falls back to its
// programmatic merge, which is the path that matters for the link rewrite.

const TARGET = 'wiki/entities/Osteopontin.md';
const SOURCE = 'wiki/entities/Osteopontin-2.md';

function makeCtx(files: Record<string, string>) {
  const fake = createFakeLinkVault(files);
  const deleted: string[] = [];
  const ctx = {
    app: { vault: fake.vault, metadataCache: fake.metadataCache },
    settings: { wikiFolder: 'wiki', language: 'en' },
    // Phase 5 (F-08): a real gate. #386 retargets vault-wide, so the call
    // site widens it per file; the write still lands in the fake vault and
    // `fake.processed` still records exactly the files that were rewritten.
    vaultWriter: new VaultWriter({
      vault: { process: (file, fn) => fake.vault.processFile(file, fn) },
      scope: testScopeFor('wiki'),
    }),
    getClient: () => null,
    tryReadFile: async (path: string) => (files[path] === undefined ? fake.read(path) || null : fake.read(path)),
    createOrUpdateFile: async (path: string, content: string) => { fake.write(path, content); },
    deleteFile: async (path: string) => { deleted.push(path); },
    getSchemaContext: async () => undefined,
  } as unknown as EngineContext;
  return { ctx, fake, deleted };
}

describe('mergeDuplicatePages — link retargeting (#386)', () => {
  it('retargets a bare-title link in a user note outside the wiki folder', async () => {
    const { ctx, fake, deleted } = makeCtx({
      [TARGET]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin\n\nBone marker.\n',
      [SOURCE]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin-2\n\nAlso a bone marker.\n',
      'Notizen/Knochenstoffwechsel.md': 'Reguliert durch [[Osteopontin-2]].\n',
      'wiki/concepts/Knochenumbau.md': 'Reguliert durch [[entities/Osteopontin-2]].\n',
    });

    const summary = await mergeDuplicatePages(ctx, TARGET, SOURCE);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe('Reguliert durch [[Osteopontin]].\n');
    expect(fake.read('wiki/concepts/Knochenumbau.md')).toBe('Reguliert durch [[entities/Osteopontin]].\n');
    expect(deleted).toEqual([SOURCE]);
    expect(summary).toContain('2 links retargeted in 2 files');
  });

  it('does not write into a note whose links point elsewhere', async () => {
    const { ctx, fake } = makeCtx({
      [TARGET]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin\n\nBone marker.\n',
      [SOURCE]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin-2\n\nAlso a bone marker.\n',
      'Notizen/Osteopontin-2.md': '# My own note\n',
      'Notizen/Knochenstoffwechsel.md': 'Siehe [[Osteopontin-2]].\n',
    });

    const summary = await mergeDuplicatePages(ctx, TARGET, SOURCE);

    expect(fake.read('Notizen/Knochenstoffwechsel.md')).toBe('Siehe [[Osteopontin-2]].\n');
    expect(fake.processed).toEqual([]);
    expect(summary).toBe('merged entities/Osteopontin-2 → entities/Osteopontin');
  });
});

// #435 Item 2 — the sibling of #419 on the lint path. Here the LLM client is
// present on purpose: the programmatic fallback keeps the target's body verbatim
// and can never lose the title, so only the adopted-rewrite path can.
describe('mergeDuplicatePages — the merged body keeps the surviving page H1 (#435)', () => {
  function ctxWithMergeAnswer(files: Record<string, string>, body: string) {
    const { ctx, fake, deleted } = makeCtx(files);
    (ctx as unknown as { getClient: () => unknown }).getClient = () => ({
      createMessage: async () => JSON.stringify({ body, aliases: [] }),
    });
    return { ctx, fake, deleted };
  }

  it('restores the H1 when the merge answer drops it', async () => {
    const { ctx, fake } = ctxWithMergeAnswer(
      {
        [TARGET]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin\n\nBone marker.\n',
        [SOURCE]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin-2\n\nAlso a bone marker.\n',
      },
      '## Description\n\nA bone marker, and also a bone marker — merged prose long enough to clear the hundred-character floor this path applies.',
    );

    await mergeDuplicatePages(ctx, TARGET, SOURCE);

    const written = fake.read(TARGET) ?? '';
    expect(written).toContain('# Osteopontin\n');
    expect(written.indexOf('# Osteopontin')).toBeLessThan(written.indexOf('## Description'));
  });

  it('does not let the merge answer rename the surviving page', async () => {
    const { ctx, fake } = ctxWithMergeAnswer(
      {
        [TARGET]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin\n\nBone marker.\n',
        [SOURCE]: '---\ntype: entity\ntags: [other]\n---\n\n# Osteopontin-2\n\nAlso a bone marker.\n',
      },
      '# Osteopontin and Osteopontin-2\n\n## Description\n\nMerged prose, long enough to clear the hundred-character floor that this path applies before it parses.',
    );

    await mergeDuplicatePages(ctx, TARGET, SOURCE);

    const written = fake.read(TARGET) ?? '';
    expect(written).toContain('# Osteopontin\n');
    expect(written).not.toContain('# Osteopontin and Osteopontin-2');
  });
});
