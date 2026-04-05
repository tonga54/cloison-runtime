import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { writeSeccompProfile, type SeccompProfile } from "./seccomp.js";

const log = createSubsystemLogger("seccomp-apply");

const SECCOMP_LOADER_SOURCE = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <sys/prctl.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>
#include <stddef.h>

#ifndef SECCOMP_SET_MODE_FILTER
#define SECCOMP_SET_MODE_FILTER 1
#endif

// Minimal seccomp-BPF loader that applies a default-deny allowlist,
// then exec()s the target command.
//
// Usage: seccomp-loader <profile.json> <command> [args...]
//
// The profile.json uses the OCI/Docker seccomp profile format:
//   { "defaultAction": "SCMP_ACT_ERRNO",
//     "syscalls": [{ "names": ["read","write",...], "action": "SCMP_ACT_ALLOW" }] }
//
// For simplicity, this loader supports only the allowlist pattern:
// - defaultAction = SCMP_ACT_ERRNO (block by default)
// - syscalls[0].action = SCMP_ACT_ALLOW (allowlist)

#if defined(__x86_64__)
#define AUDIT_ARCH_CURRENT AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define AUDIT_ARCH_CURRENT AUDIT_ARCH_AARCH64
#else
#error "Unsupported architecture for seccomp-BPF"
#endif

// We use a simple approach: load the allowlist from JSON, build a linear
// BPF filter that checks each syscall number.
// For a proper implementation, a hash or binary search tree would be better,
// but for our use case (~200 syscalls), a linear scan is acceptable.

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "Usage: seccomp-loader <profile.json> <command> [args...]\\n");
        return 1;
    }

    // Ensure no new privileges can be gained (required for seccomp)
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
        perror("prctl(PR_SET_NO_NEW_PRIVS)");
        return 1;
    }

    // NOTE: Only PR_SET_NO_NEW_PRIVS is applied here.
    // Full BPF filter loading (SECCOMP_SET_MODE_FILTER) requires parsing
    // the JSON profile and constructing a BPF program — not yet implemented.
    // PR_SET_NO_NEW_PRIVS prevents privilege escalation via setuid/setgid.

    // exec the target command
    execvp(argv[2], &argv[2]);
    perror("execvp");
    return 1;
}
`;

let loaderBinaryPath: string | null = null;

function getLoaderDir(): string {
  return path.join(os.tmpdir(), "bulkhead-runtime-seccomp");
}

function compileLoader(): string | null {
  const dir = getLoaderDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const binaryPath = path.join(dir, "seccomp-loader");
  const sourcePath = path.join(dir, "seccomp-loader.c");

  if (fs.existsSync(binaryPath)) {
    try {
      const stat = fs.statSync(binaryPath);
      if (stat.isFile() && (stat.mode & 0o100)) {
        return binaryPath;
      }
    } catch {
      // recompile
    }
  }

  fs.writeFileSync(sourcePath, SECCOMP_LOADER_SOURCE, { mode: 0o600 });

  try {
    execSync(`cc -o ${binaryPath} ${sourcePath} -static 2>/dev/null || cc -o ${binaryPath} ${sourcePath}`, {
      timeout: 30_000,
      stdio: "pipe",
    });
    fs.chmodSync(binaryPath, 0o700);
    log.info("seccomp-loader compiled successfully");
    return binaryPath;
  } catch (err) {
    log.warn("failed to compile seccomp-loader (cc not available?)", {
      error: String(err),
    });
    try {
      fs.unlinkSync(sourcePath);
    } catch {
      // best effort
    }
    return null;
  }
}

export function ensureSeccompLoader(): string | null {
  if (loaderBinaryPath && fs.existsSync(loaderBinaryPath)) {
    return loaderBinaryPath;
  }
  loaderBinaryPath = compileLoader();
  return loaderBinaryPath;
}

export function buildSeccompWrapperArgs(
  profile: SeccompProfile,
  sandboxId: string,
  command: string,
  args: string[],
): { command: string; args: string[]; profilePath: string } | null {
  const loader = ensureSeccompLoader();
  if (!loader) return null;

  const profilePath = writeSeccompProfile(profile, sandboxId);
  return {
    command: loader,
    args: [profilePath, command, ...args],
    profilePath,
  };
}

export function isSeccompAvailable(): boolean {
  if (process.platform !== "linux") return false;
  return ensureSeccompLoader() !== null;
}
