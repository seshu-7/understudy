import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initialLease } from "../../src/replay/lease.js";
import { readIntervention, writeIntervention, type Intervention } from "../../src/replay/intervention.js";

let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "understudy-intervention-test-"));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

function makeIntervention(overrides: Partial<Intervention> = {}): Intervention {
  return {
    interventionId: "r1-0",
    runId: "r1",
    capabilityId: "app.cap",
    capabilityVersion: 1,
    createdAt: "2026-08-15T00:00:00.000Z",
    reason: "irreversible actions never run unattended",
    observedLocation: "http://127.0.0.1:9999/servicing/",
    resumeAt: 1,
    recoveriesSoFar: [],
    lease: initialLease("r1", "app.cap"),
    status: "open",
    ...overrides,
  };
}

describe("intervention persistence", () => {
  it("round-trips through disk exactly", async () => {
    const intervention = makeIntervention();
    await writeIntervention(runDir, intervention);
    const loaded = await readIntervention(runDir);
    expect(loaded).toEqual(intervention);
  });

  it("round-trips a precondition too", async () => {
    const intervention = makeIntervention({
      precondition: { detect: { kind: "location_matches", pattern: "error" }, expect: "cleared" },
    });
    await writeIntervention(runDir, intervention);
    const loaded = await readIntervention(runDir);
    expect(loaded.precondition).toEqual(intervention.precondition);
  });
});
