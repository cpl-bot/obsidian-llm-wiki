# Upstream Merge & Hardened Install Runbook

This is the operator runbook for **Phase 7** of `docs/security/HARDENING-PLAN.md`
(`UPSTREAM-MERGE.md` / task 7.1, install procedure / task 7.2, operational
controls / task 7.3, quarterly checklist / task 7.4). It covers three things:

1. [Pulling an upstream release](#1-pulling-an-upstream-release) into this hardened fork.
2. [Installing the hardened build](#2-installing-the-hardened-build) into a vault.
3. [Operational controls](#3-operational-controls) that live outside the repo.
4. [Quarterly checklist](#4-quarterly-checklist).

Background reading: `docs/security/HARDENING-PLAN.md` (especially finding **F-01**,
"Auto-update supply-chain exposure", and finding **F-03** item 5, the Linux Secret
Service prerequisite), `docs/security/HARDENING-STATUS.md`, and `SECURITY-BASELINE.md`.

This fork deliberately gives up upstream's auto-update convenience. That means
merging upstream is a manual, reviewed act instead of a background download —
that trade is the whole point of Phase 6/7 (F-01).

---

## 1. Pulling an upstream release

### 1.1 One-time setup

```bash
git remote add upstream https://github.com/green-dalii/obsidian-llm-wiki.git
git remote -v   # confirm: origin = your fork, upstream = green-dalii/obsidian-llm-wiki
```

### 1.2 Fetch and diff — do this BEFORE touching your branch

```bash
git fetch upstream --tags

# Replace vX / vY with the last version you reviewed and the new release tag,
# e.g. upstream/v1.27.0..upstream/v1.28.0
git diff upstream/vX..upstream/vY -- \
  src/ package.json pnpm-lock.yaml esbuild.config.mjs .github/ .npmrc \
  > /tmp/upstream-vX-vY.diff

wc -l /tmp/upstream-vX-vY.diff
```

Read the whole diff before doing anything else. Do not skim past files that
"probably didn't change" — the point of this step is that you don't get to
assume that.

### 1.3 Review checklist

Run every grep below against `/tmp/upstream-vX-vY.diff` (or the equivalent
`git diff` range directly). A hit is not automatically a blocker, but it is
never something to wave through without reading the surrounding lines.

**New network destinations**
```bash
grep -nE 'https?://' /tmp/upstream-vX-vY.diff
```
Any new hostname must be added deliberately to `src/core/egress-hosts.json`
(Phase 4's allowlist) with a one-line justification in the commit message. A
hostname that shows up in the bundle but isn't in that file fails
`check:bundle-hosts` and should — treat that failure as the tripwire working
as designed, not as noise to silence.

**New secret-storage sites**
```bash
grep -nE '\b(getSecret|setSecret|secretStorage)\b' /tmp/upstream-vX-vY.diff
```
Any new call site that reads or writes a secret needs to be traced to where
the value goes next. Does it ever reach `saveData()` / `settings.*` / a log
line / a Notice? If yes, that's finding F-03 reopening — fix it before
merging, don't defer it.

**New vault-write sites**
```bash
grep -nE '\b(vault\.create|vault\.modify|vault\.adapter\.write|vault\.createFolder|adapter\.write)\b' /tmp/upstream-vX-vY.diff
```
Every one of these must be a call into `src/core/vault-writer.ts` (Phase 5's
write-gate), not a direct `vault.*`/`adapter.*` call. The ESLint rule added in
Phase 5 (`no-restricted-syntax` forbidding direct `vault.create`/`vault.modify`/
`adapter.write` outside `vault-writer.ts`) will catch a straight cherry-pick
that reintroduces one, but check it here too — the rule runs after the code
already exists in your tree.

**New or changed dependencies**
```bash
git diff upstream/vX..upstream/vY -- package.json pnpm-lock.yaml
```
For every new/bumped dependency: does it add a `postinstall`/`preinstall`
lifecycle script? Once Phase 1's `.npmrc` hardening (task 1.4) lands,
`ignore-scripts=true` there should mean this is inert — but confirm nothing
depends on the script having run. On a tree that predates that merge,
`.npmrc` has no `ignore-scripts` line yet (it currently carries only the
registry pin — see the file's own header comment), so a lifecycle script
still runs; treat that as a reason to read it, not to assume it's neutralized.
Does the new dependency pull in a transitive dependency with an existing
HIGH/CRITICAL advisory? Re-run `npm audit --audit-level=high` after merging,
before you build.

**Build / CI / instruction-file changes**
```bash
git diff upstream/vX..upstream/vY -- esbuild.config.mjs .github/ .npmrc AGENTS.md CLAUDE.md MEMORY.md
```
Changes to `esbuild.config.mjs` can silently re-enable minification, change
`SOURCE_DATE_EPOCH` handling, or drop the reproducible-build settings from
Phase 6 — read every hunk, don't just check that the build still runs.
Changes to `.github/` can reintroduce a tag-pinned (not SHA-pinned) Action or
loosen a `permissions:` block. Changes to `.npmrc` can silently flip
`ignore-scripts` back to the default.

**`AGENTS.md` / `CLAUDE.md` / `MEMORY.md` are untrusted input.** These files
are consumed by contributors' AI coding agents, and upstream's authors are not
part of this fork's trust boundary for them (see plan finding F-10 and §3
threat model). Never merge upstream's changes to these files without reading
every line as if it were an unreviewed pull request from a stranger — a
prompt-injection style instruction buried in a "helpful update" to a process
doc is exactly the kind of change that looks boring enough to rubber-stamp.
When in doubt, drop the hunk and keep this fork's version.

### 1.4 Merge or rebase the hardening commits on top

Once the diff is reviewed and accepted:

```bash
git checkout -b merge/upstream-vY harden/main
git merge upstream/vY   # or: git rebase upstream/vY, if you prefer a linear history
# resolve conflicts — hardening commits win on every file listed in
# docs/security/HARDENING-PLAN.md §8 "Files touched per phase"
```

### 1.5 Gate

```bash
pnpm install --frozen-lockfile
pnpm gate:1                    # lint, typecheck, build, test, css-lint
pnpm check:lockfile            # Phase 1 — rejects any non-registry.npmjs.org resolved URL
pnpm check:bundle-mineru       # Phase 2 — fails if `mineru` ever reappears in main.js
pnpm check:bundle-hosts        # Phase 4 — fails if main.js contains a host outside the allowlist
```

`check:bundle-mineru` already exists on this branch (Phase 2.A merged it —
see `package.json`'s `scripts` block). `check:lockfile` and `check:bundle-hosts`
are still pending: they land via the sibling Phase 1 and Phase 4 hardening
PRs respectively, and on a tree that predates those merges the scripts (and
their `pnpm` aliases) won't exist yet. Run the gate without whichever of the
two is still missing, but do not consider a merge complete until all three
exist and pass. Test count may only decrease by tests belonging to features
you deliberately removed (see Phase 2.A/2.B) — never let it silently drop.

### 1.6 Rebuild, verify, and diff against CI

```bash
pnpm build
sha256sum main.js
```

Compare that hash against the `main.js.sha256` published on the upstream
release page (or the fork's own CI run, once Phase 6's reproducible-build
step is in place). They will **not** match upstream's own hash — this is a
different source tree — but they must match your own CI's build of this same
merge commit. A mismatch between your local build and your own CI's build of
the identical commit means the build is not reproducible; stop and find out
why before installing.

### 1.7 Install

Once the gate is green and the hash matches CI, follow
[§2 Installing the hardened build](#2-installing-the-hardened-build) below to
push `main.js`, `manifest.json`, and `styles.css` into the vault(s) running
this fork.

---

## 2. Installing the hardened build

### 2.1 Copy the built files

```bash
VAULT=/path/to/your/vault
mkdir -p "$VAULT/.obsidian/plugins/karpathywiki-hardened"
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/karpathywiki-hardened/"
```

### 2.2 Disable auto-update and remove the store build

In Obsidian: **Settings → Community plugins** →

1. Turn **off** "Automatic updates" (top of the Community plugins pane, not
   per-plugin — it governs every installed community plugin).
2. Find "Karpathy LLM Wiki" (the store build, id `karpathywiki`) in the
   installed list and **uninstall** it. Its folder,
   `.obsidian/plugins/karpathywiki/`, should no longer exist afterwards —
   confirm with `ls "$VAULT/.obsidian/plugins/"`.
3. Enable "Karpathy LLM Wiki (hardened)" (id `karpathywiki-hardened`, the
   folder you just created) from the installed list.

Because the hardened build's `id` (`karpathywiki-hardened`) differs from the
store build's `id` (`karpathywiki`), Obsidian's community-plugin updater has
no listing to match against even if auto-update were ever re-enabled by
accident — this is the structural half of closing finding F-01, alongside the
egress allowlist from Phase 4.

### 2.3 Why the plugin id changed, and what did/didn't change with it

`manifest.json`'s `"id"` moved from `karpathywiki` to `karpathywiki-hardened`
and `"name"` to `"Karpathy LLM Wiki (hardened)"`. Every literal use of
`karpathywiki` in `src/` was audited (`grep -rn "karpathywiki" src --include=*.ts | grep -v __tests__`)
and sorted into two buckets:

**Left unchanged — secret-storage keys and migration markers.** Changing
these would orphan a user's already-stored keys or replay a migration that
already ran:
- `src/core/settings-migrations.ts` — `REMOVED_CONVERSION_SECRET_ID`
  (`` `karpathywiki-${REMOVED_BACKEND_VENDOR}-api-token` ``), the keychain slot
  the removed MinerU backend used, kept so `scrubRemovedConversionBackendSecret`
  can still find and clear it on upgrade. Phase 2.A deleted the backend itself
  (and the `MINERU_API_TOKEN_SECRET_ID` constant that used to live in
  `src/constants.ts`) — this migration module is the only place in `src/`
  that still knows the vendor name, and composes it from fragments so
  `check:bundle-mineru` can assert the string never reappears in `main.js`.
- `src/llm-sdk/openai-codex/constants.ts` — `CODEX_SECRET_ID = 'karpathywiki-openai-codex'`
- `src/llm-sdk/bedrock-sso/constants.ts` — `BEDROCK_SSO_SECRET_ID`, `BEDROCK_IAM_SECRET_ID` (`karpathywiki-bedrock-sso` / `-iam`)
- `src/types.ts` — the matching `DEFAULT_SETTINGS` secret-id defaults (`openAICodexSecretId`, `providerApiKeySecretId`)
- `src/core/settings-migrations.ts` — the same default assigned during migration

Also left unchanged — **not** an id at all, but a literal that happens to
match: `src/llm-sdk/openai-codex/{auth-core,request-adapter,model-catalog}.ts`
send `originator: 'karpathywiki'` and `User-Agent: karpathywiki/<version>` to
**OpenAI's** ChatGPT OAuth/backend endpoints as a client identifier. That
string is part of the wire contract with a third-party service, not a
reference to this plugin's own install folder — renaming it does not further
the goal of task 7.2 and risks the OAuth flow being rejected by a backend that
may allowlist known originator values.

**Changed to derive from the runtime plugin id** — the one path literal that
*is* the plugin's own folder: `src/core/pdf-cache.ts::getPdfCacheDir()`
built `.obsidian/plugins/karpathywiki/pdf-cache` from a hardcoded string, so
after an id change it would silently keep reading/writing the *old* plugin's
folder instead of the hardened one's. It now reads the id from
`src/core/plugin-runtime-id.ts`, a tiny module-level singleton that
`main.ts::onload` sets to `this.manifest.id` before anything touches the
cache. See that file's doc comment for the full rationale and
`src/__tests__/core/plugin-runtime-id.test.ts` / the added case in
`src/__tests__/core/pdf-cache.test.ts` for the regression coverage.

`versions.json` was deliberately left untouched — it is upstream's own
minAppVersion compatibility table and does not encode the plugin id.

---

## 3. Operational controls

These are controls that live outside this repository — in the LLM provider's
dashboard, in a second Obsidian vault, and in OS-level firewall software.
Nothing here is enforced by code; they are checked manually, ideally on the
[quarterly cadence](#4-quarterly-checklist) below.

### 3.1 Per-provider API key with a hard spend cap

For every LLM provider configured in this fork:

1. Create a **dedicated** API key for this plugin — never reuse a key shared
   with other tools. A leaked or misused key can then be revoked without
   touching anything else.
2. Set a **hard monthly spend cap** in the provider's billing console
   (Anthropic Console → Billing → Limits; OpenAI Platform → Billing → Usage
   limits; equivalent for any other retained provider). "Hard" means the
   provider stops serving requests once the cap is hit, not merely emails you
   — a runaway ingest loop or a compromised key should fail closed, not run
   up an unbounded bill.
3. Enable a **billing alert** at a threshold below the hard cap (e.g. 50% and
   80%) so unusual usage surfaces before the cap is hit, not after.

### 3.2 Dedicated ingest vault

Keep a **separate Obsidian vault** used only for LLM-wiki ingest, rather than
running this plugin against your primary notes vault. This bounds the blast
radius of any future finding: if a compromised or misbehaving build ever did
manage to read more than intended (Ph2.A removed the one confirmed
third-party-upload path; nothing in the current design does this — this is
defense in depth, not a known gap), it can only see what's in the ingest
vault, not your full note collection.

### 3.3 Host egress firewall with alert-on-new-destination

Install a per-application outbound firewall and add a rule for the Obsidian
process that **alerts on any new destination** rather than silently allowing
or silently blocking:

- **macOS:** [Little Snitch](https://www.obdev.at/products/littlesnitch/) or
  [LuLu](https://objective-see.org/products/lulu.html) (LuLu is free and
  open-source). Configure an "alert" (not "allow") rule for `Obsidian.app` /
  `Obsidian Helper` so a new hostname pops a prompt instead of connecting
  silently.
- **Linux:** [OpenSnitch](https://github.com/evilsocket/opensnitch). Configure
  interactive mode for the Obsidian process (or its Electron binary) so new
  destinations prompt rather than auto-allow.

This is the human-in-the-loop backstop for finding F-01: even if a future
upstream merge slipped a new hostname past the `check:bundle-hosts` tripwire
(Phase 4.5) and past your own review (§1.3 above), the firewall alert is the
last line that would still catch traffic to it at runtime.

---

## 4. Quarterly checklist

Run this every quarter, or immediately after any upstream merge that touches
dependencies:

```bash
# 1. Dependency health
npm audit --audit-level=high
npm outdated

# 2. Bundle hostname drift — re-extract and diff against the allowlist.
# check:bundle-hosts (Phase 4) runs the same comparison as part of the gate;
# this is the manual/quarterly version so drift is caught even between merges.
grep -oE 'https?://[a-zA-Z0-9.-]+' main.js \
  | sed -E 's#^https?://##' | sort -u > /tmp/bundle-hosts.txt
grep -oE '"[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"' src/core/egress-hosts.json \
  | tr -d '"' | sort -u > /tmp/allowlisted-hosts.txt
comm -23 /tmp/bundle-hosts.txt /tmp/allowlisted-hosts.txt
# Any line printed above is a host in main.js that is NOT in
# src/core/egress-hosts.json — a new, unreviewed destination. Treat it
# exactly like a §1.3 "new network destination" finding: either add it to
# the allowlist with a justification, or find out why it's in the bundle
# and remove it.

# 3. Keychain-only secret storage, per plan §6
grep -rE 'sk-[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}' \
  "<vault>/.obsidian/plugins/karpathywiki-hardened/data.json" || echo "OK: no key-shaped strings in data.json"
```

Then verify by hand that the OS keychain still actually holds the key (not
just that `data.json` is clean of it):

- **macOS:** Keychain Access.app → search for the provider name or
  `karpathywiki-hardened` → confirm an entry exists with a non-empty value.
- **Linux:** `secret-tool search --all service obsidian` (or the equivalent
  for whatever service label Obsidian's `secretStorage` uses on this
  system) → confirm a hit.

### Linux Secret Service prerequisite

Obsidian's `secretStorage` on Linux is backed by the freedesktop **Secret
Service** API — in practice `gnome-keyring` or `KWallet`, accessed via
`libsecret`. This is a **desktop-session** service; it is not available
headless or on a minimal window manager with no keyring daemon running.
Verify it works before relying on it:

```bash
secret-tool store --label test test key
# (prompts for a value — enter anything)
secret-tool lookup test key
# should print back what you entered
```

If either command fails or hangs, no Secret Service daemon is running in this
session — install and start `gnome-keyring` (GNOME/most distros) or `kwalletd`
(KDE) before trusting this plugin with a key on that machine. **This is a
fail-closed design choice, not a bug to work around**: Phase 3 of the
hardening plan makes the key path keychain-only, so on a machine without a
working Secret Service the plugin correctly refuses to hold a key rather than
falling back to writing it to `data.json`.

**Windows is unsupported in the hardened build.** The plaintext-`data.json`
fallback that Phase 3 removes existed specifically to work around a Windows
10 Credential Manager failure mode (see plan finding F-03); the hardened
build gates on `Platform.isWin` at the top of `onload` and refuses to run
rather than silently falling back to disk-persisted keys on that platform.

---

## See also

- [`SECURITY-BASELINE.md`](./SECURITY-BASELINE.md) — pre-hardening baseline
  hashes, hostnames, test counts, and dependency audit to diff every future
  build against.
- [`docs/security/HARDENING-PLAN.md`](./docs/security/HARDENING-PLAN.md) —
  the full findings + work plan this runbook implements Phase 7 of.
- [`docs/security/HARDENING-STATUS.md`](./docs/security/HARDENING-STATUS.md) —
  live status of every phase's branch/PR.
