import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCapability } from "../../src/artifact/schema.js";
import { loadPolicy, type RawPolicyConfig } from "../../src/discovery/policy.js";
import { readIntervention } from "../../src/replay/intervention.js";
import { replayCapability, resumeCapability } from "../../src/replay/replay.js";
import { ReplayTraceWriter } from "../../src/replay/trace.js";
import { WebSurface } from "../../src/surface/web/adapter.js";
import { createServicingServer, resetState } from "../../target-app/server.js";

/**
 * The claim REPORT.md §5 makes - "the human drives the same live session,
 * not a fresh one" - checked against a real browser and the real committed
 * artifact, not asserted from a scripted fake. There is no real human
 * available to this test, so the stand-in is the most honest one available:
 * calling `surface.act()` directly, exactly the call a human's own click
 * would produce through the same Surface interface, against the exact
 * WebSurface instance replay itself escalated with - never a second one.
 *
 * The real committed capability's own steps are all "safe" under
 * policy.example.json's shipped risk rules, so this marks the first step
 * (Sign On) irreversible for this test only, the same technique
 * test/replay/replay.test.ts already uses with a fake surface - what is
 * being proven here is the handoff mechanism against a real page, not a new
 * irreversible step in the shipped policy.
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
  runDir = await mkdtemp(join(tmpdir(), "understudy-resume-web-"));
}, TIMEOUT);

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(runDir, { recursive: true, force: true });
}, TIMEOUT);

async function loadPolicyMarkingSignOnIrreversible() {
  const raw = JSON.parse(await readFile(join(process.cwd(), "config", "policy.example.json"), "utf8")) as RawPolicyConfig;
  raw.allowlist.origins = [base];
  raw.risk.rules = [{ match: { nameMatches: "sign on" }, tier: "irreversible" }, ...raw.risk.rules];
  raw.unattended = { requiresApproval: "draft", maxTier: "elevated", onIrreversible: "escalate" };
  return loadPolicy(raw);
}

async function loadRealCapability() {
  const raw = JSON.parse(await readFile(ARTIFACT_PATH, "utf8")) as unknown;
  const capability = parseCapability(raw);
  return { ...capability, target: { ...capability.target, entryPoint: `${base}/servicing/login.asp` } };
}

describe("handoff and resume against a real browser and the real artifact", () => {
  it(
    "stops before each irreversible Sign On, and continues correctly once the same live session shows it happened",
    async () => {
      // The real 5-step flow clicks "Sign On" twice - once to leave the
      // login screen, once to confirm the operator ID - so marking that
      // name irreversible means two genuine handoffs in one run, not one.
      // That is a more thorough proof of the mechanism than a single
      // handoff would be: it has to keep driving the *same* session
      // correctly across repeated escalations, the same shape the CLI's own
      // while loop handles.
      const capability = await loadRealCapability();
      const policy = await loadPolicyMarkingSignOnIrreversible();
      const surface = await WebSurface.launch(capability.target.entryPoint);
      const runId = "resume-web-test";
      const trace = new ReplayTraceWriter(runDir);

      try {
        let result = await replayCapability(capability, { member_number: "100234" }, { runId, surface, policy, trace, attended: false });
        let handoffs = 0;
        const resumeAtSeen: number[] = [];

        while (result.status === "escalated") {
          expect(result.resumable).toBe(true);
          handoffs++;
          expect(handoffs).toBeLessThanOrEqual(2); // exactly two Sign On clicks exist

          const intervention = await readIntervention(trace.runDir);
          resumeAtSeen.push(intervention.resumeAt);
          expect(intervention.lease.owner).toBe("human");

          // Stand-in for a human's own click, against the exact same open
          // page replay escalated with - not a new WebSurface.
          const beforeHuman = await surface.observe();
          const signOn = beforeHuman.nodes.find((n) => n.role === "button" && n.name === "Sign On");
          expect(signOn).toBeDefined();
          await surface.act({ kind: "click", target: signOn!.ref });

          result = await resumeCapability(intervention, capability, { member_number: "100234" }, { runId, surface, policy, trace, attended: false });
        }

        expect(handoffs).toBe(2);
        expect(resumeAtSeen).toEqual([1, 3]); // after each Sign On (steps 0 and 2), continuing at 1 and 3
        expect(result.status).toBe("success");
        if (result.status === "success") expect(result.outputs).toEqual({ savings_balance: "4,182.55" });
      } finally {
        await surface.close();
      }
    },
    TIMEOUT,
  );
});
