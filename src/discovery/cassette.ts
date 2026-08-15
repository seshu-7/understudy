import { appendFile, readFile } from "node:fs/promises";
import type { Planner, PlannerContext, PlannerResult } from "./planner.js";

/**
 * Record once, replay for free, forever.
 *
 * This is what makes "the bill is $0" true beyond the first run: the one
 * genuine model exchange the brief requires is captured to disk, and every
 * later invocation - development iteration, a second demo, a reviewer
 * re-running the repo - reads from that file and never calls a model at all.
 * It is also the answer to the README's "how to run without live services".
 *
 * The wrapper is deliberately dumb. It does not try to match a replayed
 * decision to the current context - it plays the recording back in the exact
 * order it was written, and if the loop's own logic is deterministic given
 * the same decisions, replaying the cassette reproduces the same run. That is
 * a real constraint (the loop must not branch on wall-clock time or
 * randomness), and it is the same constraint the replay engine will have in
 * Phase 5, so building it here is not extra work, it is the same discipline
 * one phase early.
 */

export interface CassetteEntry {
  provider: string;
  model: string;
  context: PlannerContext;
  result: PlannerResult;
}

export type CassetteMode = "off" | "record" | "replay";

class RecordingPlanner implements Planner {
  constructor(
    private readonly inner: Planner,
    private readonly path: string,
  ) {}

  get provider(): string {
    return this.inner.provider;
  }
  get model(): string {
    return this.inner.model;
  }

  async decide(context: PlannerContext): Promise<PlannerResult> {
    const result = await this.inner.decide(context);
    const entry: CassetteEntry = {
      provider: this.inner.provider,
      model: this.inner.model,
      context,
      result,
    };
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
    return result;
  }
}

class ReplayingPlanner implements Planner {
  private cursor = 0;

  constructor(
    readonly provider: string,
    readonly model: string,
    private readonly entries: readonly CassetteEntry[],
  ) {}

  async decide(_context: PlannerContext): Promise<PlannerResult> {
    const entry = this.entries[this.cursor];
    if (!entry) {
      throw new Error(
        `cassette exhausted at step ${this.cursor} - the recorded run had fewer turns than this replay needs. ` +
          `Record a new cassette or check the loop for a change in behaviour.`,
      );
    }
    this.cursor++;
    return entry.result;
  }
}

/** Wrap a real planner so every exchange is appended to `path` as it happens.
 *  Used only when UNDERSTUDY_CASSETTE=record. */
export function wrapForRecording(planner: Planner, path: string): Planner {
  return new RecordingPlanner(planner, path);
}

/** Load a previously recorded cassette and serve it back with zero calls to
 *  any provider. Used when UNDERSTUDY_CASSETTE=replay. */
export async function loadCassette(path: string): Promise<Planner> {
  const raw = await readFile(path, "utf8");
  const entries: CassetteEntry[] = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CassetteEntry);

  const first = entries[0];
  if (!first) throw new Error(`cassette at ${path} is empty`);

  return new ReplayingPlanner(first.provider, first.model, entries);
}
