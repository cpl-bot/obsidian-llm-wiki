# Hardening work — status & resume guide

**Last updated:** 2026-09-04 (checkpoint 2 — all phases merged; integration head `75d72b0`)
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
- Gate before every PR: `pnpm gate:1` (lint, typecheck, build, test, css-lint, `check:lockfile`,
  `check:bundle-mineru`, `check:bundle-hosts`; build **before** test) plus `pnpm check:reproducible`.
  Pre-hardening baseline 267 files / 3792 tests; post-hardening 281 / 4135.
- Every PR was reviewed by a second sub-agent (review-and-fix pattern: findings fixed on the
  branch as one `fix(harden/phase-N): address review findings` commit, summary posted as a PR
  review comment, then squash-merged into the integration branch).

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

## What is left and how to pick it up

The plan itself is finished; the code is fully merged. What remains falls into three groups.

### A. Operator actions (no code; do these before installing the build)
1. In every vault: Settings → Community plugins → disable **Automatic updates**; uninstall the
   store build (`karpathywiki`). Install the hardened build per `UPSTREAM-MERGE.md` §Install
   (`<vault>/.obsidian/plugins/karpathywiki-hardened/`).
2. Rotate every provider API key ever entered into the store build; the hardened build will
   itself scrub and flag any plaintext key it finds in `data.json` on first load.
3. Set per-provider spend caps + billing alerts; configure a host egress firewall
   (Little Snitch / LuLu / OpenSnitch) alerting on new destinations for the Obsidian process.
4. GitHub → Settings → Branches: protect the integration branch (required checks Gate 1,
   CodeQL, gitleaks; no force-push; signed commits) — details in `SECURITY.md`.
5. Decide whether the integration branch becomes the fork's default branch / is merged to `main`.

### B. Optional follow-up PRs (each is one worktree + one Opus sub-agent + one review agent)
1. **Phase 2.B discretionary removals** — pick per deployment: OpenAI Codex OAuth
   (`src/llm-sdk/openai-codex/`, `codex-auth-commands.ts`, `openai-codex-auth-controls.ts`),
   AWS Bedrock SSO/IAM (`src/llm-sdk/bedrock-sso/`, `bedrock-auth-controls.ts`), unused
   providers, `AGENTS.md`/`CLAUDE.md`/`MEMORY.md`. After each removal shrink
   `src/core/egress-hosts.json` so `check:bundle-hosts` keeps the allowlist minimal.
2. **Release workflow tightening** — restrict `release.yml` to `v*` tags and run `pnpm gate:1`
   before building (pre-existing gaps noted in the PR #6 review).
3. **Dependency major upgrades** (`ai` 6→7, `@ai-sdk/*` 3→4, `zod` 3→4) — deliberately excluded
   from Phase 1; do as a separate PR now that the hardening controls are in place.
4. **First upstream merge** — follow `UPSTREAM-MERGE.md` when upstream ships > v1.27.0.

### C. Session bootstrap (for any of the above)
```bash
git fetch origin && git checkout claude/multi-agent-plan-orchestration-uvvzcn && git pull
pnpm install --frozen-lockfile && pnpm build      # tests read main.js
pnpm gate:1 && pnpm check:reproducible           # expect 281 files / 4135 tests, byte-identical
git worktree add /home/user/wt/<topic> -b harden/<topic> claude/multi-agent-plan-orchestration-uvvzcn
```
Then launch a sub-agent with the prompt skeleton below, review with a second agent, push the
branch, open a PR against the integration branch, post the review summary, squash-merge.

## Session history
- **Session 1 (checkpoint 1):** Phase 0 baseline; PRs #1–#4 opened (Phase 5 as draft).
- **Session 1 (checkpoint 2, this update):** all reviews done, PRs #1–#7 merged in order
  #2 → #3 → #5 → #1 → #4 → #6 → #7; post-hardening baseline recorded in `SECURITY-BASELINE.md`.
  Notable review catches: ungated `vault.process` at 12 sites, a `*.awsapps.com` wildcard in the
  egress allowlist, NAT64/IPv4-translated IPv6 bypasses, a plaintext key surviving the scrub when
  its marker was already set, two CI workflows that would have failed on first run.

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
  everything of value is on the pushed branches. All phase worktrees were removed after merge;
  the `harden/phase-*` remote branches remain as history and can be deleted.
- The registry audit endpoint occasionally returns 5xx; retry `npm audit` once before treating
  a failure as real.
- Sub-agent models: Opus for code phases and adversarial reviews, Sonnet for docs-heavy work;
  the orchestrator only merges, gates, and pushes.
