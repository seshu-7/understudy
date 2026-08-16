import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCapability } from "../../src/artifact/schema.js";
import { loadPolicy, type RawPolicyConfig } from "../../src/discovery/policy.js";
import { replayCapability } from "../../src/replay/replay.js";
import { ReplayTraceWriter } from "../../src/replay/trace.js";
import { WebSurface } from "../../src/surface/web/adapter.js";
import { createServicingServer, resetState } from "../../target-app/server.js";

/**
 * The real committed artifact, replayed against the real target app - not a
 * fixture standing in for either. This is what actually proves the claim
 * artifacts/README.md makes: a capability recorded once against member
 * 100234 replays correctly against a member it has never seen, with the
 * exact same JSON file and zero model calls.
 *
 * Each test gets its own server and its own in-memory data (resetState), the
 * same discipline test/surface-web.test.ts documents for the same reason:
 * undeclared shared state between tests reports a different failure on every
 * run.
 */

const TIMEOUT = 90_000;
const ARTIFACT_PATH = join(process.cwd(), "artifacts", "corevantage_servicing.member_savings_balance.v1.json");

let server: Server;
let base: string;
let runDir: string;

beforeEach(async () => {
  resetState();
  server = createServicingServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  runDir = await mkdtemp(join(tmpdir(), "understudy-replay-web-"));
}, TIMEOUT);

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(runDir, { recursive: true, force: true });
}, TIMEOUT);

async function loadRealPolicy() {
  const raw = JSON.parse(await readFile(join(process.cwd(), "config", "policy.example.json"), "utf8")) as RawPolicyConfig;
  raw.allowlist.origins = [base];
  return loadPolicy(raw);
}

async function loadRealCapability() {
  const raw = JSON.parse(await readFile(ARTIFACT_PATH, "utf8")) as unknown;
  const capability = parseCapability(raw);
  return { ...capability, target: { ...capability.target, entryPoint: `${base}/servicing/login.asp` } };
}

describe("replaying the real compiled artifact against the real target app", () => {
  it(
    "reproduces the exact recorded run for the member it was discovered against",
    async () => {
      const capability = await loadRealCapability();
      const surface = await WebSurface.launch(capability.target.entryPoint);
      try {
        const result = await replayCapability(
          capability,
          { member_number: "100234" },
          { runId: "test-same-member", surface, policy: await loadRealPolicy(), trace: new ReplayTraceWriter(runDir), attended: true },
        );
        expect(result.status).toBe("success");
        if (result.status === "success") expect(result.outputs).toEqual({ savings_balance: "4,182.55" });
      } finally {
        await surface.close();
      }
    },
    TIMEOUT,
  );

  it(
    "generalises to a member it was never recorded against - the real proof that structuralOnly (REPORT.md §2) works",
    async () => {
      const capability = await loadRealCapability();
      const surface = await WebSurface.launch(capability.target.entryPoint);
      try {
        // Member 100412: three accounts, not two - a genuine structural
        // stress test, not a cosmetic parameter swap.
        const result = await replayCapability(
          capability,
          { member_number: "100412" },
          { runId: "test-different-member", surface, policy: await loadRealPolicy(), trace: new ReplayTraceWriter(runDir), attended: true },
        );
        expect(result.status).toBe("success");
        if (result.status === "success") expect(result.outputs).toEqual({ savings_balance: "22,940.18" });
      } finally {
        await surface.close();
      }
    },
    TIMEOUT,
  );

  it(
    "fails honestly, not silently, on a real screen the artifact has no declared outcome for",
    async () => {
      const capability = await loadRealCapability();
      const surface = await WebSurface.launch(capability.target.entryPoint);
      try {
        const result = await replayCapability(
          capability,
          { member_number: "100599" },
          { runId: "test-restricted-member", surface, policy: await loadRealPolicy(), trace: new ReplayTraceWriter(runDir), attended: true },
        );
        expect(result.status).toBe("failed");
        if (result.status === "failed") {
          expect(result.failure.code).toBe("CHECKPOINT_FAILED");
          expect(result.stepsAttempted).toBe(capability.steps.length);
        }
      } finally {
        await surface.close();
      }
    },
    TIMEOUT,
  );
});
