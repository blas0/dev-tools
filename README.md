# dev-tools

Tooling that supports the development workflow rather than shipping to end users.

| Project | What it is |
| --- | --- |
| [`lwb`](lwb/) | Linux Worktree Box — disposable agent workspaces as git worktrees in a no-mount Lima VM. |
| [`meadowpress`](meadowpress/) | Scoped directory for quick lakebed web app deployments. |

Each project is self-contained: its own `README.md` and `.gitignore` live in its
own directory and apply only to that subtree. Full commit history for every
project was carried into this repository, so `git log -- lwb/` reaches all the
way back to that project's first commit.

## lwb

`lwb` doubles as a CLI and as an agent skill, so it is wired into the host in two
places. Both are symlinks into this repository:

```sh
~/.claude/skills/lwb/SKILL.md            -> dev-tools/lwb/SKILL.md
~/.bun/install/global/node_modules/lwb   -> dev-tools/lwb
```

Re-link after relocating this repository:

```sh
ln -sfn "$PWD/lwb/SKILL.md" ~/.claude/skills/lwb/SKILL.md
ln -sfn "$PWD/lwb" ~/.bun/install/global/node_modules/lwb
```

## meadowpress

`deployments/` holds generated lakebed application deploys. It stays on disk but
is deliberately untracked — see `meadowpress/.gitignore`.

## Layout

```
dev-tools/
├── lwb/            # Bun / TypeScript CLI
└── meadowpress/    # deployment docs and scoped rules
```
