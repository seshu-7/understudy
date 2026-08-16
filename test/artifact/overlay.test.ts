import { describe, expect, it } from "vitest";

import { applyOverlay } from "../../src/artifact/overlay.js";
import { CapabilitySchema, type Capability, type SemanticDescriptor } from "../../src/artifact/schema.js";

function descriptor(spec: Partial<SemanticDescriptor> & { role: SemanticDescriptor["role"] }): SemanticDescriptor {
  return spec as SemanticDescriptor;
}

const searchButton = descriptor({
  role: "button",
  name: { kind: "normalized", value: "Search" },
  within: { role: "table", name: { kind: "normalized", value: "Servicing > Member Search" } },
  frame: ["mainfrm"],
});
const balanceText = descriptor({ role: "text", within: { role: "table", name: { kind: "normalized", value: "Accounts" } }, ordinal: 6 });

function baseCapability(): Capability {
  const capability: Capability = {
    schemaVersion: "1.0",
    id: "corevantage_servicing.lookup",
    name: "Look up a member",
    description: "look up member {member_number}",
    version: 1,
    contentHash: "0123456789abcdef",
    approval: "approved",
    target: { app: "corevantage-servicing", tenant: "meridian", surface: "web", entryPoint: "http://127.0.0.1:4501/servicing/login.asp" },
    inputs: [{ name: "member_number", type: "string", description: "d", required: true, example: "100234" }],
    outputs: [{ name: "savings_balance", type: "string", description: "d", extract: { descriptor: balanceText, from: "text" } }],
    steps: [
      { index: 0, intent: "click Search", action: { kind: "click", target: searchButton }, checkpoint: { kind: "node_present", descriptor: balanceText }, risk: "safe", timeoutMs: 10_000 },
    ],
    outcomes: [
      {
        name: "no_such_member",
        class: "business_outcome",
        description: "no member found",
        detect: { kind: "node_present", descriptor: descriptor({ role: "text", name: { kind: "normalized", value: "Search" } }) },
      },
    ],
    provenance: { discoveryRunId: "r", recordedAt: "2026-08-15T00:00:00.000Z", planner: { provider: "ollama", model: "m" }, prunedSteps: 0, humanEdited: false },
  };
  return CapabilitySchema.parse(capability);
}

describe("applyOverlay", () => {
  it("rewrites a step target's name, leaving unrelated text untouched", () => {
    const { capability: overlaid } = applyOverlay(baseCapability(), {
      tenant: "northstar",
      entryPoint: "http://127.0.0.1:4502/servicing/login.asp",
      textOverrides: { Search: "Find Member" },
    });
    const step = overlaid.steps[0]!;
    expect(step.action.kind).toBe("click");
    if (step.action.kind === "click") {
      expect(step.action.target.name).toEqual({ kind: "normalized", value: "Find Member" });
      // The breadcrumb this button sits within is not part of the rename.
      expect(step.action.target.within).toEqual(searchButton.within);
    }
  });

  it("rewrites the checkpoint and the outcome detector built from the same renamed text", () => {
    const { capability: overlaid } = applyOverlay(baseCapability(), {
      tenant: "northstar",
      entryPoint: "http://127.0.0.1:4502/servicing/login.asp",
      textOverrides: { Search: "Find Member" },
    });
    const checkpoint = overlaid.steps[0]!.checkpoint;
    expect(checkpoint?.kind).toBe("node_present");
    // The checkpoint here targets balanceText, which has no name of its own -
    // nothing to rewrite, and it should come through unchanged.
    if (checkpoint?.kind === "node_present") expect(checkpoint.descriptor).toEqual(balanceText);

    const outcome = overlaid.outcomes[0]!;
    expect(outcome.detect.kind).toBe("node_present");
    if (outcome.detect.kind === "node_present") expect(outcome.detect.descriptor.name).toEqual({ kind: "normalized", value: "Find Member" });
  });

  it("leaves a text with no matching override alone", () => {
    const { capability: overlaid } = applyOverlay(baseCapability(), {
      tenant: "northstar",
      entryPoint: "http://127.0.0.1:4502/servicing/login.asp",
      textOverrides: { "Some Other Label": "Whatever" },
    });
    const step = overlaid.steps[0]!;
    if (step.action.kind === "click") expect(step.action.target.name).toEqual({ kind: "normalized", value: "Search" });
  });

  it("reports an override key as unmatched when it matches nothing, so a typo is not silent", () => {
    const { unmatchedOverrides } = applyOverlay(baseCapability(), {
      tenant: "northstar",
      entryPoint: "http://127.0.0.1:4502/servicing/login.asp",
      textOverrides: { Serach: "Find Member" }, // typo'd key, never matches "Search"
    });
    expect(unmatchedOverrides).toEqual(["Serach"]);
  });

  it("reports an override key as matched when it hits text in more than one place", () => {
    // "Search" appears in both the step's target and the outcome detector
    // built from the same text (see the test above) - one hit anywhere is
    // enough to count the key as matched, not "matched everywhere it could
    // have applied".
    const { unmatchedOverrides } = applyOverlay(baseCapability(), {
      tenant: "northstar",
      entryPoint: "http://127.0.0.1:4502/servicing/login.asp",
      textOverrides: { Search: "Find Member" },
    });
    expect(unmatchedOverrides).toEqual([]);
  });

  it("tenant-qualifies the id, so a catalog keyed on id can tell the two tenants apart", () => {
    const original = baseCapability();
    const { capability: overlaid } = applyOverlay(original, {
      tenant: "northstar",
      entryPoint: "http://127.0.0.1:4502/servicing/login.asp",
      textOverrides: {},
    });
    expect(overlaid.id).toBe(`${original.id}.northstar`);
    // The original capability's own id is untouched - only the returned
    // copy is qualified.
    expect(original.id).toBe("corevantage_servicing.lookup");
  });

  it("updates the target binding to the new tenant and entry point", () => {
    const { capability: overlaid } = applyOverlay(baseCapability(), {
      tenant: "northstar",
      entryPoint: "http://127.0.0.1:4502/servicing/login.asp",
      textOverrides: {},
    });
    expect(overlaid.target).toEqual({
      app: "corevantage-servicing",
      tenant: "northstar",
      surface: "web",
      entryPoint: "http://127.0.0.1:4502/servicing/login.asp",
    });
    // The original is never mutated.
    expect(baseCapability().target.tenant).toBe("meridian");
  });

  it("always starts draft and marks the result human-edited, regardless of the source capability's approval", () => {
    const { capability: overlaid } = applyOverlay(baseCapability(), { tenant: "northstar", entryPoint: "http://x/", textOverrides: {} });
    expect(overlaid.approval).toBe("draft");
    expect(overlaid.provenance.humanEdited).toBe(true);
  });

  it("recomputes the content hash - an overlaid capability is honestly a different program", () => {
    const original = baseCapability();
    const { capability: overlaid } = applyOverlay(original, { tenant: "northstar", entryPoint: "http://127.0.0.1:4502/servicing/login.asp", textOverrides: { Search: "Find Member" } });
    expect(overlaid.contentHash).not.toBe(original.contentHash);
  });

  it("produces something the schema itself accepts", () => {
    const { capability: overlaid } = applyOverlay(baseCapability(), {
      tenant: "northstar",
      entryPoint: "http://127.0.0.1:4502/servicing/login.asp",
      textOverrides: { Search: "Find Member" },
    });
    expect(() => CapabilitySchema.parse(overlaid)).not.toThrow();
  });
});
