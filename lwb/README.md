# lwb - Linux Worktree Box

A minimal CLI where your Mac is a control surface and all real work happens
inside a Lima VM with **no host filesystem mounts**. Agent workspaces are git
worktrees on guest-native ext4; the only things that cross the Mac/Linux
boundary are commands in and git diffs out.

lwb keeps no state of its own -- git's worktree registry inside the VM
(`git worktree list --porcelain`) is the database. There are no config
files, no lock files, and nothing written on the host, so there is nothing
to drift or corrupt: anything lwb shows you can be inspected and repaired
with plain git inside the guest.

## Quick start

```bash
brew install lima bun          # prerequisites (or your package manager)
git clone https://github.com/blas0/dev-tools.git && cd dev-tools/lwb
bun link                       # exposes `lwb` globally (or run ./lwb.ts directly)

lwb setup                      # one-time: create the VM (--mount-none) + provision it
lwb add https://github.com/vuejs/core.git
lwb create core                # -> prints a workspace id, e.g. brave-fox
lwb exec brave-fox -- git status
lwb destroy brave-fox
```

`lwb setup` downloads an Ubuntu image on first run (a few minutes); every
other command is sub-second. To also install Claude Code in the guest:

```bash
lwb setup --claude
limactl shell lwb -- claude    # one-time interactive login, inside the guest
```

## Assumptions

Explicitly, so there are no surprises:

- **Host**: any machine that runs [Lima](https://lima-vm.io) and
  [Bun](https://bun.sh) (developed on macOS/Apple Silicon). lwb writes
  **nothing** on the host -- no config, no state, no dotfiles. This repo can
  live anywhere on your filesystem.
- **VM**: `lwb setup` creates a Lima VM named `lwb` from
  `template://default` (Ubuntu) with `--mount-none`. Defaults: 4 CPUs,
  8 GiB RAM, 60 GiB disk -- override with `--cpus/--memory/--disk`. Size
  flags apply only when the VM is first created; re-running `setup` against
  an existing VM does not resize it.
- **Guest**: lwb owns `~/lwb/` in the guest home and nothing else:
  - `~/lwb/repos/<name>.git` -- bare repos
  - `~/lwb/worktrees/<repo>/<id>` -- workspaces (git worktrees)
  - `~/lwb/cache` -- scratch space
  Provisioning uses `apt-get` with passwordless sudo (true for Lima
  defaults; required for `LWB_SSH` remote hosts too, or pre-provision them
  yourself).
- **Workspace ids** are globally unique across repos (enforced at
  `create`). If you ever end up with a duplicate (e.g. worktrees created by
  hand), commands accept `<repo>/<id>` to disambiguate.

## Why

macOS/APFS is slow at exactly the small-file churn that coding agents
multiply: worktree creation, `git status`, cleaning, dependency trees.
Moving the working set onto Linux-native storage — not sharing it via a
mount — is worth 3.5–7x on those operations.

Measured with [hyperfine](https://github.com/sharkdp/hyperfine) (warmup 1,
5 runs) on [vuejs/core](https://github.com/vuejs/core), Apple Silicon Mac
vs an 8-CPU/8-GB Lima VM (Ubuntu arm64, `--mount-none`) on the same machine:

| Benchmark | macOS (APFS) | macOS + GVS | Linux VM (ext4) | Linux VM + GVS |
| --- | --- | --- | --- | --- |
| git worktree add+remove cycle | 152.9 ms | – | **44.1 ms** | – |
| warm `pnpm install --ignore-scripts` | 1.465 s | 847 ms | 836 ms | **763 ms** |
| `rg` (default filters) | 14.1 ms | 13.4 ms | 6.3 ms | **3.3 ms** |
| `rg -uu` (traverses node_modules) | 188.2 ms | 16.1 ms | 36.2 ms | **5.3 ms** |
| `git status --porcelain` | 11.4 ms | – | **2.2 ms** | 2.7 ms |
| `git clean -Xfd` | 0.89 s | – | 0.132 s | **0.018 s** |

GVS = pnpm `enableGlobalVirtualStore: true`. Takeaway: GVS closes most of
the *install* gap on both OSes, but not the status/clean/traversal churn --
that's where Linux-native storage wins, and it's what agent fleets hammer.

Five workspaces created in 0.6–0.9 s each end-to-end from the Mac; five
concurrent agent-shaped jobs (search + install + edit + status) completed in
4.6 s total with the guest at load 0.41.

`lwb destroy`'s safety gate (refusing when unfetched work would be lost)
costs one extra guest round-trip per destroy. Measured end-to-end from the
Mac (hyperfine, 5 runs, clean workspace):

| Benchmark | guard on (default) | guard off (`LWB_DESTROY_GUARD=0`) |
| --- | --- | --- |
| `lwb destroy` | 378 ms | 325 ms |

`--force` skips the check for a single destroy; `LWB_DESTROY_GUARD=0` (or
`false`/`off`) opts out globally — for teardown-heavy fleets that fetch
first anyway and want destroys ~50 ms cheaper.

> **Do not mount your Mac project directory into the VM.** Shared-filesystem
> mounts (virtiofs/9p/sshfs) are slower than native APFS -- a mounted
> workspace gets Linux process overhead *plus* worse-than-Mac I/O. The entire
> benefit above comes from `--mount-none` + git as the only boundary.

## Commands

| Command | Description |
| --- | --- |
| `lwb setup [--cpus N] [--memory GiB] [--disk GiB] [--claude] [--egress-firewall] [--egress-allow <cidr[:port]>] [--egress-off]` | One-time: create the `lwb` VM (`--mount-none`) if missing, start it, install git/ripgrep, create the `~/lwb` dirs. `--claude` also installs Node.js + Claude Code in the guest. `--egress-firewall` applies an opt-in, port-level default-deny egress firewall (nftables table `inet lwb_egress`) in the guest, with `--egress-allow <cidr[:port]>` adding allowances; `--egress-off` removes it. Not persisted across reboot. Idempotent -- safe to re-run. |
| `lwb init` | Ensure the VM is running and guest dirs exist (lighter than `setup`; no package installs). |
| `lwb add <git-url> [name]` | Clone a bare repo into `~/lwb/repos/<name>.git`. Name defaults to the repo basename without `.git`. |
| `lwb create <repo> [--base <ref>] [--name <id>] [--offline]` | Create a new worktree workspace on branch `lwb/<id>`. `id` defaults to a random adjective-noun pair; `base` defaults to the bare repo's default branch. Fetches origin first and aborts if a network origin is unreachable (avoids silently building off a stale base); pass `--offline` to skip the fetch requirement and build from the local base. |
| `lwb fork <id> [--name <newid>] [--dirty]` | Create a new workspace branched from another workspace's current HEAD (pins the base commit to the source's HEAD at fork time). `--dirty` also replays the source's uncommitted tracked + untracked state. |
| `lwb ls` | List all workspaces (id, repo, branch, guest path). |
| `lwb exec <id> [--mem <size>] [--cpus <n>] -- <cmd...>` | Run a command inside a workspace directory. `--mem`/`--cpus` wrap it in a transient `systemd-run --user --scope` (MemoryMax/CPUQuota) to resource-cap it. |
| `lwb shell <id>` | Open an interactive shell inside a workspace directory. |
| `lwb agent <id> [--mem <size>] [--cpus <n>] -- <agentcmd...>` | Launch a coding agent (e.g. `claude`, `codex`) inside a workspace directory, optionally resource-capped like `exec`. |
| `lwb diff <id>` | Show everything a workspace changed since it diverged from the repo's default branch: `git status --short`, commits made on `lwb/<id>`, the full diff (committed + staged + unstaged), and the content of untracked files. |
| `lwb fetch <id>` | Fetch a workspace's `lwb/<id>` branch into the current host git repo (run it from inside that repo). Uses git-over-ssh via Lima's own sshd (or `LWB_SSH` when set); only commits move — uncommitted work stays in the VM. |
| `lwb destroy <id> [--force]` | Remove a workspace's worktree and delete its `lwb/` branch. Refuses — showing the commits, dirty files, and a diffstat — if the workspace holds work that exists only in the VM; pass `--force` to discard it anyway. Set `LWB_DESTROY_GUARD=0` to disable the check globally (see benchmarks above). |
| `lwb gc [--reap <duration>] [--dry-run\|-n]` | Prune stale worktree registrations, empty `~/lwb/cache`, report repos with no workspaces and guest disk usage. Never deletes repos. `--reap <7d\|24h\|30m\|90s>` additionally removes workspaces whose worktree mtime is at/above that age -- but only those that pass the same unfetched-work safety guard as `destroy`; guarded workspaces are skipped, never force-destroyed. `--dry-run`/`-n` previews what would be reaped. |
| `lwb doctor` | Preflight for headless runs: VM running, guest dirs present, git installed, agent CLI logged in (via `claude auth status`, so token auto-refresh is respected). Non-zero exit on problems — gate scripts with `lwb doctor && lwb exec ...`. |
| `lwb port <guest-port> [--host-port <n>]` | Foreground SSH tunnel forwarding a host port to a guest port (Ctrl-C to stop). Takes no `<id>`: workspaces share one VM-wide network namespace, so a listening port is VM-global. |
| `lwb --help` | Show usage. |

Anywhere a command takes `<id>`, `<repo>/<id>` also works.

Pass `--json` (anywhere in the args before a `--` separator) on `ls`, `create`,
`fork`, `diff`, `destroy`, `gc`, and `doctor` for machine-readable output on
stdout instead of the human-formatted text above; a `--json` after `--` (e.g.
`lwb exec <id> -- echo --json`) is passed through to the guest command
untouched, not consumed as the flag.

`--egress-firewall` is a **port-level** default-deny firewall with optional
CIDR allowances (DNS, git, and http/https stay open by default) -- it is
*not* a domain allowlist, since nftables cannot filter by hostname.

## Transports

By default every command goes through `limactl shell lwb -- ...`. Set two
env vars to route over plain SSH instead -- same CLI, different substrate
(a remote Linux box works the same as the local VM):

```bash
LWB_SSH=<ssh-host> [LWB_SSH_CONFIG=<ssh-config-file>] lwb ls
```

Tested against Lima's own sshd (`LWB_SSH=lima-lwb
LWB_SSH_CONFIG=~/.lima/lwb/ssh.config`). The SSH transport is also ~3x
faster per call than `limactl shell` (~0.15 s vs ~0.44 s round-trip).

With `LWB_SSH` set, `lwb setup` skips VM management and only provisions the
remote host (which must be apt-based Linux with passwordless sudo).

## Running agents

Install your agent CLI inside the guest (`lwb setup --claude`, or manually
e.g. `npm i -g @anthropic-ai/claude-code`) and authenticate **inside the
guest** with a one-time interactive login -- never copy credentials from the
host into the VM. Then:

```bash
lwb agent <id> -- claude                                    # interactive session
lwb exec <id> -- claude -p "<task>" --permission-mode acceptEdits   # headless
```

Because the VM has no host mounts, an agent's blast radius is a disposable
worktree; review its work with `lwb diff <id>`, keep it with `lwb fetch <id>`
(run from the host repo that should receive the branch), and throw the
workspace away with `lwb destroy <id>` — which refuses if unfetched work
would be lost, unless you pass `--force`.

## Deny-guards for orchestrating sessions

`hooks/lwb-guard.ts` is a Claude Code PreToolUse hook that turns two
SKILL.md rules into hard denials instead of advisory text:

1. Host file tools (`Read`/`Edit`/`Write`/`NotebookEdit`) may not target
   guest paths (`/home/<user>/lwb/...` or `~/lwb/...`) -- they don't exist
   on the host.
2. Bash commands may not mount host directories into the VM (`limactl`
   with any `--mount` flag other than `--mount-none`), and may not
   reference guest paths unless routed through `lwb`, `limactl`, or `ssh`.

Register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Read|Edit|Write|NotebookEdit",
        "hooks": [
          { "type": "command", "command": "/path/to/lwb/hooks/lwb-guard.ts" }
        ]
      }
    ]
  }
}
```

A denial exits 2 and feeds the reason back to the agent, which then
self-corrects to `lwb exec` / `lwb diff`.

## Known quirks

- Args passed through `limactl shell` are **not** tilde-expanded -- `~/path`
  becomes a literal `~` directory. The CLI resolves the guest `$HOME` at
  runtime; do the same in any scripts you write.
- puppeteer's postinstall can never download Chrome on arm64 Linux (Google
  ships no Chrome-for-Testing builds for `linux_arm`). `lwb setup` sets
  `PUPPETEER_SKIP_DOWNLOAD=1` in the guest's `/etc/environment` on aarch64.
- `simple-git-hooks` logs a non-fatal `ENOTDIR` in linked worktrees (`.git`
  is a file there, so it can't `mkdir .git/hooks`); installs still succeed.

## Notes

- Zero npm dependencies; uses only `node:child_process` and standard lib.
- `destroy` refuses to delete branches that don't have the `lwb/` prefix.
- `lwb diff` diffs against the merge-base with the bare repo's default
  branch, so work an agent already committed or staged still shows up. If
  no merge-base exists it falls back to HEAD (uncommitted changes only).
  Untracked files appear as `diff --no-index` hunks against `/dev/null`
  (paths render as `a/./<file>`; the `./` guards odd filenames).
