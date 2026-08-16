#!/usr/bin/env node
import { join } from "node:path";

import { listApproved, loadCatalog, summarize, toToolDefinition } from "../catalog/catalog.js";

/**
 * `npm run catalog [-- --approved-only] [-- --tools]`
 *
 * Lists every capability artifacts/ has, the way an agent integration would
 * enumerate what it can call. `--tools` prints the Anthropic-tool-use-shaped
 * definition each capability projects to instead of the plain summary -
 * what an agent's tool list would actually contain.
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const approvedOnly = args.includes("--approved-only");
  const asTools = args.includes("--tools");

  const artifactsDir = join(process.cwd(), "artifacts");
  const catalog = await loadCatalog(artifactsDir);
  const listed = approvedOnly ? listApproved(catalog) : catalog;

  console.log(`[catalog] ${listed.length}/${catalog.length} capabilities${approvedOnly ? " (approved only)" : ""}`);
  console.log("");
  for (const capability of listed) {
    console.log(JSON.stringify(asTools ? toToolDefinition(capability) : summarize(capability), null, 2));
  }
}

main().catch((error: unknown) => {
  console.error(`[catalog] fatal: ${String(error)}`);
  process.exitCode = 1;
});
