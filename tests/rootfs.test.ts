import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as url from "node:url";
import { prepareRootfs, buildMountScript } from "../src/sandbox/rootfs.js";

describe("prepareRootfs", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanupDirs.length = 0;
  });

  it("creates rootDir structure", () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rootfs-ws-"));
    cleanupDirs.push(wsDir);

    const rootfs = prepareRootfs({
      sandboxId: "test-rootfs-1",
      workspaceDir: wsDir,
    });
    cleanupDirs.push(rootfs.rootDir);

    expect(fs.existsSync(rootfs.rootDir)).toBe(true);
    expect(fs.existsSync(path.join(rootfs.rootDir, "proc"))).toBe(true);
    expect(fs.existsSync(path.join(rootfs.rootDir, "tmp"))).toBe(true);
    expect(fs.existsSync(path.join(rootfs.rootDir, ".old-root"))).toBe(true);

    rootfs.cleanup();
    expect(fs.existsSync(rootfs.rootDir)).toBe(false);
  });

  it("mount targets are inside rootDir, not over themselves", () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rootfs-ws-"));
    cleanupDirs.push(wsDir);

    const rootfs = prepareRootfs({
      sandboxId: "test-rootfs-2",
      workspaceDir: wsDir,
    });
    cleanupDirs.push(rootfs.rootDir);

    for (const mount of rootfs.mounts) {
      expect(
        mount.target.startsWith(rootfs.rootDir),
        `mount target ${mount.target} should be inside rootDir ${rootfs.rootDir}`,
      ).toBe(true);
      expect(mount.target).not.toBe(mount.source);
    }

    rootfs.cleanup();
  });

  it("workspace dir is writable, system paths are readonly", () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rootfs-ws-"));
    cleanupDirs.push(wsDir);

    const rootfs = prepareRootfs({
      sandboxId: "test-rootfs-3",
      workspaceDir: wsDir,
    });
    cleanupDirs.push(rootfs.rootDir);

    const wsMounts = rootfs.mounts.filter((m) => m.source === wsDir);
    expect(wsMounts.length).toBe(1);
    expect(wsMounts[0].readonly).toBe(false);

    const roMounts = rootfs.mounts.filter((m) => m.readonly);
    expect(roMounts.length).toBeGreaterThan(0);

    rootfs.cleanup();
  });

  it("handles file-type additionalBinds", () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rootfs-ws-"));
    const tmpFile = path.join(wsDir, "test.conf");
    fs.writeFileSync(tmpFile, "config=value");
    cleanupDirs.push(wsDir);

    const rootfs = prepareRootfs({
      sandboxId: "test-rootfs-4",
      workspaceDir: wsDir,
      additionalBinds: [
        { source: tmpFile, target: "/etc/test.conf", readonly: true },
      ],
    });
    cleanupDirs.push(rootfs.rootDir);

    const targetPath = path.join(rootfs.rootDir, "/etc/test.conf");
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.statSync(targetPath).isFile()).toBe(true);

    rootfs.cleanup();
  });

  it("handles directory-type additionalBinds", () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rootfs-ws-"));
    const extraDir = path.join(wsDir, "extra");
    fs.mkdirSync(extraDir);
    cleanupDirs.push(wsDir);

    const rootfs = prepareRootfs({
      sandboxId: "test-rootfs-5",
      workspaceDir: wsDir,
      additionalBinds: [
        { source: extraDir, target: "/opt/extra", readonly: true },
      ],
    });
    cleanupDirs.push(rootfs.rootDir);

    const targetPath = path.join(rootfs.rootDir, "/opt/extra");
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.statSync(targetPath).isDirectory()).toBe(true);

    rootfs.cleanup();
  });

  it("includes projectDir when provided", () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rootfs-ws-"));
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), "rootfs-proj-"));
    cleanupDirs.push(wsDir, projDir);

    const rootfs = prepareRootfs({
      sandboxId: "test-rootfs-6",
      workspaceDir: wsDir,
      projectDir: projDir,
    });
    cleanupDirs.push(rootfs.rootDir);

    const projMount = rootfs.mounts.find((m) => m.source === projDir);
    expect(projMount).toBeDefined();
    expect(projMount!.readonly).toBe(true);
    expect(projMount!.target.startsWith(rootfs.rootDir)).toBe(true);

    rootfs.cleanup();
  });
});

describe("buildMountScript", () => {
  it("generates pivot_root commands", () => {
    const script = buildMountScript("/tmp/rootfs", []);

    expect(script).toContain("pivot_root . .old-root");
    expect(script).toContain("umount /.old-root");
    expect(script).toContain("FATAL: cannot unmount old root");
    expect(script).toContain("FATAL: old root still mounted after unmount");
    expect(script).toContain("FATAL: old root still accessible after unmount");
    expect(script).toContain("mountpoint -q /.old-root");
  });

  it("generates bind mount commands for readonly mounts", () => {
    const mounts = [
      { source: "/usr", target: "/tmp/rootfs/usr", readonly: true },
    ];
    const script = buildMountScript("/tmp/rootfs", mounts);

    expect(script).toContain("mount --bind '/usr' '/tmp/rootfs/usr'");
    expect(script).toContain("mount -o remount,ro,bind '/tmp/rootfs/usr'");
  });

  it("generates bind mount commands for writable mounts", () => {
    const mounts = [
      { source: "/workspace", target: "/tmp/rootfs/workspace", readonly: false },
    ];
    const script = buildMountScript("/tmp/rootfs", mounts);

    expect(script).toContain("mount --bind '/workspace' '/tmp/rootfs/workspace'");
    expect(script).not.toContain("remount,ro");
  });

  it("mounts proc only when PID namespace is active", () => {
    const withPid = buildMountScript("/tmp/rootfs", [], { hasPidNamespace: true });
    expect(withPid).toContain("mount -t proc proc");

    const withoutPid = buildMountScript("/tmp/rootfs", [], { hasPidNamespace: false });
    expect(withoutPid).not.toContain("mount -t proc proc");
    expect(withoutPid).toContain("skip proc mount");
  });

  it("rejects paths with traversal in additionalBinds", () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rootfs-ws-"));
    try {
      expect(() =>
        prepareRootfs({
          sandboxId: "test-traversal",
          workspaceDir: wsDir,
          additionalBinds: [
            { source: "/tmp", target: "../../etc/cron.d", readonly: true },
          ],
        }),
      ).toThrow("resolves outside rootDir");
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true });
      const rootDir = path.join(os.tmpdir(), "cloison-runtime-rootfs", "test-traversal");
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects sensitive host paths in additionalBinds source", () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rootfs-ws-"));
    try {
      expect(() =>
        prepareRootfs({
          sandboxId: "test-sensitive",
          workspaceDir: wsDir,
          additionalBinds: [
            { source: "/root", target: "/mnt/root", readonly: true },
          ],
        }),
      ).toThrow("sensitive host path");
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true });
      const rootDir = path.join(os.tmpdir(), "cloison-runtime-rootfs", "test-sensitive");
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("rejects non-existent additionalBinds source", () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rootfs-ws-"));
    try {
      expect(() =>
        prepareRootfs({
          sandboxId: "test-noexist",
          workspaceDir: wsDir,
          additionalBinds: [
            { source: "/nonexistent/path/xyz", target: "/mnt/xyz", readonly: true },
          ],
        }),
      ).toThrow("does not exist");
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true });
      const rootDir = path.join(os.tmpdir(), "cloison-runtime-rootfs", "test-noexist");
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("resolveWorkerPath", () => {
  it("resolves to a path that exists", () => {
    const thisFile = url.fileURLToPath(import.meta.url);
    const srcDir = path.join(path.dirname(thisFile), "..", "src");
    const tsPath = path.join(srcDir, "sandbox", "worker.ts");
    const jsPath = path.join(srcDir, "sandbox", "worker.js");

    const exists = fs.existsSync(tsPath) || fs.existsSync(jsPath);
    expect(exists).toBe(true);
  });
});
