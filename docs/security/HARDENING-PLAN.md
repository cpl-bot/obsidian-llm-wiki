# Security Assessment & Hardening Work Plan
## `green-dalii/obsidian-llm-wiki` (plugin id `karpathywiki`, v1.27.0)

**Assessment date:** 2026-09-03
**Method:** White-box review of a fresh clone: source read, pattern scanning, dependency audit against `registry.npmjs.org`, from-source build, bundle egress analysis, test-suite baseline, CI workflow review. No dynamic testing against a live Obsidian instance.
**Goal:** Produce a hardened private fork that (a) eliminates the auto-update supply-chain exposure, (b) removes unnecessary attack surface, (c) clears all known-vulnerable dependencies, and (d) makes future upstream merges auditable.

---

## 1. Executive summary

The codebase is well-engineered and shows deliberate security work (OS-keychain secret storage, PKCE OAuth bound to `127.0.0.1`, path-safe slugification, bounded zip extraction, artifact provenance attestations). **No exploitable vulnerability affecting a normal user was found in the current release.**

The material risks are structural, not defects:

| # | Risk | Severity | Class |
|---|------|----------|-------|
| F-01 | Auto-update trust: any future release can read keys + vault and exfiltrate over the plugin's normal HTTPS traffic pattern | **High** | Supply chain |
| F-02 | Committed `package-lock.json` resolves 358/434 packages from `registry.npmmirror.com` | **Medium** | Supply chain |
| F-03 | Repair command writes API key in plaintext to `data.json` (inside vault, syncs everywhere) | **Medium** | Secret handling |
| F-04 | No egress allowlist; user-supplied `baseUrl` accepts `http://` to remote hosts (key over cleartext) | **Medium** | Network |
| F-05 | `fast-uri` 3.1.5 — 4× HIGH advisories (SSRF / host confusion). Dev-only, not in bundle | **Medium** (dev) | Dependency |
| F-06 | Optional MinerU backend uploads PDFs/images/Office docs to `mineru.net` | **Medium** (opt-in) | Data egress |
| F-07 | GitHub Actions pinned by tag (`@v4`), not SHA | **Low** | CI supply chain |
| F-08 | No hard write-gate: vault writes are not enforced to stay under `wikiFolder` | **Low** | Defence in depth |
| F-09 | `ajv` is a direct devDependency but unused in `src/`; `fast-uri` pinned only to hold an override | **Low** | Hygiene |
| F-10 | No `SECURITY.md`; no secret scanning; no SAST in CI | **Low** | Process |

Plan effort: **~9–12 engineering days** across 7 phases, plus a recurring ~30 min per upstream merge.

---

## 2. Detailed findings (with evidence)

### F-01 — Auto-update supply-chain exposure — HIGH
**Evidence.** Obsidian reviews community plugins once at submission; releases thereafter ship `main.js` from the author's GitHub Releases with no build reproducibility check. Plugins run unsandboxed in Electron's renderer with Node access. This plugin legitimately (a) holds provider secrets via `app.secretStorage` (`src/llm-sdk/provider-secret-store.ts`), (b) reads the entire vault, and (c) makes outbound HTTPS to a user-configurable `baseUrl` through `src/core/obsidian-fetch-bridge.ts`. A malicious update therefore needs no new capability — exfiltration is indistinguishable from normal operation.
**Mitigating factors.** `main.js` is **not minified** (87,563 readable lines; `esbuild.config.mjs` sets no `minify`). Release workflow uses `actions/attest-build-provenance@v1`. Provenance proves the artifact came from that repo's CI, **not** that the source is benign.
**Fix.** Phase 6 + Phase 7: fork, build locally, disable auto-update, diff-review every upstream delta, and add a structural egress allowlist (Phase 4) so the mitigation holds even when review attention lapses.

### F-02 — Lockfile resolves from a third-party mirror — MEDIUM
**Evidence.**
```
$ grep -c registry.npmmirror.com package-lock.json   → 358
$ grep -c registry.npmjs.org      package-lock.json   → 76
```
The repo's own `.npmrc` documents this exact problem and pins `registry=https://registry.npmjs.org/`, but the committed lockfile still carries mirror URLs — the fix never propagated. `npm install` fails outright in any environment that blocks `npmmirror.com`. All 434 entries carry `sha512` integrity hashes, so a tampered tarball would fail verification; this is a hygiene/availability issue with supply-chain optics, not a confirmed integrity break. `pnpm-lock.yaml` is clean (0 mirror refs).
**Fix.** Phase 1: delete and regenerate against the official registry; add a CI check that rejects any `resolved` URL not on `registry.npmjs.org`.

### F-03 — Plaintext key write to `data.json` — MEDIUM
**Evidence.** `src/main-commands/secret-storage-commands.ts:44-45`
```ts
this.settings.apiKey = stored.trim();
await this.saveData(this.settings);
```
The "Migrate Secret Storage" repair command copies the key from the OS keychain into `settings.apiKey`, which `saveData()` persists to `.obsidian/plugins/karpathywiki/data.json`. That file lives inside the vault and follows it into git, iCloud, Syncthing, and backups. Introduced as a Windows 10 Credential-Manager fallback (issue #339). `settings.apiKey` also remains a live fallback in the key resolver (`provider-secret-store.ts` comments: "fall through to settings.apiKey").
**Fix (macOS + Linux deployment only; Windows out of scope).** The only reason the plaintext path exists is the Windows 10 Credential Manager failure mode. On the target platforms Obsidian's `secretStorage` is backed by macOS Keychain and the freedesktop Secret Service (gnome-keyring / KWallet via libsecret), both of which are reliable, so the fallback is pure liability. Make the key path **keychain-only and fail-closed**:

1. Delete `secret-storage-commands.ts` and its command registration. Remove the `apiKey` field from `LLMWikiSettings` entirely (type + defaults + UI binding), so there is no persisted slot a future merge could quietly repopulate.
2. `ProviderSecretStore.load()`: on `getSecret` throw, **do not** return `null` and fall through — rethrow `ProviderSecretStorageError`. The resolver surfaces "Keychain unavailable" and LLM features stay disabled until the keychain works. No silent degradation to any on-disk value.
3. Startup scrub in `onload`: if `savedData.apiKey` is a non-empty string, move it into SecretStorage (only if the slot is empty), delete the field, `saveData()`, and show a one-time Notice. Rotate the key afterwards regardless — it has already touched disk.
4. Platform gate: `if (Platform.isWin) { new Notice('Unsupported platform'); return; }` at the top of `onload`. Prevents the hardened build from ever running against the platform whose failure mode motivated the removed fallback.
5. Linux prerequisite (document in `README`/`UPSTREAM-MERGE.md`): a Secret Service daemon must be running in the desktop session — verify with `secret-tool store --label test test key` / `secret-tool lookup test key`. Headless or minimal-WM setups without gnome-keyring/KWallet will correctly fail closed rather than fall back.
6. Regression tests: (a) serialising any settings object never yields a key-shaped string; (b) `getSecret` throwing propagates as `ProviderSecretStorageError`, not `null`; (c) the `Platform.isWin` gate short-circuits before any settings load.

### F-04 — No egress control; cleartext `baseUrl` accepted — MEDIUM
**Evidence.** `src/core/obsidian-fetch-bridge.ts` is the single chokepoint for all LLM traffic (AI-SDK `fetch` → `requestUrl`). It performs no destination validation. `src/ui/settings-sections/provider-section.ts:165` accepts any string as `baseUrl`; no scheme check exists anywhere in `src/` outside the MinerU-specific `validateRemoteUrl()`. A user (or a future update) can route the `Authorization: Bearer <key>` header to `http://` or to an arbitrary host.
**Fix.** Phase 4: allowlist + scheme policy at the chokepoint.

### F-05 — `fast-uri` 3.1.5 HIGH advisories — MEDIUM (dev-only)
**Evidence.** `npm audit` (regenerated lockfile, official registry):
```
fast-uri 3.0.0 - 3.1.5  Severity: high
  GHSA-5jgf-p345-68v8  host confusion via skipped IDN canonicalization
  GHSA-f65p-4m7j-42xc  SSRF via malformed IPv6 normalization
  GHSA-fph4-wmhf-6fwf  SSRF via repeated hostname percent-decoding
  GHSA-jqff-g426-hqxp  host confusion via percent-encoded scheme normalization
  fix: fast-uri@3.1.7
```
Reached via `ajv@8.20.0` (direct devDep, unused in `src/`) and `eslint-plugin-obsidianmd → eslint-plugin-json-schema-validator`. Not present in `main.js`. Real-world impact to plugin users: none. Impact to contributors' machines: low.
**Fix.** Phase 1.

### F-06 — MinerU third-party document upload — MEDIUM (opt-in)
**Evidence.** `src/core/mineru-converter.ts` uploads full PDF/image/Office bytes to `https://mineru.net` when `markdownConversionBackend === 'mineru'`. Implementation quality is high (HTTPS-only + private-range block in `validateRemoteUrl()`, in-memory zip extraction limited to one `full.md`, file-count and size caps). The issue is purely data residency: sensitive documents leave the machine to a service unrelated to the user's chosen LLM provider. Footprint: 27 files (6 tests), 384 lines; 11 i18n files; 1 settings migration (`_migrated_v1_27_0_markdown_conversion_backend`).
**Fix.** Phase 2: remove entirely per requirement.

### F-07 — Actions pinned by tag — LOW
**Evidence.** `.github/workflows/pr-ci.yml` and `release.yml`: `actions/checkout@v4`, `actions/setup-node@v4`, `pnpm/action-setup@v4`, `actions/attest-build-provenance@v1`. Mutable tags were the vector in the 2025 `tj-actions/changed-files` compromise. Positive: both workflows declare `permissions:` blocks; no `pull_request_target`; the only secret is `GITHUB_TOKEN`.
**Fix.** Phase 6.

### F-08 — No hard write-gate on vault paths — LOW
**Evidence.** Writes occur at 14 sites (`vault.create`, `vault.modify`, `vault.adapter.write`, `createFolder`) across `wiki-engine.ts`, `auto-maintain.ts`, `schema-manager.ts`, `fix-runners.ts`, `contradictions.ts`, `merge-page.ts`, `apply-suggestion.ts`. Path *construction* is safe (`slugify` strips `/ \ .` and control chars — `src/core/slug.ts:25-33`), but there is no single enforcement point asserting the final path is under `settings.wikiFolder`. Currently correct by construction; not correct by contract.
**Fix.** Phase 5.

### F-09 — Unused/vestigial dependencies — LOW
**Evidence.** `ajv@^8.20.0` in `devDependencies` — zero imports in `src/`, `scripts/`, `tools/`. `fast-uri@3.1.5` listed as a direct devDep solely to anchor an `overrides` entry. `@types/node@16.18.126` against an `engines.node >= 22` requirement.
**Fix.** Phase 1.

### F-10 — Process gaps — LOW
No `SECURITY.md`, no secret scanning (gitleaks/trufflehog), no SAST (CodeQL/semgrep), no `npm audit` gate in `pr-ci.yml`. Repo also ships `AGENTS.md`, `CLAUDE.md`, `MEMORY.md` — instruction files consumed by contributors' AI coding agents. Low risk today; treat as untrusted input if merging upstream changes to them.
**Fix.** Phase 6.

### Verified-safe (no action)
- No `eval`, `new Function`, `innerHTML`/`outerHTML`, `child_process`, string-`setTimeout`, or `process.env` in shipped source.
- OAuth loopback: `LOOPBACK_HOST = '127.0.0.1'`, state compared on every callback, PKCE S256 with `crypto.getRandomValues` (`auth-core.ts:11,39,47`).
- Bedrock SigV4 is hand-rolled with `crypto.subtle`; secrets live only in SecretStorage.
- API key inputs are `type = 'password'` (`provider-section.ts:144`).
- No `console.*` statements log credentials (all matches were token *counts*).
- `Math.random` used only for ranking jitter and retry backoff, never for security material.
- Every hostname in the built bundle is accounted for (provider APIs, `mineru.net`, `ai-gateway.vercel.sh` from the `ai` SDK, documentation URLs, `example.com` placeholders). No unexplained destination.
- Only 2 lifecycle scripts in the dependency tree: `esbuild` (`node install.js`, expected) and `ljharb-monorepo-symlink-test` (eslint transitive).

---

## 3. Threat model (for scoping decisions)

| Actor | Capability | Addressed by |
|-------|-----------|--------------|
| Malicious/compromised upstream maintainer | Ships hostile `main.js` via auto-update | Ph 6, 7, 4 |
| Compromised npm package (`ai`, `@ai-sdk/*`, `zod`, `fflate`, build tooling) | Injects code at build time | Ph 1, 6 (ignore-scripts, SHA-pin, SBOM, audit gate) |
| Prompt-injected source document | Steers generated wiki content; attempts out-of-scope writes or exfil via rendered links | Ph 4, 5 |
| Vault-sync leak (git/cloud) | Reads secrets from `data.json` | Ph 3 |
| Local attacker on same host | Hits loopback OAuth listener | Already bound to 127.0.0.1 + state check — accept |
| Network MITM | Reads key on cleartext `baseUrl` | Ph 4 |

Out of scope: Obsidian core, Electron, OS keychain implementation, LLM-provider-side handling.

---

## 4. Work plan

Conventions: **AC** = acceptance criteria. Gate after every phase: `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm css-lint` (`pnpm gate:1`) must pass; test count may only decrease by the tests belonging to removed features.

### Phase 0 — Fork, baseline, freeze (0.5 day)

| Task | Detail |
|------|--------|
| 0.1 | Fork to a private repo. Tag upstream `v1.27.0` as `upstream/v1.27.0`. Create branch `harden/main`. |
| 0.2 | Record baseline: `main.js` sha256 from a clean build; `npm audit --json`; test count (267 files / 3,792 tests). Commit to `SECURITY-BASELINE.md`. |
| 0.3 | In every Obsidian vault that will use the fork: Settings → Community plugins → disable **Automatic updates**. Uninstall the store version. |
| 0.4 | Rotate every provider API key that was ever entered into the store version (cheap; removes doubt about `data.json` history). |

**AC:** Clean build reproducible; baseline hashes committed; no vault still pointing at the store distribution.

### Phase 1 — Dependency hygiene (1 day) — closes F-02, F-05, F-09

| Task | Detail |
|------|--------|
| 1.1 | `rm package-lock.json && npm install --legacy-peer-deps --registry=https://registry.npmjs.org/`. Commit. |
| 1.2 | Remove `ajv` from `devDependencies` (unused). Remove `fast-uri` as a direct devDep; keep only `overrides.fast-uri = "3.1.7"` (and mirror in `pnpm.overrides`). |
| 1.3 | Bump `@types/node` → `^22`. Bump `esbuild` 0.28.1 → 0.28.2, `vitest`, `eslint`, `@typescript-eslint/*` to current minors. Do **not** jump `ai` 6→7, `@ai-sdk/*` 3→4, or `zod` 3→4 in this phase — those are API-breaking and belong in a separate upgrade PR after hardening lands. |
| 1.4 | Add `.npmrc`: `ignore-scripts=true` and `audit-level=high`. Whitelist `esbuild`'s postinstall via an explicit `node node_modules/esbuild/install.js` in a `prepare` script. |
| 1.5 | Add `scripts/check-lockfile-registry.mjs`: fail if any `resolved` URL host ≠ `registry.npmjs.org`. Wire into `gate:1` and CI. |
| 1.6 | Add `npm audit --audit-level=high --omit=dev` **and** `--audit-level=high` (full) as separate CI steps; the dev-inclusive one may be `continue-on-error: true` initially, flip to blocking once clean. |

**AC:** `npm audit` reports 0 HIGH/CRITICAL (all deps); lockfile has 0 mirror URLs; `npm ci` succeeds with `ignore-scripts=true`; gate passes.

### Phase 2 — Attack-surface removal (2–3 days) — closes F-06

**2.A MinerU (required).**

| Task | Detail |
|------|--------|
| 2.1 | Delete `src/core/mineru-converter.ts` and its 6 tests under `src/__tests__/`. |
| 2.2 | `src/core/pdf-converter.ts`: remove the `'mineru'` branch; native provider-vision path remains. |
| 2.3 | `src/types.ts`: remove `mineruApiToken`, `markdownConversionBackend` (or narrow to the single literal `'native'`), and the `_migrated_v1_27_0_markdown_conversion_backend` marker. |
| 2.4 | `src/core/settings-migrations.ts`: replace the v1.27.0 backend migration with a **scrub** migration that (a) clears any stored `karpathywiki-mineru-api-token` secret via `setSecret(id, '')`, (b) deletes the two settings keys, (c) sets `_migrated_harden_mineru_removed = true`. |
| 2.5 | `src/ui/settings-sections/wiki-config-section.ts`, `src/ui/modals/IngestReportModal-class.ts`, `src/wiki/wiki-engine.ts`, `src/main.ts`, `src/constants.ts`, `src/core/source-requirements.ts`: remove MinerU UI, phase enums (`MINERU_PHASE_KEY`), constants, and the Office-format acceptance that existed only for MinerU. |
| 2.6 | Purge 11 `src/texts/*.ts` i18n bundles of `mineru*` keys. Add a test asserting no i18n key contains `mineru`. |
| 2.7 | Delete `docs/PDF-OCR-GUIDE.md`, `docs/PDF-OCR-GUIDE_CN.md`; strip MinerU sections from all `README*.md`. |
| 2.8 | Post-build assertion (add to `scripts/`): `grep -c mineru main.js` must equal 0. |

**2.B Discretionary removals (decide per deployment; each is a separate PR).**

| Candidate | Footprint | Rationale | Recommendation |
|-----------|-----------|-----------|----------------|
| OpenAI Codex OAuth (`src/llm-sdk/openai-codex/`, `codex-auth-commands.ts`, `openai-codex-auth-controls.ts`) | 83 files / 967 lines | Runs a local HTTP listener; talks to `chatgpt.com/backend-api` and `auth.openai.com`; ToS-adjacent | Remove unless you use ChatGPT-subscription auth |
| AWS Bedrock SSO/IAM (`src/llm-sdk/bedrock-sso/`, `bedrock-auth-controls.ts`) | 45 files / 999 lines | Hand-rolled SigV4 + device flow; complex; only 3 constants verified against real AWS per CHANGELOG | Remove unless on Bedrock |
| Unused providers (`kimi/moonshot`, `z.ai/bigmodel`, `minimax`, `deepseek`, `openrouter`, `gemini`) | 7–41 files each, mostly registry entries | Each is a hardcoded hostname in the bundle and a row in the egress allowlist | Keep only the providers you will actually configure |
| `ai-gateway.vercel.sh` default in `ai` SDK | 1 host | Never used when `baseUrl` is set, but present in bundle | Block via allowlist (Ph 4) rather than patching the dep |
| `AGENTS.md`, `CLAUDE.md`, `MEMORY.md` | 3 files | Agent instruction files; untrusted if merged from upstream | Delete from fork; never merge upstream changes to them blindly |

**AC:** `main.js` contains no `mineru` string; bundle hostname list (`grep -oE 'https?://[a-zA-Z0-9.-]+' main.js \| sort -u`) contains only retained providers + docs URLs; all remaining tests pass; settings from a v1.27.0 `data.json` load without error and MinerU secret slot is blanked.

### Phase 3 — Secret handling (1 day) — closes F-03

| Task | Detail |
|------|--------|
| 3.1 | Delete `src/main-commands/secret-storage-commands.ts` and its registration in `command-registry.ts`. Remove the `apiKeyMigrationFailedNotice` / `apiKeyMigratedToSecretStorageSuccess` i18n keys. |
| 3.2 | Remove `settings.apiKey` from `LLMWikiSettings` entirely (type, defaults, UI binding). Make the key resolver keychain-only and **fail-closed**: `ProviderSecretStore.load()` rethrows `ProviderSecretStorageError` on `getSecret` failure instead of returning `null`; `null` means "no key configured", a throw means "keychain unavailable — LLM features disabled". No fallback to any on-disk value in either case. |
| 3.3 | Add startup scrub in `main.ts::onload`: if `savedData.apiKey` is a non-empty string → move to SecretStorage if the slot is empty, then delete the field and `saveData()`. Log a one-time Notice: "Plaintext API key removed from data.json." |
| 3.4 | `test-connection-section.ts`: confirm the transient typed key is held only in memory and is zeroed after the test (the code already attempts this — add a test that `saveData` payload never contains a `sk-` prefix). |
| 3.5 | Add `src/core/redact.ts` and route every `console.*` and Notice that includes settings or error bodies through it (`Bearer …`, `sk-…`, `AKIA…`, `x-api-key` patterns → `***`). Provider error bodies can echo the request; this closes the log-leak path. |
| 3.6 | Add a test that serialises `DEFAULT_SETTINGS` plus a fully configured settings object and asserts no key-shaped value survives in the JSON. |
| 3.7 | Platform gate at the top of `main.ts::onload`: `if (Platform.isWin) { new Notice('Unsupported platform'); return; }`. Target platforms are macOS (Keychain) and Linux (Secret Service); Windows is out of scope and its Credential Manager failure mode is the sole reason the removed fallback existed. |
| 3.8 | Document the Linux prerequisite: a Secret Service daemon (gnome-keyring or KWallet) must be running in the desktop session. Verify with `secret-tool store --label test test key && secret-tool lookup test key`. Headless/minimal-WM setups fail closed by design. |

**AC:** Grep for `settings.apiKey` in `src/` returns 0; a `data.json` seeded with a plaintext key is scrubbed on first load; a mocked `getSecret` throw propagates as `ProviderSecretStorageError` (not `null`); the plugin refuses to load when `Platform.isWin`; no test or build path writes a secret to disk.

### Phase 4 — Network egress control (1.5 days) — closes F-04, structurally mitigates F-01

| Task | Detail |
|------|--------|
| 4.1 | Create `src/core/egress-policy.ts` exporting `assertAllowedEgress(url: string, settings): void`. Policy: (a) scheme must be `https:`, **except** `http:` is permitted when hostname ∈ {`localhost`, `127.0.0.1`, `[::1]`} (Ollama/LM Studio); (b) hostname must exactly match an entry in a compile-time allowlist of retained provider hosts **or** the hostname of the user's configured `baseUrl`; (c) reject URLs with userinfo (`user:pass@`); (d) reject RFC1918/link-local/CGNAT ranges unless (a)'s loopback exception applies. |
| 4.2 | Call `assertAllowedEgress` as the **first line** of `obsidianFetchBridge()` and of the native-`fetch` fallback in `obsidian-fetch-bridge.ts`. Also in `model-section.ts:96` (the one direct `requestUrl` call outside the bridge). Throw a typed `EgressDeniedError`; surface as a Notice. |
| 4.3 | Provider-section UI: validate `baseUrl` on blur with the same function; refuse to save an invalid one; show the reason inline. |
| 4.4 | Add a settings toggle **"Strict egress (recommended)"**, default **on**. Off = allowlist bypass with a red warning. This exists only so a legitimate corporate proxy can be used without a code change. |
| 4.5 | Post-build assertion: extract all `https?://` hosts from `main.js`; fail the build if any host is neither in the egress allowlist nor in an explicit `KNOWN_DOC_URLS` list (documentation links that are never fetched). This is the tripwire that catches a hostile upstream merge. |
| 4.6 | Tests: allowlist hit, allowlist miss, `http://` remote (deny), `http://localhost` (allow), userinfo (deny), private range (deny), redirect target denied (bridge does not follow redirects itself — `requestUrl` does; document that redirect targets are not re-validated, and set `requestUrl`'s redirect handling to manual if the Obsidian API version exposes it). |

**AC:** Any `fetch`/`requestUrl` to a host outside policy throws before a byte is sent; build fails if the bundle acquires a new hostname; existing provider flows unchanged.

### Phase 5 — Filesystem write-gate (1 day) — closes F-08

| Task | Detail |
|------|--------|
| 5.1 | Create `src/core/vault-writer.ts` wrapping `vault.create`, `vault.modify`, `vault.adapter.write`, `vault.createFolder`, `vault.delete`. Each method calls `assertWithinScope(path, settings.wikiFolder, settings.schemaFolder, configDir)` using the existing `isAtOrInFolderScope` primitive from `src/core/folder-scope.ts`, plus: reject `..` segments, absolute paths, and NUL; normalise via `normalizePath`. |
| 5.2 | Replace the 14 direct call sites (`wiki-engine.ts`, `auto-maintain.ts`, `schema-manager.ts`, `fix-runners.ts`, `contradictions.ts`, `merge-page.ts`, `apply-suggestion.ts`) with the wrapper. |
| 5.3 | Add an ESLint `no-restricted-syntax` rule forbidding `vault.create(`, `vault.modify(`, `adapter.write(` outside `vault-writer.ts`. |
| 5.4 | Tests: traversal attempt, absolute path, sibling-prefix folder (`wiki-backup/` vs `wiki/`), and the NFC/NFD path case the engine already handles. |

**AC:** ESLint fails on any new direct vault write; all writes provably land under configured folders.

### Phase 6 — Build & CI supply chain (1.5 days) — closes F-01 (detection), F-07, F-10

| Task | Detail |
|------|--------|
| 6.1 | SHA-pin every `uses:` in `pr-ci.yml` and `release.yml` (`actions/checkout@<sha> # v4.x.y`). Add `dependabot.yml` with `package-ecosystem: github-actions` so pins are bumped via PR. |
| 6.2 | Tighten `permissions:` to `contents: read` at workflow level; grant `id-token: write` + `attestations: write` only on the release job. |
| 6.3 | CI: `npm ci --ignore-scripts` (then the explicit `esbuild` install step); run `scripts/check-lockfile-registry.mjs`; run the Phase 4.5 hostname tripwire; run `npm audit --audit-level=high`. |
| 6.4 | Add CodeQL (`javascript-typescript`) and `gitleaks` workflows on PR + weekly schedule. |
| 6.5 | Reproducible build: set `SOURCE_DATE_EPOCH`, ensure esbuild output is byte-stable across two runs in CI; publish `main.js.sha256` alongside the release and keep `attest-build-provenance`. Add `scripts/verify-release.mjs` that downloads a release, rebuilds from the tag, and diffs. |
| 6.6 | Generate an SBOM (`npx @cyclonedx/cyclonedx-npm --output-file sbom.json`) per release; attach to the release. |
| 6.7 | Add `SECURITY.md` (private disclosure path, supported versions = fork `main` only). |
| 6.8 | Branch protection on `harden/main`: required checks (gate, audit, lockfile, hostname tripwire, CodeQL), no force-push, signed commits. |

**AC:** All workflow actions SHA-pinned; two consecutive CI builds produce identical `main.js` hashes; CodeQL + gitleaks green; release page carries SBOM + sha256 + provenance.

### Phase 7 — Update governance & operations (0.5 day + recurring)

| Task | Detail |
|------|--------|
| 7.1 | Document `UPSTREAM-MERGE.md`: `git fetch upstream && git diff upstream/vX..upstream/vY -- src/ package.json` → review checklist (new hosts? new `getSecret`/`setSecret` sites? new `vault.*` writes? new deps? changes to `esbuild.config.mjs`, `.github/`, `.npmrc`, `AGENTS.md`/`CLAUDE.md`?) → rebase hardening commits → gate → build → install. |
| 7.2 | Install procedure: copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/karpathywiki/`. Change `manifest.json` `id` to `karpathywiki-hardened` so Obsidian can never silently replace it with the store build. |
| 7.3 | Operational controls outside the code: dedicated per-provider API key with a hard monthly spend cap and billing alert; dedicated vault for ingest; host egress firewall (Little Snitch / OpenSnitch / LuLu) with an alert-on-new-destination rule for the Obsidian process. |
| 7.4 | Quarterly: rerun `npm audit`, `npm outdated`, and the hostname extraction against the current bundle; re-verify the OS keychain still holds the key and `data.json` does not. |

**AC:** Written runbook exists; plugin id differs from upstream; spend cap and firewall configured.

---

## 5. Sequencing & estimate

```
Week 1:  Ph0 (0.5d) → Ph1 (1d) → Ph2.A MinerU (1.5d) → Ph3 (1d)
Week 2:  Ph4 (1.5d) → Ph5 (1d) → Ph6 (1.5d) → Ph7 (0.5d)
Optional: Ph2.B removals (0.5–1d each), then ai/@ai-sdk/zod major upgrades (1–2d)
```
Total: **9–12 engineering days** for a single engineer with TypeScript + Obsidian API familiarity. Phases 1, 3, 4 are independent and can run in parallel branches; Phase 2.A touches `types.ts`/`main.ts` and should merge before Phase 3 to avoid conflicts.

Priority if time-boxed to 3 days: **Ph0 → Ph1 → Ph3 → Ph4.1–4.2 + 4.5 → Ph6.1–6.3**. That closes the plaintext-key path, the vulnerable dep, and installs the egress tripwire — the three controls with the best risk-reduction-per-hour.

---

## 6. Verification checklist (run before each install)

```bash
# 0. clean tree, correct toolchain
node -v            # >= 22
git status --porcelain | wc -l   # 0

# 1. deps
npm ci --ignore-scripts && node node_modules/esbuild/install.js
node scripts/check-lockfile-registry.mjs          # 0 non-npmjs hosts
npm audit --audit-level=high                      # 0 findings

# 2. gate
pnpm gate:1                                       # lint, typecheck, build, test, css-lint

# 3. bundle assertions
grep -c mineru main.js                            # 0
grep -oE 'https?://[a-zA-Z0-9.-]+' main.js | sort -u   # matches ALLOWLIST ∪ KNOWN_DOC_URLS only
grep -c 'settings.apiKey' main.js                 # 0
sha256sum main.js                                 # matches CI-published hash

# 4. secrets on disk
grep -rE 'sk-[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}' "<vault>/.obsidian/plugins/karpathywiki-hardened/data.json" || echo OK
```

---

## 7. Appendix A — Proposed egress allowlist (edit to retained providers)

```ts
export const EGRESS_ALLOWLIST: ReadonlySet<string> = new Set([
  'api.openai.com',
  'api.anthropic.com',
  // 'generativelanguage.googleapis.com',
  // 'openrouter.ai',
  // 'api.deepseek.com',
  // 'api.moonshot.cn', 'api.kimi.com',
  // 'api.minimaxi.com',
  // 'open.bigmodel.cn', 'api.z.ai',
  // 'bedrock-runtime.<region>.amazonaws.com'  (pattern-match if Bedrock retained)
]);
export const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
// KNOWN_DOC_URLS: strings that appear in the bundle but are never fetched
export const KNOWN_DOC_URLS = new Set([
  'docs.anthropic.com', 'platform.openai.com', 'platform.claude.com',
  'developer.mozilla.org', 'json-schema.org', 'github.com', 'ai-sdk.dev',
  'vercel.com', 'example.com', 'api.example.com',
]);
```

## 8. Appendix B — Files touched per phase (for PR scoping)

| Phase | Primary files |
|-------|---------------|
| 1 | `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `.npmrc`, `scripts/check-lockfile-registry.mjs`, `.github/workflows/pr-ci.yml` |
| 2.A | `src/core/mineru-converter.ts` (delete), `src/core/pdf-converter.ts`, `src/core/source-requirements.ts`, `src/core/settings-migrations.ts`, `src/types.ts`, `src/constants.ts`, `src/main.ts`, `src/wiki/wiki-engine.ts`, `src/ui/settings-sections/wiki-config-section.ts`, `src/ui/modals/IngestReportModal-class.ts`, `src/texts/*.ts` (11), `docs/PDF-OCR-GUIDE*.md`, `README*.md` |
| 3 | `src/main-commands/secret-storage-commands.ts` (delete), `src/main-commands/command-registry.ts`, `src/types.ts`, `src/main.ts`, `src/llm-sdk/provider-secret-store.ts`, `src/core/provider-auth.ts`, `src/ui/settings-sections/test-connection-section.ts`, `src/core/redact.ts` (new) |
| 4 | `src/core/egress-policy.ts` (new), `src/core/obsidian-fetch-bridge.ts`, `src/ui/settings-sections/model-section.ts`, `src/ui/settings-sections/provider-section.ts`, `scripts/check-bundle-hosts.mjs` (new) |
| 5 | `src/core/vault-writer.ts` (new), `src/core/folder-scope.ts`, 7 call-site files, `eslint.config.mjs` |
| 6 | `.github/workflows/*.yml`, `.github/dependabot.yml`, `.github/workflows/codeql.yml` + `gitleaks.yml` (new), `esbuild.config.mjs`, `scripts/verify-release.mjs` (new), `SECURITY.md` (new) |
| 7 | `UPSTREAM-MERGE.md` (new), `manifest.json` (`id`) |

---
*Assessment limitations: static review only; Obsidian `secretStorage` per-plugin isolation semantics were not empirically verified; `requestUrl` redirect behaviour was not tested against a live instance. Neither affects the plan's recommendations.*
