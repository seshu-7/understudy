import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseCapability, type Capability, type ParamSpec, type ParamType } from "../artifact/schema.js";
import { replayCapability, type ReplayDeps } from "../replay/replay.js";
import type { ReplayResult } from "../replay/types.js";

/**
 * The agent-facing surface README.md's layout sketch called `src/catalog/` -
 * what turns a directory of artifact JSON files into something a calling
 * agent can enumerate and invoke, without the agent ever needing to know
 * `replayCapability`, `ReplayDeps`, or that a `Surface` exists. Deliberately
 * thin: every safety and policy decision - approval gating, the allowlist,
 * risk tiers, redaction - already lives in `replayCapability` and Phase 6's
 * work on it. Duplicating any of that here would be a second place for a
 * guardrail to quietly drift out of sync with the first, which is exactly
 * the failure mode this project has already found and fixed twice (REPORT.md
 * §6). The catalog's only job is discovery and dispatch.
 */

export interface CapabilitySummary {
  id: string;
  name: string;
  description: string;
  version: number;
  approval: Capability["approval"];
  target: Capability["target"];
  inputs: readonly ParamSpec[];
  outputCount: number;
}

/** Loads and validates every `*.json` artifact in a directory - the same
 *  Zod schema a reviewer or replay itself holds a capability to, so a
 *  malformed or hand-edited-into-invalidity artifact fails loudly here
 *  rather than surfacing as a confusing failure the first time an agent
 *  tries to call it. */
export async function loadCatalog(artifactsDir: string): Promise<Capability[]> {
  const entries = await readdir(artifactsDir);
  const capabilities: Capability[] = [];
  const fileById = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    let capability: Capability;
    try {
      const raw = JSON.parse(await readFile(join(artifactsDir, entry), "utf8")) as unknown;
      capability = parseCapability(raw);
    } catch (error) {
      throw new Error(`artifact "${entry}": ${error instanceof Error ? error.message : String(error)}`);
    }
    // findCapability/invokeCapability key purely on id - a directory
    // holding two capabilities that answer to the same id is ambiguous in
    // a way that has to fail loudly here, the same way a malformed file
    // does, rather than silently letting whichever one readdir() happens
    // to list first win every lookup.
    const clashingFile = fileById.get(capability.id);
    if (clashingFile) {
      throw new Error(`duplicate capability id "${capability.id}": both "${clashingFile}" and "${entry}" claim it`);
    }
    fileById.set(capability.id, entry);
    capabilities.push(capability);
  }
  return capabilities;
}

/** What is safe to offer an agent as a callable option by default - a draft
 *  has not been reviewed, and a retired one is retired for a reason.
 *  `loadCatalog` itself does not filter, so an audit tool can still see
 *  everything. */
export function listApproved(catalog: readonly Capability[]): Capability[] {
  return catalog.filter((c) => c.approval === "approved");
}

export function summarize(capability: Capability): CapabilitySummary {
  return {
    id: capability.id,
    name: capability.name,
    description: capability.description,
    version: capability.version,
    approval: capability.approval,
    target: capability.target,
    inputs: capability.inputs,
    outputCount: capability.outputs.length,
  };
}

function jsonSchemaType(type: ParamType): { type: string; format?: string } {
  switch (type) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "string", format: "date" };
  }
}

function describeOutputs(capability: Capability): string {
  if (capability.outputs.length === 0) return "";
  const strip = (s: string) => s.replace(/\.+$/, "");
  const list = capability.outputs.map((o) => `${o.name} (${o.type}): ${strip(o.description)}`).join("; ");
  return ` Returns: ${list}.`;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; format?: string; description: string }>;
    required: string[];
  };
}

/** A capability as a tool an LLM agent can call - Anthropic's tool-use
 *  shape, since that is the format most directly relevant to what this
 *  whole project exists to feed. `ParamSpec` already carries everything a
 *  JSON Schema property needs; this is a direct projection; it does not
 *  invent new information about the capability along the way. */
export function toToolDefinition(capability: Capability): ToolDefinition {
  const properties: ToolDefinition["input_schema"]["properties"] = {};
  const required: string[] = [];
  for (const param of capability.inputs) {
    properties[param.name] = {
      ...jsonSchemaType(param.type),
      description: param.sensitive ? `${param.description} (sensitive - never logged)` : param.description,
    };
    if (param.required) required.push(param.name);
  }
  return {
    name: capability.id.replace(/[^a-zA-Z0-9_-]/g, "_"),
    description: `${capability.description}${describeOutputs(capability)}`,
    input_schema: { type: "object", properties, required },
  };
}

export class CapabilityNotFoundError extends Error {
  constructor(id: string) {
    super(`no capability "${id}" in the catalog`);
    this.name = "CapabilityNotFoundError";
  }
}

export function findCapability(catalog: readonly Capability[], id: string): Capability {
  const found = catalog.find((c) => c.id === id);
  if (!found) throw new CapabilityNotFoundError(id);
  return found;
}

/** Look up by id and dispatch to the real interpreter - the entire point
 *  being that everything past this line is exactly what `npm run replay`
 *  would have done, not a second code path an agent-facing entry point
 *  quietly diverges from. */
export async function invokeCapability(
  catalog: readonly Capability[],
  id: string,
  inputs: Readonly<Record<string, string>>,
  deps: ReplayDeps,
): Promise<ReplayResult> {
  return replayCapability(findCapability(catalog, id), inputs, deps);
}
