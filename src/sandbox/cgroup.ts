import * as fs from "node:fs";
import * as path from "node:path";

export interface CgroupLimits {
  memoryLimitBytes?: number;
  cpuWeight?: number;
  pidsMax?: number;
}

export interface CgroupController {
  cgroupPath: string;
  /** Create cgroup dir and write resource limits. Call before spawning the process. */
  setup(): boolean;
  /** Write PID to cgroup.procs. Only needed when there's no wrapper script to do it. */
  assignPid(pid: number): void;
  cleanup(): void;
}

const CGROUP_BASE = "/sys/fs/cgroup";

function findAvailableCgroupPath(name: string): string {
  const base = path.join(CGROUP_BASE, "cloison-runtime");
  return path.join(base, name);
}

export function createCgroupController(
  sandboxId: string,
  limits: CgroupLimits,
): CgroupController {
  const cgroupPath = findAvailableCgroupPath(sandboxId);

  function ensureCgroupDir(): boolean {
    try {
      fs.mkdirSync(cgroupPath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  function writeController(filename: string, value: string, required = true): void {
    try {
      fs.writeFileSync(path.join(cgroupPath, filename), value);
    } catch (err) {
      if (required) {
        throw new Error(`Failed to write cgroup controller ${filename}: ${err}`);
      }
    }
  }

  return {
    cgroupPath,

    setup(): boolean {
      if (!ensureCgroupDir()) return false;

      if (limits.memoryLimitBytes !== undefined) {
        writeController("memory.max", limits.memoryLimitBytes.toString());
        writeController("memory.swap.max", "0", false);
      }

      if (limits.cpuWeight !== undefined) {
        const weight = Math.max(1, Math.min(10000, limits.cpuWeight));
        writeController("cpu.weight", weight.toString());
      }

      if (limits.pidsMax !== undefined) {
        writeController("pids.max", limits.pidsMax.toString());
      }

      return true;
    },

    assignPid(pid: number): void {
      fs.writeFileSync(path.join(cgroupPath, "cgroup.procs"), pid.toString());
    },

    cleanup() {
      try {
        const parentProcs = path.join(path.dirname(cgroupPath), "cgroup.procs");
        const pids = fs.readFileSync(path.join(cgroupPath, "cgroup.procs"), "utf-8").trim();
        if (pids) {
          for (const pid of pids.split("\n")) {
            try { fs.writeFileSync(parentProcs, pid.trim()); } catch { /* process may have exited */ }
          }
        }
      } catch { /* cgroup may not exist or have no procs file */ }
      try {
        fs.rmdirSync(cgroupPath);
      } catch {
        // best effort: dir may still have active processes or not exist
      }
    },
  };
}

export function cgroupLimitsFromConfig(config: {
  memoryLimitMb?: number;
  cpuWeight?: number;
  pidsLimit?: number;
}): CgroupLimits {
  return {
    memoryLimitBytes: config.memoryLimitMb
      ? config.memoryLimitMb * 1024 * 1024
      : undefined,
    cpuWeight: config.cpuWeight,
    pidsMax: config.pidsLimit,
  };
}
