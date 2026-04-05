#!/usr/bin/env node
import { createRuntime } from "./runtime/index.js";

async function main() {
  const args = process.argv.slice(2);

  function getFlag(flag: string): string | undefined {
    const i = args.indexOf(flag);
    if (i === -1 || i + 1 >= args.length) return undefined;
    return args[i + 1];
  }

  const message = getFlag("--message") ?? getFlag("-m");
  const sessionId = getFlag("--session");
  const model = getFlag("--model");
  const provider = getFlag("--provider");
  const apiKey = getFlag("--api-key");
  if (apiKey) {
    process.stderr.write(
      "Warning: --api-key is visible in process listings. " +
      "Prefer setting the API key via environment variable (e.g. ANTHROPIC_API_KEY).\n",
    );
  }
  const workspaceDir = getFlag("--workspace");
  const systemPrompt = getFlag("--system-prompt");

  if (!message) {
    console.error(
      "Usage: cloison-runtime --message <message> [--session <id>] [--model <model>] [--provider <provider>]",
    );
    process.exit(1);
  }

  const runtime = await createRuntime({
    model,
    provider,
    apiKey,
    workspaceDir,
  });

  const result = await runtime.run({
    message,
    sessionId,
    model,
    provider,
    apiKey,
    workspaceDir,
    systemPrompt,
  });

  console.log(result.response);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
