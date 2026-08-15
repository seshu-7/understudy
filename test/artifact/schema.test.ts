import { describe, expect, it } from "vitest";
import {
  CapabilitySchema,
  ContentHashSchema,
  OutcomeSpecSchema,
  parseCapability,
} from "../../src/artifact/schema.js";

/**
 * The schema is the central artifact of this project, so it gets tested for
 * what it rejects at least as much as what it accepts. The discriminated
 * "remedy required iff recoverable" rule in particular was a comment in the
 * Phase 0 interfaces with no enforcement behind it - these tests are what
 * turns that promise into something a bad artifact actually cannot pass.
 */

const descriptor = { role: "button" as const, name: { kind: "normalized" as const, value: "Search" } };

const minimalCapability = {
  schemaVersion: "1.0" as const,
  id: "corevantage-servicing.lookup_savings_balance",
  name: "Look up a member's savings balance",
  description: "Signs on, searches for a member by number, and reads their savings balance.",
  version: 1,
  contentHash: "0123456789abcdef",
  approval: "draft" as const,
  target: {
    app: "corevantage-servicing",
    tenant: "meridian",
    surface: "web" as const,
    entryPoint: "http://127.0.0.1:4501/servicing/login.asp",
  },
  inputs: [{ name: "member_id", type: "string" as const, description: "6-digit member number", required: true }],
  outputs: [
    {
      name: "savings_balance",
      type: "string" as const,
      description: "Current Regular Savings balance",
      extract: { descriptor, from: "text" as const },
    },
  ],
  steps: [
    {
      index: 0,
      intent: "click the Search button",
      action: { kind: "click" as const, target: descriptor },
      risk: "safe" as const,
      timeoutMs: 10_000,
    },
  ],
  outcomes: [],
  provenance: {
    discoveryRunId: "1786833847548",
    recordedAt: "2026-08-15T22:44:09.252Z",
    planner: { provider: "ollama", model: "qwen2.5:7b-instruct" },
    prunedSteps: 0,
    humanEdited: false,
  },
};

describe("parsing a well-formed capability", () => {
  it("accepts the minimal shape", () => {
    expect(() => parseCapability(minimalCapability)).not.toThrow();
  });

  it("round-trips through JSON without changing shape", () => {
    const parsed = parseCapability(JSON.parse(JSON.stringify(minimalCapability)));
    expect(parsed).toEqual(minimalCapability);
  });
});

describe("rejecting a malformed capability", () => {
  it("rejects a missing required field", () => {
    const { name: _name, ...withoutName } = minimalCapability;
    expect(() => parseCapability(withoutName)).toThrow();
  });

  it("rejects a step action of an unknown kind", () => {
    const bad = { ...minimalCapability, steps: [{ ...minimalCapability.steps[0], action: { kind: "teleport" } }] };
    expect(() => parseCapability(bad)).toThrow();
  });

  it("rejects a content hash that is not a 16-character hex digest", () => {
    expect(() => parseCapability({ ...minimalCapability, contentHash: "not-a-hash" })).toThrow();
    expect(() => CapabilitySchema.parse({ ...minimalCapability, contentHash: "0123456789abcde" })).toThrow(); // 15 chars
  });

  it("rejects version 0 and negative versions", () => {
    expect(() => parseCapability({ ...minimalCapability, version: 0 })).toThrow();
    expect(() => parseCapability({ ...minimalCapability, version: -1 })).toThrow();
  });
});

describe("the remedy / outcome-class rule", () => {
  const base = {
    name: "member_not_found",
    description: "The searched member number does not exist.",
    detect: { kind: "text_matches" as const, descriptor, pattern: "No member found" },
  };

  it("rejects a recoverable outcome with no remedy", () => {
    const result = OutcomeSpecSchema.safeParse({ ...base, class: "recoverable" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("remedy"))).toBe(true);
    }
  });

  it("accepts a recoverable outcome that declares a remedy", () => {
    const result = OutcomeSpecSchema.safeParse({
      ...base,
      class: "recoverable",
      remedy: { kind: "wait_retry", attempts: 3, backoffMs: 500 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a business_outcome that carries a remedy nobody will consult", () => {
    const result = OutcomeSpecSchema.safeParse({
      ...base,
      class: "business_outcome",
      remedy: { kind: "reauthenticate" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a hard_failure that carries a remedy", () => {
    const result = OutcomeSpecSchema.safeParse({
      ...base,
      class: "hard_failure",
      remedy: { kind: "reauthenticate" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a business_outcome and a hard_failure with no remedy at all", () => {
    expect(OutcomeSpecSchema.safeParse({ ...base, class: "business_outcome" }).success).toBe(true);
    expect(OutcomeSpecSchema.safeParse({ ...base, class: "hard_failure" }).success).toBe(true);
  });
});

describe("ContentHashSchema", () => {
  it("accepts exactly 16 lowercase hex characters", () => {
    expect(ContentHashSchema.safeParse("0123456789abcdef").success).toBe(true);
  });
  it("rejects uppercase, wrong length, and non-hex characters", () => {
    expect(ContentHashSchema.safeParse("0123456789ABCDEF").success).toBe(false);
    expect(ContentHashSchema.safeParse("0123").success).toBe(false);
    expect(ContentHashSchema.safeParse("0123456789abcdeg").success).toBe(false);
  });
});
