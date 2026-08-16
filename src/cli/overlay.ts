#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
 * approval state was. The `id` inside the file is tenant-qualified by
 * `applyOverlay` itself, so the filename's `.<tenant>` and the id's own
 * `.<tenant>` suffix are the same one, not two.
 *
 * Refuses to overwrite an existing artifact at the computed path unless
 * `--force` is given - a second overlay run for the same tenant is
 * ordinary (rerunning after fixing an `--override` typo, say), but
 * clobbering whatever a reviewer may have already looked at, with no
 * confirmation and no diff, is not something to do by default.
 */

interface Args {
  artifactPath: string;
  tenant: string;
  entryPoint: string;
  overrides: Record<string, string>;
  force: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const overrides: Record<string, string> = {};
  let tenant: string | undefined;
  let entryPoint: string | undefined;
  let force = false;
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
    } else if (flag === "--force") {
      force = true;
    } else {
      positional.push(flag as string);
    }
  }
  const artifactPath = positional[0];
  if (!artifactPath || !tenant || !entryPoint) {
    throw new Error('usage: npm run overlay -- <artifact.json> --tenant <id> --entry-point <url> [--override "from=to" ...] [--force]');
  }
  return { artifactPath, tenant, entryPoint, overrides, force };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const raw = JSON.parse(await readFile(args.artifactPath, "utf8")) as unknown;
  const capability = parseCapability(raw);
  const { capability: overlaid, unmatchedOverrides } = applyOverlay(capability, {
    tenant: args.tenant,
    entryPoint: args.entryPoint,
    textOverrides: args.overrides,
  });

  // An override that matched nothing did nothing - almost always a typo in
  // the --override's "from" side, and otherwise silent until a much later,
  // harder-to-diagnose replay failure.
  for (const key of unmatchedOverrides) {
    console.warn(`[overlay] warning: --override "${key}=${args.overrides[key]}" matched no name/label text anywhere in the capability - check for a typo`);
  }

  const outDir = join(process.cwd(), "artifacts");
  await mkdir(outDir, { recursive: true });
  // overlaid.id is already tenant-qualified (applyOverlay appends
  // .{tenant}) - the filename just adds the version, matching every other
  // artifact's <id>.v<version> convention instead of naming the tenant twice.
  const basename = `${overlaid.id}.v${overlaid.version}`;
  const jsonPath = join(outDir, `${basename}.json`);
  const mdPath = join(outDir, `${basename}.md`);

  if (!args.force) {
    const clashes = (await Promise.all([exists(jsonPath), exists(mdPath)])).some(Boolean);
    if (clashes) {
      throw new Error(
        `${jsonPath} (or its .md) already exists - refusing to silently overwrite it. ` +
          `Pass --force to overwrite anyway, or bump the source capability's version first.`,
      );
    }
  }

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
