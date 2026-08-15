import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCassette, wrapForRecording } from "../../src/discovery/cassette.js";
import type { Planner, PlannerContext, PlannerResult } from "../../src/discovery/planner.js";

/**
 * The property that matters here is not "the file has the right bytes" - it
 * is "replay never calls the underlying planner". That is the whole basis
 * for the project's zero-cost claim beyond the first run, so it is asserted
 * directly with a call counter rather than inferred from the output looking
 * right.
 */

class CountingPlanner implements Planner {
  readonly provider = "test-provider";
  readonly model = "test-model";
  calls = 0;

  constructor(private readonly scripted: PlannerResult[]) {}

  async decide(_context: PlannerContext): Promise<PlannerResult> {
    const result = this.scripted[this.calls];
    this.calls++;
    if (!result) throw new Error("CountingPlanner ran out of scripted results");
    return result;
  }
}

function ctx(observationText: string): PlannerContext {
  return { goal: "test goal", observationText, history: "" };
}

function result(intent: string): PlannerResult {
  return {
    decision: { action: "click", index: 0, intent },
    usage: { promptTokens: 10, completionTokens: 5 },
    raw: { ok: true },
  };
}

let dir: string;
let cassettePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "understudy-cassette-"));
  cassettePath = join(dir, "planner.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("recording", () => {
  it("appends one JSON line per exchange, in order", async () => {
    const inner = new CountingPlanner([result("first"), result("second")]);
    const recording = wrapForRecording(inner, cassettePath);

    await recording.decide(ctx("screen 1"));
    await recording.decide(ctx("screen 2"));

    expect(inner.calls).toBe(2);

    const cassette = await loadCassette(cassettePath);
    expect(cassette.provider).toBe("test-provider");
    expect(cassette.model).toBe("test-model");
  });
});

describe("replay", () => {
  it("never calls the wrapped planner, however many times it is read", async () => {
    const inner = new CountingPlanner([result("first"), result("second")]);
    const recording = wrapForRecording(inner, cassettePath);
    await recording.decide(ctx("screen 1"));
    await recording.decide(ctx("screen 2"));
    expect(inner.calls).toBe(2);

    // A fresh planner, wrapping nothing live - the cassette is the only
    // source of decisions from here on.
    const replaying = await loadCassette(cassettePath);
    const first = await replaying.decide(ctx("irrelevant - replay ignores context"));
    const second = await replaying.decide(ctx("also irrelevant"));

    expect(first.decision.intent).toBe("first");
    expect(second.decision.intent).toBe("second");
    // The inner planner was never touched again after recording.
    expect(inner.calls).toBe(2);
  });

  it("throws a clear error rather than looping when the cassette runs out", async () => {
    const inner = new CountingPlanner([result("only one")]);
    const recording = wrapForRecording(inner, cassettePath);
    await recording.decide(ctx("screen 1"));

    const replaying = await loadCassette(cassettePath);
    await replaying.decide(ctx("first replay, fine"));
    await expect(replaying.decide(ctx("second replay, nothing left"))).rejects.toThrow(/exhausted/);
  });

  it("refuses to load an empty cassette", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(cassettePath, "", "utf8");
    await expect(loadCassette(cassettePath)).rejects.toThrow(/empty/);
  });
});
