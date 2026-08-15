import { describe, expect, it } from "vitest";
import { groundOutputs } from "../../src/discovery/ground.js";
import { nodeRef, type Role, type UINode, type UISnapshot } from "../../src/surface/types.js";

let counter = 0;
function node(spec: { role: Role; name?: string; value?: string; visible?: boolean }): UINode {
  return {
    ref: nodeRef(`n${counter++}`),
    role: spec.role,
    name: spec.name ?? "",
    ...(spec.value !== undefined ? { value: spec.value } : {}),
    state: { disabled: false, readonly: false, required: false, focused: false },
    frame: [],
    ancestry: [],
    ordinal: 0,
    visible: spec.visible ?? true,
  };
}

function snapshot(nodes: UINode[]): UISnapshot {
  return { snapshotId: "s", takenAt: "t", kind: "web", location: "http://x/", title: "t", nodes, digest: "d" };
}

describe("grounding a finish decision's claimed outputs", () => {
  it("traces a value to the single node that displays it", () => {
    const balanceNode = node({ role: "text", name: "4,182.55" });
    const result = groundOutputs({ savings_balance: "4,182.55" }, snapshot([balanceNode]));

    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe("4,182.55");
    expect(result[0]!.descriptor).not.toBeNull();
    expect(result[0]!.descriptor?.name?.kind).toBe("normalized");
  });

  it("grounds against a control's value, not only a text node's name", () => {
    const field = node({ role: "textbox", value: "100234" });
    const result = groundOutputs({ member_id: "100234" }, snapshot([field]));
    expect(result[0]!.descriptor).not.toBeNull();
  });

  it("refuses to guess when the value is not found on screen at all", () => {
    const result = groundOutputs({ savings_balance: "9,999.99" }, snapshot([node({ role: "text", name: "4,182.55" })]));
    expect(result[0]!.descriptor).toBeNull();
  });

  it("refuses to guess when the value appears in more than one place", () => {
    const nodes = [node({ role: "text", name: "100234" }), node({ role: "textbox", value: "100234" })];
    const result = groundOutputs({ member_id: "100234" }, snapshot(nodes));
    // Two candidates, genuinely ambiguous which one the model meant - a wrong
    // guess here would make the compiled artifact more confident than the
    // evidence supports.
    expect(result[0]!.descriptor).toBeNull();
  });

  it("ignores an invisible node even if its text matches", () => {
    const result = groundOutputs(
      { savings_balance: "4,182.55" },
      snapshot([node({ role: "text", name: "4,182.55", visible: false })]),
    );
    expect(result[0]!.descriptor).toBeNull();
  });

  it("grounds every output independently", () => {
    const nodes = [node({ role: "text", name: "Marguerite Delacroix-Whitfield" }), node({ role: "text", name: "4,182.55" })];
    const result = groundOutputs(
      { member_name: "Marguerite Delacroix-Whitfield", savings_balance: "4,182.55" },
      snapshot(nodes),
    );
    expect(result).toHaveLength(2);
    expect(result.every((g) => g.descriptor !== null)).toBe(true);
  });
});
