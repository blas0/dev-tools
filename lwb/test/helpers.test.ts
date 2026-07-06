// Hermetic unit tests for lwb's pure, exported helpers. No VM, network, or
// filesystem: importing lwb.ts is side-effect-free because main() is guarded by
// `if (import.meta.main)`, so these run anywhere `bun test` runs.

import { describe, test, expect } from "bun:test";
import { parseDuration, cpuQuota, splitJsonFlag, parseEgressAllow } from "../lwb.ts";

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
