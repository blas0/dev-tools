#!/usr/bin/env bun
// lwb - Linux Worktree Box
//
// The Mac is a control surface; all real work happens inside a Lima VM
// named "lwb". Every operation shells out to `limactl shell lwb -- ...`.
// State lives in git inside the VM (git worktree list --porcelain) --
// no database, no state files.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const VM_NAME = "lwb";

// Transport seam (POC 4): by default commands route through `limactl shell`.
// Set LWB_SSH=<host> to route through `ssh <host>` instead (e.g. a 2017 iMac
// running Linux, or lima's own sshd for testing). Optional LWB_SSH_CONFIG
// points at an ssh config file (-F). The workspace API stays fixed; only the
// execution substrate changes.
const SSH_TARGET = process.env.LWB_SSH;
const SSH_CONFIG = process.env.LWB_SSH_CONFIG;

// Destroy safety gate: refuse to destroy a workspace whose work exists only
// in the VM. Costs one extra guest round-trip per destroy; set
// LWB_DESTROY_GUARD=0 (or false/off) to opt out and destroy immediately.
const DESTROY_GUARD = !["0", "false", "off"].includes(
  (process.env.LWB_DESTROY_GUARD ?? "").toLowerCase(),
);

interface GuestCommand {
  cmd: string;
  argv: string[];
}

/**
 * Build the host-side command that runs `args` inside the guest. Over ssh the
 * remote shell re-splits words, so each arg is shell-quoted; limactl passes
 * argv through verbatim.
 */
function guestCommand(args: string[], interactive = false): GuestCommand {
  if (SSH_TARGET) {
    const sshArgs: string[] = [];
    if (SSH_CONFIG) sshArgs.push("-F", SSH_CONFIG);
    if (interactive && process.stdin.isTTY) sshArgs.push("-t");
    sshArgs.push(SSH_TARGET, "--", args.map(shQuote).join(" "));
    return { cmd: "ssh", argv: sshArgs };
  }
  return { cmd: "limactl", argv: ["shell", VM_NAME, "--", ...args] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface LinuxOpts {
  interactive?: boolean;
  capture?: boolean;
}

interface LinuxResult {
  code: number;
  stdout: string;
}

/** Run a command inside the guest (limactl shell by default, ssh if LWB_SSH). */
function linux(args: string[], opts: LinuxOpts = {}): LinuxResult {
  const stdio = opts.interactive ? "inherit" : opts.capture ? "pipe" : "inherit";
  const guest = guestCommand(args, opts.interactive);
  const result = spawnSync(guest.cmd, guest.argv, {
    stdio,
    encoding: "utf8",
  });
  const stdout = opts.capture && typeof result.stdout === "string" ? result.stdout : "";
  const code = result.status ?? (result.error ? 1 : 0);
  return { code, stdout };
}

/** Single-quote-escape a value for embedding in a `bash -lc '...'` string. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function fail(message: string): never {
  console.error(`lwb: ${message}`);
  process.exit(1);
}

// Paths passed as direct argv to `limactl shell` are NOT tilde-expanded by
// any guest shell, so `~/lwb/...` would create a literal "~" directory.
// Resolve the guest $HOME once per invocation and build absolute paths.
let guestHome: string | undefined;

function getGuestHome(): string {
  if (!guestHome) {
    const { code, stdout } = linux(["bash", "-lc", 'printf %s "$HOME"'], { capture: true });
    const home = stdout.trim();
    if (code !== 0 || !home.startsWith("/")) {
      fail("could not resolve guest $HOME (is the lwb VM running?)");
    }
    guestHome = home;
  }
  return guestHome;
}

function guestPath(relative: string): string {
  return `${getGuestHome()}/${relative}`;
}

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------

interface Workspace {
  id: string;
  repo: string;
  branch: string;
  path: string;
}

/**
 * List all workspaces by asking the guest to dump `git worktree list
 * --porcelain` for every bare repo under ~/lwb/repos, then parsing the
 * porcelain output.
 */
function listWorkspaces(): Workspace[] {
  const script =
    'for d in ~/lwb/repos/*.git; do echo "REPO $d"; git --git-dir="$d" worktree list --porcelain; done';
  const { stdout } = linux(["bash", "-lc", script], { capture: true });

  const workspaces: Workspace[] = [];
  let currentRepo = "";
  let currentPath = "";
  let currentBranch = "";
  let isBare = false;

  const flush = () => {
    if (currentPath && !isBare) {
      const id = currentPath.split("/").filter(Boolean).pop() ?? currentPath;
      workspaces.push({
        id,
        repo: currentRepo,
        branch: currentBranch,
        path: currentPath,
      });
    }
    currentPath = "";
    currentBranch = "";
    isBare = false;
  };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("REPO ")) {
      flush();
      const repoDir = line.slice("REPO ".length).trim();
      const base = repoDir.split("/").filter(Boolean).pop() ?? repoDir;
      currentRepo = base.endsWith(".git") ? base.slice(0, -".git".length) : base;
      continue;
    }
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = line.slice("worktree ".length).trim();
      continue;
    }
    if (line === "bare") {
      isBare = true;
      continue;
    }
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      const prefix = "refs/heads/";
      currentBranch = ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
      continue;
    }
    if (line === "") {
      flush();
      continue;
    }
  }
  flush();

  return workspaces;
}

/**
 * Resolve a workspace reference: either a bare id, or `<repo>/<id>` when the
 * same id exists in more than one repo.
 */
function findWorkspace(ref: string): Workspace {
  const workspaces = listWorkspaces();
  const slash = ref.indexOf("/");
  const repo = slash === -1 ? undefined : ref.slice(0, slash);
  const id = slash === -1 ? ref : ref.slice(slash + 1);
  const matches = workspaces.filter(
    (w) => w.id === id && (repo === undefined || w.repo === repo),
  );
  if (matches.length === 0) {
    fail(`no workspace found with id "${ref}"`);
  }
  if (matches.length > 1) {
    const refs = matches.map((w) => `${w.repo}/${w.id}`).join(", ");
    fail(`workspace id "${id}" is ambiguous (${refs}); use <repo>/<id>`);
  }
  return matches[0];
}

// ---------------------------------------------------------------------------
// Random id generation
// ---------------------------------------------------------------------------

const ADJECTIVES = [
  "brave", "calm", "swift", "quiet", "bold", "keen", "merry", "wry",
  "spry", "vivid", "amber", "coral", "dusky", "early", "fond", "gilt",
];
const NOUNS = [
  "river", "stone", "cloud", "pine", "fox", "wren", "gale", "moss",
  "reef", "dune", "fjord", "glen", "heath", "knoll", "mesa", "tarn",
];

function randomId(): string {
  const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adjective}-${noun}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

interface LimaVm {
  name?: string;
  status?: string;
}

/** Look up the lwb VM in `limactl list --json` (one JSON object per line). */
function findVm(): LimaVm | undefined {
  const listResult = spawnSync("limactl", ["list", "--json"], {
    stdio: "pipe",
    encoding: "utf8",
  });

  const stdout = listResult.stdout ?? "";
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.name === VM_NAME) {
        return parsed;
      }
    } catch {
      // ignore malformed lines
    }
  }
  return undefined;
}

function cmdSetup(args: string[]): void {
  let cpus = "4";
  let memory = "8";
  let disk = "60";
  let withClaude = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cpus") {
      cpus = args[++i];
    } else if (args[i] === "--memory") {
      memory = args[++i];
    } else if (args[i] === "--disk") {
      disk = args[++i];
    } else if (args[i] === "--claude") {
      withClaude = true;
    } else {
      fail(`unknown setup flag "${args[i]}" (usage: lwb setup [--cpus N] [--memory GiB] [--disk GiB] [--claude])`);
    }
  }

  // With LWB_SSH set there is no Lima VM to manage; only provision the
  // remote host (it must be an apt-based Linux with passwordless sudo).
  if (!SSH_TARGET) {
    const versionResult = spawnSync("limactl", ["--version"], { stdio: "pipe" });
    if (versionResult.error) {
      fail("limactl not found; install Lima first (e.g. `brew install lima`)");
    }

    const vm = findVm();
    if (!vm) {
      console.log(
        `Creating Lima VM "${VM_NAME}" (--mount-none, ${cpus} CPUs, ${memory} GiB RAM, ${disk} GiB disk)...`,
      );
      console.log("This downloads an Ubuntu image on first run and takes a few minutes.");
      const createResult = spawnSync(
        "limactl",
        [
          "start",
          `--name=${VM_NAME}`,
          "--mount-none",
          `--cpus=${cpus}`,
          `--memory=${memory}`,
          `--disk=${disk}`,
          "--tty=false",
          "template://default",
        ],
        { stdio: "inherit" },
      );
      if ((createResult.status ?? 1) !== 0) {
        fail(`limactl start failed while creating VM "${VM_NAME}"`);
      }
    } else if (vm.status !== "Running") {
      console.log(`Starting VM "${VM_NAME}" (status: ${vm.status})...`);
      const startResult = spawnSync("limactl", ["start", VM_NAME], { stdio: "inherit" });
      if ((startResult.status ?? 1) !== 0) {
        fail(`failed to start VM "${VM_NAME}"`);
      }
    } else {
      console.log(`VM "${VM_NAME}" already exists and is running.`);
    }
  }

  console.log("Provisioning guest (git, ripgrep, ~/lwb directories)...");
  const provisionScript = [
    "sudo DEBIAN_FRONTEND=noninteractive apt-get update -q",
    "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q git ripgrep",
    "mkdir -p ~/lwb/repos ~/lwb/worktrees ~/lwb/cache",
    // Google ships no Chrome-for-Testing builds for linux_arm, so puppeteer
    // postinstalls can never succeed there; skip the download globally.
    'if [ "$(uname -m)" = "aarch64" ] && ! grep -q PUPPETEER_SKIP_DOWNLOAD /etc/environment 2>/dev/null; then echo PUPPETEER_SKIP_DOWNLOAD=1 | sudo tee -a /etc/environment >/dev/null; fi',
  ].join(" && ");
  const provisionResult = linux(["bash", "-lc", provisionScript]);
  if (provisionResult.code !== 0) {
    fail("guest provisioning failed");
  }

  if (withClaude) {
    console.log("Installing Node.js and Claude Code in the guest...");
    const claudeScript =
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs npm && sudo npm install -g @anthropic-ai/claude-code";
    const claudeResult = linux(["bash", "-lc", claudeScript]);
    if (claudeResult.code !== 0) {
      fail("Claude Code install failed");
    }
  }

  console.log("");
  console.log("Setup complete. Next steps:");
  console.log("  lwb add <git-url>     # clone a repo into the VM");
  console.log("  lwb create <repo>     # create a disposable workspace");
  if (withClaude) {
    console.log(`  limactl shell ${VM_NAME} -- claude   # one-time interactive login, inside the guest`);
  }
}

function cmdInit(): void {
  const vm = findVm();

  if (!vm) {
    console.log(`No "${VM_NAME}" Lima VM found. Run \`lwb setup\` to create and provision one.`);
    return;
  }

  if (vm.status && vm.status !== "Running") {
    console.log(`Starting VM "${VM_NAME}" (status: ${vm.status})...`);
    const startResult = spawnSync("limactl", ["start", VM_NAME], { stdio: "inherit" });
    if ((startResult.status ?? 1) !== 0) {
      fail(`failed to start VM "${VM_NAME}"`);
    }
  }

  const { code } = linux(["bash", "-lc", "mkdir -p ~/lwb/repos ~/lwb/worktrees ~/lwb/cache"]);
  if (code !== 0) {
    fail("failed to create guest directories");
  }
  console.log("lwb initialized.");
}

function cmdAdd(args: string[]): void {
  const url = args[0];
  if (!url) {
    fail("usage: lwb add <git-url> [name]");
  }
  const base = url.split("/").filter(Boolean).pop() ?? url;
  const defaultName = base.endsWith(".git") ? base.slice(0, -".git".length) : base;
  const name = args[1] ?? defaultName;

  const dest = guestPath(`lwb/repos/${name}.git`);
  const { code } = linux(["git", "clone", "--bare", url, dest]);
  if (code !== 0) {
    fail(`git clone --bare failed for ${url}`);
  }
  console.log(`Added repo "${name}" at ${dest}`);
}

function cmdCreate(args: string[]): void {
  const repo = args[0];
  if (!repo) {
    fail("usage: lwb create <repo> [--base <ref>] [--name <id>]");
  }

  let base: string | undefined;
  let id: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--base") {
      base = args[++i];
    } else if (args[i] === "--name") {
      id = args[++i];
    }
  }

  // Workspace ids are the lookup key across ALL repos, so they must be
  // globally unique -- otherwise exec/diff/destroy would be ambiguous.
  const takenIds = new Set(listWorkspaces().map((w) => w.id));
  if (id) {
    if (takenIds.has(id)) {
      fail(`workspace id "${id}" already exists; pass a different --name`);
    }
  } else {
    for (let attempt = 0; attempt < 20 && (!id || takenIds.has(id)); attempt++) {
      id = randomId();
    }
    if (!id || takenIds.has(id)) {
      fail("could not generate a unique workspace id; pass --name");
    }
  }

  const bareRepoDir = guestPath(`lwb/repos/${repo}.git`);

  // Fetch origin, tolerating failure for local-only repos.
  const fetchResult = linux(["git", `--git-dir=${bareRepoDir}`, "fetch", "origin"]);
  if (fetchResult.code !== 0) {
    console.error(`warning: git fetch origin failed for repo "${repo}" (continuing)`);
  }

  if (!base) {
    const headResult = linux(
      ["git", `--git-dir=${bareRepoDir}`, "symbolic-ref", "--short", "HEAD"],
      { capture: true },
    );
    base = headResult.stdout.trim();
    if (!base) {
      fail(`could not determine default branch for repo "${repo}"; pass --base`);
    }
  }

  const worktreePath = guestPath(`lwb/worktrees/${repo}/${id}`);
  const parentDir = guestPath(`lwb/worktrees/${repo}`);

  const mkdirResult = linux(["bash", "-lc", `mkdir -p ${shQuote(parentDir)}`]);
  if (mkdirResult.code !== 0) {
    fail(`failed to create parent directory ${parentDir}`);
  }

  const worktreeResult = linux([
    "git",
    `--git-dir=${bareRepoDir}`,
    "worktree",
    "add",
    worktreePath,
    "-b",
    `lwb/${id}`,
    base,
  ]);
  if (worktreeResult.code !== 0) {
    fail(`git worktree add failed for repo "${repo}"`);
  }

  console.log("Created workspace:");
  console.log("");
  console.log(`ID:       ${id}`);
  console.log(`Repo:     ${repo}`);
  console.log(`Branch:   lwb/${id}`);
  console.log(`Path:     ${worktreePath}`);
  console.log("Machine:  local");
}

function cmdLs(): void {
  const workspaces = listWorkspaces();
  if (workspaces.length === 0) {
    console.log("No workspaces found.");
    return;
  }

  const headers = ["ID", "REPO", "BRANCH", "PATH"];
  const rows = workspaces.map((w) => [w.id, w.repo, w.branch, w.path]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );

  const formatRow = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");

  console.log(formatRow(headers));
  for (const row of rows) {
    console.log(formatRow(row));
  }
}

function cmdExec(args: string[]): void {
  const id = args[0];
  const dashIndex = args.indexOf("--");
  if (!id || dashIndex === -1 || dashIndex === args.length - 1) {
    fail("usage: lwb exec <id> -- <cmd...>");
  }
  const command = args.slice(dashIndex + 1);
  const workspace = findWorkspace(id);

  const quotedCmd = command.map(shQuote).join(" ");
  const script = `cd ${shQuote(workspace.path)} && exec ${quotedCmd}`;
  const guest = guestCommand(["bash", "-lc", script], true);
  const result = spawnSync(guest.cmd, guest.argv, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

function cmdShell(args: string[]): void {
  const id = args[0];
  if (!id) {
    fail("usage: lwb shell <id>");
  }
  const workspace = findWorkspace(id);

  let result;
  if (!SSH_TARGET) {
    const helpResult = spawnSync("limactl", ["shell", "--help"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    const supportsWorkdir = (helpResult.stdout ?? "").includes("--workdir");
    if (supportsWorkdir) {
      result = spawnSync(
        "limactl",
        ["shell", "--workdir", workspace.path, VM_NAME],
        { stdio: "inherit" },
      );
      process.exit(result.status ?? 1);
    }
  }
  const script = `cd ${shQuote(workspace.path)} && exec bash -i`;
  const guest = guestCommand(["bash", "-lc", script], true);
  result = spawnSync(guest.cmd, guest.argv, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

function cmdAgent(args: string[]): void {
  const id = args[0];
  const dashIndex = args.indexOf("--");
  if (!id || dashIndex === -1 || dashIndex === args.length - 1) {
    fail("usage: lwb agent <id> -- <agentcmd...>");
  }
  const command = args.slice(dashIndex + 1);
  const workspace = findWorkspace(id);

  const quotedCmd = command.map(shQuote).join(" ");
  const script = `cd ${shQuote(workspace.path)} && exec ${quotedCmd}`;
  const guest = guestCommand(["bash", "-lc", script], true);
  const result = spawnSync(guest.cmd, guest.argv, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

function cmdDiff(args: string[]): void {
  const id = args[0];
  if (!id) {
    fail("usage: lwb diff <id>");
  }
  const workspace = findWorkspace(id);

  // Agents often commit or stage their work, so a bare `git diff` (unstaged
  // only) silently under-reports. Diff against the point where lwb/<id>
  // diverged from the repo's default branch, and show untracked file content.
  // One guest round-trip; the bare repo dir comes from --git-common-dir so no
  // host-side path knowledge is needed.
  const script = [
    `cd ${shQuote(workspace.path)} || exit 1`,
    `git status --short || exit 1`,
    `common=$(git rev-parse --git-common-dir)`,
    `default=$(git --git-dir="$common" symbolic-ref --short HEAD 2>/dev/null)`,
    `base=$(git merge-base "$default" HEAD 2>/dev/null) || base=$(git rev-parse HEAD)`,
    `if [ "$base" != "$(git rev-parse HEAD)" ]; then git --no-pager log --oneline "$base..HEAD"; fi`,
    `git --no-pager diff "$base" || exit 1`,
    `git ls-files --others --exclude-standard -z | while IFS= read -r -d '' f; do git --no-pager diff --no-index -- /dev/null "./$f"; done`,
    `exit 0`,
  ].join("\n");
  const result = linux(["bash", "-lc", script]);
  if (result.code !== 0) {
    fail(`git diff failed for workspace "${id}"`);
  }
}

function cmdFetch(args: string[]): void {
  const id = args[0];
  if (!id) {
    fail("usage: lwb fetch <id> (run inside the host git repo that should receive the branch)");
  }

  const hostRepo = spawnSync("git", ["rev-parse", "--git-dir"], { stdio: "pipe" });
  if ((hostRepo.status ?? 1) !== 0) {
    fail("lwb fetch must run inside a host git repository (it fetches lwb/<id> into the current repo)");
  }

  const workspace = findWorkspace(id);
  const bareRepoDir = guestPath(`lwb/repos/${workspace.repo}.git`);

  // Commits are the only thing fetch can move; uncommitted work stays in the
  // VM (see `lwb diff`). git-over-ssh is the one git-native channel into the
  // guest: the default limactl transport has no URL scheme, so route through
  // Lima's own sshd (or LWB_SSH when set).
  let host: string;
  let sshCommand: string;
  if (SSH_TARGET) {
    host = SSH_TARGET;
    sshCommand = SSH_CONFIG ? `ssh -F ${shQuote(SSH_CONFIG)}` : "ssh";
  } else {
    host = `lima-${VM_NAME}`;
    sshCommand = `ssh -F ${shQuote(`${homedir()}/.lima/${VM_NAME}/ssh.config`)}`;
  }

  const refspec = `${workspace.branch}:${workspace.branch}`;
  const result = spawnSync(
    "git",
    ["-c", `core.sshCommand=${sshCommand}`, "fetch", `ssh://${host}${bareRepoDir}`, refspec],
    { stdio: "inherit" },
  );
  if ((result.status ?? 1) !== 0) {
    fail(`git fetch failed for workspace "${id}"`);
  }
  console.log(`Fetched ${workspace.branch} into the current repo.`);
}

function cmdDestroy(args: string[]): void {
  let id: string | undefined;
  let force = false;
  for (const arg of args) {
    if (arg === "--force" || arg === "-f") {
      force = true;
    } else if (!id) {
      id = arg;
    } else {
      fail("usage: lwb destroy <id> [--force]");
    }
  }
  if (!id) {
    fail("usage: lwb destroy <id> [--force]");
  }
  const workspace = findWorkspace(id);

  if (!workspace.branch.startsWith("lwb/")) {
    fail(
      `refusing to destroy workspace "${id}": branch "${workspace.branch}" does not have the lwb/ prefix`,
    );
  }

  // Destroy deletes commits that exist nowhere else. Unless forced (or the
  // guard is disabled via LWB_DESTROY_GUARD=0), refuse when the workspace
  // holds work not on the default branch and show what would be lost (same
  // merge-base logic as `lwb diff`).
  if (!force && DESTROY_GUARD) {
    const script = [
      `cd ${shQuote(workspace.path)} || exit 1`,
      `dirty=$(git status --porcelain) || exit 1`,
      `common=$(git rev-parse --git-common-dir)`,
      `default=$(git --git-dir="$common" symbolic-ref --short HEAD 2>/dev/null)`,
      // No merge-base with the default branch means every commit here may
      // exist only in the VM: fail closed instead of assuming ahead=0.
      `base=$([ -n "$default" ] && git merge-base "$default" HEAD 2>/dev/null)`,
      `if [ -z "$base" ]; then`,
      `  echo "cannot verify this workspace against the default branch; its commits may exist only in the VM:"`,
      `  echo; git --no-pager log --oneline -20 HEAD`,
      `  if [ -n "$dirty" ]; then echo; git status --short; fi`,
      `  exit 3`,
      `fi`,
      `ahead=$(git rev-list --count "$base..HEAD")`,
      `[ -z "$dirty" ] && [ "$ahead" -eq 0 ] && exit 0`,
      `echo "this workspace still has work that exists only in the VM:"`,
      `if [ "$ahead" -gt 0 ]; then echo; git --no-pager log --oneline "$base..HEAD"; fi`,
      `if [ -n "$dirty" ]; then echo; git status --short; fi`,
      `echo`,
      `git --no-pager diff --stat "$base"`,
      `exit 3`,
    ].join("\n");
    const check = linux(["bash", "-lc", script]);
    if (check.code === 3) {
      fail(
        `refusing to destroy workspace "${id}": keep the work with \`lwb fetch ${id}\` or discard it with \`lwb destroy ${id} --force\``,
      );
    }
    if (check.code !== 0) {
      fail(`could not inspect workspace "${id}" before destroy`);
    }
  }

  const bareRepoDir = guestPath(`lwb/repos/${workspace.repo}.git`);

  const removeResult = linux([
    "git",
    `--git-dir=${bareRepoDir}`,
    "worktree",
    "remove",
    "--force",
    workspace.path,
  ]);
  if (removeResult.code !== 0) {
    fail(`git worktree remove failed for workspace "${id}"`);
  }

  const branchResult = linux([
    "git",
    `--git-dir=${bareRepoDir}`,
    "branch",
    "-D",
    workspace.branch,
  ]);
  if (branchResult.code !== 0) {
    fail(`git branch -D failed for branch "${workspace.branch}"`);
  }

  console.log(`Destroyed workspace "${id}"`);
}

function cmdGc(): void {
  // Reclaim guest disk: prune stale worktree registrations, empty the cache
  // scratch dir. Repos are only ever reported, never deleted.
  const script = [
    `for d in ~/lwb/repos/*.git; do`,
    `  [ -e "$d" ] || continue`,
    `  git --git-dir="$d" worktree prune`,
    `done`,
    `find ~/lwb/cache -mindepth 1 -delete 2>/dev/null`,
    `echo "Pruned stale worktree registrations and cleared ~/lwb/cache."`,
    `for d in ~/lwb/repos/*.git; do`,
    `  [ -e "$d" ] || continue`,
    // porcelain lists the bare repo itself as the first "worktree" entry
    `  n=$(git --git-dir="$d" worktree list --porcelain | grep -c '^worktree ')`,
    `  [ "$n" -le 1 ] && echo "repo $(basename "$d" .git) has no workspaces (remove it by hand if unwanted)"`,
    `done`,
    `echo "Guest disk usage: $(du -sh ~/lwb | cut -f1)"`,
    `exit 0`,
  ].join("\n");
  const { code } = linux(["bash", "-lc", script]);
  if (code !== 0) {
    fail("gc failed");
  }
}

function cmdDoctor(): void {
  // Preflight for headless runs: exits non-zero on anything that would make
  // `lwb exec <id> -- claude -p ...` fail confusingly, so orchestrators can
  // gate with `lwb doctor && lwb exec ...`.
  if (!SSH_TARGET) {
    const vm = findVm();
    if (!vm) {
      fail(`no "${VM_NAME}" VM found; run \`lwb setup\``);
    }
    if (vm.status !== "Running") {
      fail(`VM "${VM_NAME}" is ${vm.status}; run \`lwb init\``);
    }
    console.log(`ok: VM "${VM_NAME}" is running`);
  }

  const script = [
    `status=0`,
    `for d in ~/lwb/repos ~/lwb/worktrees ~/lwb/cache; do`,
    `  if [ -d "$d" ]; then echo "ok: $d"; else echo "fail: $d missing (run lwb init)"; status=1; fi`,
    `done`,
    `if command -v git >/dev/null; then echo "ok: git $(git --version | cut -d' ' -f3)"; else echo "fail: git not installed (run lwb setup)"; status=1; fi`,
    // `claude auth status` is authoritative: it accounts for refresh tokens,
    // which a raw expiresAt check in .credentials.json would misreport.
    `if command -v claude >/dev/null; then`,
    `  if claude auth status 2>/dev/null | grep -q '"loggedIn":[[:space:]]*true'; then`,
    `    echo "ok: claude logged in"`,
    `  else`,
    `    echo "fail: claude not logged in; run: limactl shell ${VM_NAME} -- claude auth login"; status=1`,
    `  fi`,
    `else`,
    `  echo "info: claude not installed in guest (optional; lwb setup --claude)"`,
    `fi`,
    `exit $status`,
  ].join("\n");
  const { code } = linux(["bash", "-lc", script]);
  if (code !== 0) {
    fail("doctor found problems");
  }
}

// ---------------------------------------------------------------------------
// Usage / help
// ---------------------------------------------------------------------------

const USAGE = `lwb - Linux Worktree Box

Usage: lwb <command> [args]

Commands:
  setup [--cpus N] [--memory GiB] [--disk GiB] [--claude]
                                     Create + provision the lwb VM (one-time)
  init                              Ensure the lwb VM is running and guest dirs exist
  add <git-url> [name]              Clone a bare repo into the VM
  create <repo> [--base <ref>] [--name <id>]
                                     Create a new worktree workspace
  ls                                List all workspaces
  exec <id> -- <cmd...>             Run a command in a workspace
  shell <id>                        Open an interactive shell in a workspace
  agent <id> -- <agentcmd...>       Launch a coding agent in a workspace
  diff <id>                         Show git status/diff for a workspace
  fetch <id>                        Fetch a workspace's lwb/ branch into the current host repo
  destroy <id> [--force]            Remove a workspace and its lwb/ branch
                                     (refuses if unfetched work would be lost, unless --force;
                                      LWB_DESTROY_GUARD=0 disables the check entirely)
  gc                                Prune stale worktree registrations, clear the guest cache
  doctor                            Check VM, guest dirs, and agent credentials (for headless runs)
  --help                            Show this help text
`;

function printUsage(): void {
  console.log(USAGE);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printUsage();
    process.exit(0);
  }

  switch (command) {
    case "setup":
      cmdSetup(rest);
      break;
    case "init":
      cmdInit();
      break;
    case "add":
      cmdAdd(rest);
      break;
    case "create":
      cmdCreate(rest);
      break;
    case "ls":
      cmdLs();
      break;
    case "exec":
      cmdExec(rest);
      break;
    case "shell":
      cmdShell(rest);
      break;
    case "agent":
      cmdAgent(rest);
      break;
    case "diff":
      cmdDiff(rest);
      break;
    case "fetch":
      cmdFetch(rest);
      break;
    case "destroy":
      cmdDestroy(rest);
      break;
    case "gc":
      cmdGc();
      break;
    case "doctor":
      cmdDoctor();
      break;
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main();
