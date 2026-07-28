// Integration tests proving lwb's two transports -- `limactl shell` (default)
// and `ssh` (LWB_SSH) -- behave identically for `lwb exec`. Quoting differs
// between the two paths (limactl passes argv verbatim; ssh re-joins and lets
// the remote shell re-split), so these tests exercise the shell metacharacters
// that a naive quoting implementation could get wrong.
//
// Requires a running "lwb" Lima VM and its ssh config; skips cleanly if
// either is missing.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const LWB = `${import.meta.dir}/../lwb.ts`;
const SSH_CONFIG = `${homedir()}/.lima/lwb/ssh.config`;

function limaVmRunning(): boolean {
  const result = spawnSync("limactl", ["list", "--json"], { stdio: "pipe", encoding: "utf8" });
  const lines = (result.stdout ?? "").split("\n").filter((l) => l.trim().length > 0);
  return lines.some((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed.name === "lwb" && parsed.status === "Running";
    } catch {
      return false;
    }
  });
}

const usable = limaVmRunning() && existsSync(SSH_CONFIG);

function guestCleanup(): void {
  spawnSync("limactl", [
    "shell",
    "lwb",
    "--",
    "bash",
    "-lc",
    "rm -rf /tmp/parity-src ~/lwb/repos/parity-src.git ~/lwb/worktrees/parity-src",
  ]);
}

function runExec(args: string[], ssh: boolean): { stdout: string; code: number } {
  const env = ssh
    ? { ...process.env, LWB_SSH: "lima-lwb", LWB_SSH_CONFIG: SSH_CONFIG }
    : { ...process.env };
  if (!ssh) delete env.LWB_SSH;
  const result = spawnSync("bun", [LWB, "exec", "parity-ws", "--", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env,
  });
  return { stdout: result.stdout ?? "", code: result.status ?? -1 };
}

function runAutomationExec(args: string[]): { stdout: string; code: number } {
  const env = { ...process.env, LWB_AUTOMATION: "1" };
  delete env.LWB_SSH;
  delete env.LWB_SSH_CONFIG;
  const result = spawnSync("bun", [LWB, "exec", "parity-ws", "--", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env,
  });
  return { stdout: result.stdout ?? "", code: result.status ?? -1 };
}

describe.skipIf(!usable)("transport parity (limactl shell vs ssh)", () => {
  beforeAll(() => {
    // Clean up leftovers from any crashed prior run before creating fresh state.
    spawnSync("bun", [LWB, "destroy", "parity-ws", "--force"]);
    guestCleanup();

    const initResult = spawnSync(
      "limactl",
      [
        "shell",
        "lwb",
        "--",
        "bash",
        "-lc",
        "mkdir -p /tmp/parity-src && cd /tmp/parity-src && git init -q -b main && git config user.email t@test && git config user.name t && echo hello > file.txt && git add . && git commit -qm init",
      ],
      { stdio: "pipe" },
    );
    if ((initResult.status ?? 1) !== 0) {
      throw new Error("failed to create guest-local source repo for parity tests");
    }

    const addResult = spawnSync("bun", [LWB, "add", "/tmp/parity-src", "parity-src"], { stdio: "pipe" });
    if ((addResult.status ?? 1) !== 0) {
      throw new Error("lwb add failed for parity-src");
    }

    const createResult = spawnSync("bun", [LWB, "create", "parity-src", "--name", "parity-ws"], {
      stdio: "pipe",
    });
    if ((createResult.status ?? 1) !== 0) {
      throw new Error("lwb create failed for parity-ws");
    }
  }, 60000);

  afterAll(() => {
    spawnSync("bun", [LWB, "destroy", "parity-ws", "--force"]);
    guestCleanup();
  });

  test("preserves_args_with_spaces", () => {
    const args = ["printf", "%s\n", "hello world", "two  spaces"];
    const limactl = runExec(args, false);
    const ssh = runExec(args, true);
    expect(ssh.stdout).toBe(limactl.stdout);
    expect(ssh.code).toBe(limactl.code);
    expect(limactl.code).toBe(0);
  }, 30000);

  test("preserves_single_quotes", () => {
    const args = ["printf", "%s\n", "it's a 'quoted' arg"];
    const limactl = runExec(args, false);
    const ssh = runExec(args, true);
    expect(ssh.stdout).toBe(limactl.stdout);
    expect(ssh.code).toBe(limactl.code);
    expect(limactl.code).toBe(0);
  }, 30000);

  test("does_not_expand_dollar_vars", () => {
    const args = ["printf", "%s\n", "$HOME and ${PATH}"];
    const limactl = runExec(args, false);
    const ssh = runExec(args, true);
    expect(ssh.stdout).toBe(limactl.stdout);
    expect(ssh.code).toBe(limactl.code);
    expect(limactl.code).toBe(0);
    expect(limactl.stdout.startsWith("/")).toBe(false);
  }, 30000);

  test("preserves_double_quotes_and_backslashes", () => {
    const args = ["printf", "%s\n", "back\\slash", 'double"quote'];
    const limactl = runExec(args, false);
    const ssh = runExec(args, true);
    expect(ssh.stdout).toBe(limactl.stdout);
    expect(ssh.code).toBe(limactl.code);
    expect(limactl.code).toBe(0);
  }, 30000);

  test("preserves_unicode", () => {
    const args = ["printf", "%s\n", "ünïcødé ✓ 日本語"];
    const limactl = runExec(args, false);
    const ssh = runExec(args, true);
    expect(ssh.stdout).toBe(limactl.stdout);
    expect(ssh.code).toBe(limactl.code);
    expect(limactl.code).toBe(0);
  }, 30000);

  test("does_not_glob_asterisk", () => {
    const args = ["printf", "%s\n", "*", "?.txt"];
    const limactl = runExec(args, false);
    const ssh = runExec(args, true);
    expect(ssh.stdout).toBe(limactl.stdout);
    expect(ssh.code).toBe(limactl.code);
    expect(limactl.code).toBe(0);
  }, 30000);

  test("propagates_exit_code", () => {
    const args = ["bash", "-c", "exit 7"];
    const limactl = runExec(args, false);
    const ssh = runExec(args, true);
    expect(ssh.stdout).toBe(limactl.stdout);
    expect(ssh.code).toBe(limactl.code);
    expect(limactl.code).toBe(7);
  }, 30000);

  test("git_status_short_matches", () => {
    const args = ["git", "status", "--short"];
    const limactl = runExec(args, false);
    const ssh = runExec(args, true);
    expect(ssh.stdout).toBe(limactl.stdout);
    expect(ssh.code).toBe(limactl.code);
    expect(limactl.code).toBe(0);
    expect(limactl.stdout).toBe("");
  }, 30000);

  test("automation mode uses the Lima SSH transport", () => {
    const args = ["printf", "%s\n", "scheduled task"];
    const limactl = runExec(args, false);
    const automation = runAutomationExec(args);
    expect(automation.stdout).toBe(limactl.stdout);
    expect(automation.code).toBe(limactl.code);
    expect(automation.code).toBe(0);
  }, 30000);
});
