import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface SeccompProfile {
  defaultAction: "SCMP_ACT_ALLOW" | "SCMP_ACT_ERRNO" | "SCMP_ACT_KILL";
  syscalls: SeccompRule[];
}

export interface SeccompRule {
  names: string[];
  action: "SCMP_ACT_ALLOW" | "SCMP_ACT_ERRNO" | "SCMP_ACT_KILL";
}

const NODE_REQUIRED_SYSCALLS = [
  "read", "write", "open", "close", "stat", "fstat", "lstat",
  "poll", "lseek", "mmap", "mprotect", "munmap", "brk",
  "rt_sigaction", "rt_sigprocmask", "rt_sigreturn", "ioctl",
  "pread64", "pwrite64", "readv", "writev", "access",
  "pipe", "select", "sched_yield", "mremap", "msync",
  "mincore", "madvise", "shmget", "shmat", "shmctl",
  "dup", "dup2", "pause", "nanosleep", "getitimer",
  "alarm", "setitimer", "getpid", "sendfile",
  "socket", "connect", "accept", "sendto", "recvfrom",
  "sendmsg", "recvmsg", "shutdown", "bind", "listen",
  "getsockname", "getpeername", "socketpair",
  "setsockopt", "getsockopt",
  "clone", "fork", "vfork", "execve",
  "exit", "wait4", "kill", "uname",
  "fcntl", "flock", "fsync", "fdatasync", "truncate", "ftruncate",
  "getdents", "getcwd", "chdir", "fchdir",
  "rename", "mkdir", "rmdir", "creat", "link", "unlink",
  "symlink", "readlink", "chmod", "fchmod", "chown", "fchown",
  "lchown", "umask", "gettimeofday", "getrlimit",
  "getrusage", "sysinfo", "times", "getuid", "syslog",
  "getgid", "setuid", "setgid", "geteuid", "getegid",
  "setpgid", "getppid", "getpgrp", "setsid",
  "setreuid", "setregid", "getgroups", "setgroups",
  "setresuid", "getresuid", "setresgid", "getresgid",
  "sigpending", "sigaltstack", "statfs", "fstatfs",
  "arch_prctl", "set_tid_address", "set_robust_list",
  "get_robust_list",
  "futex", "sched_getaffinity",
  "epoll_create", "epoll_ctl", "epoll_wait",
  "epoll_create1", "epoll_pwait",
  "eventfd", "eventfd2", "timerfd_create", "timerfd_settime",
  "signalfd", "signalfd4",
  "clock_gettime", "clock_getres", "clock_nanosleep",
  "exit_group", "tgkill", "openat", "mkdirat",
  "fchownat", "newfstatat", "unlinkat", "renameat",
  "linkat", "symlinkat", "readlinkat", "fchmodat",
  "faccessat", "pselect6", "ppoll",
  "splice", "tee", "sync_file_range", "utimensat",
  "fallocate", "accept4", "pipe2", "inotify_init1",
  "preadv", "pwritev", "recvmmsg", "sendmmsg",
  "getrandom", "memfd_create", "copy_file_range",
  "statx", "rseq",
  "close_range", "openat2", "pidfd_open",
  "clone3", "faccessat2",
  "process_mrelease", "futex_waitv",
  "preadv2", "pwritev2",
  "io_uring_setup", "io_uring_enter", "io_uring_register",
  "mlock", "munlock",
  "prctl", "capget", "capset",
  "getdents64", "dup3",
  "sched_setaffinity", "sched_getaffinity",
];

const BLOCKED_SYSCALLS = [
  "ptrace",
  "mount", "umount2",
  "pivot_root", "chroot",
  "reboot", "kexec_load", "kexec_file_load",
  "init_module", "finit_module", "delete_module",
  "acct",
  "swapon", "swapoff",
  "nfsservctl",
  "personality",
  "keyctl", "request_key", "add_key",
  "bpf",
  "userfaultfd",
  "perf_event_open",
  "lookup_dcookie",
  "kcmp",
  "process_vm_readv", "process_vm_writev",
  "move_pages", "migrate_pages",
  "mbind", "set_mempolicy", "get_mempolicy",
  "unshare", "setns",
];

export function buildDefaultProfile(): SeccompProfile {
  return {
    defaultAction: "SCMP_ACT_ERRNO",
    syscalls: [
      {
        names: NODE_REQUIRED_SYSCALLS,
        action: "SCMP_ACT_ALLOW",
      },
      {
        names: BLOCKED_SYSCALLS,
        action: "SCMP_ACT_ERRNO",
      },
    ],
  };
}

export function buildRestrictedProfile(
  additionalAllowed?: string[],
): SeccompProfile {
  const allowed = [...NODE_REQUIRED_SYSCALLS, ...(additionalAllowed ?? [])];
  return {
    defaultAction: "SCMP_ACT_KILL",
    syscalls: [
      {
        names: allowed,
        action: "SCMP_ACT_ALLOW",
      },
    ],
  };
}

export function writeSeccompProfile(
  profile: SeccompProfile,
  sandboxId: string,
): string {
  const tmpDir = path.join(os.tmpdir(), "cloison-runtime-seccomp");
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const profilePath = path.join(tmpDir, `${sandboxId}.json`);
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), { mode: 0o600 });
  return profilePath;
}

export function cleanupSeccompProfile(profilePath: string): void {
  try {
    fs.unlinkSync(profilePath);
  } catch {
    // best effort
  }
}
