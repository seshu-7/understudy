import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CapabilityNotFoundError,
  findCapability,
  invokeCapability,
  listApproved,
  loadCatalog,
  summarize,
  toToolDefinition,
} from "../../src/catalog/catalog.js";
import type { ReplayDeps } from "../../src/replay/replay.js";
import { ReplayTraceWriter } from "../../src/replay/trace.js";
import { loadPolicy, type RawPolicyConfig } from "../../src/discovery/policy.js";
import { nodeRef, type Action, type CapturedEvidence, type Surface, type UINode, type UISnapshot } from "../../src/surface/types.js";

/**
 * Loaded from the real `artifacts/` directory - the actual committed
 * capability, not a fixture standing in for it. If the real artifact ever
 * fails to parse, this is where that shows up.
 */

const ARTIFACTS_DIR = join(process.cwd(), "artifacts");
const REAL_ID = "corevantage_servicing.member_savings_balance";

describe("loadCatalog", () => {
  it("loads and validates the real committed artifact, ignoring README.md", async () => {
    const catalog = await loadCatalog(ARTIFACTS_DIR);
    expect(catalog.length).toBeGreaterThanOrEqual(1);
    expect(catalog.some((c) => c.id === REAL_ID)).toBe(true);
  });
});

describe("summarize and toToolDefinition", () => {
  it("projects the real capability into a summary carrying its real inputs", async () => {
    const catalog = await loadCatalog(ARTIFACTS_DIR);
    const capability = findCapability(catalog, REAL_ID);
    const summary = summarize(capability);
    expect(summary.id).toBe(REAL_ID);
    expect(summary.inputs.some((p) => p.name === "member_number")).toBe(true);
    expect(summary.outputCount).toBe(1);
  });

  it("produces a tool definition whose required properties match the capability's required inputs", async () => {
    const catalog = await loadCatalog(ARTIFACTS_DIR);
    const capability = findCapability(catalog, REAL_ID);
    const tool = toToolDefinition(capability);
    expect(tool.input_schema.required).toEqual(["member_number"]);
    expect(tool.input_schema.properties["member_number"]).toEqual({ type: "string", description: capability.inputs[0]!.description });
    expect(tool.description).toContain("savings_balance");
    // The real output's own description already ends in a period - the
    // template must not double it up.
    expect(tool.description).not.toMatch(/\.\./);
  });
});

describe("findCapability", () => {
  it("throws CapabilityNotFoundError for an id that is not in the catalog", async () => {
    const catalog = await loadCatalog(ARTIFACTS_DIR);
    expect(() => findCapability(catalog, "nonexistent.capability")).toThrow(CapabilityNotFoundError);
  });
});

describe("listApproved", () => {
  it("excludes anything not approved - the real committed artifact is still draft", async () => {
    const catalog = await loadCatalog(ARTIFACTS_DIR);
    expect(listApproved(catalog).some((c) => c.id === REAL_ID)).toBe(false);
  });
});

describe("invokeCapability", () => {
  let runDir: string;
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "understudy-catalog-test-"));
  });
  afterEach(async () => {
    await rm(runDir, { recursive: true, force: true });
  });

  let counter = 0;
  function node(spec: { role: UINode["role"]; name?: string; label?: string; ordinal?: number; ancestry?: { role: UINode["role"]; name: string }[] }): UINode {
    return {
      ref: nodeRef(`n${counter++}`),
      role: spec.role,
      name: spec.name ?? "",
      ...(spec.label !== undefined ? { label: spec.label } : {}),
      state: { disabled: false, readonly: false, required: false, focused: false },
      frame: [],
      ancestry: spec.ancestry ?? [],
      ordinal: spec.ordinal ?? 0,
      visible: true,
    };
  }
  class FakeSurface implements Surface {
    readonly kind = "web" as const;
    async observe(): Promise<UISnapshot> {
      return { snapshotId: "s", takenAt: "t", kind: "web", location: "http://x/", title: "t", nodes: [node({ role: "text", name: "irrelevant" })], digest: "d" };
    }
    async act(_action: Action): Promise<void> {}
    async capture(): Promise<CapturedEvidence> {
      return { kind: "screenshot", mediaType: "image/png", bytes: new Uint8Array() };
    }
    async close(): Promise<void> {}
  }

  it("dispatches to replayCapability by id, so a missing input is refused the same way replayCapability refuses it", async () => {
    const catalog = await loadCatalog(ARTIFACTS_DIR);
    const raw: RawPolicyConfig = {
      allowlist: { origins: ["http://x"], routes: ["/**"], denyRoutes: [], actions: ["click", "fill", "select", "press", "navigate", "wait"] },
      risk: { default: "safe", rules: [] },
      unattended: { requiresApproval: "approved", maxTier: "elevated", onIrreversible: "escalate" },
      redaction: { patterns: [], fieldNames: [], placeholder: "[redacted:{name}]" },
    };
    const deps: ReplayDeps = { runId: "t", surface: new FakeSurface(), policy: loadPolicy(raw), trace: new ReplayTraceWriter(runDir), attended: true };
    await expect(invokeCapability(catalog, REAL_ID, {}, deps)).rejects.toThrow(/missing required input/);
  });

  it("throws CapabilityNotFoundError before ever touching replay for an unknown id", async () => {
    const catalog = await loadCatalog(ARTIFACTS_DIR);
    const raw: RawPolicyConfig = {
      allowlist: { origins: [], routes: [], denyRoutes: [], actions: [] },
      risk: { default: "safe", rules: [] },
      unattended: { requiresApproval: "approved", maxTier: "elevated", onIrreversible: "escalate" },
      redaction: { patterns: [], fieldNames: [], placeholder: "[redacted:{name}]" },
    };
    const deps: ReplayDeps = { runId: "t", surface: new FakeSurface(), policy: loadPolicy(raw), trace: new ReplayTraceWriter(runDir), attended: true };
    await expect(invokeCapability(catalog, "nonexistent.capability", {}, deps)).rejects.toThrow(CapabilityNotFoundError);
  });
});
