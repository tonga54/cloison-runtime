import { describe, it, expect } from "vitest";
import { detectCapabilities } from "../src/sandbox/namespace.js";
import { buildDefaultProfile } from "../src/sandbox/seccomp.js";
import { cgroupLimitsFromConfig } from "../src/sandbox/cgroup.js";
import { sanitizeEnv } from "../src/sandbox/manager.js";

describe("detectCapabilities", () => {
  if (process.platform === "linux") {
    it("returns valid capabilities object on Linux", async () => {
      const caps = await detectCapabilities();

      expect(caps.platform).toBe("linux");
      expect(caps).toHaveProperty("hasUserNamespace");
      expect(caps).toHaveProperty("hasPidNamespace");
      expect(caps).toHaveProperty("hasMountNamespace");
      expect(caps).toHaveProperty("hasNetNamespace");
      expect(caps).toHaveProperty("hasCgroupV2");
      expect(caps).toHaveProperty("hasSeccomp");
      expect(caps).toHaveProperty("hasUnshare");
    });

    it("all capabilities are booleans", async () => {
      const caps = await detectCapabilities();

      expect(typeof caps.hasUserNamespace).toBe("boolean");
      expect(typeof caps.hasPidNamespace).toBe("boolean");
      expect(typeof caps.hasMountNamespace).toBe("boolean");
      expect(typeof caps.hasNetNamespace).toBe("boolean");
      expect(typeof caps.hasCgroupV2).toBe("boolean");
      expect(typeof caps.hasSeccomp).toBe("boolean");
      expect(typeof caps.hasUnshare).toBe("boolean");
    });
  } else {
    it("throws on non-Linux platforms", async () => {
      await expect(detectCapabilities()).rejects.toThrow("Cloison Runtime requires Linux");
    });
  }
});

describe("seccomp profile", () => {
  it("default profile blocks dangerous syscalls", () => {
    const profile = buildDefaultProfile();

    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(profile.syscalls.length).toBeGreaterThanOrEqual(2);

    const allowedRule = profile.syscalls.find((r) => r.action === "SCMP_ACT_ALLOW");
    const blockedRule = profile.syscalls.find((r) => r.action === "SCMP_ACT_ERRNO");

    expect(allowedRule).toBeDefined();
    expect(blockedRule).toBeDefined();

    expect(blockedRule!.names).toContain("ptrace");
    expect(blockedRule!.names).toContain("mount");
    expect(blockedRule!.names).toContain("reboot");
    expect(blockedRule!.names).toContain("bpf");
    expect(blockedRule!.names).toContain("unshare");
  });

  it("allows basic Node.js syscalls", () => {
    const profile = buildDefaultProfile();
    const allowedRule = profile.syscalls.find((r) => r.action === "SCMP_ACT_ALLOW");

    expect(allowedRule!.names).toContain("read");
    expect(allowedRule!.names).toContain("write");
    expect(allowedRule!.names).toContain("open");
    expect(allowedRule!.names).toContain("close");
    expect(allowedRule!.names).toContain("mmap");
    expect(allowedRule!.names).toContain("socket");
    expect(allowedRule!.names).toContain("epoll_create");
    expect(allowedRule!.names).toContain("clone");
  });
});

describe("cgroup limits", () => {
  it("converts MB to bytes", () => {
    const limits = cgroupLimitsFromConfig({ memoryLimitMb: 512 });
    expect(limits.memoryLimitBytes).toBe(512 * 1024 * 1024);
  });

  it("passes through CPU weight and PIDs", () => {
    const limits = cgroupLimitsFromConfig({
      memoryLimitMb: 256,
      cpuWeight: 100,
      pidsLimit: 50,
    });

    expect(limits.cpuWeight).toBe(100);
    expect(limits.pidsMax).toBe(50);
  });

  it("handles undefined values", () => {
    const limits = cgroupLimitsFromConfig({});
    expect(limits.memoryLimitBytes).toBeUndefined();
    expect(limits.cpuWeight).toBeUndefined();
    expect(limits.pidsMax).toBeUndefined();
  });
});


describe("environment sanitization", () => {
  it("credential patterns are comprehensive", () => {
    const patterns = [
      /_API_KEY$/,
      /_SECRET$/,
      /_TOKEN$/,
      /_PASSWORD$/,
      /^AWS_/,
      /^OPENAI_/,
      /^ANTHROPIC_/,
      /^GEMINI_/,
      /^GOOGLE_/,
      /^CLOISON_CREDENTIAL/,
    ];

    const dangerousVars = [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "GOOGLE_API_KEY",
      "DATABASE_PASSWORD",
      "MY_SECRET",
      "AUTH_TOKEN",
      "CLOISON_CREDENTIAL_KEY",
    ];

    for (const envVar of dangerousVars) {
      const matched = patterns.some((p) => p.test(envVar));
      expect(matched, `${envVar} should be caught`).toBe(true);
    }

    const safeVars = ["PATH", "HOME", "NODE_ENV", "SANDBOX_ID", "LANG"];
    for (const envVar of safeVars) {
      const matched = patterns.some((p) => p.test(envVar));
      expect(matched, `${envVar} should NOT be caught`).toBe(false);
    }
  });
});

describe("sanitizeEnv (allowlist)", () => {
  it("only passes allowed env keys", () => {
    const env: Record<string, string> = {
      PATH: "/usr/bin",
      HOME: "/tmp",
      NODE_ENV: "production",
      SANDBOX_ID: "sb_1",
      SANDBOX_WORKER_CONFIG: "{}",
      OPENAI_API_KEY: "sk-leaked",
      DATABASE_URL: "postgres://leak",
      GH_TOKEN: "ghp_leaked",
      SSH_PRIVATE_KEY: "leaked",
      RANDOM_VAR: "leaked",
    };

    const result = sanitizeEnv(env);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/tmp");
    expect(result.NODE_ENV).toBe("production");
    expect(result.SANDBOX_ID).toBe("sb_1");
    expect(result.SANDBOX_WORKER_CONFIG).toBe("{}");
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.DATABASE_URL).toBeUndefined();
    expect(result.GH_TOKEN).toBeUndefined();
    expect(result.SSH_PRIVATE_KEY).toBeUndefined();
    expect(result.RANDOM_VAR).toBeUndefined();
  });

  it("preserves protected keys through allowlist", () => {
    const env: Record<string, string> = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-oai",
    };

    const result = sanitizeEnv(env, ["ANTHROPIC_API_KEY"]);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(result.OPENAI_API_KEY).toBeUndefined();
  });

  it("blocks credential vars that denylist would miss", () => {
    const env: Record<string, string> = {
      PATH: "/usr/bin",
      DATABASE_URL: "postgres://user:pass@host/db",
      MONGODB_URI: "mongodb://leak",
      REDIS_URL: "redis://leak",
      GH_TOKEN: "ghp_leaked",
      SSH_AUTH_SOCK: "/tmp/ssh",
      DOCKER_AUTH_CONFIG: "{}",
    };

    const result = sanitizeEnv(env);
    expect(Object.keys(result)).toEqual(["PATH"]);
  });
});
