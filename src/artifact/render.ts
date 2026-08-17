import { describeDetector, describeTarget, describeValue } from "./format.js";
import type { Capability, Step } from "./schema.js";

/**
 * The human-readable side of "the artifact should be versioned and
 * reviewable" (brief, §3.2). A capability is JSON because a program has to
 * read it; this is Markdown because a person does too, and shouldn't have to
 * parse descriptor objects to decide whether a capability goes from `draft`
 * to `approved`.
 *
 * Renders every field on purpose, including ones a shorter summary would
 * drop. A reviewer signing off on unattended replay against a legacy banking
 * screen needs the actual match evidence, not a gloss of it.
 */

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
