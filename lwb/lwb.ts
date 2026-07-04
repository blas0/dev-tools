#!/usr/bin/env bun
// lwb - Linux Worktree Box
//
// The Mac is a control surface; all real work happens inside a Lima VM
// named "lwb". Every operation shells out to `limactl shell lwb -- ...`.
// State lives in git inside the VM (git worktree list --porcelain) --
// no database, no state files.

import { spawnSync } from "node:child_process";

const VM_NAME = "lwb";

// Transport seam (POC 4): by default commands route through `limactl shell`.
// Set LWB_SSH=<host> to route through `ssh <host>` instead (e.g. a 2017 iMac
// running Linux, or lima's own sshd for testing). Optional LWB_SSH_CONFIG
// points at an ssh config file (-F). The workspace API stays fixed; only the
// execution substrate changes.
const SSH_TARGET = process.env.LWB_SSH;
const SSH_CONFIG = process.env.LWB_SSH_CONFIG;

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

  const statusResult = linux(["git", "-C", workspace.path, "status", "--short"]);
  if (statusResult.code !== 0) {
    fail(`git status failed for workspace "${id}"`);
  }
  const diffResult = linux(["git", "-C", workspace.path, "diff"]);
  if (diffResult.code !== 0) {
    fail(`git diff failed for workspace "${id}"`);
  }
}

function cmdDestroy(args: string[]): void {
  const id = args[0];
  if (!id) {
    fail("usage: lwb destroy <id>");
  }
  const workspace = findWorkspace(id);

  if (!workspace.branch.startsWith("lwb/")) {
    fail(
      `refusing to destroy workspace "${id}": branch "${workspace.branch}" does not have the lwb/ prefix`,
    );
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
  destroy <id>                      Remove a workspace and its lwb/ branch
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
    case "destroy":
      cmdDestroy(rest);
      break;
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main();
