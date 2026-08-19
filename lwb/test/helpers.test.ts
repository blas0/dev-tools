// Hermetic unit tests for lwb's pure, exported helpers. No VM, network, or
// filesystem: importing lwb.ts is side-effect-free because main() is guarded by
// `if (import.meta.main)`, so these run anywhere `bun test` runs.

import { describe, test, expect } from "bun:test";
import {
  resolveTransport,
  parseDuration,
  cpuQuota,
  splitJsonFlag,
  parseDoctorArgs,
  finalizeDoctorChecks,
  parseEgressAllow,
  isNetworkOrigin,
  fetchFailureAction,
  orphanedBranchMessage,
} from "../lwb.ts";

describe("resolveTransport", () => {
  test("uses limactl by default", () => {
    expect(resolveTransport({}, "/Users/tester")).toEqual({});
  });

  test("uses Lima SSH without host writes in automation mode", () => {
    expect(resolveTransport({ LWB_AUTOMATION: "1" }, "/Users/tester")).toEqual({
      target: "lima-lwb",
      config: "/Users/tester/.lima/lwb/ssh.config",
    });
  });

  test("preserves an explicitly configured SSH transport", () => {
    expect(
      resolveTransport(
        {
          LWB_AUTOMATION: "1",
          LWB_SSH: "remote-builder",
          LWB_SSH_CONFIG: "/tmp/ssh.config",
        },
        "/Users/tester",
      ),
    ).toEqual({ target: "remote-builder", config: "/tmp/ssh.config" });
  });
});

describe("parseDuration", () => {
  test("parses each unit into seconds", () => {
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("30m")).toBe(1800);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("7d")).toBe(604800);
  });
});

describe("cpuQuota", () => {
  test("converts fractional cores to an integer systemd percentage", () => {
    expect(cpuQuota(1)).toBe(100);
    expect(cpuQuota(2)).toBe(200);
    expect(cpuQuota(0.5)).toBe(50);
    expect(cpuQuota(1.5)).toBe(150);
  });
});

describe("splitJsonFlag", () => {
  test("strips a leading --json from the head", () => {
    const { argv, json } = splitJsonFlag(["ls", "--json"]);
    expect(json).toBe(true);
    expect(argv).toEqual(["ls"]);
  });

  test("leaves --json after -- untouched (passes through to the guest)", () => {
    const { argv, json } = splitJsonFlag(["exec", "abc", "--", "foo", "--json"]);
    expect(json).toBe(false);
    expect(argv).toEqual(["exec", "abc", "--", "foo", "--json"]);
  });

  test("no --json anywhere leaves argv unchanged", () => {
    const { argv, json } = splitJsonFlag(["diff", "abc"]);
    expect(json).toBe(false);
    expect(argv).toEqual(["diff", "abc"]);
  });
});

describe("parseDoctorArgs", () => {
  test("keeps the default doctor checks", () => {
    expect(parseDoctorArgs([])).toEqual({ github: false });
  });

  test("enables the GitHub SSH authentication check", () => {
    expect(parseDoctorArgs(["--github"])).toEqual({ github: true });
  });

  test("rejects unknown doctor flags", () => {
    expect(parseDoctorArgs(["--unknown"])).toBeNull();
  });
});

describe("finalizeDoctorChecks", () => {
  test("rejects an empty result when the guest transport failed", () => {
    expect(finalizeDoctorChecks([], 1)).toEqual({
      ok: false,
      checks: [{ status: "fail", message: "guest transport failed" }],
    });
  });

  test("rejects an empty result even when the process exited zero", () => {
    expect(finalizeDoctorChecks([], 0)).toEqual({
      ok: false,
      checks: [{ status: "fail", message: "doctor returned no guest checks" }],
    });
  });

  test("preserves successful non-empty checks", () => {
    const checks = [{ status: "ok", message: "git 2.53.0" }];
    expect(finalizeDoctorChecks(checks, 0)).toEqual({ ok: true, checks });
  });

  test("adds a transport failure when output looked healthy but exit was nonzero", () => {
    expect(finalizeDoctorChecks([{ status: "ok", message: "git 2.53.0" }], 1)).toEqual({
      ok: false,
      checks: [
        { status: "ok", message: "git 2.53.0" },
        { status: "fail", message: "guest transport failed" },
      ],
    });
  });
});

describe("parseEgressAllow", () => {
  test("accepts a bare IPv4 address", () => {
    expect(parseEgressAllow("1.2.3.4")).toEqual({ cidr: "1.2.3.4", port: undefined });
  });

  test("accepts an IPv4 CIDR", () => {
    expect(parseEgressAllow("10.0.0.0/8")).toEqual({ cidr: "10.0.0.0/8", port: undefined });
  });

  test("accepts an IPv4 CIDR with a port", () => {
    expect(parseEgressAllow("1.2.3.4/32:443")).toEqual({ cidr: "1.2.3.4/32", port: "443" });
  });

  test("rejects octets above 255", () => {
    expect(parseEgressAllow("256.0.0.1")).toBeNull();
    expect(parseEgressAllow("1.2.3.999")).toBeNull();
  });

  test("rejects a prefix length above 32", () => {
    expect(parseEgressAllow("10.0.0.0/33")).toBeNull();
  });

  test("rejects ports outside 1-65535", () => {
    expect(parseEgressAllow("1.2.3.4:0")).toBeNull();
    expect(parseEgressAllow("1.2.3.4:70000")).toBeNull();
    expect(parseEgressAllow("1.2.3.4:abc")).toBeNull();
  });

  test("rejects non-IPv4 shapes (hostnames, IPv6)", () => {
    expect(parseEgressAllow("example.com")).toBeNull();
    expect(parseEgressAllow("::1")).toBeNull();
    expect(parseEgressAllow("")).toBeNull();
  });

  // The core reason this validator exists: the value is interpolated into an
  // nft ruleset written through a quoted heredoc and applied with sudo. A
  // newline carrying the heredoc terminator must never survive validation, or
  // it could close the heredoc early and run trailing text as a shell command.
  test("rejects a heredoc-terminator / shell-injection payload", () => {
    expect(parseEgressAllow("1.2.3.4\nLWB_EGRESS_EOF\nrm -rf ~")).toBeNull();
    expect(parseEgressAllow("1.2.3.4; rm -rf ~")).toBeNull();
    expect(parseEgressAllow("$(touch /tmp/pwned)")).toBeNull();
  });
});

describe("isNetworkOrigin", () => {
  test("treats ssh/https/git schemes as network remotes", () => {
    expect(isNetworkOrigin("https://github.com/blas0/lwb.git")).toBe(true);
    expect(isNetworkOrigin("ssh://git@github.com/blas0/lwb.git")).toBe(true);
    expect(isNetworkOrigin("git://example.com/repo.git")).toBe(true);
  });

  test("treats scp-like user@host:path as a network remote", () => {
    expect(isNetworkOrigin("git@github.com:blas0/lwb.git")).toBe(true);
    expect(isNetworkOrigin("git@host:repo")).toBe(true);
  });

  test("treats filesystem paths and file:// as local (not network)", () => {
    expect(isNetworkOrigin("/home/user/repos/lwb.git")).toBe(false);
    expect(isNetworkOrigin("./lwb.git")).toBe(false);
    expect(isNetworkOrigin("~/repos/lwb.git")).toBe(false);
    expect(isNetworkOrigin("file:///home/user/repos/lwb.git")).toBe(false);
  });

  test("treats empty/unknown origin as local (tolerant default)", () => {
    expect(isNetworkOrigin("")).toBe(false);
    expect(isNetworkOrigin("   ")).toBe(false);
  });
});

describe("fetchFailureAction", () => {
  test("proceeds when the fetch succeeded", () => {
    expect(
      fetchFailureAction({
        fetchFailed: false,
        originUrl: "https://github.com/blas0/lwb.git",
        offline: false,
      }),
    ).toBe("proceed");
  });

  // The core regression: a network origin that fails to fetch must abort rather
  // than silently build the workspace off a stale base.
  test("aborts when a network origin fails and --offline is not set", () => {
    expect(
      fetchFailureAction({
        fetchFailed: true,
        originUrl: "https://github.com/blas0/lwb.git",
        offline: false,
      }),
    ).toBe("abort");
  });

  test("warns (tolerates) when a network origin fails but --offline is set", () => {
    expect(
      fetchFailureAction({
        fetchFailed: true,
        originUrl: "git@github.com:blas0/lwb.git",
        offline: true,
      }),
    ).toBe("warn");
  });

  test("warns for a local-path origin failure (expected to be unreachable)", () => {
    expect(
      fetchFailureAction({
        fetchFailed: true,
        originUrl: "/home/user/repos/lwb.git",
        offline: false,
      }),
    ).toBe("warn");
  });
});

describe("orphanedBranchMessage", () => {
  test("names the orphan and prints the exact recovery command", () => {
    const msg = orphanedBranchMessage("/home/lwb/repos/api.git", "lwb/brave-fox");
    expect(msg).toContain('branch "lwb/brave-fox"');
    expect(msg).toContain("git --git-dir=/home/lwb/repos/api.git branch -D lwb/brave-fox");
  });
});
