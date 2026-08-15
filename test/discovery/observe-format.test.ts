import { describe, expect, it } from "vitest";
import { formatObservation } from "../../src/discovery/observe-format.js";
import { loadRedactionPolicy } from "../../src/discovery/redact.js";
import { nodeRef, type Role, type UINode, type UISnapshot } from "../../src/surface/types.js";

const policy = loadRedactionPolicy({
  patterns: [{ name: "ssn", regex: "\\b\\d{3}-\\d{2}-\\d{4}\\b" }],
  fieldNames: ["password"],
  placeholder: "[redacted:{name}]",
});

let counter = 0;
function node(spec: { role: Role; name?: string; label?: string; value?: string; visible?: boolean }): UINode {
  return {
    ref: nodeRef(`n${counter++}`),
    role: spec.role,
    name: spec.name ?? "",
    ...(spec.label !== undefined ? { label: spec.label } : {}),
    ...(spec.value !== undefined ? { value: spec.value } : {}),
    state: { disabled: false, readonly: false, required: false, focused: false },
    frame: [],
    ancestry: [],
    ordinal: 0,
    visible: spec.visible ?? true,
  };
}

function snapshot(nodes: UINode[]): UISnapshot {
  return { snapshotId: "s", takenAt: "t", kind: "web", location: "http://x/", title: "Member Search", nodes, digest: "d" };
}

describe("formatting an observation for the model", () => {
  it("lists interactive controls and nearby text, numbered", () => {
    const snap = snapshot([node({ role: "textbox", label: "Operator ID" }), node({ role: "button", name: "Sign On" })]);
    const { text, indexed } = formatObservation(snap, policy);

    expect(text).toContain("[0] textbox");
    expect(text).toContain('label:"Operator ID"');
    expect(text).toContain("[1] button");
    expect(text).toContain('"Sign On"');
    expect(indexed).toHaveLength(2);
  });

  it("omits nodes a human could not see", () => {
    const snap = snapshot([node({ role: "textbox", label: "Hidden", visible: false })]);
    const { indexed } = formatObservation(snap, policy);
    expect(indexed).toHaveLength(0);
  });

  it("redacts a sensitive field's value in the rendered text", () => {
    const snap = snapshot([node({ role: "textbox", label: "Password", value: "hunter2" })]);
    const { text } = formatObservation(snap, policy);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("[redacted:field]");
  });

  it("redacts a pattern match even in a field with an innocuous label", () => {
    const snap = snapshot([node({ role: "text", name: "SSN on file: 123-45-6789" })]);
    const { text } = formatObservation(snap, policy);
    expect(text).not.toContain("123-45-6789");
  });

  it("elides a large run of unchanged elements but keeps a changed one visible", () => {
    const many = Array.from({ length: 50 }, (_, i) => node({ role: "text", name: `Row ${i}` }));
    const before = snapshot(many);
    const after = snapshot([...many, node({ role: "text", name: "New Row" })]);

    const { text } = formatObservation(after, policy, before);
    expect(text).toContain("New Row");
    expect(text).toMatch(/unchanged element\(s\) omitted/);
  });

  it("shows every element on the very first observation, with no prior snapshot", () => {
    const many = Array.from({ length: 50 }, (_, i) => node({ role: "text", name: `Row ${i}` }));
    const { text } = formatObservation(snapshot(many), policy);
    expect(text).not.toMatch(/omitted/);
    expect(text).toContain("Row 0");
    expect(text).toContain("Row 49");
  });
});
