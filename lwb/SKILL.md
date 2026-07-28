---
name: lwb
description: Manage disposable Linux agent workspaces via the lwb CLI (Linux Worktree Box). Use when the user asks to create, list, run commands or coding agents in, diff, or destroy VM-backed workspaces, or mentions lwb.
---

# lwb — Linux Worktree Box

lwb manages agent workspaces as git worktrees inside a no-mount Lima VM.
The Mac is a control surface; all file churn happens on guest-native ext4.
Work crosses the boundary only as commands in and git diffs out.

## Rules (non-negotiable)

- The `lwb` CLI is the ONLY way to touch VM workspaces. Never mount host
  directories into the VM, never edit guest files through any other path.
- Workspace paths printed by `lwb ls` are GUEST paths. Do not Read/Edit
  them with host tools — they do not exist on the host filesystem.
- Retrieve results exclusively via `lwb diff <id>` (review) and
  `lwb fetch <id>` (pull the `lwb/<id>` branch into the current host repo).
- Never copy credentials or secrets from the host into the VM. Agent CLIs
  are authenticated inside the guest by the user, one time, interactively.
- `lwb destroy` deletes the worktree and its `lwb/`-prefixed branch. Treat
  it as destructive: confirm with the user unless they already asked. It
  refuses when unfetched work would be lost; `--force` is the explicit
  "yes, discard it" — only pass it after the diff has been reviewed.
  (`LWB_DESTROY_GUARD=0` disables the refusal wholesale; leave it on
  when orchestrating agents.)

## Verbs

```bash
lwb setup [--claude] [--egress-firewall] [--egress-allow <cidr[:port]>] [--egress-off]
                                          # one-time: create VM (--mount-none) + provision guest
                                          #   --egress-firewall: opt-in port-level default-deny
                                          #   egress (nftables), not a domain allowlist
lwb init                                  # ensure VM is running, guest dirs exist
lwb add <git-url> [name]                  # bare-clone a repo into the VM
lwb create <repo> [--base <ref>] [--name <id>]   # new workspace (worktree + lwb/<id> branch)
lwb fork <id> [--name <newid>] [--dirty]  # new workspace branched from another's current HEAD
                                          #   (--dirty also replays its uncommitted state)
lwb ls                                    # list workspaces: id, repo, branch, guest path
lwb exec <id> [--mem <size>] [--cpus <n>] -- <cmd...>   # run one command in a workspace,
                                          #   optionally resource-capped via systemd --user --scope
lwb shell <id>                            # interactive shell in a workspace
lwb agent <id> [--mem <size>] [--cpus <n>] -- <agentcmd...>   # interactive agent session
                                          #   (claude, codex, ...), optionally resource-capped
lwb diff <id>                             # all changes since divergence from the default branch:
                                          #   status + commits on lwb/<id> + diff + untracked content
lwb fetch <id>                            # pull the lwb/<id> branch into the current host repo
lwb destroy <id> [--force]                # remove worktree + lwb/ branch; refuses if unfetched
                                          #   work would be lost (--force discards it)
lwb gc [--reap <duration>] [--dry-run|-n] # prune stale worktrees, clear guest cache
                                          #   --reap <7d|24h|30m|90s>: also destroys workspaces at/above
                                          #   that age that pass the same unfetched-work guard as destroy
lwb doctor                                # preflight: VM up, dirs, git, agent login (exit != 0 on problems)
lwb port <guest-port> [--host-port <n>]   # foreground SSH tunnel host->guest (Ctrl-C to stop); no <id>,
                                          #   ports are VM-global since workspaces share one netns
```

Workspace ids are globally unique; if a duplicate ever exists, use
`<repo>/<id>` anywhere an `<id>` is accepted.

Pass `--json` (before any `--`) on `ls`, `create`, `fork`, `diff`, `destroy`,
`gc`, and `doctor` for machine-readable output.

Transport: default is `limactl shell`. Set `LWB_SSH=<host>` (and optionally
`LWB_SSH_CONFIG=<file>`) to target any Linux box over SSH — same verbs.

## Dispatching headless agent work

The fleet pattern — one disposable workspace per task:

```bash
lwb doctor               # once, before dispatching: VM up + agent logged in
lwb create app --name task-1
lwb exec task-1 -- claude -p "<task prompt>" --permission-mode acceptEdits
lwb diff task-1          # review the result
lwb fetch task-1         # keep it: pulls lwb/task-1 into the current host repo
lwb destroy task-1 --force   # discard it (--force = "yes, lose the unfetched work")
```

Runs are independent: parallel tasks get parallel workspaces, never a
shared one. The VM is the sandbox, so permissive agent modes are
acceptable inside it; the diff is the review gate.
