import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import type {
  SandboxCapabilities,
  SandboxManager,
  SandboxProcess,
  SandboxSpawnOptions,
} from "./types.js";
import { detectCapabilities, buildUnshareArgs, buildNamespaceFlags } from "./namespace.js";
import { createCgroupController, cgroupLimitsFromConfig, type CgroupController } from "./cgroup.js";
import { prepareRootfs, buildMountScript, type PreparedRootfs } from "./rootfs.js";
import { escapeShellArg } from "../shared/index.js";
import { buildDefaultProfile, type SeccompProfile } from "./seccomp.js";
import { buildSeccompWrapperArgs, isSeccompAvailable } from "./seccomp-apply.js";
import { cleanupSeccompProfile } from "./seccomp.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("sandbox");

const activeSandboxCleanups = new Set<() => void>();

function registerCleanupHandlers(): void {
  const cleanup = () => {
    for (const fn of activeSandboxCleanups) {
      try { fn(); } catch {}
    }
    activeSandboxCleanups.clear();
  };
  process.on("exit", cleanup);

  let terminating = false;
  const handleSignal = (signal: NodeJS.Signals, code: number) => {
    if (terminating) {
      process.exit(128 + code);
    }
    terminating = true;
    cleanup();
    process.exit(128 + code);
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM", 15));
  process.on("SIGINT", () => handleSignal("SIGINT", 2));
}

let cleanupHandlersRegistered = false;

export function createSandboxManager(): SandboxManager {
  if (!cleanupHandlersRegistered) {
    registerCleanupHandlers();
    cleanupHandlersRegistered = true;
  }

  let capabilitiesPromise: Promise<SandboxCapabilities> | null = null;

  return {
    async capabilities() {
      if (!capabilitiesPromise) {
        capabilitiesPromise = detectCapabilities();
      }
      return capabilitiesPromise;
    },

    async spawn(options: SandboxSpawnOptions): Promise<SandboxProcess> {
      const caps = await this.capabilities();

      if (!caps.hasUnshare) {
        throw new Error(
          "Sandbox requires 'unshare' command. Install util-linux or run on a standard Linux distribution.",
        );
      }
      if (!caps.hasMountNamespace) {
        throw new Error(
          "Sandbox requires mount namespace support. Ensure the kernel supports user namespaces " +
          "and /proc/sys/user/max_user_namespaces > 0.",
        );
      }

      return spawnLinuxSandbox(options, caps);
    },
  };
}

function generateSandboxId(): string {
  return `sb_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

async function spawnLinuxSandbox(
  options: SandboxSpawnOptions,
  caps: SandboxCapabilities,
): Promise<SandboxProcess> {
  const sandboxId = generateSandboxId();
  const config = options.config;

  const nsFlags = buildNamespaceFlags(caps, config.networkIsolation ?? false);
  const unshareArgs = buildUnshareArgs(nsFlags);

  let cgroup: CgroupController | null = null;
  if (caps.hasCgroupV2) {
    const limits = cgroupLimitsFromConfig(config);
    cgroup = createCgroupController(sandboxId, limits);
    if (!cgroup.setup()) {
      cgroup.cleanup();
      throw new Error("Failed to create cgroup directory for sandbox resource limits");
    }
  }

  let seccompProfilePath: string | null = null;
  let targetCommand = options.command;
  let targetArgs = options.args;

  if (isSeccompAvailable()) {
    const profile = buildDefaultProfile();
    const seccomp = buildSeccompWrapperArgs(
      profile,
      sandboxId,
      options.command,
      options.args,
    );
    if (seccomp) {
      targetCommand = seccomp.command;
      targetArgs = seccomp.args;
      seccompProfilePath = seccomp.profilePath;
      log.debug("seccomp: PR_SET_NO_NEW_PRIVS applied (no BPF filter — full seccomp-BPF requires libseccomp)", { sandboxId });
    }
  }

  let rootfs: PreparedRootfs | null = null;
  let wrapperScriptPath: string | null = null;

  if (nsFlags.mount) {
    rootfs = prepareRootfs({
      sandboxId,
      workspaceDir: options.cwd,
      additionalBinds: config.mountBinds,
    });
    const mountScript = buildMountScript(rootfs.rootDir, rootfs.mounts, {
      hasPidNamespace: nsFlags.pid,
    });
    wrapperScriptPath = writeWrapperScript(
      sandboxId,
      mountScript,
      options,
      cgroup?.cgroupPath,
      targetCommand !== options.command ? targetCommand : undefined,
      targetArgs !== options.args ? targetArgs : undefined,
    );
  }

  const rawEnv: Record<string, string> = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp",
    NODE_ENV: "production",
    SANDBOX_ID: sandboxId,
    ...options.env,
  };

  const sanitizedEnv = sanitizeEnv(rawEnv, options.protectedKeys);

  let fullArgs: string[];
  if (wrapperScriptPath) {
    fullArgs = [...unshareArgs, "/bin/sh", wrapperScriptPath];
  } else {
    fullArgs = [...unshareArgs, targetCommand, ...targetArgs];
  }

  const child = spawn("unshare", fullArgs, {
    cwd: options.cwd,
    env: sanitizedEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let spawnError: Error | null = null;
  let cleanedUp = false;

  const cleanupAll = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    activeSandboxCleanups.delete(cleanupAll);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    cgroup?.cleanup();
    rootfs?.cleanup();
    if (wrapperScriptPath) cleanupFile(wrapperScriptPath);
    if (seccompProfilePath) cleanupSeccompProfile(seccompProfilePath);
  };

  activeSandboxCleanups.add(cleanupAll);

  child.on("error", (err) => {
    spawnError = err;
    cleanupAll();
  });
  child.on("exit", cleanupAll);

  if (cgroup && child.pid && !wrapperScriptPath) {
    cgroup.assignPid(child.pid);
  }

  if (options.onStderr && child.stderr) {
    child.stderr.on("data", (data: Buffer) => {
      options.onStderr!(data.toString("utf-8"));
    });
  }

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  if (config.timeoutMs) {
    timeoutTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, config.timeoutMs);
  }

  let exitPromise: Promise<number> | null = null;

  return {
    pid: child.pid ?? -1,
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,

    kill() {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    },

    waitForExit(): Promise<number> {
      if (!exitPromise) {
        exitPromise = new Promise((resolve, reject) => {
          if (spawnError) { cleanupAll(); reject(spawnError); return; }
          if (child.exitCode !== null) { cleanupAll(); resolve(child.exitCode); return; }
          child.on("error", (err) => { cleanupAll(); reject(err); });
          child.on("exit", (code) => { cleanupAll(); resolve(code ?? 1); });
        });
      }
      return exitPromise;
    },
  };
}

function writeWrapperScript(
  sandboxId: string,
  mountScript: string,
  options: SandboxSpawnOptions,
  cgroupProcsPath?: string,
  seccompCmd?: string,
  seccompArgs?: string[],
): string {
  const tmpDir = path.join(os.tmpdir(), "bulkhead-runtime-sandbox");
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const scriptPath = path.join(tmpDir, `${sandboxId}-init.sh`);

  const cmd = seccompCmd ?? options.command;
  const args = seccompArgs ?? options.args;
  const escapedCmd = escapeShellArg(cmd);
  const escapedArgs = args.map(escapeShellArg).join(" ");

  const preamble: string[] = [];
  if (cgroupProcsPath) {
    preamble.push(
      "# Assign to cgroup before pivot_root (while host FS is accessible)",
      `echo $$ > ${escapeShellArg(path.join(cgroupProcsPath, "cgroup.procs"))} || { echo 'FATAL: cannot assign process to cgroup' >&2; exit 1; }`,
      "",
    );
  }

  const script = [
    "#!/bin/sh",
    "set -e",
    "",
    ...preamble,
    mountScript,
    "",
    `exec ${escapedCmd} ${escapedArgs}`,
  ].join("\n");

  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  return scriptPath;
}

function cleanupFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best effort
  }
}

const SANDBOX_ALLOWED_ENV_KEYS = new Set([
  "PATH", "HOME", "NODE_ENV", "SANDBOX_ID", "SANDBOX_WORKER_CONFIG",
  "LANG", "LC_ALL", "TZ", "TERM", "NODE_PATH",
]);

export function sanitizeEnv(
  env: Record<string, string>,
  protectedKeys?: string[],
): Record<string, string> {
  const allowed = new Set([...SANDBOX_ALLOWED_ENV_KEYS, ...(protectedKeys ?? [])]);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (allowed.has(key)) {
      result[key] = value;
    }
  }
  return result;
}

