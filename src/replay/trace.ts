import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReplayResult } from "./types.js";

/**
 * Evidence for one replay run, in the shape evidence/README.md already
 * documents: `trace.jsonl` (every step, match score and checkpoint result),
 * `result.json` (the ReplayResult exactly as a calling agent received it),
 * and `failure/` (screenshot plus node snapshot, written only on failure -
 * a clean run has nothing to show there and shouldn't pretend otherwise).
 */

export interface ReplayTraceEvent {
  ts: string;
  index: number;
  kind: "resolve" | "policy" | "action" | "checkpoint" | "recovery" | "outcome" | "stop";
  data: unknown;
}

export class ReplayTraceWriter {
  private readonly traceFile: string;
  private readonly failureDir: string;

  constructor(readonly runDir: string) {
    this.traceFile = join(this.runDir, "trace.jsonl");
    this.failureDir = join(this.runDir, "failure");
  }

  async init(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
  }

  async event(kind: ReplayTraceEvent["kind"], index: number, data: unknown): Promise<void> {
    const event: ReplayTraceEvent = { ts: new Date().toISOString(), index, kind, data };
    await appendFile(this.traceFile, `${JSON.stringify(event)}\n`, "utf8");
  }

  async failureEvidence(screenshot: Uint8Array, snapshot: unknown): Promise<void> {
    await mkdir(this.failureDir, { recursive: true });
    await writeFile(join(this.failureDir, "screen.png"), screenshot);
    await writeFile(join(this.failureDir, "snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
  }

  async result(result: ReplayResult): Promise<void> {
    await writeFile(join(this.runDir, "result.json"), JSON.stringify(result, null, 2), "utf8");
  }
}
