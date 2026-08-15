#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadEnvFile } from "../config/env.js";
import { CostGovernor } from "../discovery/cost.js";
import { loadCassette, wrapForRecording } from "../discovery/cassette.js";
import { runDiscovery } from "../discovery/loop.js";
import { systemPrompt, type Planner } from "../discovery/planner.js";
import { loadPolicy, type RawPolicyConfig } from "../discovery/policy.js";
import { GooglePlanner } from "../discovery/providers/google.js";
import { OllamaPlanner } from "../discovery/providers/ollama.js";
import { TraceWriter } from "../discovery/trace.js";
import type { DiscoveryGoal } from "../discovery/types.js";
import { WebSurface } from "../surface/web/adapter.js";

/**
 * `npm run discover -- --goal "..."`
 *
 * Wires the pieces built across this phase into one runnable command: loads
 * policy, picks a planner from the environment (defaulting to the local,
 * free one), optionally wraps it for cassette recording or replay, launches
 * the target surface, and runs the loop. Everything this file does is
 * plumbing - the decisions worth defending live in the modules it imports.
 */

interface Args {
  goal: string;
  entryPoint: string;
  tenant: string;
  app: string;
  maxSteps?: number;
  timeoutMs?: number;
  headless: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const out: { -readonly [K in keyof Args]?: Args[K] } = { headless: true };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value after ${flag}`);
      return value;
    };
    switch (flag) {
      case "--goal":
        out.goal = next();
        break;
      case "--entry":
        out.entryPoint = next();
        break;
      case "--tenant":
        out.tenant = next();
        break;
      case "--app":
        out.app = next();
        break;
      case "--max-steps":
        out.maxSteps = Number(next());
        break;
      case "--timeout-ms":
        out.timeoutMs = Number(next());
        break;
      case "--headed":
        out.headless = false;
        break;
    }
  }
  if (!out.goal) throw new Error('--goal is required, e.g. --goal "look up member 100234 and read their savings balance"');

  return {
    goal: out.goal,
    entryPoint: out.entryPoint ?? `http://127.0.0.1:${process.env["TARGET_APP_PORT"] ?? "4501"}/servicing/login.asp`,
    tenant: out.tenant ?? process.env["TARGET_APP_TENANT"] ?? "meridian",
    app: out.app ?? "corevantage-servicing",
    ...(out.maxSteps !== undefined ? { maxSteps: out.maxSteps } : {}),
    ...(out.timeoutMs !== undefined ? { timeoutMs: out.timeoutMs } : {}),
    headless: out.headless ?? true,
  };
}

function buildPlanner(prompt: string): Planner {
  const provider = process.env["UNDERSTUDY_PLANNER"] ?? "ollama";
  switch (provider) {
    case "ollama":
      return new OllamaPlanner({
        ...(process.env["OLLAMA_HOST"] ? { host: process.env["OLLAMA_HOST"] } : {}),
        ...(process.env["OLLAMA_MODEL"] ? { model: process.env["OLLAMA_MODEL"] } : {}),
        ...(process.env["OLLAMA_TIMEOUT_MS"] ? { timeoutMs: Number(process.env["OLLAMA_TIMEOUT_MS"]) } : {}),
        systemPrompt: prompt,
      });
    case "google": {
      const apiKey = process.env["GOOGLE_AI_API_KEY"];
      if (!apiKey) throw new Error("GOOGLE_AI_API_KEY is required when UNDERSTUDY_PLANNER=google");
      return new GooglePlanner({ apiKey, systemPrompt: prompt });
    }
    default:
      throw new Error(`unknown UNDERSTUDY_PLANNER "${provider}" - expected "ollama" or "google"`);
  }
}

async function main(): Promise<void> {
  await loadEnvFile();
  const args = parseArgs(process.argv.slice(2));

  const policyPath = join(process.cwd(), "config", "policy.example.json");
  const policyRaw = JSON.parse(await readFile(policyPath, "utf8")) as RawPolicyConfig;
  const policy = loadPolicy(policyRaw);

  const runId = String(Date.now());
  const runDir = join(process.cwd(), "evidence", `discovery-${runId}`);
  const trace = new TraceWriter(runDir);

  const cassetteMode = process.env["UNDERSTUDY_CASSETTE"] ?? "off";
  let planner: Planner;
  if (cassetteMode === "replay") {
    const cassettePath = process.env["UNDERSTUDY_CASSETTE_PATH"];
    if (!cassettePath) throw new Error("UNDERSTUDY_CASSETTE_PATH is required when UNDERSTUDY_CASSETTE=replay");
    planner = await loadCassette(cassettePath);
    console.log(`[discover] replaying cassette ${cassettePath} - zero model calls will be made`);
  } else {
    planner = buildPlanner(systemPrompt());
    if (cassetteMode === "record") {
      planner = wrapForRecording(planner, trace.plannerLogPath());
      console.log(`[discover] recording planner exchanges to ${trace.plannerLogPath()}`);
    }
  }

  const maxUsd = Number(process.env["UNDERSTUDY_MAX_USD"] ?? "0");
  const costGovernor = new CostGovernor(maxUsd);

  const goal: DiscoveryGoal = {
    goalId: `goal-${runId}`,
    text: args.goal,
    target: { entryPoint: args.entryPoint, tenant: args.tenant, app: args.app },
  };

  console.log(`[discover] goal: ${args.goal}`);
  console.log(`[discover] target: ${args.entryPoint}`);
  console.log(`[discover] planner: ${planner.provider}/${planner.model}`);
  console.log(`[discover] cost ceiling: $${maxUsd.toFixed(2)}`);

  const surface = await WebSurface.launch(args.entryPoint, { headless: args.headless });
  try {
    const outcome = await runDiscovery(goal, {
      runId,
      surface,
      planner,
      policy,
      costGovernor,
      trace,
      options: {
        ...(args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
      },
    });

    console.log("");
    console.log(`[discover] stopped: ${outcome.stopReason}`);
    console.log(`[discover] steps: ${outcome.steps.length}`);
    console.log(`[discover] tokens: ${outcome.tokenUsage.promptTokens} prompt + ${outcome.tokenUsage.completionTokens} completion`);
    console.log(`[discover] estimated cost: $${outcome.tokenUsage.estimatedUsd.toFixed(4)}`);
    if (Object.keys(outcome.extractedOutputs).length > 0) {
      console.log("[discover] outputs:", outcome.extractedOutputs);
    }
    console.log(`[discover] evidence written to ${runDir}`);

    if (outcome.stopReason !== "goal_met") process.exitCode = 1;
  } finally {
    await surface.close();
  }
}

main().catch((error: unknown) => {
  console.error(`[discover] fatal: ${String(error)}`);
  process.exitCode = 1;
});
