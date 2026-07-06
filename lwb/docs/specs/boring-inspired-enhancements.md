# Spec: boring-computers-inspired enhancements to lwb

Six abstract enhancements surfaced by comparing `lwb` (stateless CLI over one
shared no-mount Lima VM; git is the only database) with
[`boring-computers`](https://github.com/michaelshimeles/boring-computers)
(stateful Go control plane minting a Firecracker microVM per workspace). Each
idea below translates a boring-computers primitive into lwb's vocabulary
*without* importing a daemon, per-workspace kernels, or an embedded agent.

## Invariants every feature must preserve

These are lwb's load-bearing properties. A spec that violates one is wrong.

1. **Git is the only database.** No new host state, no config files, no lock
   files. Anything a feature "remembers" must be derivable from git (branches,
   worktree registry, commit/reflog) or from the guest filesystem lwb already
   owns (`~/lwb/`). Workspace *lineage* is recorded by branch ancestry, not by us.
2. **No host filesystem mounts.** The only things crossing the Mac/Linux
   boundary stay: commands in (via `linux()` / `guestCommand()`), git diffs out.
3. **Transport-agnostic.** Every guest interaction goes through `linux()` /
   `guestCommand()`, so it works identically under `limactl shell` and
   `LWB_SSH`. No feature may hardcode `limactl`.
4. **Tilde is not expanded** across `limactl shell` argv. Build absolute guest
   paths with `guestPath()`; never pass a literal `~/...` as argv.
5. **`fail()` convention.** Errors print `lwb: <msg>` to stderr and exit 1.
6. **Backward compatibility.** Existing invocations and stdout shapes are a
   public contract. New behavior is additive and flag-gated; default output of
   `ls`/`diff`/`gc`/`doctor`/`destroy`/`create` is byte-for-byte unchanged when
   no new flag is passed.

## Shared plumbing (implement once, reuse across features)

### `--json` global flag

- Parse in `main()` **before** dispatch: split `argv` at the first `--`
  separator; strip a single `--json` token from the *head* only (so
  `lwb exec <id> -- foo --json` passes `--json` through to the guest command
  untouched). Set a module-level `let jsonOutput = false`.
- Helper: `function printJson(value: unknown): void { console.log(JSON.stringify(value, null, 2)); }`
- Commands that honor it: `ls`, `create`, `fork`, `diff`, `doctor`, `destroy`,
  `gc`. A command that does not recognize `--json` simply ignores the (already
  stripped) flag.

### Reusable destroy-guard predicate

Extract the existing bash guard in `cmdDestroy` (lines ~652–673) into a pure
string builder so `gc --reap` can reuse the identical safety check:

```ts
// Returns bash that exits 0 iff the workspace at `path` holds NO work that
// exists only in the VM (clean tree AND no commits ahead of default branch's
// merge-base). Exits 3 with a human-readable report otherwise; other non-zero
// means "could not verify" (fail closed).
function unfetchedWorkGuard(path: string): string { /* the current script */ }
```

`cmdDestroy` keeps its current behavior by calling `unfetchedWorkGuard(workspace.path)`.

### Test seam

Guard the entry point so pure helpers can be imported hermetically:

```ts
if (import.meta.main) main();
```

Export the pure helpers the tests exercise: `parseDuration`, `cpuQuota`,
`splitJsonFlag` (the argv splitter). No behavior change; enables unit tests
without a live VM.

---

## Feature 1 — `lwb fork <id> [--name <newid>] [--dirty] [--json]`

**Idea (from boring's ~35 ms live fork).** Make the workspace graph a *tree*:
branch a new workspace from an existing workspace's HEAD instead of always from
the bare repo's default branch. Git already stores the lineage; no new state.

**CLI.** `lwb fork <source-id> [--name <id>] [--dirty]`
- `source-id`: resolved with `findWorkspace()` (accepts `<repo>/<id>`).
- `--name`: new id; else a unique random id (reuse `cmdCreate`'s uniqueness
  loop against `listWorkspaces()`).
- `--dirty`: also replay the source's *uncommitted* state (tracked + untracked)
  into the fork. Default is HEAD-only (fully git-native, deterministic).

**Mechanism.**
1. `src = findWorkspace(sourceId)`; `repo = src.repo`; bare = `guestPath("lwb/repos/<repo>.git")`.
2. Pin the base commit: `sha = git --git-dir=<bare> rev-parse lwb/<sourceId>` (capture).
3. `git --git-dir=<bare> worktree add <newPath> -b lwb/<newId> <sha>`
   (`newPath = guestPath("lwb/worktrees/<repo>/<newId>")`; `mkdir -p` its parent first, exactly as `cmdCreate`).
4. If `--dirty`, one guest bash round-trip (no temp files, uses pipes):
   ```bash
   set -e
   # tracked staged+unstaged:
   ( cd <srcPath> && git diff HEAD ) | ( cd <newPath> && git apply --index --whitespace=nowarn - ) \
     || echo "lwb: warning: some tracked changes did not apply cleanly" >&2
   # untracked (respecting .gitignore):
   if [ -n "$( cd <srcPath> && git ls-files --others --exclude-standard )" ]; then
     ( cd <srcPath> && git ls-files --others --exclude-standard -z | tar --null -T - -cf - ) \
       | ( cd <newPath> && tar -xf - )
   fi
   ```
**Output.** Human: mirror `cmdCreate` and add `Forked from: <sourceId>`. JSON:
`{ id, repo, branch: "lwb/<id>", path, forkedFrom: <sourceId> }`.

**Statelessness proof.** Fork = one new branch + worktree. Lineage is
`git merge-base lwb/<newId> lwb/<sourceId>`; nothing stored outside git.

**Edge cases.** Reject fork of a non-`lwb/` branch (shouldn't occur via lwb).
`--dirty` is best-effort: a failed `git apply` warns but does not abort (the
committed fork already succeeded).

---

## Feature 2 — `--json` on `ls`, `create`, `fork`, `diff`, `doctor`, `destroy`, `gc`

**Idea (from boring's REST/SDK/MCP).** lwb's SKILL.md + deny-guard already make
it an orchestration surface; give that surface a stable structured contract so a
future MCP shim is a thin wrapper, not a redesign.

**Shapes.**
- `ls`: `[{ id, repo, branch, path }]` (empty array when none).
- `create` / `fork`: the created-workspace object (see features 1 & existing create).
- `diff`: `{ id, repo, branch, base, ahead, dirty, status: [{ code, path }], commits: [{ sha, subject }], patch }`
  where `patch` is the full unified diff (committed-since-base + staged +
  unstaged + untracked-as-`/dev/null` hunks) — i.e. the exact text `lwb diff`
  prints today, carried verbatim in one field so nothing is lost.
- `doctor`: `{ ok, checks: [{ status: "ok"|"fail"|"info", message }] }`. Restructure
  `cmdDoctor` to `capture:true` and parse each `status: message` line; `ok` is
  `false` iff any check is `fail`. Exit code unchanged (non-zero on fail).
- `destroy`: success `{ id, destroyed: true }`; refusal
  `{ id, refused: true, reason: "unfetched-work"|"unverifiable"|"non-lwb-branch", detail }`
  where `detail` is the captured human report. Exit code unchanged.
- `gc`: see Feature 3.

**Human output is unchanged** when `--json` is absent.

---

## Feature 3 — `lwb gc --reap <duration> [--dry-run] [--json]`

**Idea (from boring's TTL self-destruct), statelessly.** Reap workspaces that
are *both* older than `<duration>` *and* safe (guard passes). Age comes from the
guest filesystem; safety is the Feature-shared guard. `lwb gc` with no flags is
unchanged.

**CLI.** `lwb gc [--reap <duration>] [--dry-run|-n]`
- `parseDuration("7d"|"24h"|"30m"|"90s")` → seconds. Integer + single unit
  `s|m|h|d`. Anything else → `fail("invalid duration ...")`.
- Without `--reap`: today's prune/report behavior, verbatim.
- With `--reap`: run today's prune/report, **then** the reap pass.

**Age signal.** Creation time = mtime of the worktree's git link file:
`stat -c %Y <path>/.git` (a linked worktree's `.git` is a file written once at
`worktree add`; stable across agent edits). `age = now - mtime`.

**Reap pass.**
1. Compute ages for all workspaces in one guest round-trip:
   `for p in <paths...>; do echo "$p $(stat -c %Y "$p/.git" 2>/dev/null || echo 0)"; done`
   plus a single `date +%s` for `now` (same script).
2. Candidates = `age >= threshold`.
3. For each candidate, run `unfetchedWorkGuard(path)`. Exit 0 → **reap**
   (worktree remove --force + branch -D, same as destroy's tail). Non-zero →
   **skip** (never `--force` during reap; safety first).
4. Report reaped and skipped (with reason). `--dry-run` reports candidates and
   their guard verdict but destroys nothing.

**Output.** Human: `Reaped <id> (<repo>, age 9d)` / `Skipped <id>: unfetched work`.
JSON: `{ reaped: [{ id, repo, ageSeconds }], skipped: [{ id, reason }] }`.

**Statelessness proof.** Age is read from the filesystem; eligibility is the
same git predicate as destroy. Nothing persisted.

---

## Feature 4 — Resource envelopes: `lwb exec|agent <id> [--mem <size>] [--cpus <n>] -- ...`

**Idea (from boring's per-machine cgroups).** The cost of "worktrees in one
shared VM" is that one runaway `pnpm install` or looping agent starves the fleet.
Wrap the guest command in a transient systemd scope so it's memory/CPU-capped.
Opt-in; no default limits (default behavior byte-identical).

**CLI.** Add to `exec` and `agent` (parsed from the args *before* `--`):
- `--mem <size>`: validated `/^\d+(\.\d+)?[KMGT]?$/i`, mapped to `MemoryMax`.
- `--cpus <n>`: float; `cpuQuota(n)` → `Math.round(n*100)` → `CPUQuota=<pct>%`.

**Mechanism.** When either is set, prepend to the guest argv:
```
systemd-run --user --scope -q --collect
  [-p MemoryMax=<size>] [-p CPUQuota=<pct>%]
  -- bash -lc '<existing cd && exec ... script>'
```
`--scope` (not `--service`) keeps the process attached to the current TTY, so
interactive `agent`/`exec` sessions still work. Only include `-p` flags that are
set. Passes through both transports unchanged (argv is shQuoted over SSH).

**Graceful failure.** Requires a user systemd instance in the guest. If
`systemd-run` is missing or the user bus is unavailable, the guest command fails
loudly with systemd's own error — acceptable because the feature is opt-in.
(Verification will confirm `systemd-run --user --scope` works in the Lima guest.)

**Statelessness proof.** A transient scope with `--collect` is reclaimed on
exit; nothing persisted.

---

## Feature 5 — Egress firewall: `lwb setup --egress-firewall [--egress-allow <cidr[:port]> ...]` / `--egress-off`

**Idea (from boring's egress firewall).** lwb contains an agent's *filesystem*
blast radius (no mounts, disposable worktree) but not its *network* blast
radius. A prompt-injected agent can still exfiltrate or reach arbitrary hosts.
This adds an opt-in, guest-side nftables egress policy. It lives in `setup`
because `setup` is already the one place lwb mutates guest system config
(apt installs, `/etc/environment`).

**Honesty about scope.** This is a **port-level default-deny egress firewall
with optional CIDR allowances**, not a domain allowlist. Pure nftables cannot
filter by domain (that needs a proxy). It still meaningfully shrinks blast
radius: it blocks reverse shells / exfil on arbitrary high ports, SMTP, and
port-scanning, while permitting DNS + git + http/https. Framed as such.

**CLI (setup flags).**
- `--egress-firewall`: apt-install `nftables` if absent; render the ruleset;
  `nft -c -f` validate; `sudo nft -f` apply.
- `--egress-allow <cidr>[:port]` (repeatable): extra `ip daddr <cidr> [tcp dport
  <port>] accept` rules.
- `--egress-off`: `sudo nft delete table inet lwb_egress` (removes only our
  table; touches nothing else).

**Ruleset (dedicated, removable table `inet lwb_egress`).**
```
table inet lwb_egress {
  chain output {
    type filter hook output priority 0; policy drop;
    oif "lo" accept
    ct state established,related accept
    tcp dport 53 accept
    udp dport 53 accept
    udp dport { 67, 68, 123 } accept
    tcp dport { 22, 80, 443, 9418 } accept
    <user allowances>
    counter drop
  }
}
```
Written to `/etc/lwb-egress.nft`. A named table means `--egress-off` is a clean,
scoped removal. Persistence across reboot is documented (add an include to
`/etc/nftables.conf`), **not** auto-applied, to avoid clobbering user config.

**Safety / verification note.** Applying default-deny egress to the shared dev
VM can disrupt in-flight work; therefore lwb only applies it on the explicit
`--egress-firewall` flag and never by default. Automated verification here
validates ruleset **syntax** with `nft -c -f` (check mode, does not apply) and
does **not** apply it to the user's running VM.

---

## Feature 6 — `lwb port <guest-port> [--host-port <n>]`

**Idea (from boring's "live URL").** An agent starts a dev server in the guest;
the developer can't reach it. Forward a guest port to the host over SSH — sugar
over the transport lwb already uses for `fetch`.

**CLI.** `lwb port <guest-port> [--host-port <n>]`
- `guest-port`: integer 1–65535.
- `--host-port`: host bind port; defaults to `guest-port`.
- **No `<id>`.** Workspaces share one network namespace, so a listening port is
  VM-global, not per-workspace. Requiring an id would imply isolation that does
  not exist; the spec is honest and omits it. (Documented explicitly.)

**Mechanism.** Foreground SSH tunnel via the same ssh config `fetch` uses:
- `LWB_SSH` set: `ssh [-F $LWB_SSH_CONFIG] -N -L <hostPort>:localhost:<guestPort> $LWB_SSH`
- else (limactl mode): `ssh -F ~/.lima/lwb/ssh.config -N -L <hostPort>:localhost:<guestPort> lima-lwb`
Print `Forwarding http://localhost:<hostPort> -> guest :<guestPort> (Ctrl-C to stop)`
then exec ssh in the foreground (blocks until Ctrl-C).

**Statelessness proof.** A foreground tunnel; nothing written anywhere.

---

## Cross-cutting: docs, hooks, tests

- **USAGE / SKILL.md / README.md:** add `fork` and `port` verbs, the `--json`
  flag, `gc --reap`, exec/agent `--mem`/`--cpus`, and setup egress flags.
- **Deny-guard hook (`hooks/lwb-guard.ts`):** no change required — new verbs are
  lwb subcommands and remain within the `ROUTED` allowlist.
- **Tests:** hermetic unit tests (no VM) for `parseDuration`, `cpuQuota`,
  `splitJsonFlag`, enabled by the `import.meta.main` guard. VM-dependent
  behavior (fork/reap/port) is smoke-tested end-to-end against the running VM
  during verification, in the style of the existing parity suite (skip-if-no-VM).

## Verification plan (what is actually runnable here)

| Feature | Verifiable now (live VM up) | Not verifiable here |
|---|---|---|
| fork | create→fork→diff→destroy end-to-end | — |
| --json | `ls/doctor/diff/destroy --json` parse as JSON | — |
| gc --reap | `--dry-run` on real workspaces; `parseDuration` units | destructive reap (use dry-run) |
| resource envelopes | `systemd-run --user --scope -p MemoryMax=… true` probe on guest | — |
| egress | `nft -c -f` syntax check of rendered ruleset | **applying** it (would risk the user's VM) |
| port | forward a guest port with a listener, curl it, stop | — |

Anything not run is reported as not run — never claimed as passing.
