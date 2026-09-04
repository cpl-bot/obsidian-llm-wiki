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

## Phase status

| Phase | Branch / PR | State | Gate | Notes |
|-------|-------------|-------|------|-------|
| 0 Baseline | integration branch, commit `c6d15e2` | **done** | n/a | `SECURITY-BASELINE.md`; plan checked in. Operator items 0.3/0.4 (disable auto-update, rotate keys) are outside the repo — still open. |
| 1 Dependency hygiene | `harden/phase-1-deps` → [PR #1](https://github.com/cpl-bot/obsidian-llm-wiki/pull/1) | **ready for review** | green, 268/3810, audit 0 high | Tasks 1.1–1.6 complete. |
| 2.A MinerU removal | `harden/phase-2-mineru-removal` → [PR #2](https://github.com/cpl-bot/obsidian-llm-wiki/pull/2) | **ready for review** | green, 265/3793 | Tasks 2.1–2.8 complete. `grep -c mineru main.js` = 0. **Merge first.** |
| 2.B Discretionary removals | — | not started (deliberately) | | Decide per deployment: Codex OAuth, Bedrock SSO, unused providers, `AGENTS.md`/`CLAUDE.md`/`MEMORY.md`. One PR each. |
| 3 Secret handling | — | not started | | Blocked on PR #2 merge (shared `types.ts`, `main.ts`, `src/texts/*`). |
| 4 Egress policy | `harden/phase-4-egress-policy` → [PR #3](https://github.com/cpl-bot/obsidian-llm-wiki/pull/3) | **ready for review** | green, 271/3880 | Tasks 4.1–4.6 complete. `check:bundle-hosts` fails only on `mineru.net` until PR #2 merges. |
| 5 Vault write-gate | `harden/phase-5-vault-write-gate` → [PR #4 (draft)](https://github.com/cpl-bot/obsidian-llm-wiki/pull/4) | **WIP** | typecheck FAIL, 32 tests fail | 5.1 + 5.4 done (`2a4278f`); 5.2 mostly done (`b82435b`); 5.3 (ESLint rule) not started. Remaining steps listed in the PR body. |
| 6 Build & CI supply chain | — | not started | | Depends on PR #1 (CI steps), PR #3 (tripwire script), PR #2 (host list). |
| 7 Update governance | — | not started | | `UPSTREAM-MERGE.md`, `manifest.json` id → `karpathywiki-hardened`, install runbook, ops controls, quarterly checklist. |

## Resume procedure (next session)

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
