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

// --json global flag: set once in main() before dispatch, read by commands
// that support structured output. Absent by default so human output is
// unchanged unless a caller explicitly opts in.
let jsonOutput = false;

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * Split argv at the first `--` separator and strip a single `--json` token
 * from the head only, so e.g. `lwb exec <id> -- foo --json` passes `--json`
 * through to the guest command untouched.
 */
function splitJsonFlag(argv: string[]): { argv: string[]; json: boolean } {
  const dashIndex = argv.indexOf("--");
  const head = dashIndex === -1 ? argv.slice() : argv.slice(0, dashIndex);
  const tail = dashIndex === -1 ? [] : argv.slice(dashIndex);
  const flagIndex = head.indexOf("--json");
  let json = false;
  if (flagIndex !== -1) {
    json = true;
    head.splice(flagIndex, 1);
  }
  return { argv: [...head, ...tail], json };
}

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

/** `--cpus <n>` maps to a CPUQuota percentage: 1.5 cpus -> 150%. */
function cpuQuota(cpus: number): number {
  return Math.round(cpus * 100);
}

/**
 * Parse `--mem <size>` / `--cpus <n>` from the flag args preceding `--` in
 * `exec`/`agent`. Validates both; `fail()`s on malformed input.
 */
function parseResourceFlags(flagArgs: string[]): { mem?: string; cpus?: number } {
  let mem: string | undefined;
  let cpus: number | undefined;
  for (let i = 0; i < flagArgs.length; i++) {
    if (flagArgs[i] === "--mem") {
      mem = flagArgs[++i];
      if (!mem || !/^\d+(\.\d+)?[KMGT]?$/i.test(mem)) {
        fail(`invalid --mem value "${mem ?? ""}" (expected e.g. 512M, 2G)`);
      }
    } else if (flagArgs[i] === "--cpus") {
      const raw = flagArgs[++i];
      cpus = raw === undefined ? NaN : Number(raw);
      if (!raw || Number.isNaN(cpus) || cpus <= 0) {
        fail(`invalid --cpus value "${raw ?? ""}" (expected a positive number)`);
      }
    } else {
      fail(`unknown flag "${flagArgs[i]}" (expected --mem <size> or --cpus <n>)`);
    }
  }
  return { mem, cpus };
}

/**
 * When `--mem`/`--cpus` are set, wrap the guest argv in a transient
 * `systemd-run --user --scope` so the command is memory/CPU-capped.
 * `--scope` (not `--service`) keeps it attached to the current TTY.
 */
function wrapWithResourceLimits(
  commandArgs: string[],
  mem: string | undefined,
  cpus: number | undefined,
): string[] {
  if (mem === undefined && cpus === undefined) {
    return commandArgs;
  }
  const wrapped = ["systemd-run", "--user", "--scope", "-q", "--collect"];
  if (mem !== undefined) wrapped.push("-p", `MemoryMax=${mem}`);
  if (cpus !== undefined) wrapped.push("-p", `CPUQuota=${cpuQuota(cpus)}%`);
  wrapped.push("--", ...commandArgs);
  return wrapped;
}

/**
 * Parse and validate one `--egress-allow` entry ("<cidr>" or "<cidr>:<port>").
 * Returns the split parts, or null when the value is not a clean IPv4
 * address/CIDR with an optional 1-65535 port. Pure so it can be unit-tested;
 * the caller turns null into a fail().
 *
 * This is a security boundary, not just input hygiene: the value is
 * interpolated raw into an nft ruleset that is written via a quoted heredoc
 * and applied with `sudo nft`, so an embedded newline + "LWB_EGRESS_EOF" could
 * terminate the heredoc early and run trailing content as a shell command.
 */
function parseEgressAllow(entry: string): { cidr: string; port?: string } | null {
  const parts = entry.split(":");
  if (parts.length > 2) return null;
  const [cidr, port] = parts;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(cidr);
  if (!m) return null;
  if ([m[1], m[2], m[3], m[4]].some((octet) => Number(octet) > 255)) return null;
  if (m[5] !== undefined && Number(m[5]) > 32) return null;
  if (port !== undefined) {
    if (!/^\d+$/.test(port)) return null;
    const p = Number(port);
    if (p < 1 || p > 65535) return null;
  }
  return { cidr, port };
}

function cmdSetup(args: string[]): void {
  let cpus = "4";
  let memory = "8";
  let disk = "60";
  let withClaude = false;
  let egressFirewall = false;
  let egressOff = false;
  const egressAllow: { cidr: string; port?: string }[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cpus") {
      cpus = args[++i];
    } else if (args[i] === "--memory") {
      memory = args[++i];
    } else if (args[i] === "--disk") {
      disk = args[++i];
    } else if (args[i] === "--claude") {
      withClaude = true;
    } else if (args[i] === "--egress-firewall") {
      egressFirewall = true;
    } else if (args[i] === "--egress-off") {
      egressOff = true;
    } else if (args[i] === "--egress-allow") {
      const entry = args[++i];
      const parsed = entry === undefined ? null : parseEgressAllow(entry);
      if (!parsed) {
        fail(
          `invalid --egress-allow "${entry}" (expected IPv4 <cidr> or <cidr>:<port>, e.g. 10.0.0.0/8 or 1.2.3.4:443)`,
        );
      }
      egressAllow.push(parsed);
    } else {
      fail(
        `unknown setup flag "${args[i]}" (usage: lwb setup [--cpus N] [--memory GiB] [--disk GiB] [--claude] [--egress-firewall] [--egress-allow <cidr[:port]>] [--egress-off])`,
      );
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

  if (egressOff) {
    console.log("Removing egress firewall table (inet lwb_egress)...");
    const offResult = linux(["bash", "-lc", "sudo nft delete table inet lwb_egress"]);
    if (offResult.code !== 0) {
      fail("failed to remove egress firewall table (was it applied?)");
    }
    console.log("Egress firewall removed.");
  } else if (egressFirewall) {
    console.log(
      "Applying egress firewall (port-level default-deny egress with optional CIDR allowances)...",
    );
    const allowLines = egressAllow.map(({ cidr, port }) =>
      port
        ? `    ip daddr ${cidr} tcp dport ${port} accept`
        : `    ip daddr ${cidr} accept`,
    );
    const ruleset = [
      "table inet lwb_egress {",
      "  chain output {",
      "    type filter hook output priority 0; policy drop;",
      '    oif "lo" accept',
      "    ct state established,related accept",
      "    tcp dport 53 accept",
      "    udp dport 53 accept",
      "    udp dport { 67, 68, 123 } accept",
      "    tcp dport { 22, 80, 443, 9418 } accept",
      ...allowLines,
      "    counter drop",
      "  }",
      "}",
      "",
    ].join("\n");
    const applyScript = [
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q nftables",
      `cat <<'LWB_EGRESS_EOF' | sudo tee /etc/lwb-egress.nft >/dev/null\n${ruleset}LWB_EGRESS_EOF`,
      "sudo nft -c -f /etc/lwb-egress.nft",
      "sudo nft -f /etc/lwb-egress.nft",
    ].join(" && ");
    const applyResult = linux(["bash", "-lc", applyScript]);
    if (applyResult.code !== 0) {
      fail("egress firewall apply failed (ruleset syntax or nft apply error)");
    }
    console.log("Egress firewall applied (table inet lwb_egress).");
    console.log("");
    console.log(
      "Scope note: this is a port-level default-deny egress firewall with optional",
    );
    console.log(
      "CIDR allowances, not a domain allowlist -- nftables cannot filter by domain.",
    );
    console.log(
      "It blocks reverse shells/exfil on arbitrary ports, SMTP, and port-scanning,",
    );
    console.log("while permitting DNS, git, and http/https.");
    console.log("");
    console.log("Not persisted across reboot. To persist, add to /etc/nftables.conf:");
    console.log('  include "/etc/lwb-egress.nft"');
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

  // Capture in JSON mode so git's "HEAD is now at ..." checkout line cannot
  // leak onto stdout and corrupt the JSON object; humans still see it (inherit).
  const worktreeResult = linux(
    [
      "git",
      `--git-dir=${bareRepoDir}`,
      "worktree",
      "add",
      worktreePath,
      "-b",
      `lwb/${id}`,
      base,
    ],
    { capture: jsonOutput },
  );
  if (worktreeResult.code !== 0) {
    fail(`git worktree add failed for repo "${repo}"`);
  }

  if (jsonOutput) {
    printJson({ id, repo, branch: `lwb/${id}`, path: worktreePath });
    return;
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
  if (jsonOutput) {
    printJson(workspaces.map((w) => ({ id: w.id, repo: w.repo, branch: w.branch, path: w.path })));
    return;
  }
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
    fail("usage: lwb exec <id> [--mem <size>] [--cpus <n>] -- <cmd...>");
  }
  const { mem, cpus } = parseResourceFlags(args.slice(1, dashIndex));
  const command = args.slice(dashIndex + 1);
  const workspace = findWorkspace(id);

  const quotedCmd = command.map(shQuote).join(" ");
  const script = `cd ${shQuote(workspace.path)} && exec ${quotedCmd}`;
  const commandArgs = wrapWithResourceLimits(["bash", "-lc", script], mem, cpus);
  const guest = guestCommand(commandArgs, true);
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
    fail("usage: lwb agent <id> [--mem <size>] [--cpus <n>] -- <agentcmd...>");
  }
  const { mem, cpus } = parseResourceFlags(args.slice(1, dashIndex));
  const command = args.slice(dashIndex + 1);
  const workspace = findWorkspace(id);

  const quotedCmd = command.map(shQuote).join(" ");
  const script = `cd ${shQuote(workspace.path)} && exec ${quotedCmd}`;
  const commandArgs = wrapWithResourceLimits(["bash", "-lc", script], mem, cpus);
  const guest = guestCommand(commandArgs, true);
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
  if (jsonOutput) {
    const patchResult = linux(["bash", "-lc", script], { capture: true });
    if (patchResult.code !== 0) {
      fail(`git diff failed for workspace "${id}"`);
    }
    // A second, small guest round-trip supplies the structured fields
    // (status/base/commits) separately from the verbatim patch text above.
    const metaScript = [
      `cd ${shQuote(workspace.path)} || exit 1`,
      `git status --porcelain || exit 1`,
      `echo LWB_SEP`,
      `common=$(git rev-parse --git-common-dir)`,
      `default=$(git --git-dir="$common" symbolic-ref --short HEAD 2>/dev/null)`,
      `base=$(git merge-base "$default" HEAD 2>/dev/null) || base=$(git rev-parse HEAD)`,
      `head=$(git rev-parse HEAD)`,
      `echo "$base"`,
      `echo LWB_SEP`,
      `if [ "$base" != "$head" ]; then git --no-pager log --format='%H %s' "$base..HEAD"; fi`,
      `exit 0`,
    ].join("\n");
    const metaResult = linux(["bash", "-lc", metaScript], { capture: true });
    if (metaResult.code !== 0) {
      fail(`git diff failed for workspace "${id}"`);
    }
    const [statusText, baseText, commitsText] = metaResult.stdout.split("LWB_SEP\n");
    const status = (statusText ?? "")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));
    const base = (baseText ?? "").trim();
    const commits = (commitsText ?? "")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => {
        const spaceIdx = l.indexOf(" ");
        return { sha: l.slice(0, spaceIdx), subject: l.slice(spaceIdx + 1) };
      });
    printJson({
      id,
      repo: workspace.repo,
      branch: workspace.branch,
      base,
      ahead: commits.length,
      dirty: status.length > 0,
      status,
      commits,
      patch: patchResult.stdout,
    });
    return;
  }

  const result = linux(["bash", "-lc", script]);
  if (result.code !== 0) {
    fail(`git diff failed for workspace "${id}"`);
  }
}

function cmdFork(args: string[]): void {
  const sourceId = args[0];
  if (!sourceId) {
    fail("usage: lwb fork <id> [--name <newid>] [--dirty]");
  }

  let name: string | undefined;
  let dirty = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--name") {
      name = args[++i];
    } else if (args[i] === "--dirty") {
      dirty = true;
    } else {
      fail(`unknown fork flag "${args[i]}" (usage: lwb fork <id> [--name <newid>] [--dirty])`);
    }
  }

  const src = findWorkspace(sourceId);
  if (!src.branch.startsWith("lwb/")) {
    fail(
      `refusing to fork workspace "${sourceId}": branch "${src.branch}" does not have the lwb/ prefix`,
    );
  }
  const bareRepoDir = guestPath(`lwb/repos/${src.repo}.git`);

  // Workspace ids are globally unique; reuse cmdCreate's uniqueness loop.
  const takenIds = new Set(listWorkspaces().map((w) => w.id));
  let id = name;
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

  // Pin the base commit to the source workspace's current HEAD.
  const shaResult = linux(["git", `--git-dir=${bareRepoDir}`, "rev-parse", src.branch], {
    capture: true,
  });
  const sha = shaResult.stdout.trim();
  if (shaResult.code !== 0 || !sha) {
    fail(`could not resolve base commit for workspace "${sourceId}"`);
  }

  const worktreePath = guestPath(`lwb/worktrees/${src.repo}/${id}`);
  const parentDir = guestPath(`lwb/worktrees/${src.repo}`);

  const mkdirResult = linux(["bash", "-lc", `mkdir -p ${shQuote(parentDir)}`]);
  if (mkdirResult.code !== 0) {
    fail(`failed to create parent directory ${parentDir}`);
  }

  // Capture in JSON mode so git's "HEAD is now at ..." checkout line cannot
  // leak onto stdout and corrupt the JSON object; humans still see it (inherit).
  const worktreeResult = linux(
    [
      "git",
      `--git-dir=${bareRepoDir}`,
      "worktree",
      "add",
      worktreePath,
      "-b",
      `lwb/${id}`,
      sha,
    ],
    { capture: jsonOutput },
  );
  if (worktreeResult.code !== 0) {
    fail(`git worktree add failed for repo "${src.repo}"`);
  }

  if (dirty) {
    // Best-effort replay of the source's uncommitted state (tracked +
    // untracked). A failed `git apply` warns but does not abort: the
    // committed fork above already succeeded.
    const dirtyScript = [
      `set -e`,
      `( cd ${shQuote(src.path)} && git diff HEAD ) | ( cd ${shQuote(worktreePath)} && git apply --index --whitespace=nowarn - ) \\`,
      `  || echo "lwb: warning: some tracked changes did not apply cleanly" >&2`,
      `if [ -n "$( cd ${shQuote(src.path)} && git ls-files --others --exclude-standard )" ]; then`,
      `  ( cd ${shQuote(src.path)} && git ls-files --others --exclude-standard -z | tar --null -T - -cf - ) \\`,
      `    | ( cd ${shQuote(worktreePath)} && tar -xf - )`,
      `fi`,
    ].join("\n");
    linux(["bash", "-lc", dirtyScript]);
  }

  if (jsonOutput) {
    printJson({
      id,
      repo: src.repo,
      branch: `lwb/${id}`,
      path: worktreePath,
      forkedFrom: sourceId,
    });
    return;
  }

  console.log("Created workspace:");
  console.log("");
  console.log(`ID:       ${id}`);
  console.log(`Repo:     ${src.repo}`);
  console.log(`Branch:   lwb/${id}`);
  console.log(`Path:     ${worktreePath}`);
  console.log("Machine:  local");
  console.log(`Forked from: ${sourceId}`);
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

// Returns bash that exits 0 iff the workspace at `path` holds NO work that
// exists only in the VM (clean tree AND no commits ahead of default branch's
// merge-base). Exits 3 with a human-readable report otherwise; other non-zero
// means "could not verify" (fail closed).
function unfetchedWorkGuard(path: string): string {
  return [
    `cd ${shQuote(path)} || exit 1`,
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
}

function cmdPort(args: string[]): void {
  const guestPortRaw = args[0];
  const guestPortNum = Number(guestPortRaw);
  if (!guestPortRaw || !Number.isInteger(guestPortNum) || guestPortNum < 1 || guestPortNum > 65535) {
    fail("usage: lwb port <guest-port> [--host-port <n>] (guest-port must be an integer 1-65535)");
  }

  let hostPortRaw: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--host-port") {
      hostPortRaw = args[++i];
    } else {
      fail(`unknown port flag "${args[i]}" (usage: lwb port <guest-port> [--host-port <n>])`);
    }
  }
  const hostPortNum = hostPortRaw === undefined ? guestPortNum : Number(hostPortRaw);
  if (!Number.isInteger(hostPortNum) || hostPortNum < 1 || hostPortNum > 65535) {
    fail(`invalid --host-port value "${hostPortRaw ?? ""}" (must be an integer 1-65535)`);
  }

  console.log(
    `Forwarding http://localhost:${hostPortNum} -> guest :${guestPortNum} (Ctrl-C to stop)`,
  );

  // No <id>: workspaces share one network namespace, so a listening port is
  // VM-global, not per-workspace. Same ssh-config logic `cmdFetch` uses.
  //
  // `-o ControlPath=none` disables connection sharing for this invocation:
  // Lima's generated ssh.config sets `ControlMaster auto` + `ControlPersist`,
  // which would otherwise hand the forward to a persistent background master
  // and return immediately -- leaving an un-stoppable tunnel and contradicting
  // the "Ctrl-C to stop" contract. A fresh connection ties the forward to this
  // foreground process, so Ctrl-C tears it down.
  const noShare = ["-o", "ControlPath=none"];
  let sshArgv: string[];
  if (SSH_TARGET) {
    sshArgv = [];
    if (SSH_CONFIG) sshArgv.push("-F", SSH_CONFIG);
    sshArgv.push(...noShare, "-N", "-L", `${hostPortNum}:localhost:${guestPortNum}`, SSH_TARGET);
  } else {
    sshArgv = [
      "-F",
      `${homedir()}/.lima/${VM_NAME}/ssh.config`,
      ...noShare,
      "-N",
      "-L",
      `${hostPortNum}:localhost:${guestPortNum}`,
      `lima-${VM_NAME}`,
    ];
  }
  const result = spawnSync("ssh", sshArgv, { stdio: "inherit" });
  process.exit(result.status ?? 1);
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
    if (jsonOutput) {
      printJson({
        id,
        refused: true,
        reason: "non-lwb-branch",
        detail: `branch "${workspace.branch}" does not have the lwb/ prefix`,
      });
      process.exit(1);
    }
    fail(
      `refusing to destroy workspace "${id}": branch "${workspace.branch}" does not have the lwb/ prefix`,
    );
  }

  // Destroy deletes commits that exist nowhere else. Unless forced (or the
  // guard is disabled via LWB_DESTROY_GUARD=0), refuse when the workspace
  // holds work not on the default branch and show what would be lost (same
  // merge-base logic as `lwb diff`).
  if (!force && DESTROY_GUARD) {
    const script = unfetchedWorkGuard(workspace.path);
    const check = linux(["bash", "-lc", script], { capture: jsonOutput });
    if (check.code === 3) {
      if (jsonOutput) {
        const detail = check.stdout.trim();
        const reason = detail.startsWith("cannot verify") ? "unverifiable" : "unfetched-work";
        printJson({ id, refused: true, reason, detail });
        process.exit(1);
      }
      fail(
        `refusing to destroy workspace "${id}": keep the work with \`lwb fetch ${id}\` or discard it with \`lwb destroy ${id} --force\``,
      );
    }
    if (check.code !== 0) {
      if (jsonOutput) {
        printJson({ id, refused: true, reason: "unverifiable", detail: check.stdout.trim() });
        process.exit(1);
      }
      fail(`could not inspect workspace "${id}" before destroy`);
    }
  }

  const bareRepoDir = guestPath(`lwb/repos/${workspace.repo}.git`);

  // Capture in JSON mode so git's "Deleted branch lwb/... (was ...)" line (and
  // any worktree-remove chatter) cannot leak onto stdout and corrupt the JSON
  // object; humans still see it in the default (inherit) path.
  const removeResult = linux(
    [
      "git",
      `--git-dir=${bareRepoDir}`,
      "worktree",
      "remove",
      "--force",
      workspace.path,
    ],
    { capture: jsonOutput },
  );
  if (removeResult.code !== 0) {
    fail(`git worktree remove failed for workspace "${id}"`);
  }

  const branchResult = linux(
    [
      "git",
      `--git-dir=${bareRepoDir}`,
      "branch",
      "-D",
      workspace.branch,
    ],
    { capture: jsonOutput },
  );
  if (branchResult.code !== 0) {
    fail(`git branch -D failed for branch "${workspace.branch}"`);
  }

  if (jsonOutput) {
    printJson({ id, destroyed: true });
    return;
  }
  console.log(`Destroyed workspace "${id}"`);
}

/** Parse "7d"/"24h"/"30m"/"90s" (integer + single unit) into seconds. */
function parseDuration(input: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(input);
  if (!match) {
    fail(`invalid duration "${input}" (expected an integer + unit, e.g. 30s, 5m, 2h, 7d)`);
  }
  const seconds: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return Number(match[1]) * seconds[match[2]];
}

/** Render an age in seconds as a short human string, e.g. "9d", "3h". */
function humanizeAge(ageSeconds: number): string {
  if (ageSeconds >= 86400) return `${Math.floor(ageSeconds / 86400)}d`;
  if (ageSeconds >= 3600) return `${Math.floor(ageSeconds / 3600)}h`;
  if (ageSeconds >= 60) return `${Math.floor(ageSeconds / 60)}m`;
  return `${ageSeconds}s`;
}

function cmdGc(args: string[]): void {
  let reap: string | undefined;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--reap") {
      reap = args[++i];
    } else if (args[i] === "--dry-run" || args[i] === "-n") {
      dryRun = true;
    } else {
      fail(`unknown gc flag "${args[i]}" (usage: lwb gc [--reap <duration>] [--dry-run|-n])`);
    }
  }
  const thresholdSeconds = reap === undefined ? undefined : parseDuration(reap);

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
  const needsCapture = jsonOutput || thresholdSeconds !== undefined;
  const { code, stdout } = linux(["bash", "-lc", script], { capture: needsCapture });
  if (code !== 0) {
    fail("gc failed");
  }
  if (needsCapture && !jsonOutput) {
    process.stdout.write(stdout);
  }

  if (thresholdSeconds === undefined) {
    if (jsonOutput) {
      printJson({ reaped: [], skipped: [] });
    }
    return;
  }

  // Reap pass: candidates are workspaces at/above the age threshold; only
  // those that PASS the destroy safety guard are actually removed.
  const workspaces = listWorkspaces();
  const reaped: { id: string; repo: string; ageSeconds: number }[] = [];
  const skipped: { id: string; reason: string }[] = [];

  if (workspaces.length > 0) {
    const quotedPaths = workspaces.map((w) => shQuote(w.path)).join(" ");
    const ageScript = [
      `echo "NOW $(date +%s)"`,
      `for p in ${quotedPaths}; do echo "PATH $p $(stat -c %Y "$p/.git" 2>/dev/null || echo 0)"; done`,
    ].join("\n");
    const ageResult = linux(["bash", "-lc", ageScript], { capture: true });
    if (ageResult.code !== 0) {
      fail("gc --reap: failed to read workspace ages");
    }

    let now = 0;
    const mtimes = new Map<string, number>();
    for (const line of ageResult.stdout.split("\n")) {
      if (line.startsWith("NOW ")) {
        now = Number(line.slice("NOW ".length).trim());
      } else if (line.startsWith("PATH ")) {
        const rest = line.slice("PATH ".length);
        const spaceIdx = rest.lastIndexOf(" ");
        mtimes.set(rest.slice(0, spaceIdx), Number(rest.slice(spaceIdx + 1)));
      }
    }

    for (const w of workspaces) {
      const mtime = mtimes.get(w.path) ?? 0;
      const age = now - mtime;
      if (age < thresholdSeconds) continue;

      const guardResult = linux(["bash", "-lc", unfetchedWorkGuard(w.path)], { capture: true });
      if (guardResult.code !== 0) {
        skipped.push({ id: w.id, reason: guardResult.code === 3 ? "unfetched work" : "could not verify" });
        continue;
      }

      if (dryRun) {
        reaped.push({ id: w.id, repo: w.repo, ageSeconds: age });
        continue;
      }

      const bareRepoDir = guestPath(`lwb/repos/${w.repo}.git`);
      // Capture in JSON mode so git's "Deleted branch ..." line cannot leak
      // onto stdout and corrupt the JSON object (see cmdDestroy for rationale).
      const removeResult = linux([
        "git", `--git-dir=${bareRepoDir}`, "worktree", "remove", "--force", w.path,
      ], { capture: jsonOutput });
      if (removeResult.code !== 0) {
        skipped.push({ id: w.id, reason: "worktree remove failed" });
        continue;
      }
      const branchResult = linux(["git", `--git-dir=${bareRepoDir}`, "branch", "-D", w.branch], { capture: jsonOutput });
      if (branchResult.code !== 0) {
        skipped.push({ id: w.id, reason: "branch delete failed" });
        continue;
      }
      reaped.push({ id: w.id, repo: w.repo, ageSeconds: age });
    }
  }

  if (jsonOutput) {
    printJson({ reaped, skipped });
    return;
  }

  const verb = dryRun ? "Would reap" : "Reaped";
  for (const r of reaped) {
    console.log(`${verb} ${r.id} (${r.repo}, age ${humanizeAge(r.ageSeconds)})`);
  }
  for (const s of skipped) {
    console.log(`Skipped ${s.id}: ${s.reason}`);
  }
}

function cmdDoctor(): void {
  // Preflight for headless runs: exits non-zero on anything that would make
  // `lwb exec <id> -- claude -p ...` fail confusingly, so orchestrators can
  // gate with `lwb doctor && lwb exec ...`.
  const checks: { status: string; message: string }[] = [];

  if (!SSH_TARGET) {
    const vm = findVm();
    if (!vm) {
      if (jsonOutput) {
        printJson({ ok: false, checks: [{ status: "fail", message: `no "${VM_NAME}" VM found; run \`lwb setup\`` }] });
        process.exit(1);
      }
      fail(`no "${VM_NAME}" VM found; run \`lwb setup\``);
    }
    if (vm.status !== "Running") {
      if (jsonOutput) {
        printJson({ ok: false, checks: [{ status: "fail", message: `VM "${VM_NAME}" is ${vm.status}; run \`lwb init\`` }] });
        process.exit(1);
      }
      fail(`VM "${VM_NAME}" is ${vm.status}; run \`lwb init\``);
    }
    checks.push({ status: "ok", message: `VM "${VM_NAME}" is running` });
    if (!jsonOutput) console.log(`ok: VM "${VM_NAME}" is running`);
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
  const { code, stdout } = linux(["bash", "-lc", script], { capture: jsonOutput });

  if (jsonOutput) {
    for (const line of stdout.split("\n")) {
      const m = /^(ok|fail|info):\s*(.*)$/.exec(line);
      if (m) checks.push({ status: m[1], message: m[2] });
    }
    const ok = !checks.some((c) => c.status === "fail");
    printJson({ ok, checks });
    if (code !== 0) process.exit(1);
    return;
  }

  if (code !== 0) {
    fail("doctor found problems");
  }
}

// ---------------------------------------------------------------------------
// Usage / help
// ---------------------------------------------------------------------------

const USAGE = `lwb - Linux Worktree Box

Usage: lwb <command> [args]

Global flags:
  --json                             Print structured JSON instead of human output
                                     (supported by: ls, create, fork, diff, doctor, destroy, gc)

Commands:
  setup [--cpus N] [--memory GiB] [--disk GiB] [--claude]
        [--egress-firewall] [--egress-allow <cidr[:port]>] [--egress-off]
                                     Create + provision the lwb VM (one-time)
                                     --egress-firewall applies a port-level default-deny
                                     egress nftables policy in the guest (opt-in); --egress-off removes it
  init                              Ensure the lwb VM is running and guest dirs exist
  add <git-url> [name]              Clone a bare repo into the VM
  create <repo> [--base <ref>] [--name <id>]
                                     Create a new worktree workspace
  fork <id> [--name <newid>] [--dirty]
                                     Create a new workspace branched from another workspace's HEAD
                                     (--dirty also replays its uncommitted tracked + untracked state)
  ls                                List all workspaces
  exec <id> [--mem <size>] [--cpus <n>] -- <cmd...>
                                     Run a command in a workspace, optionally resource-capped
                                     via a transient systemd --user --scope
  shell <id>                        Open an interactive shell in a workspace
  agent <id> [--mem <size>] [--cpus <n>] -- <agentcmd...>
                                     Launch a coding agent in a workspace, optionally resource-capped
  diff <id>                         Show git status/diff for a workspace
  fetch <id>                        Fetch a workspace's lwb/ branch into the current host repo
  destroy <id> [--force]            Remove a workspace and its lwb/ branch
                                     (refuses if unfetched work would be lost, unless --force;
                                      LWB_DESTROY_GUARD=0 disables the check entirely)
  gc [--reap <duration>] [--dry-run|-n]
                                     Prune stale worktree registrations, clear the guest cache
                                     --reap <7d|24h|30m|90s> also removes workspaces at/above
                                     that age that pass the destroy safety guard
  doctor                            Check VM, guest dirs, and agent credentials (for headless runs)
  port <guest-port> [--host-port <n>]
                                     Forward a guest port to the host over SSH (foreground; Ctrl-C to stop)
  --help                            Show this help text
`;

function printUsage(): void {
  console.log(USAGE);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const rawArgv = process.argv.slice(2);
  const { argv, json } = splitJsonFlag(rawArgv);
  jsonOutput = json;
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
    case "fork":
      cmdFork(rest);
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
      cmdGc(rest);
      break;
    case "doctor":
      cmdDoctor();
      break;
    case "port":
      cmdPort(rest);
      break;
    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

if (import.meta.main) main();

export { parseDuration, cpuQuota, splitJsonFlag, parseEgressAllow };
