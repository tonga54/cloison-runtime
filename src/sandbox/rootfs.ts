import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";
import type { MountBind } from "./types.js";
import { escapeShellArg } from "../shared/index.js";

export interface RootfsOptions {
  sandboxId: string;
  workspaceDir: string;
  nodeExecutable?: string;
  /** Directory containing the worker script (src/ or dist/) */
  projectDir?: string;
  additionalBinds?: MountBind[];
}

export interface PreparedRootfs {
  rootDir: string;
  mounts: MountBind[];
  cleanup(): void;
}

const SYSTEM_READONLY_PATHS = [
  "/usr",
  "/lib",
  "/lib64",
  "/bin",
  "/sbin",
  "/etc/alternatives",
  "/etc/ssl",
  "/etc/ca-certificates",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
];

export function prepareRootfs(options: RootfsOptions): PreparedRootfs {
  const resolvedWorkspace = path.resolve(options.workspaceDir);
  if (isSensitiveHostPath(resolvedWorkspace)) {
    throw new Error(
      `workspaceDir "${options.workspaceDir}" references a sensitive host path`,
    );
  }

  const rootDir = path.join(
    os.tmpdir(),
    "cloison-runtime-rootfs",
    options.sandboxId,
  );

  fs.mkdirSync(rootDir, { recursive: true });

  const mounts: MountBind[] = [];

  for (const sysPath of SYSTEM_READONLY_PATHS) {
    const stat = safeStat(sysPath);
    if (!stat) continue;
    const targetInRoot = path.join(rootDir, sysPath);
    if (stat?.isDirectory()) {
      fs.mkdirSync(targetInRoot, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(targetInRoot), { recursive: true });
      safeTouch(targetInRoot);
    }
    mounts.push({ source: sysPath, target: targetInRoot, readonly: true });
  }

  const nodeExec = options.nodeExecutable ?? process.execPath;
  const nodeDir = path.dirname(nodeExec);
  const resolvedNodeDir = path.resolve(nodeDir);
  if (isSensitiveHostPath(resolvedNodeDir)) {
    throw new Error(
      `nodeExecutable directory "${nodeDir}" references a sensitive host path`,
    );
  }
  const nodeDirInRoot = path.join(rootDir, nodeDir);
  fs.mkdirSync(nodeDirInRoot, { recursive: true });
  mounts.push({ source: nodeDir, target: nodeDirInRoot, readonly: true });

  const nodeModulesPath = findNodeModules();
  if (nodeModulesPath) {
    const nmInRoot = path.join(rootDir, nodeModulesPath);
    fs.mkdirSync(nmInRoot, { recursive: true });
    mounts.push({ source: nodeModulesPath, target: nmInRoot, readonly: true });
  }

  if (options.projectDir) {
    const resolvedProjectDir = path.resolve(options.projectDir);
    if (isSensitiveHostPath(resolvedProjectDir)) {
      throw new Error(
        `projectDir "${options.projectDir}" references a sensitive host path`,
      );
    }
    const projInRoot = path.join(rootDir, options.projectDir);
    fs.mkdirSync(projInRoot, { recursive: true });
    mounts.push({ source: options.projectDir, target: projInRoot, readonly: true });
  }

  const wsInRoot = path.join(rootDir, options.workspaceDir);
  fs.mkdirSync(wsInRoot, { recursive: true });
  mounts.push({
    source: options.workspaceDir,
    target: wsInRoot,
    readonly: false,
  });

  const tmpInRoot = path.join(rootDir, "tmp");
  fs.mkdirSync(tmpInRoot, { recursive: true });

  const devDir = path.join(rootDir, "dev");
  fs.mkdirSync(devDir, { recursive: true });
  for (const dev of ["null", "zero", "urandom", "random"]) {
    const devPath = `/dev/${dev}`;
    if (fs.existsSync(devPath)) {
      const devInRoot = path.join(rootDir, "dev", dev);
      safeTouch(devInRoot);
      mounts.push({ source: devPath, target: devInRoot, readonly: true });
    }
  }

  const procDir = path.join(rootDir, "proc");
  fs.mkdirSync(procDir, { recursive: true });

  const oldRootDir = path.join(rootDir, ".old-root");
  fs.mkdirSync(oldRootDir, { recursive: true });

  if (options.additionalBinds) {
    const resolvedRoot = path.resolve(rootDir);
    for (const bind of options.additionalBinds) {
      const resolvedSource = path.resolve(bind.source);
      if (isSensitiveHostPath(resolvedSource)) {
        throw new Error(
          `additionalBind source "${bind.source}" references a sensitive host path`,
        );
      }
      const targetInRoot = path.join(rootDir, bind.target);
      const resolvedTarget = path.resolve(targetInRoot);
      if (!resolvedTarget.startsWith(resolvedRoot + path.sep) && resolvedTarget !== resolvedRoot) {
        throw new Error(
          `additionalBind target "${bind.target}" resolves outside rootDir`,
        );
      }

      const srcStat2 = safeStat(resolvedSource);
      if (!srcStat2) {
        throw new Error(
          `additionalBind source "${bind.source}" does not exist`,
        );
      }
      if (srcStat2.isSymbolicLink()) {
        throw new Error(
          `additionalBind source "${bind.source}" is a symbolic link (not allowed)`,
        );
      }
      if (srcStat2.isDirectory()) {
        fs.mkdirSync(targetInRoot, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(targetInRoot), { recursive: true });
        safeTouch(targetInRoot);
      }
      mounts.push({ source: resolvedSource, target: targetInRoot, readonly: bind.readonly });
    }
  }

  return {
    rootDir,
    mounts,
    cleanup() {
      try {
        fs.rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

export interface MountScriptOptions {
  hasPidNamespace?: boolean;
}

export function buildMountScript(
  rootDir: string,
  mounts: MountBind[],
  options?: MountScriptOptions,
): string {
  const esc = escapeShellArg;
  const lines: string[] = [
    "#!/bin/sh",
    "set -e",
    "",
    `ROOTDIR=${esc(rootDir)}`,
    "",
    "# Make rootDir a mount point for pivot_root",
    'mount --bind "$ROOTDIR" "$ROOTDIR"',
    "",
  ];

  for (const mount of mounts) {
    if (mount.readonly) {
      lines.push(`mount --bind ${esc(mount.source)} ${esc(mount.target)}`);
      lines.push(`mount -o remount,ro,bind ${esc(mount.target)}`);
    } else {
      lines.push(`mount --bind ${esc(mount.source)} ${esc(mount.target)}`);
    }
  }

  lines.push("");

  if (options?.hasPidNamespace) {
    lines.push("# Mount proc (PID namespace active)");
    lines.push('mount -t proc proc "$ROOTDIR/proc" || { echo "WARNING: proc mount failed" >&2; }');
  } else {
    lines.push("# No PID namespace: skip proc mount to prevent host process exposure");
  }

  lines.push("");
  lines.push("# pivot_root: swap root filesystem");
  lines.push('cd "$ROOTDIR"');
  lines.push("pivot_root . .old-root");
  lines.push("");
  lines.push("# Unmount old root - fail-closed: abort if either unmount fails");
  lines.push("umount /.old-root 2>/dev/null || umount -l /.old-root || { echo 'FATAL: cannot unmount old root' >&2; exit 1; }");
  lines.push("# Verify old root is no longer a mount point");
  lines.push('if mountpoint -q /.old-root 2>/dev/null; then');
  lines.push('  echo "FATAL: old root still mounted after unmount" >&2');
  lines.push("  exit 1");
  lines.push("fi");
  lines.push("# Verify old root directory is empty (fail-closed: ls errors also trigger abort)");
  lines.push('if [ -d "/.old-root" ] && [ -n "$(ls -A /.old-root 2>&1)" ]; then');
  lines.push('  echo "FATAL: old root still accessible after unmount" >&2');
  lines.push("  exit 1");
  lines.push("fi");
  lines.push("rmdir /.old-root 2>/dev/null || true");
  lines.push("");

  return lines.join("\n");
}

function findNodeModules(): string | null {
  const searchRoots = [
    path.dirname(url.fileURLToPath(import.meta.url)),
    process.cwd(),
  ];

  for (const start of searchRoots) {
    let dir = start;
    for (let i = 0; i < 10; i++) {
      const nmPath = path.join(dir, "node_modules");
      const stat = safeStat(nmPath);
      if (stat && stat.isDirectory() && !stat.isSymbolicLink()) return nmPath;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

const SENSITIVE_HOST_PATHS = new Set([
  "/",
  "/root",
  "/proc",
  "/sys",
  "/dev",
  "/boot",
  "/run",
  "/var/run/docker.sock",
  "/run/docker.sock",
]);

const SENSITIVE_HOST_PREFIXES = [
  "/root/",
  "/proc/",
  "/sys/",
  "/home/",
  "/run/",
  "/etc/shadow",
  "/etc/sudoers",
  "/etc/gshadow",
  "/etc/master.passwd",
  "/var/run/docker.sock",
  "/run/docker.sock",
];

function isSensitiveHostPath(resolved: string): boolean {
  if (SENSITIVE_HOST_PATHS.has(resolved)) return true;
  return SENSITIVE_HOST_PREFIXES.some((prefix) => resolved.startsWith(prefix));
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function safeTouch(p: string): void {
  try {
    fs.writeFileSync(p, "", { flag: "a" });
  } catch {
    // best effort
  }
}
