import { describe, expect, it } from "vitest";

import { DEFAULT_MATCH_CONFIG, explain, match } from "../src/surface/match.js";
import { matchText, normalize, similarity } from "../src/surface/text.js";
import { nodeRef, type Ancestor, type Role, type UINode, type UISnapshot } from "../src/surface/types.js";

/**
 * The matcher is the claim this project stands on, so it is tested against the
 * situations the target application actually produces — an input with no
 * accessible name, two identically-named buttons, the same control living in
 * two frames — rather than against convenient ones.
 */

let counter = 0;

function node(spec: {
  role: Role;
  name?: string;
  label?: string;
  frame?: string[];
  ancestry?: Ancestor[];
  ordinal?: number;
  visible?: boolean;
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
    visible: spec.visible ?? true,
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

describe("text similarity", () => {
  it("strips legacy label punctuation", () => {
    expect(normalize("  Member   Number: ")).toBe("member number");
    expect(normalize("Amount *")).toBe("amount");
  });

  it("scores an abbreviation as close and an unrelated phrase as far", () => {
    expect(similarity(normalize("Member Number"), normalize("Member No."))).toBeGreaterThan(0.6);
    expect(similarity(normalize("Search"), normalize("Find Member"))).toBeLessThan(0.2);
  });

  it("floors coincidental overlap, so unrelated words contribute nothing", () => {
    // "search" and "clear" share the bigrams `ea` and `ar` by pure accident
    // and score 0.44 against each other. Counting that as partial evidence is
    // enough to pick the wrong button on a rebranded screen.
    expect(similarity("search", "clear")).toBeGreaterThan(0.4);
    expect(matchText({ kind: "normalized", value: "Search" }, "Clear")).toBe(0);

    // Genuine resemblance still survives the floor.
    expect(matchText({ kind: "normalized", value: "Member Number" }, "Member No.")).toBeGreaterThan(0.6);
  });
});

describe("matching an unlabelled control by anchor", () => {
  // This is the case the target application forces: the Member Number input
  // has no accessible name and no label association. Its only identity is
  // being the first textbox after the text "Member Number".
  const nodes = [
    node({ role: "text", name: "Member Number" }),
    node({ role: "textbox", name: "" }),
    node({ role: "text", name: "Branch" }),
    node({ role: "textbox", name: "" }),
    node({ role: "button", name: "Search" }),
  ];

  it("finds the input after its label", () => {
    const result = match(
      {
        role: "textbox",
        anchor: { direction: "after", node: { role: "text", name: { kind: "normalized", value: "Member Number" } } },
      },
      snapshot(nodes),
    );

    expect(result.status).toBe("unique");
    if (result.status !== "unique") return;
    expect(result.ref).toBe(nodes[1]!.ref);
  });

  it("prefers the nearest following control over a later one", () => {
    const result = match(
      {
        role: "textbox",
        anchor: { direction: "after", node: { role: "text", name: { kind: "normalized", value: "Branch" } } },
      },
      snapshot(nodes),
    );

    expect(result.status).toBe("unique");
    if (result.status !== "unique") return;
    expect(result.ref).toBe(nodes[3]!.ref);
  });
});

describe("refusing to guess", () => {
  it("won't pick between two identical controls", () => {
    const nodes = [
      node({ role: "button", name: "Submit" }),
      node({ role: "button", name: "Submit" }),
    ];

    const result = match({ role: "button", name: { kind: "normalized", value: "Submit" } }, snapshot(nodes));

    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates).toHaveLength(2);
    expect(explain(result)).toContain("does not identify one control");
  });

  it("separates two same-named controls once containment distinguishes them", () => {
    const nodes = [
      node({ role: "button", name: "Submit", ancestry: [{ role: "form", name: "Member Search" }] }),
      node({ role: "button", name: "Submit", ancestry: [{ role: "form", name: "Transaction Journal" }] }),
    ];

    const result = match(
      {
        role: "button",
        name: { kind: "normalized", value: "Submit" },
        within: { role: "form", name: { kind: "normalized", value: "Member Search" } },
      },
      snapshot(nodes),
    );

    expect(result.status).toBe("unique");
    if (result.status !== "unique") return;
    expect(result.ref).toBe(nodes[0]!.ref);
  });

  it("declines a descriptor that only names a role, since that is a class not a control", () => {
    const result = match({ role: "button" }, snapshot([node({ role: "button", name: "Search" })]));
    expect(result.status).toBe("absent");
  });

  it("reports absence when nothing comes close", () => {
    const result = match(
      { role: "button", name: { kind: "normalized", value: "Post Transaction" } },
      snapshot([node({ role: "button", name: "Search" })]),
    );
    expect(result.status).toBe("absent");
    expect(explain(result)).toContain("acceptance threshold");
  });
});

describe("surviving a tenant rebrand", () => {
  // Another institution runs the same product with the submit button
  // relabelled from "Search" to "Find Member". The name signal collapses -
  // correctly - so the match has to be carried by where the control sits, or
  // not made at all. Note "Clear" sits beside it as a decoy: it is a plausible
  // wrong answer, which is the only kind worth testing against.
  const form: Ancestor = { role: "form", name: "Member Search" };
  const rebranded = snapshot([
    node({ role: "text", name: "Member Number", ancestry: [form] }),
    node({ role: "textbox", name: "", ancestry: [form] }),
    node({ role: "button", name: "Find Member", ancestry: [form], ordinal: 0 }),
    node({ role: "button", name: "Clear", ancestry: [form], ordinal: 1 }),
  ]);

  const descriptor = {
    role: "button" as const,
    name: { kind: "normalized" as const, value: "Search" },
    within: { role: "form" as const, name: { kind: "normalized" as const, value: "Member Search" } },
    anchor: {
      direction: "after" as const,
      node: { role: "text" as const, name: { kind: "normalized" as const, value: "Member Number" } },
    },
    ordinal: 0,
  };

  it("resolves the renamed control from containment, anchoring and position", () => {
    const result = match(descriptor, rebranded);

    expect(result.status).toBe("unique");
    if (result.status !== "unique") return;
    expect(result.ref).toBe(rebranded.nodes[2]!.ref);

    // The name contributed nothing at all; every other signal carried it.
    expect(result.evidence.name).toBe(0);
    expect(result.evidence.within).toBe(1);
    expect(result.evidence.anchor).toBe(1);
  });

  it("matches with visibly less confidence than an unrenamed control would", () => {
    const result = match(descriptor, rebranded);
    expect(result.status).toBe("unique");
    if (result.status !== "unique") return;
    // Comfortably decisive against the decoy, but nowhere near certain. That
    // is the right amount of confidence for a control whose name no longer
    // matches, and it is what a drift report should be keyed off.
    expect(result.score).toBeLessThan(0.7);
    expect(result.score - (result.runnerUp ?? 0)).toBeGreaterThan(DEFAULT_MATCH_CONFIG.margin);
  });

  it("does not resolve on a collapsed name alone", () => {
    const result = match({ role: "button", name: { kind: "normalized", value: "Search" } }, rebranded);
    expect(result.status).toBe("absent");
  });
});

describe("hard gates", () => {
  it("does not cross frames when the descriptor names one", () => {
    const nodes = [
      node({ role: "link", name: "Member Search", frame: ["navfrm"] }),
      node({ role: "link", name: "Member Search", frame: ["mainfrm"] }),
    ];

    const result = match(
      { role: "link", name: { kind: "normalized", value: "Member Search" }, frame: ["mainfrm"] },
      snapshot(nodes),
    );

    expect(result.status).toBe("unique");
    if (result.status !== "unique") return;
    expect(result.ref).toBe(nodes[1]!.ref);
  });

  it("resolves a control nested two frames deep", () => {
    const nodes = [
      node({ role: "textbox", name: "", frame: ["mainfrm"] }),
      node({ role: "textbox", name: "", frame: ["mainfrm", "frmfrm"], label: "Initial Deposit" }),
    ];

    const result = match(
      {
        role: "textbox",
        label: { kind: "normalized", value: "Initial Deposit" },
        frame: ["mainfrm", "frmfrm"],
      },
      snapshot(nodes),
    );

    expect(result.status).toBe("unique");
    if (result.status !== "unique") return;
    expect(result.ref).toBe(nodes[1]!.ref);
  });

  it("excludes a control of the wrong role outright", () => {
    const result = match(
      { role: "textbox", name: { kind: "normalized", value: "Search" } },
      snapshot([node({ role: "button", name: "Search" })]),
    );
    expect(result.status).toBe("absent");
  });

  it("ignores controls a human could not see", () => {
    const nodes = [
      node({ role: "textbox", name: "Member Number", visible: false }),
      node({ role: "textbox", name: "Member Number", visible: true }),
    ];

    const result = match(
      { role: "textbox", name: { kind: "normalized", value: "Member Number" } },
      snapshot(nodes),
    );

    expect(result.status).toBe("unique");
    if (result.status !== "unique") return;
    expect(result.ref).toBe(nodes[1]!.ref);
  });
});

describe("the deciding margin", () => {
  it("is what separates a decision from a coin flip", () => {
    const nodes = [
      node({ role: "button", name: "Open Account", ancestry: [{ role: "form", name: "New Sub-Account" }] }),
      node({ role: "button", name: "Open Accounts", ancestry: [{ role: "form", name: "New Sub-Account" }] }),
    ];
    const descriptor = {
      role: "button" as const,
      name: { kind: "normalized" as const, value: "Open Account" },
    };

    // With the shipped margin these two are too close to call.
    expect(match(descriptor, snapshot(nodes)).status).toBe("ambiguous");

    // Drop the margin to zero and it silently picks one - which is exactly the
    // behaviour the margin exists to prevent.
    const reckless = match(descriptor, snapshot(nodes), { ...DEFAULT_MATCH_CONFIG, margin: 0 });
    expect(reckless.status).toBe("unique");
  });
});
