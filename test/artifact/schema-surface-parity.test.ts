import { describe, expect, it } from "vitest";
import { describeNode } from "../../src/surface/describe.js";
import { SemanticDescriptorSchema } from "../../src/artifact/schema.js";
import { nodeRef, type Ancestor, type Role, type UINode, type UISnapshot } from "../../src/surface/types.js";

/**
 * The artifact schema re-declares the descriptor vocabulary in Zod rather
 * than importing it from surface/types.ts (see the comment atop schema.ts
 * for why). That is a real risk: two hand-maintained representations of the
 * same shape can drift, silently, the moment one changes and the other does
 * not.
 *
 * This test is the guard against that. It does not compare types - it takes
 * a real descriptor out of the actual matcher's own describeNode(), the same
 * function the compiler will use to build a Step's target, and feeds it
 * through the Zod schema an artifact will actually be validated against. If
 * the two representations disagree about a single field, this fails, loudly,
 * regardless of what the type checker thinks.
 */

let counter = 0;
function node(spec: {
  role: Role;
  name?: string;
  label?: string;
  frame?: string[];
  ancestry?: Ancestor[];
  ordinal?: number;
}): UINode {
  return {
    ref: nodeRef(`n${counter++}`),
    role: spec.role,
    name: spec.name ?? "",
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    state: { disabled: false, readonly: false, required: false, focused: false },
    frame: spec.frame ?? [],
    ancestry: spec.ancestry ?? [],
    ordinal: spec.ordinal ?? 0,
    visible: true,
  };
}

function snapshot(nodes: UINode[]): UISnapshot {
  return { snapshotId: "s", takenAt: "t", kind: "web", location: "http://x/", title: "t", nodes, digest: "d" };
}

describe("a real describeNode() output validates against the artifact schema", () => {
  it("a named, labelled control", () => {
    const target = node({ role: "textbox", label: "Operator ID" });
    const descriptor = describeNode(target, snapshot([target]));
    expect(SemanticDescriptorSchema.safeParse(descriptor).success).toBe(true);
  });

  it("an anchored, unlabelled control nested in a frame", () => {
    const nodes = [
      node({ role: "text", name: "Member Number", frame: ["mainfrm"] }),
      node({ role: "textbox", name: "", frame: ["mainfrm"] }),
    ];
    const snap = snapshot(nodes);
    const descriptor = describeNode(nodes[1]!, snap);
    expect(SemanticDescriptorSchema.safeParse(descriptor).success).toBe(true);
  });

  it("a control with containment (within)", () => {
    const target = node({ role: "button", name: "Search", ancestry: [{ role: "form", name: "Member Search" }] });
    const descriptor = describeNode(target, snapshot([target]));
    const result = SemanticDescriptorSchema.safeParse(descriptor);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.within?.role).toBe("form");
  });

  it("preserves every field describeNode set, not a subset the schema happens to accept", () => {
    const nodes = [
      node({ role: "text", name: "Member Number", frame: ["mainfrm"] }),
      node({ role: "textbox", name: "", frame: ["mainfrm"], ordinal: 2 }),
    ];
    const descriptor = describeNode(nodes[1]!, snapshot(nodes));
    const result = SemanticDescriptorSchema.parse(descriptor); // throws on any drop
    expect(result).toEqual(descriptor);
  });
});
