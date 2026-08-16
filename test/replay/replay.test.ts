import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Capability, OutcomeSpec, SemanticDescriptor, Step } from "../../src/artifact/schema.js";
import { loadPolicy, type Policy, type RawPolicyConfig } from "../../src/discovery/policy.js";
import { readIntervention } from "../../src/replay/intervention.js";
import { ReplayError, replayCapability, resumeCapability } from "../../src/replay/replay.js";
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
  value?: string;
  ordinal?: number;
  visible?: boolean;
}): UINode {
  return {
    ref: nodeRef(`n${counter++}`),
    role: spec.role,
    name: spec.name ?? "",
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    ...(spec.value !== undefined ? { value: spec.value } : {}),
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
  redactionFieldNames: readonly string[] = [],
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
    redaction: { patterns: [], fieldNames: redactionFieldNames, placeholder: "[redacted:{name}]" },
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

describe("surface failure", () => {
  it("fails with SURFACE_ERROR when the action call throws - a detached frame, a dead session, a gone process", async () => {
    const surface = new ScriptedSurface(() => snap([node({ role: "button", name: "Search" })]));
    surface.act = async () => {
      throw new Error("frame was detached");
    };
    const result = await replayCapability(makeCapability(), {}, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("SURFACE_ERROR");
      expect(result.failure.message).toContain("frame was detached");
    }
  });
});

describe("step timeout", () => {
  it("fails with STEP_TIMEOUT when the action call itself never returns, distinct from a checkpoint that never holds", async () => {
    const surface = new ScriptedSurface(() => snap([node({ role: "button", name: "Search" })]));
    // Never resolves and never rejects - the one shape CHECKPOINT_FAILED
    // and SURFACE_ERROR cannot cover, since both require act() to have
    // already returned (successfully or by throwing).
    surface.act = () => new Promise<void>(() => {});
    const capability = makeCapability({ steps: [makeStep({ timeoutMs: 20 })] });
    const result = await replayCapability(capability, {}, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("STEP_TIMEOUT");
      expect(result.failure.message).toContain("20ms");
    }
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
    // Phase 7: this is a real, resumable handoff, not a dead end - see
    // "resuming after handoff" below for resumeCapability actually
    // continuing from here.
    if (result.status === "escalated") {
      expect(result.resumable).toBe(true);
      const intervention = await readIntervention(runDir);
      expect(intervention.resumeAt).toBe(1); // the step *after* the blocked one
      expect(intervention.precondition).toEqual({ detect: { kind: "node_present", descriptor: resultText }, expect: "matched" });
      expect(intervention.lease.owner).toBe("human");
    }
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

describe("redaction inside replay", () => {
  it("sends the real value to the surface but never traces it, for a sensitive parameter", async () => {
    const passwordField = descriptor({ role: "textbox", label: { kind: "normalized", value: "Password" } });
    const before = snap([node({ role: "textbox", label: "Password" })]);
    const after = snap([node({ role: "text", name: "Result" })]);
    const surface = new ScriptedSurface((n) => (n === 0 ? before : after));
    const capability = makeCapability({
      inputs: [{ name: "password", type: "string", description: "d", required: true, sensitive: true }],
      steps: [
        makeStep({
          action: { kind: "fill", target: passwordField, value: { kind: "param", name: "password" } },
          checkpoint: { kind: "node_present", descriptor: resultText },
        }),
      ],
    });

    const result = await replayCapability(capability, { password: "hunter2" }, { ...deps(makePolicy()), surface });
    expect(result.status).toBe("success");

    // The live surface still has to receive the real secret to work at all.
    expect(surface.acted).toHaveLength(1);
    const acted = surface.acted[0]!;
    expect(acted.kind).toBe("fill");
    if (acted.kind === "fill") expect(acted.text).toBe("hunter2");

    const traceContents = await readFile(join(runDir, "trace.jsonl"), "utf8");
    expect(traceContents).not.toContain("hunter2");
    expect(traceContents).toContain("[redacted:field]");
  });

  it("redacts a sensitive field's live value out of failure evidence", async () => {
    const surface = new ScriptedSurface(() =>
      snap([node({ role: "button", name: "Cancel" }), node({ role: "textbox", label: "Password", value: "hunter2" })]),
    );
    const policy = makePolicy(undefined, undefined, undefined, ["password"]);
    const result = await replayCapability(makeCapability(), {}, { ...deps(policy), surface });
    expect(result.status).toBe("failed");

    const snapshotContents = await readFile(join(runDir, "failure", "snapshot.json"), "utf8");
    expect(snapshotContents).not.toContain("hunter2");
    expect(snapshotContents).toContain("[redacted:field]");
  });
});

describe("resuming after handoff", () => {
  it("continues at the step after an irreversible one, once a human's own action leaves the expected checkpoint behind", async () => {
    // Step 0 is the irreversible one a human must perform themselves; step 1
    // is what should execute *after* resume - proving this is a genuine
    // continuation of the same run, not just a re-finalisation of step 0.
    const continueButton = descriptor({ role: "button", name: { kind: "normalized", value: "Continue" } });
    const doneText = descriptor({ role: "text", name: { kind: "normalized", value: "Done" } });
    const capability = makeCapability({
      steps: [
        makeStep({ index: 0, action: { kind: "click", target: searchButton }, checkpoint: { kind: "node_present", descriptor: resultText } }),
        makeStep({ index: 1, intent: "click Continue", action: { kind: "click", target: continueButton }, checkpoint: { kind: "node_present", descriptor: doneText } }),
      ],
    });
    const policy = makePolicy(
      { onIrreversible: "escalate" },
      { default: "safe", rules: [{ match: { nameMatches: "search" }, tier: "irreversible" }] },
    );

    let snapshotProvider = () => snap([node({ role: "button", name: "Search" })]);
    const surface = new ScriptedSurface(() => snapshotProvider());

    const stopped = await replayCapability(capability, {}, { ...deps(policy, false), surface });
    expect(stopped.status).toBe("escalated");
    if (stopped.status !== "escalated") return;

    const intervention = await readIntervention(runDir);
    expect(intervention.resumeAt).toBe(1);
    expect(intervention.lease).toEqual({ runId: "test", capabilityId: capability.id, owner: "human", token: 1 });

    // "A human" performed the search live; the result screen and the next
    // control are now up. Only *this* click (step 1's) should ever reach
    // the surface - step 0 was never automation's to retry.
    let phase: "afterSearch" | "afterContinue" = "afterSearch";
    snapshotProvider = () =>
      phase === "afterSearch" ? snap([node({ role: "text", name: "Result" }), node({ role: "button", name: "Continue" })]) : snap([node({ role: "text", name: "Done" })]);
    const originalAct = surface.act.bind(surface);
    surface.act = async (action) => {
      if (action.kind === "click") phase = "afterContinue";
      await originalAct(action);
    };

    const resumed = await resumeCapability(intervention, capability, {}, { ...deps(policy, false), surface });
    expect(resumed.status).toBe("success");
    expect(surface.acted).toHaveLength(1);
    expect(surface.acted[0]!.kind).toBe("click");
  });

  it("retries the same step, not the next one, after a reauthenticate handoff clears", async () => {
    const loginPrompt = descriptor({ role: "dialog", name: { kind: "normalized", value: "Session Expired" } });
    const expired: OutcomeSpec = {
      name: "session_expired",
      class: "recoverable",
      description: "the session timed out",
      detect: { kind: "node_present", descriptor: loginPrompt },
      remedy: { kind: "reauthenticate" },
    };
    let phase: "expired" | "search" | "result" = "expired";
    const surface = new ScriptedSurface(() => {
      if (phase === "expired") return snap([node({ role: "dialog", name: "Session Expired" })]);
      if (phase === "search") return snap([node({ role: "button", name: "Search" })]);
      return snap([node({ role: "text", name: "Result" })]);
    });
    const originalAct = surface.act.bind(surface);
    surface.act = async (action) => {
      if (action.kind === "click" && phase === "search") phase = "result";
      await originalAct(action);
    };

    const capability = makeCapability({ outcomes: [expired] });
    const stopped = await replayCapability(capability, {}, { ...deps(makePolicy()), surface });
    expect(stopped.status).toBe("escalated");
    if (stopped.status !== "escalated") return;

    const intervention = await readIntervention(runDir);
    expect(intervention.resumeAt).toBe(0);
    expect(intervention.precondition).toEqual({ detect: expired.detect, expect: "cleared" });

    phase = "search"; // "the human" logged back in; the search screen is up again
    const resumed = await resumeCapability(intervention, capability, {}, { ...deps(makePolicy()), surface });
    expect(resumed.status).toBe("success");
  });

  it("refuses a second resume against an already-consumed intervention, rather than silently re-executing its step", async () => {
    const loginPrompt = descriptor({ role: "dialog", name: { kind: "normalized", value: "Session Expired" } });
    const expired: OutcomeSpec = {
      name: "session_expired",
      class: "recoverable",
      description: "the session timed out",
      detect: { kind: "node_present", descriptor: loginPrompt },
      remedy: { kind: "reauthenticate" },
    };
    let phase: "expired" | "search" = "expired";
    // Unlike the test above, the Search button never leaves the screen once
    // the human has logged back in - realistic, since a persistent
    // toolbar/nav control staying visible across a state change is exactly
    // how this project's own target app behaves. Nothing here ever
    // transitions the screen away from "search", so a stale second resume
    // has no incidental self-protection to rely on - only the guard itself
    // is what stops it.
    const surface = new ScriptedSurface(() =>
      phase === "expired"
        ? snap([node({ role: "dialog", name: "Session Expired" })])
        : snap([node({ role: "button", name: "Search" }), node({ role: "text", name: "Result" })]),
    );

    const capability = makeCapability({ outcomes: [expired] });
    const stopped = await replayCapability(capability, {}, { ...deps(makePolicy()), surface });
    expect(stopped.status).toBe("escalated");
    if (stopped.status !== "escalated") return;

    const intervention = await readIntervention(runDir);
    phase = "search"; // "the human" logged back in

    const firstResume = await resumeCapability(intervention, capability, {}, { ...deps(makePolicy()), surface });
    expect(firstResume.status).toBe("success");
    expect(surface.acted).toHaveLength(1);

    // A retry wrapper, a crash-and-restart from the persisted
    // intervention.json, or a second concurrent caller could all pass this
    // exact same, now-stale intervention object a second time.
    const secondResume = await resumeCapability(intervention, capability, {}, { ...deps(makePolicy()), surface });
    expect(secondResume.status).toBe("failed");
    if (secondResume.status === "failed") {
      expect(secondResume.failure.code).toBe("INTERVENTION_CONSUMED");
      expect(secondResume.failure.message).toContain(intervention.interventionId);
    }
    // The step must not have been re-executed a second time.
    expect(surface.acted).toHaveLength(1);

    // Any caller that reads intervention.json fresh, rather than reusing
    // the in-memory object, sees the same thing.
    const onDisk = await readIntervention(runDir);
    expect(onDisk.status).toBe("resolved");
  });

  it("refuses to continue when the precondition still does not hold, rather than trusting that the human is finished", async () => {
    const policy = makePolicy(
      { onIrreversible: "escalate" },
      { default: "safe", rules: [{ match: { nameMatches: "search" }, tier: "irreversible" }] },
    );
    // Nothing about the screen ever changes - the human hasn't actually done it.
    const surface = new ScriptedSurface(() => snap([node({ role: "button", name: "Search" })]));

    const stopped = await replayCapability(makeCapability(), {}, { ...deps(policy, false), surface });
    expect(stopped.status).toBe("escalated");
    if (stopped.status !== "escalated") return;
    const intervention = await readIntervention(runDir);

    const resumed = await resumeCapability(intervention, makeCapability(), {}, { ...deps(policy, false), surface });
    expect(resumed.status).toBe("failed");
    if (resumed.status === "failed") {
      expect(resumed.failure.code).toBe("CHECKPOINT_FAILED");
      expect(resumed.failure.message).toContain(intervention.interventionId);
    }
    // Nothing was retried on the human's unverified word.
    expect(surface.acted).toHaveLength(0);
  });
});
