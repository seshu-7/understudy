import { describe, expect, it } from "vitest";

import { coerceOutput, evaluateDetector, extractOutput } from "../../src/replay/detect.js";
import type { Detector, OutputSpec, SemanticDescriptor } from "../../src/artifact/schema.js";
import { nodeRef, type UINode, type UISnapshot } from "../../src/surface/types.js";

let counter = 0;

function node(spec: {
  role: UINode["role"];
  name?: string;
  label?: string;
  value?: string;
  ordinal?: number;
  ancestry?: { role: UINode["role"]; name: string }[];
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
    ancestry: spec.ancestry ?? [],
    ordinal: spec.ordinal ?? 0,
    visible: spec.visible ?? true,
  };
}

function snapshot(nodes: UINode[], location = "http://127.0.0.1:4501/servicing/"): UISnapshot {
  return { snapshotId: "s", takenAt: "t", kind: "web", location, title: "t", nodes, digest: "d" };
}

function descriptor(spec: Partial<SemanticDescriptor> & { role: SemanticDescriptor["role"] }): SemanticDescriptor {
  return spec as SemanticDescriptor;
}

describe("evaluateDetector", () => {
  it("node_present matches when the descriptor resolves uniquely", () => {
    const snap = snapshot([node({ role: "button", name: "Search" })]);
    const detector: Detector = { kind: "node_present", descriptor: descriptor({ role: "button", name: { kind: "normalized", value: "Search" } }) };
    expect(evaluateDetector(detector, snap).matched).toBe(true);
  });

  it("node_present does not match when nothing resolves", () => {
    const snap = snapshot([node({ role: "button", name: "Cancel" })]);
    const detector: Detector = { kind: "node_present", descriptor: descriptor({ role: "button", name: { kind: "normalized", value: "Search" } }) };
    expect(evaluateDetector(detector, snap).matched).toBe(false);
  });

  it("node_absent matches when the descriptor resolves to nothing", () => {
    const snap = snapshot([node({ role: "button", name: "Cancel" })]);
    const detector: Detector = { kind: "node_absent", descriptor: descriptor({ role: "dialog", name: { kind: "normalized", value: "Session Expired" } }) };
    expect(evaluateDetector(detector, snap).matched).toBe(true);
  });

  it("node_absent does not match while the node is still there", () => {
    const snap = snapshot([node({ role: "dialog", name: "Session Expired" })]);
    const detector: Detector = { kind: "node_absent", descriptor: descriptor({ role: "dialog", name: { kind: "normalized", value: "Session Expired" } }) };
    expect(evaluateDetector(detector, snap).matched).toBe(false);
  });

  it("text_matches tests a pattern against the resolved node's own text", () => {
    const snap = snapshot([node({ role: "text", name: "No member found for 999999", ordinal: 0 })]);
    const detector: Detector = { kind: "text_matches", descriptor: descriptor({ role: "text", ordinal: 0 }), pattern: "no member found" };
    expect(evaluateDetector(detector, snap).matched).toBe(true);
  });

  it("text_matches is false when target resolution itself is ambiguous, rather than testing the pattern against a guess", () => {
    const snap = snapshot([node({ role: "text", name: "Balance", ordinal: 0 }), node({ role: "text", name: "Balance", ordinal: 1 })]);
    const detector: Detector = { kind: "text_matches", descriptor: descriptor({ role: "text", name: { kind: "normalized", value: "Balance" } }), pattern: ".*" };
    expect(evaluateDetector(detector, snap).matched).toBe(false);
  });

  it("location_matches tests a pattern against the snapshot's current location, case-insensitively", () => {
    const snap = snapshot([], "http://127.0.0.1:4501/servicing/ERROR.asp");
    const detector: Detector = { kind: "location_matches", pattern: "error" };
    expect(evaluateDetector(detector, snap).matched).toBe(true);
  });
});

describe("extractOutput", () => {
  const balance = descriptor({ role: "text", within: { role: "table", name: { kind: "normalized", value: "Accounts" } }, ordinal: 6 });

  it("reads 'text' as the node's displayed content", () => {
    const snap = snapshot([node({ role: "text", name: "4,182.55", ordinal: 6, ancestry: [{ role: "table", name: "Accounts" }] })]);
    const spec: OutputSpec = { name: "balance", type: "string", description: "d", extract: { descriptor: balance, from: "text" } };
    expect(extractOutput(spec, snap)).toBe("4,182.55");
  });

  it("reads 'value' from a form control's current value, not its name", () => {
    const snap = snapshot([node({ role: "textbox", label: "Member Number", value: "100234" })]);
    const spec: OutputSpec = {
      name: "typed",
      type: "string",
      description: "d",
      extract: { descriptor: descriptor({ role: "textbox", label: { kind: "normalized", value: "Member Number" } }), from: "value" },
    };
    expect(extractOutput(spec, snap)).toBe("100234");
  });

  it("throws rather than returning an empty string when the target cannot be re-resolved", () => {
    const snap = snapshot([node({ role: "text", name: "unrelated", ancestry: [{ role: "table", name: "Something Else" }] })]);
    const spec: OutputSpec = { name: "balance", type: "string", description: "d", extract: { descriptor: balance, from: "text" } };
    expect(() => extractOutput(spec, snap)).toThrow(/could not be re-extracted/);
  });
});

describe("coerceOutput", () => {
  it("parses a number output, stripping thousands separators", () => {
    expect(coerceOutput("4,182.55", "number")).toBe(4182.55);
  });

  it("falls back to the raw string when a number output does not actually parse", () => {
    expect(coerceOutput("not a number", "number")).toBe("not a number");
  });

  it("parses a boolean output case-insensitively", () => {
    expect(coerceOutput("True", "boolean")).toBe(true);
    expect(coerceOutput("false", "boolean")).toBe(false);
  });

  it("passes string and date outputs through unchanged", () => {
    expect(coerceOutput("hello", "string")).toBe("hello");
    expect(coerceOutput("2026-08-15", "date")).toBe("2026-08-15");
  });
});
