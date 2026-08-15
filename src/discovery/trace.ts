import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveryOutcome } from "./types.js";

/**
 * Evidence, as the brief specifies it: a structured log of what the agent did
 * and why, plus a richer signal on failure. `evidence/README.md` documents
 * the shape this produces; this module is what actually writes it.
 *
 * One layout decision worth naming: the model exchange (`planner.jsonl`) and
 * the step trace (`trace.jsonl`) are separate files. The exchange is raw
 * evidence that the discovery run was real - point a reviewer at it and they
 * can see the actual prompts and responses. The trace is the distilled
 * record Phase 4's compiler reads. Keeping them apart means the compiler
 * never has to parse model chatter to find the six decisions that mattered.
 */

export interface TraceEvent {
  ts: string;
  index: number;
  kind: "observation" | "decision" | "action" | "checkpoint" | "policy" | "grounding" | "stop";
  data: unknown;
}

export class TraceWriter {
  private readonly traceFile: string;
  private readonly stepsDir: string;

  constructor(readonly runDir: string) {
    this.traceFile = join(runDir, "trace.jsonl");
    this.stepsDir = join(runDir, "steps");
  }

  async init(): Promise<void> {
    await mkdir(this.stepsDir, { recursive: true });
  }

  /** Path a recording planner should append its exchanges to. Lives beside
   *  the trace so evidence/<run>/ is self-contained. */
  plannerLogPath(): string {
    return join(this.runDir, "planner.jsonl");
  }

  async event(kind: TraceEvent["kind"], index: number, data: unknown): Promise<void> {
    const event: TraceEvent = { ts: new Date().toISOString(), index, kind, data };
    await appendFile(this.traceFile, `${JSON.stringify(event)}\n`, "utf8");
  }

  async screenshot(index: number, bytes: Uint8Array): Promise<void> {
    await writeFile(join(this.stepsDir, `${String(index).padStart(2, "0")}.png`), bytes);
  }

  async summary(outcome: DiscoveryOutcome): Promise<void> {
    await writeFile(join(this.runDir, "summary.json"), JSON.stringify(outcome, null, 2), "utf8");
  }
}
