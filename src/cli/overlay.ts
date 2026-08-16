#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { renderCapability } from "../artifact/render.js";
import { applyOverlay } from "../artifact/overlay.js";
import { parseCapability } from "../artifact/schema.js";

/**
 * `npm run overlay -- <artifact.json> --tenant northstar --entry-point <url> --override "Search=Find Member"`
 *
 * Produces a new artifacts/<id>.<tenant>.v<version>.json (and its .md) for
 * a second tenant, from an existing capability - text substitution only,
 * per overlay.ts's own scope. The result always starts `draft`: nobody has
 * reviewed *these* descriptors yet, whatever the source capability's own
 * approval state was.
 */

interface Args {
  artifactPath: string;
  tenant: string;
  entryPoint: string;
  overrides: Record<string, string>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const overrides: Record<string, string> = {};
  let tenant: string | undefined;
  let entryPoint: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--tenant") {
      tenant = argv[++i];
    } else if (flag === "--entry-point") {
      entryPoint = argv[++i];
    } else if (flag === "--override") {
      const pair = argv[++i];
      if (!pair) throw new Error("missing value after --override, expected --override \"from=to\"");
      const eq = pair.indexOf("=");
      if (eq < 0) throw new Error(`--override "${pair}" is not in from=to form`);
      overrides[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else {
      positional.push(flag as string);
    }
  }
  const artifactPath = positional[0];
  if (!artifactPath || !tenant || !entryPoint) {
    throw new Error('usage: npm run overlay -- <artifact.json> --tenant <id> --entry-point <url> [--override "from=to" ...]');
  }
  return { artifactPath, tenant, entryPoint, overrides };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const raw = JSON.parse(await readFile(args.artifactPath, "utf8")) as unknown;
  const capability = parseCapability(raw);
  const overlaid = applyOverlay(capability, { tenant: args.tenant, entryPoint: args.entryPoint, textOverrides: args.overrides });

  const outDir = join(process.cwd(), "artifacts");
  await mkdir(outDir, { recursive: true });
  const basename = `${overlaid.id}.${overlaid.target.tenant}.v${overlaid.version}`;
  const jsonPath = join(outDir, `${basename}.json`);
  const mdPath = join(outDir, `${basename}.md`);
  await writeFile(jsonPath, JSON.stringify(overlaid, null, 2), "utf8");
  await writeFile(mdPath, renderCapability(overlaid), "utf8");

  console.log(`[overlay] ${capability.id} -> tenant "${args.tenant}" (content hash ${overlaid.contentHash}, approval ${overlaid.approval})`);
  console.log(`[overlay] wrote ${jsonPath}`);
  console.log(`[overlay] wrote ${mdPath}`);
}

main().catch((error: unknown) => {
  console.error(`[overlay] fatal: ${String(error)}`);
  process.exitCode = 1;
});
