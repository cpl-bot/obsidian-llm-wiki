# Security Policy

This repository is a **hardened private fork** of the `karpathywiki` Obsidian
plugin. It is maintained for one deployment, not distributed through the
Obsidian community plugin store, and its security posture is documented in
[`SECURITY-BASELINE.md`](./SECURITY-BASELINE.md) and
[`docs/security/HARDENING-PLAN.md`](./docs/security/HARDENING-PLAN.md).

## Supported versions

| Version | Supported |
|---------|-----------|
| The current hardening integration branch of this fork | ✅ |
| Any tag or release of this fork other than the current one | ❌ |
| Upstream `karpathywiki` (any version, including the community store build) | ❌ |

Only the tip of this fork's integration branch receives fixes. There are no
backports: the fork exists to be rebuilt from source and installed locally, so
"upgrade" means "rebuild the current branch", not "wait for a patch release".

Vulnerabilities in **upstream** `karpathywiki` are not handled here. Report
those to the upstream project. If an upstream issue also affects this fork,
mention it in a report to us so the merge review
([Phase 7 / `UPSTREAM-MERGE.md`](./UPSTREAM-MERGE.md), the upstream-merge
runbook) can account for it.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security
problem.** A public report on a plugin that holds provider API keys and has
full vault read access is a disclosure to everyone running it at the same time
as it is a disclosure to the maintainer.

Use GitHub **private vulnerability reporting** on this repository:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** (Security advisories → private reporting).
3. Include: affected commit or tag, the code path, what an attacker gains,
   reproduction steps, and — if it involves egress — the destination host.

If private reporting is disabled for this repository, open a **draft security
advisory** (Security → Advisories → New draft advisory) instead, or contact the
repository owner through their GitHub profile. Do not send secrets, vault
contents, or live API keys with a report; a redacted excerpt is enough.

**Expectations.** This is a single-maintainer fork with no on-call rotation.
Acknowledgement is best-effort, typically within a week. There is no bounty.
Fixes land on the integration branch and are announced in the advisory; the
operator rebuilds and reinstalls per the install procedure.

## Scope

### In scope

- Anything in `src/` that ships inside `main.js`.
- The build and release pipeline: `esbuild.config.mjs`, `scripts/*.mjs`,
  `.github/workflows/**`, `.github/dependabot.yml`, the lockfiles, `.npmrc`.
- The egress policy and its chokepoint (`src/core/egress-policy.ts`,
  `src/core/obsidian-fetch-bridge.ts`) — in particular any way to reach a host
  that is not on the allowlist, or to send a credential over cleartext HTTP.
- The secret path: any way a provider API key reaches disk, a log, a note, or a
  request to a destination other than the configured provider.
- Vault writes that land outside the configured wiki folder.
- Anything that makes the build non-reproducible, or that lets a released
  artifact differ from a rebuild of its tag (see "Verifying a release" below).

### Out of scope

These are real risks; they are simply not fixable in this repository, and
reports about them will be closed with a pointer rather than a patch.

- **Obsidian core and its plugin API** — sandboxing, permission model, plugin
  auto-update behaviour. Report to Obsidian.
- **Electron / Chromium / Node** as shipped inside Obsidian. This plugin cannot
  choose or patch those versions. Report upstream.
- **The OS keychain** — macOS Keychain, and the freedesktop Secret Service
  (gnome-keyring / KWallet) on Linux. The plugin stores secrets there and fails
  closed when the keychain is unavailable; the keychain's own security is the
  platform's responsibility. Windows is an unsupported platform for this fork.
- **LLM provider infrastructure** — what a provider does with a prompt, its
  retention policy, its authentication, or a compromise on its side. Choose
  providers accordingly and use a per-provider key with a spend cap.
- **Model behaviour** — hallucination, prompt injection carried in a note the
  user chose to ingest, or unwanted content in generated pages. Treat generated
  wiki pages as untrusted text.
- **Third-party Obsidian plugins** installed alongside this one. Any plugin in a
  vault can read any other plugin's `data.json`.
- Findings that require an attacker to already have local code execution as the
  user, or write access to this repository.

## Verifying a release

Provenance attestation proves an artifact came out of this repository's CI. It
does not prove the source that went in is the source you read. The hash
comparison does:

```bash
git fetch --tags
pnpm verify:release <tag>      # downloads the released main.js, rebuilds the
                               # tag in a throwaway worktree, diffs sha256
pnpm check:reproducible        # two builds of this tree must be byte-identical
```

Every release from v1.27.0 onward carries `SHA256SUMS` and `sbom.json`
alongside `main.js`, `manifest.json`, and `styles.css`. A mismatch is not proof
of an attack — check `pnpm check:reproducible` first, because a
non-deterministic build makes the comparison meaningless — but it is a reason
to stop and not install the artifact.

## Repository settings (manual)

The following cannot be configured from files in the repository. They must be
set once, by hand, in **Settings → Branches** and **Settings → Code security**
on GitHub. Until they are set, the checks below run but nothing enforces that
they passed — a green workflow that a merge can ignore is documentation, not a
control (HARDENING-PLAN Phase 6.8).

**Branch protection on the integration branch (and `main`):**

- **Require a pull request before merging.** No direct pushes.
- **Require status checks to pass before merging**, and require branches to be
  up to date first. Required checks:
  - `Gate 1 / Five-Gate` — carries lint, typecheck, build, test, css-lint, the
    lockfile registry check, both bundle tripwires, the two `npm audit` steps,
    and the reproducible-build check.
  - `Analyze (javascript-typescript)` — CodeQL.
  - `Scan history for secrets` — gitleaks.
- **Require signed commits.** Every commit on the protected branch must carry a
  verified signature. This is what makes "who wrote this line" answerable after
  an account compromise.
- **Do not allow force pushes**, and **do not allow deletions**. History on a
  branch whose artifacts are attested must be append-only, or a tag can be
  moved under a build that was already verified.
- **Do not allow bypassing the above**, including for administrators.
- **Require conversation resolution before merging.**

**Repository-level security settings:**

- **Private vulnerability reporting: enabled** (Settings → Code security). This
  is what makes the reporting path above exist.
- **Dependabot alerts and security updates: enabled.** `.github/dependabot.yml`
  schedules the version updates; the alerts are a separate switch.
- **Secret scanning + push protection: enabled** where available. The gitleaks
  workflow scans history; push protection stops the commit being made at all.
- **Actions permissions:** allow only actions used by this repository and
  GitHub-verified creators. Workflow permissions default to **read-only**;
  every write scope is granted per-job in the workflow file.
- **Tag protection** on `v*` so a release tag cannot be moved after its
  artifacts have been attested and hashed.

## Related documents

- [`SECURITY-BASELINE.md`](./SECURITY-BASELINE.md) — the pre-hardening
  measurements every later change is diffed against (build hashes, bundle
  hostnames, audit counts, gate results).
- [`docs/security/HARDENING-PLAN.md`](./docs/security/HARDENING-PLAN.md) —
  findings F-01 … F-10 with evidence, and the phased work plan that closes
  them.
- [`UPSTREAM-MERGE.md`](./UPSTREAM-MERGE.md) — the upstream-merge review
  runbook (Phase 7): what to diff, what to look for, and the operational
  controls that live outside the repository.
