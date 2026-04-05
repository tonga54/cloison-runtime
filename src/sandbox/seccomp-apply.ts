import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { writeSeccompProfile, type SeccompProfile } from "./seccomp.js";

const log = createSubsystemLogger("seccomp-apply");

// Real seccomp-BPF loader: applies PR_SET_NO_NEW_PRIVS + a BPF filter
// that blocks dangerous syscalls (ptrace, mount, unshare, bpf, etc.)
// with EPERM. Falls back to no-new-privs only if seccomp() syscall fails.
const SECCOMP_LOADER_SOURCE = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <linux/seccomp.h>
#include <linux/filter.h>
#include <linux/audit.h>

#ifndef SECCOMP_SET_MODE_FILTER
#define SECCOMP_SET_MODE_FILTER 1
#endif

#if defined(__x86_64__)
#define AUDIT_ARCH_CURRENT AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define AUDIT_ARCH_CURRENT AUDIT_ARCH_AARCH64
#else
#error "Unsupported architecture for seccomp-BPF"
#endif

/* Blocked syscalls matching BLOCKED_SYSCALLS in seccomp.ts */
static const int BLOCKED[] = {
#ifdef __NR_ptrace
    __NR_ptrace,
#endif
#ifdef __NR_mount
    __NR_mount,
#endif
#ifdef __NR_umount2
    __NR_umount2,
#endif
#ifdef __NR_pivot_root
    __NR_pivot_root,
#endif
#ifdef __NR_chroot
    __NR_chroot,
#endif
#ifdef __NR_reboot
    __NR_reboot,
#endif
#ifdef __NR_kexec_load
    __NR_kexec_load,
#endif
#ifdef __NR_init_module
    __NR_init_module,
#endif
#ifdef __NR_finit_module
    __NR_finit_module,
#endif
#ifdef __NR_delete_module
    __NR_delete_module,
#endif
#ifdef __NR_acct
    __NR_acct,
#endif
#ifdef __NR_swapon
    __NR_swapon,
#endif
#ifdef __NR_swapoff
    __NR_swapoff,
#endif
#ifdef __NR_bpf
    __NR_bpf,
#endif
#ifdef __NR_userfaultfd
    __NR_userfaultfd,
#endif
#ifdef __NR_perf_event_open
    __NR_perf_event_open,
#endif
#ifdef __NR_unshare
    __NR_unshare,
#endif
#ifdef __NR_setns
    __NR_setns,
#endif
#ifdef __NR_keyctl
    __NR_keyctl,
#endif
#ifdef __NR_request_key
    __NR_request_key,
#endif
#ifdef __NR_add_key
    __NR_add_key,
#endif
#ifdef __NR_process_vm_readv
    __NR_process_vm_readv,
#endif
#ifdef __NR_process_vm_writev
    __NR_process_vm_writev,
#endif
#ifdef __NR_personality
    __NR_personality,
#endif
};

#define N (sizeof(BLOCKED)/sizeof(BLOCKED[0]))

static int apply_filter(void) {
    /* BPF program: check arch, load nr, for each blocked: jeq->errno, default allow */
    unsigned int len = 4 + N + 2;
    struct sock_filter *f = calloc(len, sizeof(struct sock_filter));
    if (!f) return -1;
    unsigned int i = 0;
    /* [0] load arch */
    f[i++] = (struct sock_filter)BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch));
    /* [1] check arch */
    f[i++] = (struct sock_filter)BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AUDIT_ARCH_CURRENT, 1, 0);
    /* [2] kill on wrong arch */
    f[i++] = (struct sock_filter)BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS);
    /* [3] load syscall nr */
    f[i++] = (struct sock_filter)BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr));
    /* [4..4+N-1] check each blocked: jt jumps to errno return at [4+N+1] */
    for (unsigned int j = 0; j < N; j++) {
        unsigned int jt = (unsigned int)(N - j); /* distance to errno instr */
        f[i++] = (struct sock_filter)BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, (unsigned int)BLOCKED[j], jt, 0);
    }
    /* [4+N] allow */
    f[i++] = (struct sock_filter)BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW);
    /* [4+N+1] errno EPERM */
    f[i++] = (struct sock_filter)BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|(EPERM & SECCOMP_RET_DATA));

    struct sock_fprog prog = { .len = (unsigned short)i, .filter = f };
    int ret = (int)syscall(__NR_seccomp, SECCOMP_SET_MODE_FILTER, 0, &prog);
    free(f);
    return ret;
}

int main(int argc, char *argv[]) {
    if (argc < 3) {
        fprintf(stderr, "Usage: seccomp-loader <profile.json> <command> [args...]\\n");
        return 1;
    }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) {
        perror("prctl(PR_SET_NO_NEW_PRIVS)");
        return 1;
    }
    if (apply_filter() < 0) {
        fprintf(stderr, "seccomp-loader: BPF filter failed (errno=%d); continuing with no-new-privs only\\n", errno);
    }
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
    log.info("seccomp-loader compiled successfully (BPF filter enabled)");
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
