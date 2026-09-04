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
// Four AST shapes per method, because all four occur or are reachable:
//   * a member receiver — `app.vault.create(...)`, `this.ctx.app.vault.create(...)`,
//     `app.vault.adapter.write(...)` — matched on `callee.object.property.name`
//   * a bare receiver — `const { vault } = app; vault.create(...)` — matched
//     on `callee.object.name`. Optional chaining on either the receiver
//     (`app.vault?.create(...)`) or the call (`vault.create?.(...)`) still
//     produces the same `CallExpression`, so both are covered — verified
//     against the rule, not assumed.
//   * an indirect call — `app.vault.create.call(x, ...)`. `path-resolution.ts`
//     really did invoke `renameFile` that way, so this is not hypothetical.
//   * a computed member — `vault['create'](...)`, whose `callee.property` is
//     a Literal and therefore invisible to the shapes above. Any computed
//     call on one of these receivers is restricted; none is legitimate.
// All are anchored on the *receiver* name (`vault` / `adapter` /
// `fileManager`), so an unrelated `foo.create(...)` is untouched.
//
// NOT covered, and not coverable by syntax: a receiver renamed on assignment
// (`const v = app.vault; v.create(...)`). That needs type information the
// `no-restricted-syntax` rule does not have; the gate's other half — every
// write path in `src/` already routed through `VaultWriter` — is what makes
// such a line a deliberate act rather than an oversight.
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

/** Receivers whose write methods are gated, and the methods for each. */
const WRITE_GATE_RECEIVERS = {
  // `process` is Obsidian's atomic read-modify-write — `modify` with the read
  // folded in. It is the update half of `createOrUpdateFile`, so omitting it
  // would leave the plugin's primary write path gated only for files that do
  // not yet exist.
  vault: ["create", "modify", "process", "createFolder", "delete", "rename", "trash", "append", "copy"],
  adapter: ["write", "writeBinary", "append", "mkdir", "remove", "rename", "copy", "trashSystem", "trashLocal"],
  fileManager: ["renameFile", "trashFile"],
};

const WRITE_GATE_METHODS = [
  ...new Set(Object.values(WRITE_GATE_RECEIVERS).flat()),
];
const RECEIVER_PATTERN = `^(${Object.keys(WRITE_GATE_RECEIVERS).join("|")})$`;
const METHOD_PATTERN = `^(${WRITE_GATE_METHODS.join("|")})$`;

/**
 * `x.vault.create.call(...)` / `.apply(...)` / `.bind(...)`. Anchored on the
 * receiver too, so an unrelated `foo.write.call(...)` is untouched.
 */
const INDIRECT_CALL_RULES = [
  `CallExpression[callee.property.name=/^(call|apply|bind)$/][callee.object.property.name=/${METHOD_PATTERN}/][callee.object.object.name=/${RECEIVER_PATTERN}/]`,
  `CallExpression[callee.property.name=/^(call|apply|bind)$/][callee.object.property.name=/${METHOD_PATTERN}/][callee.object.object.property.name=/${RECEIVER_PATTERN}/]`,
].map((selector) => ({
  selector,
  message: `Indirect call of a gated vault write method. ${WRITE_GATE_HINT}`,
}));

/** `vault['create'](...)` — the method name hides in a Literal. */
const COMPUTED_CALL_RULES = [
  `CallExpression[callee.computed=true][callee.object.name=/${RECEIVER_PATTERN}/]`,
  `CallExpression[callee.computed=true][callee.object.property.name=/${RECEIVER_PATTERN}/]`,
].map((selector) => ({
  selector,
  message: `Computed-member call on a vault/adapter/fileManager receiver. ${WRITE_GATE_HINT}`,
}));

const WRITE_GATE_RESTRICTED_SYNTAX = [
  ...Object.entries(WRITE_GATE_RECEIVERS).flatMap(([receiver, methods]) =>
    writeGateRules(receiver, methods)
  ),
  ...INDIRECT_CALL_RULES,
  ...COMPUTED_CALL_RULES,
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