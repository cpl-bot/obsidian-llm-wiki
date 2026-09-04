/**
 * Runtime plugin id — the `manifest.id` Obsidian assigned to this install.
 *
 * Hardened-fork background (`docs/security/HARDENING-PLAN.md` Phase 7,
 * `UPSTREAM-MERGE.md` §2.3): the install procedure renames the plugin id
 * from `karpathywiki` to `karpathywiki-hardened` so Obsidian's community-
 * plugin auto-updater has no matching listing to silently overwrite the
 * hardened build with (finding F-01). Every identifier in `src/` that is a
 * **path** — specifically, the plugin's own folder under
 * `.obsidian/plugins/<id>/` — must follow that rename, or it keeps
 * reading/writing the *old* id's folder after the rename. Every identifier
 * that is a **secret-storage key or migration marker** (e.g.
 * `karpathywiki-mineru-api-token`, `karpathywiki-openai-codex`,
 * `_migrated_*`) must NOT follow it — renaming those would orphan a user's
 * already-stored keys or replay a migration that already ran. This module
 * is the single source of truth for the former category; it does not touch
 * the latter.
 *
 * `main.ts::onload` calls `setActivePluginId(this.manifest.id)` before
 * anything that touches the plugin's own folder (e.g. the PDF cache in
 * `src/core/pdf-cache.ts`). The default below is the upstream literal, so
 * any code path exercised before `onload` runs — or a test that never calls
 * the setter — keeps behaving exactly as it did before this module existed.
 */

/** The plugin id shipped by the upstream (store) build. */
export const UPSTREAM_PLUGIN_ID = 'karpathywiki';

let activePluginId: string = UPSTREAM_PLUGIN_ID;

/**
 * Set once, from `main.ts::onload`, to `this.manifest.id`. Obsidian loads at
 * most one instance of this plugin per vault, so a module-level singleton is
 * the right shape here — there is no multi-tenant case to guard against.
 */
export function setActivePluginId(id: string): void {
  activePluginId = id;
}

/** The plugin id to use when constructing a path under `.obsidian/plugins/<id>/`. */
export function getActivePluginId(): string {
  return activePluginId;
}

/**
 * Test-only: restore the default so one test's `setActivePluginId` call
 * cannot leak into another test file (module state persists for the life of
 * the process, and vitest can run files in the same worker).
 */
export function resetActivePluginIdForTests(): void {
  activePluginId = UPSTREAM_PLUGIN_ID;
}
