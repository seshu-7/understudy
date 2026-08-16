#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

import { parseCapability } from "../artifact/schema.js";
import { loadEnvFile } from "../config/env.js";
import { loadPolicy, type RawPolicyConfig } from "../discovery/policy.js";
import { readIntervention } from "../replay/intervention.js";
import { ReplayError, replayCapability, resumeCapability } from "../replay/replay.js";
import { ReplayTraceWriter } from "../replay/trace.js";
import type { ReplayResult } from "../replay/types.js";
import { WebSurface } from "../surface/web/adapter.js";

/**
 * `npm run replay -- <path/to/artifact.json> [--input name=value ...] [--unattended] [--headed]`
 *
 * Loads a compiled capability, validates it against the same schema a
 * replay engine or reviewer would hold it to, and runs it with zero model
 * calls. Attended by default - the safer default for a human running this
 * from a terminal - so `--unattended` has to be asked for explicitly, the
 * same way an approval has to be explicit before it does anything.
 *
 * On an escalated, resumable result, this is what actually makes "the human
 * drives the same live session" (REPORT.md §5) true rather than aspirational:
 * the browser is left open, not closed, and the process pauses on stdin
 * rather than exiting - a fresh `npm run replay` invocation later would be a
 * new WebSurface against the app's starting screen, not the session a human
 * is meant to pick up mid-flow. `--headed` is what makes the paused browser
 * actually visible to someone at the terminal; escalating headless still
 * works (the intervention and evidence are real either way) but there is
 * nothing on screen for a human to drive.
 */

interface Args {
  artifactPath: string;
  inputs: Record<string, string>;
  attended: boolean;
  headless: boolean;
  policyPath: string;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const inputs: Record<string, string> = {};
  let attended = true;
  let headless = true;
  let policyPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--unattended") {
      attended = false;
    } else if (flag === "--headed") {
      headless = false;
    } else if (flag === "--policy") {
      policyPath = argv[++i];
      if (!policyPath) throw new Error("missing value after --policy, expected --policy path/to/policy.json");
    } else if (flag === "--input") {
      const pair = argv[++i];
      if (!pair) throw new Error("missing value after --input, expected --input name=value");
      const eq = pair.indexOf("=");
      if (eq < 0) throw new Error(`--input "${pair}" is not in name=value form`);
      inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else {
      positional.push(flag as string);
    }
  }
  const artifactPath = positional[0];
  if (!artifactPath) throw new Error("usage: npm run replay -- <path/to/artifact.json> [--input name=value ...] [--unattended] [--headed] [--policy path]");
  return { artifactPath, inputs, attended, headless, policyPath: policyPath ?? join("config", "policy.example.json") };
}

function report(result: ReplayResult, totalSteps: number): void {
  console.log("");
  console.log(`[replay] status: ${result.status}`);
  console.log(`[replay] steps attempted: ${result.stepsAttempted}/${totalSteps}`);
  if (result.recoveries.length > 0) console.log(`[replay] recoveries: ${JSON.stringify(result.recoveries)}`);
  if (result.status === "success") console.log(`[replay] outputs:`, result.outputs);
  if (result.status === "business_outcome") console.log(`[replay] outcome "${result.outcome}":`, result.data);
  if (result.status === "failed") console.log(`[replay] failure [${result.failure.code}] at step ${result.failure.stepIndex}: ${result.failure.message}`);
  if (result.status === "escalated") console.log(`[replay] escalated: ${result.reason}`);
}

async function main(): Promise<void> {
  await loadEnvFile();
  const args = parseArgs(process.argv.slice(2));

  const raw = JSON.parse(await readFile(args.artifactPath, "utf8")) as unknown;
  const capability = parseCapability(raw);

  const policyPath = join(process.cwd(), args.policyPath);
  const policyRaw = JSON.parse(await readFile(policyPath, "utf8")) as RawPolicyConfig;
  const policy = loadPolicy(policyRaw);

  const runId = String(Date.now());
  const runDir = join(process.cwd(), "evidence", `replay-${runId}`);
  const trace = new ReplayTraceWriter(runDir);

  console.log(`[replay] capability: ${capability.id} v${capability.version} (${capability.approval})`);
  console.log(`[replay] mode: ${args.attended ? "attended" : "unattended"}`);
  console.log(`[replay] target: ${capability.target.entryPoint}`);

  const surface = await WebSurface.launch(capability.target.entryPoint, { headless: args.headless });
  let leaveSurfaceOpenForHuman = false;
  try {
    let result = await replayCapability(capability, args.inputs, { runId, surface, policy, trace, attended: args.attended });

    while (result.status === "escalated" && result.resumable) {
      console.log("");
      console.log(`[replay] handoff: ${result.reason}`);
      console.log(`[replay] the browser is staying open at ${trace.runDir} - drive it yourself now.`);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      await rl.question("Press Enter once you're done (Ctrl+C to abandon and leave the browser open): ");
      rl.close();

      const intervention = await readIntervention(trace.runDir);
      result = await resumeCapability(intervention, capability, args.inputs, { runId, surface, policy, trace, attended: args.attended });
    }

    report(result, capability.steps.length);
    console.log(`[replay] evidence written to ${runDir}`);

    if (result.status === "failed") process.exitCode = 1;
    if (result.status === "escalated") leaveSurfaceOpenForHuman = true;
  } catch (error) {
    if (error instanceof ReplayError) {
      console.error(`[replay] refused: ${error.message}`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    if (!leaveSurfaceOpenForHuman) await surface.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[replay] fatal: ${String(error)}`);
  process.exitCode = 1;
});
