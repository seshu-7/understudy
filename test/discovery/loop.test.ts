import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CostGovernor } from "../../src/discovery/cost.js";
import { runDiscovery } from "../../src/discovery/loop.js";
import { loadPolicy, type Policy, type RawPolicyConfig } from "../../src/discovery/policy.js";
import { TraceWriter } from "../../src/discovery/trace.js";
import type { Planner, PlannerContext, PlannerDecision, PlannerResult } from "../../src/discovery/planner.js";
import type { DiscoveryGoal } from "../../src/discovery/types.js";
import { nodeRef, type Action, type CapturedEvidence, type Surface, type UINode, type UISnapshot } from "../../src/surface/types.js";

/**
 * The loop against fakes, not a browser or a model - every stopping
 * condition it is responsible for gets one test, exercised deterministically
 * and for $0. The browser-backed path is proven separately in
 * test/surface-web.test.ts; what matters here is the loop's own logic.
 */

class ScriptedPlanner implements Planner {
  calls = 0;
  constructor(
    private readonly decisions: readonly PlannerDecision[],
    readonly provider = "ollama",
    readonly model = "test-model",
    private readonly usage = { promptTokens: 100, completionTokens: 20 },
  ) {}

  async decide(_context: PlannerContext): Promise<PlannerResult> {
    const decision = this.decisions[Math.min(this.calls, this.decisions.length - 1)];
    this.calls++;
    if (!decision) throw new Error("ScriptedPlanner ran out of decisions");
    return { decision, usage: this.usage, raw: { call: this.calls } };
  }
}

class FakeSurface implements Surface {
  readonly kind = "web" as const;
  readonly actedOn: Action[] = [];

  constructor(private readonly snapshot: UISnapshot) {}

  async observe(): Promise<UISnapshot> {
    return this.snapshot;
  }
  async act(action: Action): Promise<void> {
    this.actedOn.push(action);
  }
  async capture(): Promise<CapturedEvidence> {
    return { kind: "screenshot", mediaType: "image/png", bytes: new Uint8Array() };
  }
  async close(): Promise<void> {}
}

function node(spec: { role: UINode["role"]; name?: string; label?: string }): UINode {
  return {
    ref: nodeRef(`n-${spec.role}-${spec.name ?? spec.label ?? ""}`),
    role: spec.role,
    name: spec.name ?? "",
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    state: { disabled: false, readonly: false, required: false, focused: false },
    frame: [],
    ancestry: [],
    ordinal: 0,
    visible: true,
  };
}

const LOCATION = "http://127.0.0.1:9999/servicing/mbr.asp";

function makeSnapshot(): UISnapshot {
  return {
    snapshotId: "s",
    takenAt: "t",
    kind: "web",
    location: LOCATION,
    title: "Member Search",
    nodes: [node({ role: "button", name: "Search" }), node({ role: "textbox", label: "Member Number" })],
    digest: "d",
  };
}

function makePolicy(overrides: Partial<RawPolicyConfig["allowlist"]> = {}): Policy {
  const raw: RawPolicyConfig = {
    allowlist: {
      origins: ["http://127.0.0.1:9999"],
      routes: ["/**"],
      denyRoutes: ["/servicing/**/delete"],
      actions: ["click", "fill", "select", "press", "navigate", "wait"],
      ...overrides,
    },
    risk: { default: "safe", rules: [] },
    unattended: { requiresApproval: "approved", maxTier: "elevated", onIrreversible: "escalate" },
    redaction: { patterns: [], fieldNames: [], placeholder: "[redacted:{name}]" },
  };
  return loadPolicy(raw);
}

const GOAL: DiscoveryGoal = {
  goalId: "g1",
  text: "test goal",
  target: { entryPoint: LOCATION, tenant: "meridian", app: "corevantage-servicing" },
};

let runDir: string;

beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "understudy-loop-"));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

async function run(planner: Planner, opts: Parameters<typeof runDiscovery>[1]["options"] = {}, policy = makePolicy()) {
  const surface = new FakeSurface(makeSnapshot());
  const trace = new TraceWriter(runDir);
  const outcome = await runDiscovery(GOAL, {
    runId: "r1",
    surface,
    planner,
    policy,
    costGovernor: new CostGovernor(0),
    trace,
    options: opts,
  });
  return { outcome, surface };
}

describe("stopping conditions", () => {
  it("stops at max_steps when the model keeps making distinct progress", async () => {
    const planner = new ScriptedPlanner(
      Array.from({ length: 5 }, (_, i) => ({ action: "fill" as const, index: 1, text: `value-${i}`, intent: `fill attempt ${i}` })),
    );
    const { outcome } = await run(planner, { maxSteps: 3 });
    expect(outcome.stopReason).toBe("max_steps");
    expect(outcome.steps).toHaveLength(3);
  });

  it("stops at goal_met and carries outputs through from finish", async () => {
    const planner = new ScriptedPlanner([{ action: "finish", intent: "done", outputs: { balance: "4,182.55" } }]);
    const { outcome } = await run(planner);
    expect(outcome.stopReason).toBe("goal_met");
    expect(outcome.extractedOutputs).toEqual({ balance: "4,182.55" });
    expect(outcome.steps).toHaveLength(0);
  });

  it("stops at dead_end when give_up is decided", async () => {
    const planner = new ScriptedPlanner([{ action: "give_up", intent: "stuck", reason: "permission denied" }]);
    const { outcome } = await run(planner);
    expect(outcome.stopReason).toBe("dead_end");
  });

  it("stops at dead_end when the same decision repeats past the threshold", async () => {
    const same: PlannerDecision = { action: "click", index: 0, intent: "click search, again" };
    const planner = new ScriptedPlanner([same, same, same, same]);
    const { outcome, surface } = await run(planner, { stuckThreshold: 2 });

    expect(outcome.stopReason).toBe("dead_end");
    // The repeat is detected before the second, identical action executes.
    expect(surface.actedOn).toHaveLength(1);
    expect(outcome.steps).toHaveLength(1);
  });

  it("skips a decision that references a control outside the observed list, without crashing", async () => {
    const planner = new ScriptedPlanner([
      { action: "click", index: 99, intent: "click something that does not exist" },
      { action: "finish", intent: "done", outputs: { ok: "true" } },
    ]);
    const { outcome, surface } = await run(planner);
    expect(outcome.stopReason).toBe("goal_met");
    expect(surface.actedOn).toHaveLength(0);
    expect(outcome.steps).toHaveLength(0);
  });
});

describe("policy enforcement inside discovery", () => {
  it("blocks a navigate to a denied route and never touches the surface", async () => {
    const planner = new ScriptedPlanner([
      { action: "navigate", url: "http://127.0.0.1:9999/servicing/acct/1/delete", intent: "go delete it" },
    ]);
    const { outcome, surface } = await run(planner);

    expect(outcome.stopReason).toBe("policy_blocked");
    expect(surface.actedOn).toHaveLength(0);
    expect(outcome.steps).toHaveLength(0);
  });

  it("blocks an origin outside the allowlist", async () => {
    const planner = new ScriptedPlanner([
      { action: "navigate", url: "http://evil.example.com/servicing/mbr.asp", intent: "leave the app" },
    ]);
    const { outcome, surface } = await run(planner);
    expect(outcome.stopReason).toBe("policy_blocked");
    expect(surface.actedOn).toHaveLength(0);
  });
});

describe("redaction inside discovery", () => {
  function makeSnapshotWithPassword(): UISnapshot {
    return {
      snapshotId: "s",
      takenAt: "t",
      kind: "web",
      location: LOCATION,
      title: "Sign On",
      nodes: [node({ role: "button", name: "Sign On" }), node({ role: "textbox", label: "Password" })],
      digest: "d",
    };
  }

  function makePolicyWithFieldRedaction(): Policy {
    const raw: RawPolicyConfig = {
      allowlist: {
        origins: ["http://127.0.0.1:9999"],
        routes: ["/**"],
        denyRoutes: [],
        actions: ["click", "fill", "select", "press", "navigate", "wait"],
      },
      risk: { default: "safe", rules: [] },
      unattended: { requiresApproval: "approved", maxTier: "elevated", onIrreversible: "escalate" },
      redaction: { patterns: [], fieldNames: ["password"], placeholder: "[redacted:{name}]" },
    };
    return loadPolicy(raw);
  }

  it("sends the real value to the surface but never records it, for a field the policy names as sensitive", async () => {
    const planner = new ScriptedPlanner([
      { action: "fill", index: 1, text: "hunter2", intent: "enter the password" },
      { action: "finish", intent: "done", outputs: {} },
    ]);
    const surface = new FakeSurface(makeSnapshotWithPassword());
    const trace = new TraceWriter(runDir);
    const outcome = await runDiscovery(GOAL, {
      runId: "r-redact",
      surface,
      planner,
      policy: makePolicyWithFieldRedaction(),
      costGovernor: new CostGovernor(0),
      trace,
    });

    // The live surface still has to receive the real value to work at all.
    expect(surface.actedOn).toHaveLength(1);
    expect(surface.actedOn[0]).toMatchObject({ kind: "fill", text: "hunter2" });

    // Nothing that gets persisted ever sees it.
    expect(outcome.steps).toHaveLength(1);
    const stored = outcome.steps[0]!;
    expect(stored.sensitive).toBe(true);
    expect(stored.action).toMatchObject({ kind: "fill", text: "[redacted:field]" });

    const traceContents = await readFile(join(runDir, "trace.jsonl"), "utf8");
    expect(traceContents).not.toContain("hunter2");
    expect(traceContents).toContain("[redacted:field]");

    const summaryContents = await readFile(join(runDir, "summary.json"), "utf8");
    expect(summaryContents).not.toContain("hunter2");
  });

  it("leaves an ordinary field's value untouched, both live and recorded", async () => {
    const planner = new ScriptedPlanner([{ action: "fill", index: 1, text: "100234", intent: "enter the member number" }]);
    const { outcome, surface } = await run(planner, {}, makePolicy());
    expect(surface.actedOn[0]).toMatchObject({ kind: "fill", text: "100234" });
    expect(outcome.steps[0]!.sensitive).toBe(false);
    expect(outcome.steps[0]!.action).toMatchObject({ kind: "fill", text: "100234" });
  });
});

describe("the cost governor inside discovery", () => {
  it("stops at cost_ceiling before the first paid exchange is allowed to run away", async () => {
    // ollama and google both cost nothing in this codebase, so exercising the
    // ceiling needs a provider the pricing table actually charges for.
    const planner = new ScriptedPlanner(
      [{ action: "click", index: 0, intent: "click" }],
      "anthropic",
      "claude-sonnet-5",
      { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    );
    const { outcome, surface } = await run(planner);
    expect(outcome.stopReason).toBe("cost_ceiling");
    expect(surface.actedOn).toHaveLength(0);
  });
});
