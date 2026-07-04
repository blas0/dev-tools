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
- Retrieve results exclusively via `lwb diff <id>` or git (fetch the
  workspace's `lwb/<id>` branch).
- Never copy credentials or secrets from the host into the VM. Agent CLIs
  are authenticated inside the guest by the user, one time, interactively.
- `lwb destroy` deletes the worktree and its `lwb/`-prefixed branch. Treat
  it as destructive: confirm with the user unless they already asked.

## Verbs

```bash
lwb setup [--claude]                      # one-time: create VM (--mount-none) + provision guest
lwb init                                  # ensure VM is running, guest dirs exist
lwb add <git-url> [name]                  # bare-clone a repo into the VM
lwb create <repo> [--base <ref>] [--name <id>]   # new workspace (worktree + lwb/<id> branch)
lwb ls                                    # list workspaces: id, repo, branch, guest path
lwb exec <id> -- <cmd...>                 # run one command in a workspace
lwb shell <id>                            # interactive shell in a workspace
lwb agent <id> -- <agentcmd...>           # interactive agent session (claude, codex, ...)
lwb diff <id>                             # git status --short + git diff
lwb destroy <id>                          # remove worktree + lwb/ branch
```

Workspace ids are globally unique; if a duplicate ever exists, use
`<repo>/<id>` anywhere an `<id>` is accepted.

Transport: default is `limactl shell`. Set `LWB_SSH=<host>` (and optionally
`LWB_SSH_CONFIG=<file>`) to target any Linux box over SSH — same verbs.

## Dispatching headless agent work

The fleet pattern — one disposable workspace per task:

```bash
lwb create app --name task-1
lwb exec task-1 -- claude -p "<task prompt>" --permission-mode acceptEdits
lwb diff task-1          # review the result
lwb destroy task-1       # or fetch the lwb/task-1 branch first to keep it
```

Runs are independent: parallel tasks get parallel workspaces, never a
shared one. The VM is the sandbox, so permissive agent modes are
acceptable inside it; the diff is the review gate.
