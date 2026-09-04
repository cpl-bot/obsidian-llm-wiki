# Hardening work — status & resume guide

**Last updated:** 2026-09-04 (session 1 wrap-up)
**Plan:** [`HARDENING-PLAN.md`](./HARDENING-PLAN.md) · **Baseline:** [`../../SECURITY-BASELINE.md`](../../SECURITY-BASELINE.md)
**Repo:** `cpl-bot/obsidian-llm-wiki` · **Integration branch:** `claude/multi-agent-plan-orchestration-uvvzcn`
(this is the fork's `harden/main`; upstream `main` is untouched at `2bd4a6d` = v1.27.0)

## How the work is organised

- One feature branch + PR per plan phase, named `harden/phase-N-<topic>`, based on and
  targeting the integration branch (never `main`).
- Each phase was implemented by an Opus sub-agent in its own `git worktree`
  (`/home/user/wt/<phase>`); the orchestrator (Fable) only pushes, opens PRs, reviews, merges.
- Commit messages: conventional `type(scope): subject`, body, mandatory
  `## Gate 4: Performance` table (see `AGENTS.md`), then the `Co-Authored-By` /
  `Claude-Session` trailers.
- Gate before every PR: `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm css-lint`
  (build **before** test). Baseline 267 files / 3792 tests.

## Phase status — ALL SEVEN PHASES MERGED (2026-09-04)

Integration branch head: `3498bbf`. Post-hardening numbers are in `SECURITY-BASELINE.md`
(281 files / 4,135 tests; `gate:1` and `check:reproducible` green).

| Phase | PR | Merge commit | Highlights |
|-------|----|--------------|-----------|
| 0 Baseline | — | `c6d15e2` | `SECURITY-BASELINE.md`, plan checked in |
| 1 Dependency hygiene | [#1](https://github.com/cpl-bot/obsidian-llm-wiki/pull/1) | `80535dd` | official-registry lockfile, fast-uri 3.1.7, ignore-scripts, `check:lockfile`, audit steps |
| 2.A MinerU removal | [#2](https://github.com/cpl-bot/obsidian-llm-wiki/pull/2) | `cdaeb28` | backend deleted, scrub migration, `check:bundle-mineru` |
| 3 Secret handling | [#7](https://github.com/cpl-bot/obsidian-llm-wiki/pull/7) | `3498bbf` | keychain-only fail-closed, plaintext scrub, `redact.ts`, Windows gate |
| 4 Egress policy | [#3](https://github.com/cpl-bot/obsidian-llm-wiki/pull/3) | `14b0e96` | `egress-policy.ts` + `egress-hosts.json`, `strictEgress`, `check:bundle-hosts` |
| 5 Vault write-gate | [#4](https://github.com/cpl-bot/obsidian-llm-wiki/pull/4) | `cf768b8` | `VaultWriter` incl. `process`/`rename`, ESLint enforcement |
| 6 CI supply chain | [#6](https://github.com/cpl-bot/obsidian-llm-wiki/pull/6) | `b1a7e89` | SHA-pinned actions, CodeQL + gitleaks, reproducible build, SBOM, `SECURITY.md` |
| 7 Governance | [#5](https://github.com/cpl-bot/obsidian-llm-wiki/pull/5) | `0bfad53` | `UPSTREAM-MERGE.md`, id `karpathywiki-hardened`, runtime plugin id |

Every PR was implemented by an Opus/Sonnet sub-agent, then independently reviewed by a
second agent that fixed its findings on the branch before merge (review notes are on each PR).

## Open items (not code, or deliberately deferred)

- **Operator tasks (plan 0.3 / 0.4 / 7.3):** disable community-plugin auto-update in every vault,
  uninstall the store build, rotate every provider key ever entered, set per-provider spend caps,
  configure a host egress firewall. See `UPSTREAM-MERGE.md`.
- **Repository settings (plan 6.8):** branch protection on the integration branch — required
  checks (Gate 1, CodeQL, gitleaks), no force-push, signed commits. Manual; listed in `SECURITY.md`.
- **Phase 2.B discretionary removals:** Codex OAuth, Bedrock SSO, unused providers,
  `AGENTS.md`/`CLAUDE.md`/`MEMORY.md`. Decide per deployment; one PR each; shrink
  `src/core/egress-hosts.json` accordingly.
- **Release workflow hardening (noted in PR #6 review):** `release.yml` still triggers on any tag
  and skips lint/test before building; consider restricting to `v*` tags and running `gate:1`.
- **Known limitations documented in code:** `requestUrl` follows redirects without re-validation;
  ESLint cannot catch a vault receiver renamed on assignment.
- Merging this integration branch into `main` (or making it the fork's default branch) is the
  owner's decision; nothing here touches `main`.

## Resume procedure (if more work is needed)
1. `git fetch origin && git checkout claude/multi-agent-plan-orchestration-uvvzcn && git pull`.
   `pnpm install --frozen-lockfile && pnpm build` (test suite reads `main.js`).
2. **Review + merge in this order:** PR #2 (MinerU) → PR #1 (deps) → PR #3 (egress).
   Use squash or merge into the integration branch. Suggested review: a Sonnet/Opus
   sub-agent running the `code-review` skill on each PR diff; fix findings on the PR branch.
   After merging PR #1 + #2 + #3, on the integration branch:
   - append `&& pnpm check:bundle-mineru && pnpm check:bundle-hosts` to the `gate:1` script
     (PR #1 already appends `check:lockfile`), run the gate, confirm `check:bundle-hosts` is
     green now that `mineru.net` is gone.
3. **Finish PR #4 (Phase 5):** in a worktree on `harden/phase-5-vault-write-gate`,
   `git merge origin/claude/multi-agent-plan-orchestration-uvvzcn` (expect a small conflict in
   `src/wiki/wiki-engine.ts` with the MinerU removal), then do the "Remaining work" list in the
   PR body, gate, push, mark ready, review, merge.
4. **Wave 2 (parallel worktrees):**
   - Phase 3 `harden/phase-3-secrets` — plan §Phase 3 tasks 3.1–3.8 (delete
     `secret-storage-commands.ts`, remove `settings.apiKey`, fail-closed `ProviderSecretStore.load()`,
     startup scrub, `src/core/redact.ts`, `Platform.isWin` gate, Linux Secret Service docs, tests).
   - Phase 7 `harden/phase-7-governance` — `UPSTREAM-MERGE.md`, manifest id
     `karpathywiki-hardened` (check tests that assert the id), install + ops runbook.
5. **Wave 3:** Phase 6 `harden/phase-6-ci` — SHA-pin actions, `dependabot.yml`, tightened
   `permissions:`, CI runs `check:lockfile` / `check:bundle-hosts` / `check:bundle-mineru` /
   `npm audit`, CodeQL + gitleaks workflows, reproducible build (`SOURCE_DATE_EPOCH`, double-build
   hash compare), `main.js.sha256` + SBOM on release, `scripts/verify-release.mjs`, `SECURITY.md`,
   branch protection on the integration branch (GitHub settings, manual).
6. Update this file and `SECURITY-BASELINE.md` (post-hardening hashes / test count) at the end.

## Sub-agent prompt skeleton (reuse)

Work only in worktree `<path>` on branch `<branch>`; read `docs/security/HARDENING-PLAN.md`
§Phase N and `AGENTS.md` (TDD, no eslint-disable/ts-ignore); do not touch other phases' files;
do not push or open PRs; gate must be green; 2–4 scoped conventional commits with the Gate 4
table and the two trailers; report commits, files, test delta, and anything incomplete.

## Known environment notes

- GitHub write access via the git proxy was intermittently 403 in session 1; it recovered
  without a change on our side. If it recurs: org admin installs the Claude GitHub App with
  write access, or reconnect GitHub under claude.ai Settings → Connectors.
- `pnpm audit` times out through the proxy; use `npm audit --registry=https://registry.npmjs.org/`.
- Worktrees live outside the repo at `/home/user/wt/*`; they are ephemeral to the container —
  everything of value is on the pushed branches.
