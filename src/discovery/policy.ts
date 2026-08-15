import { matchesAny } from "./glob.js";
import { loadRedactionPolicy, type RawRedactionConfig, type RedactionPolicy } from "./redact.js";
import type { Action } from "../surface/types.js";

/**
 * The guardrail model, loaded from config/policy.example.json.
 *
 * Enforced on every action in both discovery and replay - a model exploring
 * a back-office application is not a trusted context, and an unbounded
 * action there does exactly the damage the brief is warning about. Discovery
 * gets no exemption for being "just exploring".
 */

export type RiskTier = "safe" | "elevated" | "irreversible";

export interface AllowlistPolicy {
  origins: readonly string[];
  routes: readonly string[];
  denyRoutes: readonly string[];
  actions: readonly string[];
}

export interface RiskRule {
  match: { route?: string; nameMatches?: string };
  tier: RiskTier;
}

export interface RiskPolicy {
  default: RiskTier;
  rules: readonly RiskRule[];
}

export interface UnattendedPolicy {
  requiresApproval: "draft" | "approved" | "retired";
  maxTier: RiskTier;
  onIrreversible: "escalate" | "block";
}

export interface Policy {
  allowlist: AllowlistPolicy;
  risk: RiskPolicy;
  unattended: UnattendedPolicy;
  redaction: RedactionPolicy;
}

export interface RawPolicyConfig {
  allowlist: AllowlistPolicy;
  risk: RiskPolicy;
  unattended: UnattendedPolicy;
  redaction: RawRedactionConfig;
}

export function loadPolicy(raw: RawPolicyConfig): Policy {
  return {
    allowlist: raw.allowlist,
    risk: raw.risk,
    unattended: raw.unattended,
    redaction: loadRedactionPolicy(raw.redaction),
  };
}

export type PolicyDecision =
  | { allowed: true; tier: RiskTier }
  | { allowed: false; tier: RiskTier; reason: string };

function pathnameOf(location: string): string {
  try {
    return new URL(location).pathname;
  } catch {
    return location;
  }
}

function originOf(location: string): string {
  try {
    return new URL(location).origin;
  } catch {
    return location;
  }
}

function riskOf(route: string, controlName: string | undefined, policy: RiskPolicy): RiskTier {
  for (const rule of policy.rules) {
    if (rule.match.route && matchesAny(route, [rule.match.route])) return rule.tier;
    if (rule.match.nameMatches && controlName) {
      try {
        // Always case-insensitive. JS RegExp has no inline (?i) flag syntax -
        // it silently throws on construction, which a naive catch turns into
        // "the rule matched nothing" with no indication anything was wrong.
        // That is precisely how this project's own shipped policy config had
        // every name-based escalation rule silently dead: every pattern was
        // written the PCRE way, "(?i)\\bdelete\\b", which is invalid here.
        if (new RegExp(rule.match.nameMatches, "i").test(controlName)) return rule.tier;
      } catch (error) {
        throw new Error(
          `risk rule has an invalid nameMatches pattern "${rule.match.nameMatches}": ${String(error)}. ` +
            `A guardrail that silently fails open is worse than one that fails loud.`,
        );
      }
    }
  }
  return policy.default;
}

/**
 * Checks one action against the allowlist and assigns its risk tier.
 *
 * `location` is the current screen's location (post the action, for
 * navigate; pre the action, otherwise - navigation is the one action kind
 * that changes what "current route" means). `controlName` is the accessible
 * name or intent text of the target, when there is one, and is what the
 * `nameMatches` risk rules pattern against - it is how "any button whose
 * name contains Delete is irreversible" gets enforced without a route to key
 * on.
 */
export function checkAction(
  action: Action,
  location: string,
  policy: Policy,
  controlName?: string,
): PolicyDecision {
  if (!policy.allowlist.actions.includes(action.kind)) {
    return { allowed: false, tier: "irreversible", reason: `action kind "${action.kind}" is not in the allowlist` };
  }

  const target = action.kind === "navigate" ? action.to : location;
  const origin = originOf(target);
  const route = pathnameOf(target);

  if (!matchesAny(origin, policy.allowlist.origins)) {
    return { allowed: false, tier: "irreversible", reason: `origin "${origin}" is not in the allowlist` };
  }
  if (matchesAny(route, policy.allowlist.denyRoutes)) {
    return { allowed: false, tier: "irreversible", reason: `route "${route}" is explicitly denied` };
  }
  if (!matchesAny(route, policy.allowlist.routes)) {
    return { allowed: false, tier: "irreversible", reason: `route "${route}" is not in the allowlist` };
  }

  const tier = riskOf(route, controlName, policy.risk);
  return { allowed: true, tier };
}
