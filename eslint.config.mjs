import tsparser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

// ── Phase 5 (F-08) — the filesystem write-gate, enforced by lint ─────────
//
// Every vault write in `src/` goes through `VaultWriter`
// (`src/core/vault-writer.ts`), which asserts the target path is inside a
// configured folder before calling Obsidian. That property is only worth
// anything if it cannot quietly regress, so a direct call to the underlying
// write API is a lint error everywhere except the gate module itself.
//
// Two AST shapes per method, because both occur in this codebase:
//   * a member receiver — `app.vault.create(...)`, `this.ctx.app.vault.create(...)`,
//     `app.vault.adapter.write(...)` — matched on `callee.object.property.name`
//   * a bare receiver — `const { vault } = app; vault.create(...)` — matched
//     on `callee.object.name`
// Both are anchored on the *receiver* name (`vault` / `adapter`), so an
// unrelated `foo.create(...)` is untouched.
//
// Test files are not linted at all (see the `ignores` block below), and
// `plugin.saveData()` is deliberately not restricted: it writes the plugin's
// own `data.json` through Obsidian's plugin API, not a caller-supplied path.
const WRITE_GATE_HINT =
  "Route it through the VaultWriter in src/core/vault-writer.ts, which asserts " +
  "the path is inside a configured folder (Phase 5, finding F-08).";

/** `no-restricted-syntax` entries for one receiver and its write methods. */
function writeGateRules(receiver, methods) {
  return methods.flatMap((method) => [
    {
      selector: `CallExpression[callee.property.name="${method}"][callee.object.property.name="${receiver}"]`,
      message: `Direct \`.${receiver}.${method}()\` call. ${WRITE_GATE_HINT}`,
    },
    {
      selector: `CallExpression[callee.property.name="${method}"][callee.object.name="${receiver}"]`,
      message: `Direct \`${receiver}.${method}()\` call. ${WRITE_GATE_HINT}`,
    },
  ]);
}

const WRITE_GATE_RESTRICTED_SYNTAX = [
  ...writeGateRules("vault", ["create", "modify", "createFolder", "delete", "rename"]),
  ...writeGateRules("adapter", ["write", "writeBinary", "mkdir", "remove", "rename"]),
];

export default [
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },
  {
    // The write-gate itself is the one module allowed to call the real API.
    // Nothing else in `src/` may — including future files, which is the point.
    files: ["src/**/*.ts"],
    ignores: ["src/core/vault-writer.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...WRITE_GATE_RESTRICTED_SYNTAX],
    },
  },
  {
    ignores: [
      "main.js",
      "node_modules/",
      // Test files are excluded from local lint to mirror the Obsidian
      // Bot review pipeline's focus on plugin production code. Note (2026-08-06,
      // v1.26.0 pre-submission finding): the Bot actually scans the WHOLE repo
      // `.ts` tree, not just `main.js` — it reported ~60 Warnings on
      // `tools/llm-wiki-cli/` that local lint cannot see (this config lints only
      // `src/` and the root tsconfig includes only `src/**`). The exclude list
      // below keeps local lint focused on plugin code; tools/ warnings are
      // accepted (structural to a Node CLI; see CLAUDE.md Bot compliance
      // invariant). See [[feedback_obsidian_bot_tools_cli_warnings]].
      // Each entry below has a documented user direction:
      //   - src/**/__tests__/** — test files (Direction v1.25.4)
      //   - src/**/__support__/** — test polyfills (Direction v1.25.4)
      //   - src/**/fixtures/** — fixture wikis (Direction v1.25.4)
      //   - src/**/*.test.ts / src/**/*.spec.ts — top-level test files (Direction v1.25.4)
      "src/**/__tests__/**",
      "src/**/__support__/**",
      "src/**/fixtures/**",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
    ],
  },
];