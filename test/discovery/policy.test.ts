import { describe, expect, it } from "vitest";
import { checkAction, loadPolicy, type RawPolicyConfig } from "../../src/discovery/policy.js";
import type { Action } from "../../src/surface/types.js";

const raw: RawPolicyConfig = {
  allowlist: {
    origins: ["http://127.0.0.1:4501"],
    routes: ["/servicing/**"],
    denyRoutes: ["/servicing/**/delete", "/admin/**"],
    actions: ["click", "fill", "select", "press", "navigate", "wait"],
  },
  risk: {
    default: "safe",
    rules: [
      { match: { route: "/**/confirm" }, tier: "elevated" },
      { match: { nameMatches: "\\bdelete\\b" }, tier: "irreversible" },
    ],
  },
  unattended: { requiresApproval: "approved", maxTier: "elevated", onIrreversible: "escalate" },
  redaction: { patterns: [], fieldNames: [], placeholder: "[redacted:{name}]" },
};

const policy = loadPolicy(raw);
const HERE = "http://127.0.0.1:4501/servicing/mbr.asp?fn=srch";

function click(): Action {
  return { kind: "click", target: "n1" as never };
}

describe("the guardrail model", () => {
  it("allows an action on an allowlisted route at a known origin", () => {
    const result = checkAction(click(), HERE, policy);
    expect(result.allowed).toBe(true);
  });

  it("blocks an origin that is not allowlisted", () => {
    const result = checkAction(click(), "http://evil.example.com/servicing/mbr.asp", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks a route that is not allowlisted at all", () => {
    const result = checkAction(click(), "http://127.0.0.1:4501/reports/export", policy);
    expect(result.allowed).toBe(false);
  });

  it("blocks a denied route even though it sits inside an allowed one", () => {
    // /servicing/** allows this path in general, but the more specific deny
    // rule must still win - this is the case an allowlist-only check misses.
    const result = checkAction(click(), "http://127.0.0.1:4501/servicing/acct/123/delete", policy);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain("explicitly denied");
  });

  it("blocks an action kind that is not in the allowlist", () => {
    const result = checkAction({ kind: "navigate", to: "http://127.0.0.1:4501/servicing/mbr.asp" }, HERE, {
      ...policy,
      allowlist: { ...policy.allowlist, actions: ["click"] },
    });
    expect(result.allowed).toBe(false);
  });

  it("checks navigate against its destination, not the current page", () => {
    // Standing on an allowed page and navigating to a denied one must not
    // slip through because the current route looked fine.
    const result = checkAction(
      { kind: "navigate", to: "http://127.0.0.1:4501/admin/console" },
      HERE,
      policy,
    );
    expect(result.allowed).toBe(false);
  });

  it("assigns the default risk tier when no rule matches", () => {
    const result = checkAction(click(), HERE, policy);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.tier).toBe("safe");
  });

  it("raises the tier for a route matching a risk rule", () => {
    const result = checkAction(click(), "http://127.0.0.1:4501/servicing/acct/confirm", policy);
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.tier).toBe("elevated");
  });

  it("raises the tier from the target's own name, not just the route", () => {
    // "Delete Account" as a button name should be irreversible wherever it
    // is clicked from, even on an otherwise safe route.
    const result = checkAction(click(), HERE, policy, "Delete Account");
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.tier).toBe("irreversible");
  });

  it("matches nameMatches case-insensitively without needing an inline flag", () => {
    const result = checkAction(click(), HERE, policy, "DELETE ACCOUNT");
    expect(result.allowed).toBe(true);
    if (result.allowed) expect(result.tier).toBe("irreversible");
  });

  it("fails loud on a malformed nameMatches pattern rather than silently defaulting to safe", () => {
    // JS RegExp has no inline (?i) flag syntax - "(?i)\\bdelete\\b" throws at
    // construction. A guardrail rule that fails open on a typo is worse than
    // one that refuses to run, so this must surface as an error, not as
    // every irreversible-action rule quietly matching nothing.
    const broken = loadPolicy({
      ...raw,
      risk: { default: "safe", rules: [{ match: { nameMatches: "(?i)\\bdelete\\b" }, tier: "irreversible" }] },
    });
    expect(() => checkAction(click(), HERE, broken, "Delete Account")).toThrow(/invalid nameMatches pattern/);
  });
});
