# Security Baseline — hardening fork of `karpathywiki` v1.27.0

Recorded 2026-09-04 from a clean clone at commit `2bd4a6d`
(upstream `main`, plugin version 1.27.0) **before** any hardening change.
This file is the reference point for the hardening work plan
(`docs/security/HARDENING-PLAN.md`) and for every later upstream merge:
re-run the commands below and diff against these numbers.

## Toolchain

| Item | Value |
|------|-------|
| Node | v22.22.2 |
| pnpm | 10.14.0 (`packageManager` pin) |
| Install | `pnpm install --frozen-lockfile` |

## Build artefacts (`pnpm build`, production)

| Artefact | sha256 |
|----------|--------|
| `main.js` | `e888afa0de9c5438da4f354882c591cc6b6048e3ea63f20b3184503febc94264` |
| `styles.css` | `23f9bdc6dbe57ccf92b4d96818e69086f6ede34657283248e7175a2d3350a47c` |

`main.js`: 87,563 lines, not minified. `grep -c mineru main.js` → **120**.

### Hostnames present in the bundle (`grep -oE 'https?://[a-zA-Z0-9.-]+' main.js | sort -u`)

```
http://json-schema.org
http://localhost
https://ai-gateway.vercel.sh
https://ai-sdk.dev
https://api.anthropic.com
https://api.deepseek.com
https://api.example.com
https://api.minimaxi.com
https://api.moonshot.cn
https://api.openai.com
https://auth.openai.com
https://bedrock-mantle.          (prefix; region appended at runtime)
https://chatgpt.com
https://cookbook.openai.com
https://d-xxxxxxxxx.awsapps.com  (placeholder)
https://developer.mozilla.org
https://developers.openai.com
https://docs.anthropic.com
https://example.com
https://generativelanguage.googleapis.com
https://github.com
https://json-schema.org
https://mineru.net
https://oidc.                    (prefix; AWS SSO OIDC, region appended)
https://open.bigmodel.cn
https://openrouter.ai
https://platform.claude.com
https://platform.openai.com
https://portal.sso.              (prefix; AWS SSO portal, region appended)
https://vercel.com
```

## Quality gate (Gate 1)

| Check | Result |
|-------|--------|
| `pnpm lint` | 0 errors / 0 warnings |
| `pnpm typecheck` | clean |
| `pnpm build` | clean |
| `pnpm test` | **267 files / 3,792 tests** passed |
| `pnpm css-lint` | 0 violations |

## Dependency audit (`npm audit --json`, official registry)

| Severity | Count |
|----------|-------|
| critical | 0 |
| high | **1** (`fast-uri` 3.0.0 – 3.1.5: GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp; fix 3.1.7) |
| moderate | 0 |
| low | 0 |

Dependency tree: 434 packages (15 prod, 420 dev, 52 optional).

### Lockfile registry hygiene

| Lockfile | `registry.npmmirror.com` refs | `registry.npmjs.org` refs |
|----------|-------------------------------|---------------------------|
| `package-lock.json` | **358** | 76 |
| `pnpm-lock.yaml` | 0 | n/a (pnpm stores no resolved URLs) |

## Operational items outside the repository (Phase 0.3 / 0.4)

These cannot be performed from the codebase and must be done by the operator:

- [ ] In every Obsidian vault that will use this fork: Settings → Community
      plugins → disable **Automatic updates**; uninstall the store version.
- [ ] Rotate every provider API key that was ever entered into the store
      version (removes doubt about `data.json` history).

---

# Post-hardening baseline — integration branch at `3498bbf` (2026-09-04)

All seven phases of the plan are merged (PRs #1–#7). Re-run the same commands and
diff against these numbers after every upstream merge (see `UPSTREAM-MERGE.md`).

## Build artefacts (`pnpm build`, production; two builds byte-identical)

| Artefact | sha256 |
|----------|--------|
| `main.js` | `28dabfc26c335e7cffdf9ea65c5bac88b76da03678235f372a042dd2294faa8d` |
| `styles.css` | `9389fbb5c9d55ebb3e0ac92d2a6f88e4c5c7bcc48a7266a6032101521121498c` |

`main.js`: 87,553 lines. `grep -c mineru main.js` → **0**. `grep -c 'settings.apiKey' main.js` → **0**.
`manifest.json` id → `karpathywiki-hardened`.

## Bundle hostnames (`check:bundle-hosts`: 28 hosts, all accounted for in `src/core/egress-hosts.json`)

Same list as the pre-hardening baseline minus `mineru.net`. Fetch-allowlisted provider hosts
are enforced at runtime by `src/core/egress-policy.ts`; the rest are documentation-only
strings (`ai-gateway.vercel.sh` is present in the `ai` SDK but blocked by policy).

## Quality gate (`pnpm gate:1` = lint, typecheck, build, test, css-lint, check:lockfile, check:bundle-mineru, check:bundle-hosts)

| Check | Result |
|-------|--------|
| all eight steps | green |
| tests | **281 files / 4,135 tests** (pre-hardening 267 / 3,792; the 2 removed files were MinerU-only) |
| `pnpm check:reproducible` | two builds byte-identical |
| `pnpm typecheck:tools` | clean |

## Dependency audit

`npm audit --audit-level=high` → **0 high / 0 critical** (verified during the PR #1 review; the
registry audit endpoint returned transient 5xx errors at the time of this final run — re-run
if in doubt). `package-lock.json` mirror refs → **0**; `fast-uri` resolves to 3.1.7.

## Findings closed

| Finding | Closed by |
|---------|-----------|
| F-01 auto-update supply chain | Phase 6 (detection: tripwires, reproducible build, SBOM, provenance) + Phase 7 (distinct plugin id, manual install, runbook) + Phase 4 (egress allowlist) |
| F-02 mirror lockfile | Phase 1 (#1) |
| F-03 plaintext key in data.json | Phase 3 (#7) |
| F-04 no egress control | Phase 4 (#3) |
| F-05 fast-uri advisories | Phase 1 (#1) |
| F-06 MinerU upload | Phase 2.A (#2) |
| F-07 tag-pinned actions | Phase 6 (#6) |
| F-08 no write-gate | Phase 5 (#4) |
| F-09 vestigial deps | Phase 1 (#1) |
| F-10 process gaps | Phase 6 (#6) |
