import { describe, expect, it } from "vitest";
import { describeNode } from "../src/surface/describe.js";
import { match } from "../src/surface/match.js";
import { nodeRef, type Ancestor, type Role, type UINode, type UISnapshot } from "../src/surface/types.js";

/**
 * describeNode is the inverse of match(): it turns a chosen node back into a
 * descriptor. The property that actually matters is round-tripping - a
 * descriptor built here must resolve back to the same node through the real
 * matcher, on the same snapshot it was built from. Every test below checks
 * that, not just the shape of the descriptor.
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
  return {
    snapshotId: "s1",
    takenAt: "2026-08-15T00:00:00.000Z",
    kind: "web",
    location: "http://127.0.0.1:4501/servicing/",
    title: "Member Search",
    nodes,
    digest: "test",
  };
}

describe("describing a named control", () => {
  it("uses name and label, and does not fall back to an anchor", () => {
    const target = node({ role: "textbox", name: "", label: "Operator ID" });
    const snap = snapshot([target]);

    const descriptor = describeNode(target, snap);
    expect(descriptor.label?.kind).toBe("normalized");
    expect(descriptor.anchor).toBeUndefined();

    const result = match(descriptor, snap);
    expect(result.status).toBe("unique");
    if (result.status === "unique") expect(result.ref).toBe(target.ref);
  });
});

describe("describing an unlabelled control", () => {
  it("falls back to an anchor on the nearest preceding named node", () => {
    const nodes = [
      node({ role: "text", name: "Member Number" }),
      node({ role: "textbox", name: "" }), // the one being described
    ];
    const snap = snapshot(nodes);
    const target = nodes[1]!;

    const descriptor = describeNode(target, snap);
    expect(descriptor.name).toBeUndefined();
    expect(descriptor.label).toBeUndefined();
    expect(descriptor.anchor?.node.name.kind).toBe("normalized");

    const result = match(descriptor, snap);
    expect(result.status).toBe("unique");
    if (result.status === "unique") expect(result.ref).toBe(target.ref);
  });

  it("round-trips even with a decoy control between the anchor and the target", () => {
    const nodes = [
      node({ role: "text", name: "Branch" }),
      node({ role: "textbox", name: "" }), // decoy: a different unlabelled field
      node({ role: "text", name: "Member Number" }),
      node({ role: "textbox", name: "" }), // the one being described
    ];
    const snap = snapshot(nodes);
    const target = nodes[3]!;

    const descriptor = describeNode(target, snap);
    const result = match(descriptor, snap);
    expect(result.status).toBe("unique");
    if (result.status === "unique") expect(result.ref).toBe(target.ref);
  });
});

describe("describing containment", () => {
  it("carries the nearest ancestry entry as the within signal", () => {
    const target = node({
      role: "button",
      name: "Search",
      ancestry: [{ role: "form", name: "Member Search" }],
    });
    const snap = snapshot([target]);

    const descriptor = describeNode(target, snap);
    expect(descriptor.within?.role).toBe("form");
    expect(descriptor.within?.name.kind).toBe("normalized");

    const result = match(descriptor, snap);
    expect(result.status).toBe("unique");
  });
});

describe("describing preserves frame and ordinal", () => {
  it("records the frame path a nested control was found in", () => {
    const target = node({ role: "textbox", label: "Initial Deposit", frame: ["mainfrm", "frmfrm"] });
    const snap = snapshot([target]);

    const descriptor = describeNode(target, snap);
    expect(descriptor.frame).toEqual(["mainfrm", "frmfrm"]);

    const result = match(descriptor, snap);
    expect(result.status).toBe("unique");
  });
});
