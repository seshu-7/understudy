import { describe, expect, it } from "vitest";
import { CompileError, compileCapability } from "../../src/artifact/compile.js";
import { CapabilitySchema } from "../../src/artifact/schema.js";
import type { DiscoveredStep, DiscoveryOutcome } from "../../src/discovery/types.js";
import { nodeRef, type SemanticDescriptor } from "../../src/surface/types.js";

/**
 * The fixture below is not invented - it mirrors the real five-step run in
 * evidence/discovery-1786833847548/ (sign on, fill operator id, sign on,
 * fill member number, search), including the one detail that makes the
 * parameterisation heuristic worth testing at all: "demo" (the operator id)
 * does not appear in the goal text and must stay a literal, while "100234"
 * does and must become a parameter - and the *same* parameter, not two
 * different ones, when the compiler sees it used more than once.
 */

const GOAL_TEXT = "look up member 100234 and read their current savings balance";

function descriptor(spec: Partial<SemanticDescriptor> & { role: SemanticDescriptor["role"] }): SemanticDescriptor {
  return spec as SemanticDescriptor;
}

const signOnButton = descriptor({ role: "button", name: { kind: "normalized", value: "Sign On" } });
const operatorField = descriptor({ role: "textbox", label: { kind: "normalized", value: "Operator ID" } });
const memberField = descriptor({
  role: "textbox",
  label: { kind: "normalized", value: "Member Number" },
  frame: ["mainfrm"],
});
const searchButton = descriptor({
  role: "button",
  name: { kind: "normalized", value: "Search" },
  frame: ["mainfrm"],
});
const balanceText = descriptor({
  role: "text",
  name: { kind: "normalized", value: "4,182.55" },
  within: { role: "table", name: { kind: "normalized", value: "Accounts" } },
  frame: ["mainfrm"],
  ordinal: 6,
});

function step(index: number, intent: string, action: DiscoveredStep["action"], desc: SemanticDescriptor | null): DiscoveredStep {
  return { index, intent, action, descriptor: desc, confirmed: false };
}

/** Test-only narrowing helper - a "pattern" TextMatch carries `source`, not
 *  `value`; the fixtures above never use that variant, so this just saves
 *  every assertion from having to prove it to the type checker itself. */
function labelValue(descriptor: SemanticDescriptor): string | undefined {
  const label = descriptor.label;
  return label && label.kind !== "pattern" ? label.value : undefined;
}

function successfulOutcome(overrides: Partial<DiscoveryOutcome> = {}): DiscoveryOutcome {
  return {
    goalId: "goal-1",
    goal: {
      goalId: "goal-1",
      text: GOAL_TEXT,
      target: { entryPoint: "http://127.0.0.1:4501/servicing/login.asp", tenant: "meridian", app: "corevantage-servicing" },
    },
    runId: "1786833847548",
    startedAt: "2026-08-15T22:44:09.252Z",
    finishedAt: "2026-08-15T22:49:53.380Z",
    stopReason: "goal_met",
    steps: [
      step(0, "click the Sign On button", { kind: "click", target: nodeRef("#7") }, signOnButton),
      step(1, "enter the operator ID", { kind: "fill", target: nodeRef("#6"), text: "demo" }, operatorField),
      step(2, "click Sign On again", { kind: "click", target: nodeRef("#8") }, signOnButton),
      step(3, "enter the member number", { kind: "fill", target: nodeRef("mainfrm#6"), text: "100234" }, memberField),
      step(4, "click Search", { kind: "click", target: nodeRef("mainfrm#7") }, searchButton),
    ],
    extractedOutputs: { savings_balance: "4,182.55" },
    outputGroundings: [{ name: "savings_balance", value: "4,182.55", descriptor: balanceText }],
    tokenUsage: { promptTokens: 5687, completionTokens: 245, estimatedUsd: 0 },
    provider: { name: "ollama", model: "qwen2.5:7b-instruct" },
    ...overrides,
  };
}

describe("compiling a genuine successful run", () => {
  const capability = compileCapability(successfulOutcome());

  it("produces something the schema itself accepts", () => {
    expect(() => CapabilitySchema.parse(capability)).not.toThrow();
  });

  it("parameterises the value that appears in the goal text", () => {
    const fillMember = capability.steps.find((s) => s.action.kind === "fill" && labelValue(s.action.target) === "Member Number");
    expect(fillMember).toBeDefined();
    const value = fillMember!.action.kind === "fill" ? fillMember!.action.value : undefined;
    expect(value).toEqual({ kind: "param", name: "member_number" });
    expect(capability.inputs.some((p) => p.name === "member_number" && p.example === "100234")).toBe(true);
  });

  it("leaves the value that does not appear in the goal text as a literal", () => {
    const fillOperator = capability.steps.find((s) => s.action.kind === "fill" && labelValue(s.action.target) === "Operator ID");
    const value = fillOperator!.action.kind === "fill" ? fillOperator!.action.value : undefined;
    expect(value).toEqual({ kind: "literal", value: "demo" });
    expect(capability.inputs.some((p) => p.example === "demo")).toBe(false);
  });

  it("compiles the goal into a description with the parameter substituted in place", () => {
    expect(capability.description).toBe("look up member {member_number} and read their current savings balance");
    expect(capability.description).not.toContain("100234");
  });

  it("checkpoints each step against the next step's own target", () => {
    expect(capability.steps[0]!.checkpoint).toEqual({ kind: "node_present", descriptor: operatorField });
    expect(capability.steps[3]!.checkpoint).toEqual({ kind: "node_present", descriptor: searchButton });
  });

  // balanceText.name *is* the extracted value ("4,182.55"), so both the
  // output's own extract descriptor and the checkpoint built from it must
  // have that name stripped - otherwise replay for a different member would
  // search for a node literally named today's balance and never find it.
  const structuralBalance = { ...balanceText, name: undefined };

  it("checkpoints the last step against the grounded output, having no next step to borrow from", () => {
    expect(capability.steps[4]!.checkpoint).toEqual({ kind: "node_present", descriptor: structuralBalance });
  });

  it("strips the extracted value itself out of the output's own re-extraction descriptor", () => {
    expect(capability.outputs).toEqual([
      {
        name: "savings_balance",
        type: "string",
        description: "Read from the screen reached at the end of this capability.",
        extract: { descriptor: structuralBalance, from: "text" },
      },
    ]);
    expect(capability.outputs[0]!.extract.descriptor.within).toEqual(balanceText.within);
    expect(capability.outputs[0]!.extract.descriptor.ordinal).toBe(6);
  });

  it("carries provenance mapped from the discovery run, and starts life as draft", () => {
    expect(capability.provenance.discoveryRunId).toBe("1786833847548");
    expect(capability.provenance.planner).toEqual({ provider: "ollama", model: "qwen2.5:7b-instruct" });
    expect(capability.provenance.humanEdited).toBe(false);
    expect(capability.approval).toBe("draft");
  });
});

describe("parameter deduplication", () => {
  it("binds two steps using the identical literal value to the same parameter", () => {
    const outcome = successfulOutcome({
      steps: [
        step(0, "enter the member number", { kind: "fill", target: nodeRef("a"), text: "100234" }, memberField),
        step(1, "confirm the member number again", { kind: "fill", target: nodeRef("b"), text: "100234" }, memberField),
      ],
    });
    const capability = compileCapability(outcome);
    expect(capability.inputs).toHaveLength(1);
    const values = capability.steps.map((s) => (s.action.kind === "fill" ? s.action.value : null));
    expect(values[0]).toEqual(values[1]);
  });
});

describe("content hash stability", () => {
  it("is identical for two runs recorded independently but semantically the same", () => {
    const first = compileCapability(successfulOutcome());
    const second = compileCapability(
      successfulOutcome({ runId: "some-other-run-id", startedAt: "2099-01-01T00:00:00.000Z" }),
    );
    expect(second.contentHash).toBe(first.contentHash);
    // Provenance itself still differs, correctly - only the hash is blind to it.
    expect(second.provenance.discoveryRunId).not.toBe(first.provenance.discoveryRunId);
  });

  it("changes when a step's target genuinely differs", () => {
    const first = compileCapability(successfulOutcome());
    const changed = compileCapability(
      successfulOutcome({
        steps: successfulOutcome().steps.map((s) => (s.index === 4 ? { ...s, intent: "click a different button" } : s)),
      }),
    );
    // Intent text is part of the semantic content (it is what a reviewer
    // reads to understand the step), so changing it changes the hash.
    expect(changed.contentHash).not.toBe(first.contentHash);
  });
});

describe("refusing to compile what the evidence does not support", () => {
  it("refuses a run that did not reach goal_met", () => {
    expect(() => compileCapability(successfulOutcome({ stopReason: "dead_end" }))).toThrow(CompileError);
  });

  it("refuses a run with no steps at all", () => {
    expect(() => compileCapability(successfulOutcome({ steps: [] }))).toThrow(CompileError);
  });

  it("refuses when a claimed output could not be grounded to a real node", () => {
    const outcome = successfulOutcome({
      outputGroundings: [{ name: "savings_balance", value: "4,182.55", descriptor: null }],
    });
    expect(() => compileCapability(outcome)).toThrow(/could not be traced/);
  });

  it("refuses a click step with no descriptor - unreplayable outside its own session", () => {
    const outcome = successfulOutcome({
      steps: [step(0, "click something", { kind: "click", target: nodeRef("x") }, null)],
      outputGroundings: [],
      extractedOutputs: {},
    });
    expect(() => compileCapability(outcome)).toThrow(CompileError);
  });
});
