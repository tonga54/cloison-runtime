/**
 * Demo: File-based memory indexing
 *
 * Shows:
 * - Auto-indexing of MEMORY.md and memory/ directory files
 * - Hash-based change detection (skips unchanged files)
 * - Re-indexing on file modification
 * - Chunk removal on file deletion
 * - Ignored directories (.git, node_modules, etc.)
 * - Searchable indexed content
 *
 * Run: npx tsx demos/demo-file-indexer.ts
 * Note: No API key needed — uses FTS-only memory (no embeddings).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createSimpleMemoryManager } from "../src/memory/index.js";
import { createFileIndexer } from "../src/memory/file-indexer.js";

const WORKSPACE = ".demo-file-indexer";

async function main() {
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE, { recursive: true });

  console.log("=== File-based Memory Indexing Demo ===\n");

  const memory = createSimpleMemoryManager({ dbDir: path.join(WORKSPACE, "db") });
  const indexer = createFileIndexer({ workspaceDir: WORKSPACE, memory });

  // --- Create MEMORY.md ---
  console.log("--- Step 1: Create MEMORY.md ---\n");
  fs.writeFileSync(
    path.join(WORKSPACE, "MEMORY.md"),
    [
      "# Project Architecture",
      "",
      "The project uses a microservices architecture with 3 main services:",
      "- **API Gateway**: handles routing and auth (Node.js + Express)",
      "- **Worker Service**: processes background jobs (Python + Celery)",
      "- **Data Pipeline**: ETL pipeline (Spark + Airflow)",
      "",
      "## Tech Stack",
      "",
      "- Frontend: React 19 + TypeScript",
      "- Backend: Node.js 22 + Fastify",
      "- Database: PostgreSQL 16 on AWS RDS",
      "- Cache: Redis 7 on ElastiCache",
      "- CI/CD: GitHub Actions → AWS ECS",
    ].join("\n"),
  );

  const r1 = await indexer.sync();
  console.log(`  Files processed: ${r1.filesProcessed}`);
  console.log(`  Chunks stored: ${r1.chunksStored}`);
  console.log(`  Errors: ${r1.errors}`);

  // --- Create memory/ directory with more files ---
  console.log("\n--- Step 2: Add memory/ directory files ---\n");
  const memoryDir = path.join(WORKSPACE, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });

  fs.writeFileSync(
    path.join(memoryDir, "api-conventions.md"),
    [
      "# API Conventions",
      "",
      "- All endpoints return JSON with `{ data, error, meta }` shape",
      "- Authentication: Bearer tokens (JWT, 24h expiry)",
      "- Rate limiting: 100 req/min per user, 1000 req/min per org",
      "- Pagination: cursor-based with `?cursor=xxx&limit=50`",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(memoryDir, "deployment.md"),
    [
      "# Deployment Process",
      "",
      "1. Push to `main` triggers CI pipeline",
      "2. Tests run in parallel (unit, integration, e2e)",
      "3. Docker image built and pushed to ECR",
      "4. ECS rolling update with health checks",
      "5. Canary deployment: 10% → 50% → 100% over 30 minutes",
    ].join("\n"),
  );

  const r2 = await indexer.sync();
  console.log(`  Files processed: ${r2.filesProcessed}`);
  console.log(`  Chunks stored: ${r2.chunksStored} (new files only)`);

  // --- Search indexed content ---
  console.log("\n--- Step 3: Search indexed content ---\n");
  const queries = [
    "What database do we use?",
    "How does deployment work?",
    "rate limiting",
    "authentication",
  ];

  for (const q of queries) {
    const results = await memory.search(q, { maxResults: 2 });
    console.log(`  Q: "${q}"`);
    for (const r of results) {
      console.log(`    [${r.score.toFixed(3)}] ${r.snippet.slice(0, 80).replace(/\n/g, " ")}...`);
    }
    console.log();
  }

  // --- Re-sync unchanged files (skips them) ---
  console.log("--- Step 4: Re-sync (no changes → skips) ---\n");
  const r3 = await indexer.sync();
  console.log(`  Files processed: ${r3.filesProcessed}`);
  console.log(`  Chunks stored: ${r3.chunksStored} (should be 0 — no changes)`);
  console.log(`  Chunks removed: ${r3.chunksRemoved} (should be 0)`);

  // --- Modify a file ---
  console.log("\n--- Step 5: Modify MEMORY.md → re-indexes ---\n");
  fs.writeFileSync(
    path.join(WORKSPACE, "MEMORY.md"),
    [
      "# Project Architecture (Updated)",
      "",
      "Migrated from monolith to microservices in Q1 2026.",
      "Now using Kubernetes instead of ECS.",
      "Added GraphQL gateway in front of REST services.",
    ].join("\n"),
  );

  const r4 = await indexer.sync();
  console.log(`  Files processed: ${r4.filesProcessed}`);
  console.log(`  Chunks stored: ${r4.chunksStored} (new content)`);
  console.log(`  Chunks removed: ${r4.chunksRemoved} (old content)`);

  // Verify updated content is searchable
  const k8sResults = await memory.search("Kubernetes", { maxResults: 1 });
  console.log(`  Search "Kubernetes": ${k8sResults.length > 0 ? "found ✓" : "not found ✗"}`);

  // --- Delete a file ---
  console.log("\n--- Step 6: Delete deployment.md → removes chunks ---\n");
  fs.unlinkSync(path.join(memoryDir, "deployment.md"));

  const r5 = await indexer.sync();
  console.log(`  Chunks removed: ${r5.chunksRemoved}`);
  console.log(`  Files processed: ${r5.filesProcessed}`);

  const deployResults = await memory.search("canary deployment", { maxResults: 1 });
  console.log(`  Search "canary deployment": ${deployResults.length === 0 ? "gone ✓" : "still found ✗"}`);

  // --- Total memories ---
  console.log("\n--- Final state ---\n");
  const all = await memory.list();
  console.log(`  Total memory chunks: ${all.length}`);

  await memory.close();
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  console.log("\nDemo complete.");
}

main().catch(console.error);
