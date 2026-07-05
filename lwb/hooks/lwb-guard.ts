#!/usr/bin/env bun
// lwb-guard - PreToolUse deny-guard for Claude Code sessions orchestrating lwb.
//
// Guest workspace paths (/home/<user>/lwb/...) do not exist on the host, and
// the VM's value comes entirely from --mount-none. This hook makes those two
// SKILL.md rules deterministic instead of advisory:
//   1. host file tools may not target guest paths (use lwb exec / lwb diff)
//   2. nothing may mount host directories into the lwb VM
//
// Register in ~/.claude/settings.json under hooks.PreToolUse with matcher
// "Bash|Read|Edit|Write|NotebookEdit". Exit 2 = deny; stderr is fed back to
// the agent as the reason.

const raw = await Bun.stdin.text();

let payload: { tool_name?: string; tool_input?: Record<string, unknown> };
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0); // malformed input: never block unrelated tools
}

const tool = payload.tool_name ?? "";
const input = payload.tool_input ?? {};

// Guest homes are /home/<user>; macOS host homes are /Users/<user>, so this
// cannot collide with legitimate host paths (including this repo itself).
const GUEST_FILE = /^(~|\/home\/[^/]+)\/lwb\//;
const GUEST_IN_CMD = /(^|[\s"'=:])(~|\/home\/[^/\s"']+)\/lwb\//;

// A guest path is only legitimate when routed through lwb itself, limactl,
// an ssh invocation, or an ssh:// URL (the documented branch-fetch path).
// Matching invocation position matters: the guest path itself contains the
// word "lwb", so a bare substring whitelist would defeat the guard.
const ROUTED = /(^|[;&|(]\s*)(lwb|limactl|ssh)(\s|$)/m;
const SSH_URL = /\bssh:\/\//;

function deny(reason: string): never {
  console.error(`lwb-guard: ${reason}`);
  process.exit(2);
}

if (["Read", "Edit", "Write", "NotebookEdit"].includes(tool)) {
  const path = String(input.file_path ?? input.notebook_path ?? "");
  if (GUEST_FILE.test(path)) {
    deny(
      `"${path}" is a GUEST path inside the lwb VM; it does not exist on the host. ` +
        "Run commands there with `lwb exec <id> -- ...` and read changes with `lwb diff <id>`.",
    );
  }
}

if (tool === "Bash") {
  const command = String(input.command ?? "");
  if (/\blimactl\b/.test(command) && /--mount(?!-none\b)/.test(command)) {
    deny(
      "mounting host directories into the lwb VM is forbidden; " +
        "--mount-none is the entire design (see lwb README).",
    );
  }
  if (GUEST_IN_CMD.test(command) && !ROUTED.test(command) && !SSH_URL.test(command)) {
    deny(
      "this command references a guest path inside the lwb VM but does not go " +
        "through lwb; route it as `lwb exec <id> -- ...`.",
    );
  }
}

process.exit(0);
