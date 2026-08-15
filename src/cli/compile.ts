#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { compileCapability } from "../artifact/compile.js";
import { renderCapability } from "../artifact/render.js";
import type { DiscoveryOutcome } from "../discovery/types.js";

/**
 * `npm run compile -- evidence/discovery-<runId>/summary.json`
 *
 * The other half of Phase 4: takes the trace a discovery run already wrote
 * to disk and distills it into a versioned `Capability`, written both as the
 * JSON a replay engine or calling agent reads and as the Markdown a human
 * reviewer reads. Deliberately reads `summary.json` rather than re-deriving
 * anything from `trace.jsonl` - `DiscoveryOutcome` is the compiler's entire
 * contract, and if a field it needs isn't there, that's `compileCapability`
 * refusing loudly rather than this file guessing around it.
 */

interface Args {
  summaryPath: string;
  id?: string;
  name?: string;
  description?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const out: { -readonly [K in keyof Args]?: Args[K] } = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value after ${flag}`);
      return value;
    };
    switch (flag) {
      case "--id":
        out.id = next();
        break;
      case "--name":
        out.name = next();
        break;
      case "--description":
        out.description = next();
        break;
      default:
        positional.push(flag as string);
    }
  }
  const summaryPath = positional[0];
  if (!summaryPath) throw new Error("usage: npm run compile -- <path/to/summary.json> [--id id] [--name name] [--description text]");
  return { summaryPath, ...out };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const raw = await readFile(args.summaryPath, "utf8");
  const outcome = JSON.parse(raw) as DiscoveryOutcome;

  const capability = compileCapability(outcome, {
    ...(args.id !== undefined ? { id: args.id } : {}),
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.description !== undefined ? { description: args.description } : {}),
  });

  const outDir = join(process.cwd(), "artifacts");
  await mkdir(outDir, { recursive: true });
  // <id>.v<version>.json, per artifacts/README.md - versioned on disk so a
  // re-compile never silently overwrites a capability a reviewer already
  // approved; approving a new version is a distinct, visible act.
  const basename = `${capability.id}.v${capability.version}`;
  const jsonPath = join(outDir, `${basename}.json`);
  const mdPath = join(outDir, `${basename}.md`);
  await writeFile(jsonPath, JSON.stringify(capability, null, 2), "utf8");
  await writeFile(mdPath, renderCapability(capability), "utf8");

  console.log(`[compile] ${outcome.steps.length} steps -> capability "${capability.id}" (content hash ${capability.contentHash})`);
  console.log(`[compile] wrote ${jsonPath}`);
  console.log(`[compile] wrote ${mdPath}`);
}

main().catch((error: unknown) => {
  console.error(`[compile] fatal: ${String(error)}`);
  process.exitCode = 1;
});
