import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Capability, OutcomeSpec, SemanticDescriptor, Step } from "../../src/artifact/schema.js";
import { loadPolicy, type Policy, type RawPolicyConfig } from "../../src/discovery/policy.js";
import { ReplayError, replayCapability } from "../../src/replay/replay.js";
import { ReplayTraceWriter } from "../../src/replay/trace.js";
import { nodeRef, type Action, type CapturedEvidence, type Surface, type UINode, type UISnapshot } from "../../src/surface/types.js";

/**
 * The interpreter against a scriptable fake surface, not a browser - every
 * arm of ReplayResult and every FailureCode gets one test, exercised
 * deterministically. The browser-backed path is proven separately in
 * test/replay/replay-web.test.ts against the real target app and the real
 * compiled Phase 4 artifact.
 */

const LOCATION = "http://127.0.0.1:9999/servicing/mbr.asp";

let counter = 0;
function node(spec: {
  role: UINode["role"];
  name?: string;
  label?: string;
  ordinal?: number;
  visible?: boolean;
}): UINode {
  return {
    ref: nodeRef(`n${counter++}`),
    role: spec.role,
    name: spec.name ?? "",
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    state: { disabled: false, readonly: false, required: false, focused: false },
    frame: [],
    ancestry: [],
    ordinal: spec.ordinal ?? 0,
    visible: spec.visible ?? true,
  };
}

function snap(nodes: UINode[], location = LOCATION): UISnapshot {
  return { snapshotId: "s", takenAt: "t", kind: "web", location, title: "t", nodes, digest: "d" };
}

function descriptor(spec: Partial<SemanticDescriptor> & { role: SemanticDescriptor["role"] }): SemanticDescriptor {
  return spec as SemanticDescriptor;
}

/** A surface driven by a function from "how many actions have landed so far"
 *  to the snapshot observation should return - flexible enough to script a
 *  screen that changes after an action, without a real browser. */
class ScriptedSurface implements Surface {
  readonly kind = "web" as const;
  readonly acted: Action[] = [];
  private actionCount = 0;

  constructor(private readonly snapshotAt: (actionCount: number) => UISnapshot) {}

  async observe(): Promise<UISnapshot> {
    return this.snapshotAt(this.actionCount);
  }
  async act(action: Action): Promise<void> {
    this.acted.push(action);
    this.actionCount++;
  }
  async capture(): Promise<CapturedEvidence> {
    return { kind: "screenshot", mediaType: "image/png", bytes: new Uint8Array() };
  }
  async close(): Promise<void> {}
}

function makePolicy(
  overrides: Partial<RawPolicyConfig["unattended"]> = {},
  risk: RawPolicyConfig["risk"] = { default: "safe", rules: [] },
  allowlist: Partial<RawPolicyConfig["allowlist"]> = {},
): Policy {
  const raw: RawPolicyConfig = {
    allowlist: {
      origins: ["http://127.0.0.1:9999"],
      routes: ["/**"],
      denyRoutes: ["/servicing/**/delete"],
      actions: ["click", "fill", "select", "press", "navigate", "wait"],
      ...allowlist,
    },
    risk,
    unattended: { requiresApproval: "approved", maxTier: "elevated", onIrreversible: "escalate", ...overrides },
    redaction: { patterns: [], fieldNames: [], placeholder: "[redacted:{name}]" },
  };
  return loadPolicy(raw);
}

const searchButton = descriptor({ role: "button", name: { kind: "normalized", value: "Search" } });
const resultText = descriptor({ role: "text", name: { kind: "normalized", value: "Result" } });

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    index: 0,
    intent: "click Search",
    action: { kind: "click", target: searchButton },
    checkpoint: { kind: "node_present", descriptor: resultText },
    risk: "safe",
    timeoutMs: 200,
    ...overrides,
  };
}

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    schemaVersion: "1.0",
    id: "app.search",
    name: "Search",
    description: "search",
    version: 1,
    contentHash: "0123456789abcdef",
    approval: "approved",
    target: { app: "app", tenant: "t", surface: "web", entryPoint: LOCATION },
    inputs: [],
    outputs: [],
    steps: [makeStep()],
    outcomes: [],
    provenance: { discoveryRunId: "r", recordedAt: "2026-08-15T00:00:00.000Z", planner: { provider: "ollama", model: "m" }, prunedSteps: 0, humanEdited: false },
    ...overrides,
  };
}

let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "understudy-replay-test-"));
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

function deps(policy: Policy, attended = true) {
  return { runId: "test", surface: undefined as unknown as Surface, policy, trace: new ReplayTraceWriter(runDir), attended, pollIntervalMs: 5 };
}

describe("the happy path", () => {
  it("resolves each step's target, acts, verifies the checkpoint, and extracts outputs", async () => {
    const before = snap([node({ role: "button", name: "Search" })]);
    const after = snap([node({ role: "text", name: "Result" })]);
    const surface = new ScriptedSurface((n) => (n === 0 ? before : after));

    const capability = makeCapability({
      outputs: [{ name: "answer", type: "string", description: "d", extract: { descriptor: resultText, from: "text" } }],
    });
    const result = await replayCapability(capability, {}, { ...deps(makePolicy()), surface });

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.outputs).toEqual({ answer: "Result" });
      expect(result.stepsAttempted).toBe(1);
      expect(result.recoveries).toEqual([]);
    }
    expect(surface.acted).toHaveLength(1);
    expect(surface.acted[0]!.kind).toBe("click");
  });

  it("substitutes a param value into a fill action from the caller's inputs", async () => {
    const field = descriptor({ role: "textbox", label: { kind: "normalized", value: "Member Number" } });
    const before = snap([node({ role: "textbox", label: "Member Number" })]);
    const surface = new ScriptedSurface(() => before);
    const capability = makeCapability({
      inputs: [{ name: "member_number", type: "string", description: "d", required: true }],
      steps: [makeStep({ action: { kind: "fill", target: field, value: { kind: "param", name: "member_number" } }, checkpoint: undefined })],
    });

    await replayCapability(capability, { member_number: "100234" }, { ...deps(makePolicy()), surface });
    expect(surface.acted).toHaveLength(1);
    const acted = surface.acted[0]!;
    expect(acted.kind).toBe("fill");
    if (acted.kind === "fill") expect(acted.text).toBe("100234");
  });
});

describe("target resolution failures", () => {
  it("fails with TARGET_ABSENT when nothing on screen matches the step's target", async () => {
    const surface = new ScriptedSurface(() => snap([node({ role: "button", name: "Cancel" })]));
    const result = await replayCapability(makeCapability(), {}, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("TARGET_ABSENT");
  });

  it("fails with AMBIGUOUS_TARGET rather than guessing between two equally strong candidates", async () => {
    const surface = new ScriptedSurface(() =>
      snap([node({ role: "button", name: "Search", ordinal: 0 }), node({ role: "button", name: "Search", ordinal: 1 })]),
    );
    const result = await replayCapability(makeCapability(), {}, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("AMBIGUOUS_TARGET");
  });
});

describe("checkpoint verification", () => {
  it("fails with CHECKPOINT_FAILED when the expected result never appears within the step's budget", async () => {
    const still = snap([node({ role: "button", name: "Search" })]);
    const surface = new ScriptedSurface(() => still);
    const result = await replayCapability(makeCapability(), {}, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("CHECKPOINT_FAILED");
  });
});

describe("policy enforcement", () => {
  it("fails with POLICY_BLOCKED for a route outside the allowlist, attended or not", async () => {
    const before = snap([node({ role: "button", name: "Search" })], "http://127.0.0.1:9999/admin/danger");
    const surface = new ScriptedSurface(() => before);
    const policy = makePolicy(undefined, { default: "safe", rules: [] }, { routes: ["/servicing/**"] });
    const capability = makeCapability({ target: { app: "app", tenant: "t", surface: "web", entryPoint: "http://127.0.0.1:9999/admin/danger" } });
    const result = await replayCapability(capability, {}, { ...deps(policy), surface });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("POLICY_BLOCKED");
  });
});

describe("unattended-mode gates", () => {
  it("refuses before running at all when the capability is not approved", async () => {
    const surface = new ScriptedSurface(() => snap([]));
    const capability = makeCapability({ approval: "draft" });
    await expect(replayCapability(capability, {}, { ...deps(makePolicy(), false), surface })).rejects.toThrow(ReplayError);
  });

  it("runs a draft capability fine when attended", async () => {
    const before = snap([node({ role: "button", name: "Search" })]);
    const after = snap([node({ role: "text", name: "Result" })]);
    const surface = new ScriptedSurface((n) => (n === 0 ? before : after));
    const capability = makeCapability({ approval: "draft" });
    const result = await replayCapability(capability, {}, { ...deps(makePolicy(), true), surface });
    expect(result.status).toBe("success");
  });

  it("always refuses a retired capability, attended or not", async () => {
    const surface = new ScriptedSurface(() => snap([]));
    const capability = makeCapability({ approval: "retired" });
    await expect(replayCapability(capability, {}, { ...deps(makePolicy(), true), surface })).rejects.toThrow(/retired/);
  });

  it("escalates an irreversible step rather than running it unattended, when policy says escalate", async () => {
    const before = snap([node({ role: "button", name: "Search" })]);
    const surface = new ScriptedSurface(() => before);
    const policy = makePolicy(
      { onIrreversible: "escalate" },
      { default: "safe", rules: [{ match: { nameMatches: "search" }, tier: "irreversible" }] },
    );
    const result = await replayCapability(makeCapability(), {}, { ...deps(policy, false), surface });
    expect(result.status).toBe("escalated");
    if (result.status === "escalated") expect(result.resumable).toBe(false);
  });

  it("fails closed on an irreversible step when policy says block instead of escalate", async () => {
    const before = snap([node({ role: "button", name: "Search" })]);
    const surface = new ScriptedSurface(() => before);
    const policy = makePolicy(
      { onIrreversible: "block" },
      { default: "safe", rules: [{ match: { nameMatches: "search" }, tier: "irreversible" }] },
    );
    const result = await replayCapability(makeCapability(), {}, { ...deps(policy, false), surface });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("POLICY_BLOCKED");
  });

  it("blocks a step whose risk tier exceeds the unattended ceiling, without escalating", async () => {
    const before = snap([node({ role: "button", name: "Search" })]);
    const surface = new ScriptedSurface(() => before);
    const policy = makePolicy(
      { maxTier: "safe" },
      { default: "safe", rules: [{ match: { nameMatches: "search" }, tier: "elevated" }] },
    );
    const result = await replayCapability(makeCapability(), {}, { ...deps(policy, false), surface });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("POLICY_BLOCKED");
  });
});

describe("declared outcomes", () => {
  const noSuchMember: OutcomeSpec = {
    name: "no_such_member",
    class: "business_outcome",
    description: "the member does not exist",
    detect: { kind: "node_present", descriptor: descriptor({ role: "text", name: { kind: "normalized", value: "No member found" } }) },
    data: [{ name: "message", type: "string", description: "d", extract: { descriptor: descriptor({ role: "text", name: { kind: "normalized", value: "No member found" } }), from: "text" } }],
  };

  it("returns a business_outcome instead of trying to run the rest of the script", async () => {
    const surface = new ScriptedSurface(() => snap([node({ role: "text", name: "No member found" })]));
    const capability = makeCapability({ outcomes: [noSuchMember] });
    const result = await replayCapability(capability, {}, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.outcome).toBe("no_such_member");
      expect(result.data).toEqual({ message: "No member found" });
    }
    expect(surface.acted).toEqual([]);
  });

  const systemDown: OutcomeSpec = {
    name: "system_down",
    class: "hard_failure",
    description: "the core system is unavailable",
    detect: { kind: "text_matches", descriptor: descriptor({ role: "text", ordinal: 0 }), pattern: "system unavailable" },
  };

  it("returns a failure with OUTCOME_HARD_FAILURE for a declared hard_failure outcome", async () => {
    const surface = new ScriptedSurface(() => snap([node({ role: "text", name: "System unavailable, try later", ordinal: 0 })]));
    const capability = makeCapability({ outcomes: [systemDown] });
    const result = await replayCapability(capability, {}, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("OUTCOME_HARD_FAILURE");
  });

  it("recovers from a recoverable outcome via wait_retry and then continues the script", async () => {
    const banner = descriptor({ role: "alert", name: { kind: "normalized", value: "Please wait" } });
    const sessionSlow: OutcomeSpec = {
      name: "slow_session",
      class: "recoverable",
      description: "the session is momentarily busy",
      detect: { kind: "node_present", descriptor: banner },
      remedy: { kind: "wait_retry", attempts: 3, backoffMs: 1 },
    };
    let observations = 0;
    const surface = new ScriptedSurface(() => {
      observations++;
      // Present for the first two observations, gone from the third onward -
      // simulates the banner clearing on its own after two retries.
      if (observations <= 2) return snap([node({ role: "alert", name: "Please wait" })]);
      if (observations === 3) return snap([node({ role: "button", name: "Search" })]);
      return snap([node({ role: "text", name: "Result" })]);
    });
    const capability = makeCapability({ outcomes: [sessionSlow] });
    const result = await replayCapability(capability, {}, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.recoveries).toHaveLength(1);
      expect(result.recoveries[0]).toMatchObject({ outcome: "slow_session", succeeded: true });
    }
  });

  it("fails with RECOVERY_EXHAUSTED when a recoverable outcome never clears", async () => {
    const banner = descriptor({ role: "alert", name: { kind: "normalized", value: "Please wait" } });
    const stuck: OutcomeSpec = {
      name: "slow_session",
      class: "recoverable",
      description: "the session is momentarily busy",
      detect: { kind: "node_present", descriptor: banner },
      remedy: { kind: "wait_retry", attempts: 2, backoffMs: 1 },
    };
    const surface = new ScriptedSurface(() => snap([node({ role: "alert", name: "Please wait" })]));
    const capability = makeCapability({ outcomes: [stuck] });
    const result = await replayCapability(capability, {}, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("RECOVERY_EXHAUSTED");
      expect(result.recoveries[0]).toMatchObject({ succeeded: false, attempts: 2 });
    }
  });

  it("dismisses a recoverable outcome by clicking its declared descriptor", async () => {
    const dialog = descriptor({ role: "dialog", name: { kind: "normalized", value: "Tip of the Day" } });
    const dismissButton = descriptor({ role: "button", name: { kind: "normalized", value: "OK" } });
    const tip: OutcomeSpec = {
      name: "tip_dialog",
      class: "recoverable",
      description: "a dismissable tip dialog appears",
      detect: { kind: "node_present", descriptor: dialog },
      remedy: { kind: "dismiss", descriptor: dismissButton },
    };
    // Three real phases, not two: dismissing the dialog reveals the Search
    // button the step actually targets, and only clicking *that* reaches the
    // result screen - collapsing "dismissed" straight to "result" would mean
    // the step's own click never had a real target to resolve against.
    let phase: "dialog" | "search" | "result" = "dialog";
    const surface = new ScriptedSurface(() => {
      if (phase === "dialog") return snap([node({ role: "dialog", name: "Tip of the Day" }), node({ role: "button", name: "OK" })]);
      if (phase === "search") return snap([node({ role: "button", name: "Search" })]);
      return snap([node({ role: "text", name: "Result" })]);
    });
    const originalAct = surface.act.bind(surface);
    surface.act = async (action: Action) => {
      if (action.kind === "click" && phase === "dialog") phase = "search";
      else if (action.kind === "click" && phase === "search") phase = "result";
      await originalAct(action);
    };
    const capability = makeCapability({ outcomes: [tip] });
    const result = await replayCapability(capability, {}, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("success");
  });

  it("escalates immediately on a reauthenticate remedy, since no human is available to perform it", async () => {
    const loginPrompt = descriptor({ role: "dialog", name: { kind: "normalized", value: "Session Expired" } });
    const expired: OutcomeSpec = {
      name: "session_expired",
      class: "recoverable",
      description: "the session timed out",
      detect: { kind: "node_present", descriptor: loginPrompt },
      remedy: { kind: "reauthenticate" },
    };
    const surface = new ScriptedSurface(() => snap([node({ role: "dialog", name: "Session Expired" })]));
    const capability = makeCapability({ outcomes: [expired] });
    const result = await replayCapability(capability, {}, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("escalated");
  });
});

describe("output re-extraction at the end of a run", () => {
  it("fails with UNRECOGNISED_STATE when a declared output can no longer be found on the final screen", async () => {
    const before = snap([node({ role: "button", name: "Search" })]);
    const after = snap([node({ role: "text", name: "Result" })]);
    const surface = new ScriptedSurface((n) => (n === 0 ? before : after));
    const capability = makeCapability({
      outputs: [{ name: "missing", type: "string", description: "d", extract: { descriptor: descriptor({ role: "text", name: { kind: "normalized", value: "Nowhere" } }), from: "text" } }],
    });
    const result = await replayCapability(capability, {}, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.failure.code).toBe("UNRECOGNISED_STATE");
  });
});

describe("input validation", () => {
  it("refuses before running when a required input is missing", async () => {
    const surface = new ScriptedSurface(() => snap([]));
    const capability = makeCapability({ inputs: [{ name: "member_number", type: "string", description: "d", required: true }] });
    await expect(replayCapability(capability, {}, { ...deps(makePolicy()), surface })).rejects.toThrow(/missing required input/);
  });
});
