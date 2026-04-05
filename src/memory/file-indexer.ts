// Ported from OpenClaw extensions/memory-core/src/memory/manager-sync-ops.ts
// ensureWatcher logic, IGNORED_MEMORY_WATCH_DIR_NAMES, shouldIgnoreMemoryWatchPath,
// syncMemoryFiles with hash comparison and stale cleanup

import * as fs from "node:fs";
import * as path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { chunkMarkdown, hashText } from "./internal.js";
import type { SimpleMemoryManager } from "./simple-manager.js";

const log = createSubsystemLogger("memory/file-indexer");

const MAX_FILE_SIZE = 1024 * 1024;

// From OpenClaw: exact list of ignored directory names
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

export interface FileIndexerOptions {
  workspaceDir: string;
  memory: SimpleMemoryManager;
  watchPaths?: string[];
  debounceMs?: number;
  extraPaths?: string[];
  chunking?: { tokens: number; overlap: number };
}

export interface FileIndexer {
  start(): void;
  stop(): void;
  sync(): Promise<FileIndexSyncResult>;
  readonly watching: boolean;
}

export interface FileIndexSyncResult {
  filesProcessed: number;
  chunksStored: number;
  chunksRemoved: number;
  errors: number;
}

interface IndexedFileState {
  hash: string;
  chunkIds: string[];
}

// From OpenClaw
function shouldIgnoreMemoryWatchPath(watchPath: string): boolean {
  const normalized = path.normalize(watchPath);
  const parts = normalized.split(path.sep).map((segment) => segment.trim().toLowerCase());
  return parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment));
}

export function createFileIndexer(options: FileIndexerOptions): FileIndexer {
  const {
    workspaceDir,
    memory,
    debounceMs = 2000,
    chunking = { tokens: 500, overlap: 50 },
  } = options;

  const watchers: fs.FSWatcher[] = [];
  let watching = false;
  let watchTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;

  const indexedFiles = new Map<string, IndexedFileState>();

  function resolveWatchPaths(): string[] {
    const paths = new Set<string>();
    const memoryMd = path.join(workspaceDir, "MEMORY.md");
    if (fs.existsSync(memoryMd)) paths.add(memoryMd);
    const memoryMdLower = path.join(workspaceDir, "memory.md");
    if (memoryMdLower !== memoryMd && fs.existsSync(memoryMdLower)) paths.add(memoryMdLower);

    const memoryDir = path.join(workspaceDir, "memory");
    if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) paths.add(memoryDir);

    for (const p of [...(options.watchPaths ?? []), ...(options.extraPaths ?? [])]) {
      const resolved = path.isAbsolute(p) ? p : path.join(workspaceDir, p);
      try {
        const stat = fs.lstatSync(resolved);
        if (stat.isSymbolicLink()) continue;
        if (stat.isFile() || stat.isDirectory()) paths.add(resolved);
      } catch { /* skip missing */ }
    }

    return Array.from(paths);
  }

  function collectMarkdownFiles(dir: string): string[] {
    const files: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (shouldIgnoreMemoryWatchPath(full)) continue;
        if (entry.isDirectory()) {
          files.push(...collectMarkdownFiles(full));
        } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".txt"))) {
          files.push(full);
        }
      }
    } catch { /* directory not readable */ }
    return files;
  }

  function collectAllFiles(): string[] {
    const files: string[] = [];
    const memoryMd = path.join(workspaceDir, "MEMORY.md");
    if (fs.existsSync(memoryMd)) files.push(memoryMd);
    const memoryMdLower = path.join(workspaceDir, "memory.md");
    if (memoryMdLower !== memoryMd && fs.existsSync(memoryMdLower)) files.push(memoryMdLower);

    const memoryDir = path.join(workspaceDir, "memory");
    if (fs.existsSync(memoryDir) && fs.statSync(memoryDir).isDirectory()) {
      files.push(...collectMarkdownFiles(memoryDir));
    }

    for (const p of [...(options.watchPaths ?? []), ...(options.extraPaths ?? [])]) {
      const resolved = path.isAbsolute(p) ? p : path.join(workspaceDir, p);
      try {
        const stat = fs.statSync(resolved);
        if (stat.isFile()) files.push(resolved);
        else if (stat.isDirectory()) files.push(...collectMarkdownFiles(resolved));
      } catch { /* skip */ }
    }

    return [...new Set(files)];
  }

  function scheduleWatchSync(): void {
    dirty = true;
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      watchTimer = null;
      sync().catch((err) => log.warn(`memory sync failed (watch): ${String(err)}`));
    }, debounceMs);
  }

  async function sync(): Promise<FileIndexSyncResult> {
    dirty = false;
    const result: FileIndexSyncResult = {
      filesProcessed: 0, chunksStored: 0, chunksRemoved: 0, errors: 0,
    };

    const currentFiles = collectAllFiles();
    const currentPaths = new Set(currentFiles);

    // Remove chunks for deleted files
    for (const [filePath, state] of indexedFiles) {
      if (!currentPaths.has(filePath)) {
        for (const chunkId of state.chunkIds) {
          try { await memory.delete(chunkId); result.chunksRemoved++; } catch { result.errors++; }
        }
        indexedFiles.delete(filePath);
      }
    }

    // Index new/changed files
    for (const filePath of currentFiles) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_SIZE) {
          log.warn(`skipping large file: ${filePath} (${stat.size} bytes)`);
          continue;
        }
        const content = fs.readFileSync(filePath, "utf-8");
        const hash = hashText(content);
        const existing = indexedFiles.get(filePath);

        // Skip unchanged files (OpenClaw's hash comparison)
        if (existing && existing.hash === hash) {
          result.filesProcessed++;
          continue;
        }

        // Remove old chunks for changed files
        if (existing) {
          for (const chunkId of existing.chunkIds) {
            try { await memory.delete(chunkId); result.chunksRemoved++; } catch { result.errors++; }
          }
        }

        const relPath = path.relative(workspaceDir, filePath);
        const chunks = chunkMarkdown(content, chunking);
        const newChunkIds: string[] = [];

        for (const chunk of chunks) {
          if (!chunk.text.trim()) continue;
          try {
            const id = await memory.store(chunk.text, {
              source: "file",
              path: relPath,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
            });
            newChunkIds.push(id);
            result.chunksStored++;
          } catch { result.errors++; }
        }

        indexedFiles.set(filePath, { hash, chunkIds: newChunkIds });
        result.filesProcessed++;
      } catch (err) {
        log.error(`failed to index ${filePath}`, { error: String(err) });
        result.errors++;
      }
    }

    log.info("sync complete", {
      files: result.filesProcessed, stored: result.chunksStored,
      removed: result.chunksRemoved, errors: result.errors,
    });
    return result;
  }

  return {
    get watching() { return watching; },

    start() {
      if (watching) return;
      watching = true;
      const paths = resolveWatchPaths();
      if (paths.length === 0) { log.debug("no watch paths found"); return; }

      for (const watchPath of paths) {
        try {
          const isDir = fs.statSync(watchPath).isDirectory();
          const watcher = fs.watch(
            watchPath,
            { recursive: isDir, persistent: false },
            (_eventType, filename) => {
              if (!filename) return;
              if (shouldIgnoreMemoryWatchPath(filename)) return;
              const ext = path.extname(filename);
              if (ext === ".md" || ext === ".txt" || filename === "MEMORY.md") {
                log.debug(`file change detected: ${filename}`);
                scheduleWatchSync();
              }
            },
          );
          watchers.push(watcher);
        } catch (err) {
          log.warn(`cannot watch ${watchPath}: ${err}`);
        }
      }

      log.info(`watching ${paths.length} paths for changes`);
      sync().catch((err) => log.error("initial sync failed", { error: String(err) }));
    },

    stop() {
      watching = false;
      if (watchTimer) { clearTimeout(watchTimer); watchTimer = null; }
      for (const w of watchers) { try { w.close(); } catch { /* best effort */ } }
      watchers.length = 0;
    },

    sync,
  };
}
