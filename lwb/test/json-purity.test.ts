// Regression tests for the "--json stdout must be pure JSON" invariant.
//
// Several verbs shell out to git commands that print progress to stdout:
// `git worktree add` emits "HEAD is now at <sha> <subject>" and `git branch -D`
// emits "Deleted branch lwb/<id> (was <sha>).". lwb's linux() helper INHERITS
// the guest's stdout by default, so in --json mode those lines leaked ahead of
// the JSON object and broke JSON.parse for any consumer. The fix captures git's
// output in --json mode only (humans still see it on the default path). These
// tests fail loudly if that regresses.
//
// Requires a running "lwb" Lima VM; skips cleanly otherwise. Uses its own
// fixture repo and workspaces (jsonpurity-*) and only ever destroys those --
// gc is exercised with --dry-run only, so no real workspace is ever reaped.

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawnSync } from "node:child_process";

const LWB = `${import.meta.dir}/../lwb.ts`;
const SRC = "jsonpurity-src";
const WS = "jsonpurity-ws";
const FORK = "jsonpurity-fork";

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

const usable = limaVmRunning();

function lwb(args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync("bun", [LWB, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status ?? -1 };
}

function cleanup(): void {
  spawnSync("bun", [LWB, "destroy", FORK, "--force"], { stdio: "ignore" });
  spawnSync("bun", [LWB, "destroy", WS, "--force"], { stdio: "ignore" });
  spawnSync("limactl", [
    "shell",
    "lwb",
    "--",
    "bash",
    "-lc",
    `rm -rf /tmp/${SRC} ~/lwb/repos/${SRC}.git ~/lwb/worktrees/${SRC}`,
  ], { stdio: "ignore" });
}

describe.skipIf(!usable)("--json stdout purity", () => {
  beforeAll(() => {
    cleanup();
    const initResult = spawnSync(
      "limactl",
      [
        "shell",
        "lwb",
        "--",
        "bash",
        "-lc",
        `mkdir -p /tmp/${SRC} && cd /tmp/${SRC} && git init -q -b main && git config user.email t@test && git config user.name t && echo hello > file.txt && git add . && git commit -qm init`,
      ],
      { stdio: "pipe" },
    );
    if ((initResult.status ?? 1) !== 0) {
      throw new Error("failed to create guest-local source repo for json-purity tests");
    }
    const addResult = spawnSync("bun", [LWB, "add", `/tmp/${SRC}`, SRC], { stdio: "pipe" });
    if ((addResult.status ?? 1) !== 0) {
      throw new Error(`lwb add failed for ${SRC}`);
    }
  }, 60000);

  afterAll(() => {
    cleanup();
  });

  test("create --json emits pure JSON (no 'HEAD is now at' leak)", () => {
    const { stdout, code } = lwb(["create", SRC, "--name", WS, "--json"]);
    expect(code).toBe(0);
    expect(stdout).not.toContain("HEAD is now at");
    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe(WS);
    expect(parsed.branch).toBe(`lwb/${WS}`);
  }, 60000);

  test("fork --json emits pure JSON (no 'HEAD is now at' leak)", () => {
    const { stdout, code } = lwb(["fork", WS, "--name", FORK, "--json"]);
    expect(code).toBe(0);
    expect(stdout).not.toContain("HEAD is now at");
    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe(FORK);
    expect(parsed.forkedFrom).toBe(WS);
  }, 60000);

  test("gc --reap --dry-run --json emits pure JSON", () => {
    // --dry-run: read-only, never reaps a real workspace.
    const { stdout, code } = lwb(["gc", "--reap", "0s", "--dry-run", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed.reaped)).toBe(true);
    expect(Array.isArray(parsed.skipped)).toBe(true);
  }, 30000);

  test("destroy --json emits pure JSON (no 'Deleted branch' leak)", () => {
    const { stdout, code } = lwb(["destroy", FORK, "--force", "--json"]);
    expect(code).toBe(0);
    expect(stdout).not.toContain("Deleted branch");
    const parsed = JSON.parse(stdout);
    expect(parsed.id).toBe(FORK);
    expect(parsed.destroyed).toBe(true);
  }, 30000);
});
