import type { Capability, Detector, SemanticDescriptor, Step, TextMatch, ValueSource } from "./schema.js";

/**
 * The human-readable side of "the artifact should be versioned and
 * reviewable — both a human reviewer and a calling agent should be able to
 * understand what the capability does" (brief, §3.2). A capability is JSON
 * because a program has to read it; this is Markdown because a person also
 * has to, and a person reviewing a capability before it goes from `draft` to
 * `approved` should not have to parse descriptor objects to do it.
 *
 * Deliberately renders every field, including ones a shorter summary would
 * drop — a reviewer approving unattended replay of a step against a legacy
 * banking screen is exactly the audience that needs to see the actual match
 * evidence a step will resolve against, not a gloss of it.
 */

function textMatchLabel(match: TextMatch | undefined): string {
  if (!match) return "";
  if (match.kind === "pattern") return `/${match.source}/${match.flags ?? ""}`;
  return match.value;
}

function describeTarget(descriptor: SemanticDescriptor): string {
  const parts: string[] = [descriptor.role];
  const name = textMatchLabel(descriptor.name);
  const label = textMatchLabel(descriptor.label);
  if (name) parts.push(`named "${name}"`);
  if (label) parts.push(`labelled "${label}"`);
  if (!name && !label && descriptor.anchor) {
    parts.push(`after "${textMatchLabel(descriptor.anchor.node.name)}"`);
  }
  if (descriptor.within) parts.push(`within "${textMatchLabel(descriptor.within.name)}"`);
  if (descriptor.frame && descriptor.frame.length > 0) parts.push(`(frame: ${descriptor.frame.join("/")})`);
  if (!name && !label && descriptor.ordinal !== undefined) parts.push(`[position ${descriptor.ordinal}]`);
  return parts.join(" ");
}

function describeValue(value: ValueSource): string {
  return value.kind === "param" ? `{${value.name}}` : JSON.stringify(value.value);
}

function describeDetector(detector: Detector): string {
  switch (detector.kind) {
    case "node_present":
      return `screen shows ${describeTarget(detector.descriptor)}`;
    case "node_absent":
      return `screen does not show ${describeTarget(detector.descriptor)}`;
    case "text_matches":
      return `${describeTarget(detector.descriptor)} matches /${detector.pattern}/`;
    case "location_matches":
      return `location matches /${detector.pattern}/`;
  }
}

function describeAction(step: Step): string {
  const a = step.action;
  switch (a.kind) {
    case "click":
      return `click ${describeTarget(a.target)}`;
    case "fill":
      return `fill ${describeTarget(a.target)} with ${describeValue(a.value)}`;
    case "select":
      return `select ${describeValue(a.value)} in ${describeTarget(a.target)}`;
    case "press":
      return `press "${a.key}"`;
    case "navigate":
      return `navigate to ${describeValue(a.to)}`;
    case "wait":
      return `wait (up to ${a.timeoutMs}ms) for ${a.until.kind === "settled" ? "the screen to settle" : a.until.kind === "location_matches" ? `location /${a.until.pattern}/` : describeTarget(a.until.descriptor)}`;
  }
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return "_(none)_\n";
  const header = `| ${headers.join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `${header}\n${divider}\n${body}\n`;
}

export function renderCapability(capability: Capability): string {
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push(`# ${capability.name}`);
  push();
  push(capability.description);
  push();
  push(
    `**id** \`${capability.id}\` · **version** ${capability.version} · **approval** \`${capability.approval}\` · **content hash** \`${capability.contentHash}\``,
  );
  push();

  push(`## Target`);
  push();
  push(`${capability.target.app} (${capability.target.surface}), tenant \`${capability.target.tenant}\``);
  push(`Entry point: ${capability.target.entryPoint}`);
  push();

  push(`## Inputs`);
  push();
  push(
    table(
      ["name", "type", "required", "description", "example"],
      capability.inputs.map((p) => [
        `\`${p.name}\``,
        p.type,
        p.required ? "yes" : "no",
        p.sensitive ? `${p.description} _(sensitive — never logged)_` : p.description,
        p.example ? `\`${p.example}\`` : "",
      ]),
    ),
  );

  push(`## Outputs`);
  push();
  push(
    table(
      ["name", "type", "description", "extracted from"],
      capability.outputs.map((o) => [`\`${o.name}\``, o.type, o.description, describeTarget(o.extract.descriptor)]),
    ),
  );

  push(`## Steps`);
  push();
  for (const step of capability.steps) {
    push(`${step.index + 1}. **${step.intent}**`);
    push(`   - action: ${describeAction(step)}`);
    push(`   - risk: \`${step.risk}\``);
    if (step.checkpoint) push(`   - checkpoint: ${describeDetector(step.checkpoint)}`);
    else push(`   - checkpoint: _(none — see write-up for why)_`);
  }
  push();

  push(`## Outcomes`);
  push();
  if (capability.outcomes.length === 0) {
    push("_None declared. Replay treats anything other than reaching the final step's checkpoint as a hard failure — see REPORT.md §3 for the boundary between what discovery can infer and what a reviewer adds by hand._");
  } else {
    for (const outcome of capability.outcomes) {
      push(`- **${outcome.name}** (\`${outcome.class}\`) — ${outcome.description}`);
      push(`  - detect: ${describeDetector(outcome.detect)}`);
      if (outcome.remedy) {
        push(
          `  - remedy: ${outcome.remedy.kind}${outcome.remedy.kind === "wait_retry" ? ` (${outcome.remedy.attempts}x, ${outcome.remedy.backoffMs}ms backoff)` : ""}`,
        );
      }
    }
  }
  push();

  push(`## Provenance`);
  push();
  push(`- discovered by \`${capability.provenance.planner.provider}/${capability.provenance.planner.model}\``);
  push(`- discovery run: \`${capability.provenance.discoveryRunId}\` at ${capability.provenance.recordedAt}`);
  push(`- steps pruned during compilation: ${capability.provenance.prunedSteps}`);
  push(`- human-edited since compilation: ${capability.provenance.humanEdited ? "yes" : "no"}`);
  push();

  return lines.join("\n");
}
