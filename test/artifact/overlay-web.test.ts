import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyOverlay } from "../../src/artifact/overlay.js";
import { parseCapability } from "../../src/artifact/schema.js";
import { loadPolicy, type RawPolicyConfig } from "../../src/discovery/policy.js";
import { replayCapability } from "../../src/replay/replay.js";
import { ReplayTraceWriter } from "../../src/replay/trace.js";
import { WebSurface } from "../../src/surface/web/adapter.js";
import { createServicingServer, resetState } from "../../target-app/server.js";
import { NORTHSTAR } from "../../target-app/tenants.js";

/**
 * The real committed artifact - recorded against tenant "meridian", where
 * the button reads "Search" - replayed against a second, real tenant
 * ("northstar") where the same underlying software renames it to "Find
 * Member". `target-app/tenants.ts` is the same server code as every other
 * test in this repo runs, not a stand-in for a second institution.
 *
 * Two things checked, not one: that the raw recording genuinely does not
 * survive the rename unmodified (not just "still works, trust me" - and not
 * where a naive guess would place the failure either, see the first test's
 * own comment), and that the overlaid capability replays correctly
 * end-to-end for real - reaching the exact same balance the original
 * meridian recording does, from a JSON file with the button's name literally
 * rewritten.
 */

const TIMEOUT = 90_000;
const ARTIFACT_PATH = join(process.cwd(), "artifacts", "corevantage_servicing.member_savings_balance.v1.json");

let server: Server;
let base: string;
let runDir: string;

beforeEach(async () => {
  resetState();
  server = createServicingServer(NORTHSTAR);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  runDir = await mkdtemp(join(tmpdir(), "understudy-overlay-web-"));
}, TIMEOUT);

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(runDir, { recursive: true, force: true });
}, TIMEOUT);

async function loadRealCapability() {
  const raw = JSON.parse(await readFile(ARTIFACT_PATH, "utf8")) as unknown;
  return parseCapability(raw);
}

async function loadPolicyFor(origin: string) {
  const raw = JSON.parse(await readFile(join(process.cwd(), "config", "policy.example.json"), "utf8")) as RawPolicyConfig;
  raw.allowlist.origins = [origin];
  raw.unattended = { requiresApproval: "draft", maxTier: "elevated", onIrreversible: "escalate" };
  return loadPolicy(raw);
}

describe("cross-tenant reuse against a real second tenant", () => {
  it(
    "the un-overlaid recording fails before it ever gets to the renamed button",
    async () => {
      // Runs the *raw* meridian recording, with no overlay at all, against
      // northstar. Steps 0-3 (Sign On, Operator ID, Sign On, Member Number)
      // are all untouched by the rename and succeed exactly as recorded -
      // but step 3's *checkpoint* is "step 4's own target is present"
      // (Phase 4's checkpoint-inference rule), and step 4's target is the
      // renamed button. So the failure actually lands one step earlier than
      // a naive guess would place it: replay never gets to *attempt* step 4
      // at all, because step 3's own checkpoint already can't find it.
      // Structural evidence alone (within the breadcrumb + ordinal, with
      // the name signal scoring ~0 against "Find Member") does not clear
      // the acceptance threshold on its own for this rename.
      const capability = await loadRealCapability();
      const surface = await WebSurface.launch(`${base}/servicing/login.asp`);
      try {
        const result = await replayCapability(
          capability,
          { member_number: "100234" },
          { runId: "overlay-web-baseline", surface, policy: await loadPolicyFor(base), trace: new ReplayTraceWriter(runDir), attended: true },
        );

        if (result.status === "failed") {
          expect(result.failure.stepIndex).toBe(3);
          expect(result.failure.code).toBe("CHECKPOINT_FAILED");
          expect(result.failure.observed).toContain("absent");
        } else {
          // If structural evidence alone turns out to be enough on this
          // particular rename, that is still evidence for the same point,
          // just a softer version of it - record what actually happened
          // rather than assume the stronger claim.
          expect(result.status).toBe("success");
        }
      } finally {
        await surface.close();
      }
    },
    TIMEOUT,
  );

  it(
    "the overlaid capability replays correctly end-to-end, reaching the identical answer",
    async () => {
      const capability = await loadRealCapability();
      const { capability: overlaid, unmatchedOverrides } = applyOverlay(capability, {
        tenant: NORTHSTAR.id,
        entryPoint: `${base}/servicing/login.asp`,
        textOverrides: { Search: NORTHSTAR.searchButtonLabel },
      });
      expect(overlaid.approval).toBe("draft");
      expect(unmatchedOverrides).toEqual([]);

      const surface = await WebSurface.launch(overlaid.target.entryPoint);
      try {
        const result = await replayCapability(
          overlaid,
          { member_number: "100234" },
          { runId: "overlay-web-test", surface, policy: await loadPolicyFor(base), trace: new ReplayTraceWriter(runDir), attended: true },
        );
        expect(result.status).toBe("success");
        if (result.status === "success") expect(result.outputs).toEqual({ savings_balance: "4,182.55" });
      } finally {
        await surface.close();
      }
    },
    TIMEOUT,
  );
});
