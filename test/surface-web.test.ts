import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServicingServer, resetState } from "../target-app/server.js";
import { match } from "../src/surface/match.js";
import { WebSurface } from "../src/surface/web/adapter.js";
import type { SemanticDescriptor, UISnapshot } from "../src/surface/types.js";

/**
 * The adapter against the real application, not a fixture of it.
 *
 * These are written as one sequential journey rather than as independent cases
 * sharing a surface. The first attempt did the latter and was flaky: each test
 * silently depended on the screen the previous one happened to leave behind,
 * so a single slow step cascaded into unrelated failures and the suite
 * reported a different pair of failures on each run. A browser test that
 * inherits undeclared state is not testing what it claims to.
 *
 * The journey also happens to be exactly what discovery and replay will do, so
 * if the abstraction leaks, it leaks here first.
 */

const TIMEOUT = 90_000;

let server: Server;
let surface: WebSurface;
let base: string;

beforeAll(async () => {
  resetState();
  server = createServicingServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  surface = await WebSurface.launch(`${base}/servicing/login.asp`);
}, TIMEOUT);

afterAll(async () => {
  await surface?.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}, TIMEOUT);

/** Resolve or fail loudly, quoting the matcher's own explanation. */
function resolve(descriptor: SemanticDescriptor, snapshot: UISnapshot) {
  const result = match(descriptor, snapshot);
  if (result.status !== "unique") {
    throw new Error(`expected a unique match, got ${result.status}: ${JSON.stringify(result)}`);
  }
  return result;
}

const hasText = (snapshot: UISnapshot, needle: string) =>
  snapshot.nodes.some((n) => n.role === "text" && n.name.includes(needle));

describe("the web surface", () => {
  it(
    "walks the whole servicing flow through two levels of frame nesting",
    async () => {
      // --- sign on -------------------------------------------------------
      let snapshot = await surface.observe();

      const operatorId = snapshot.nodes.find((n) => n.role === "textbox" && n.label === "Operator ID");
      expect(operatorId, "Operator ID should be found by the label beside it").toBeDefined();
      // The premise the matcher exists for: this control has no name at all.
      expect(operatorId!.name).toBe("");
      // The submit button does have one, taken from its value attribute.
      expect(snapshot.nodes.some((n) => n.role === "button" && n.name === "Sign On")).toBe(true);

      await surface.act({
        kind: "fill",
        target: resolve({ role: "textbox", label: { kind: "normalized", value: "Operator ID" } }, snapshot).ref,
        text: "OPERATOR",
      });
      await surface.act({
        kind: "click",
        target: resolve({ role: "button", name: { kind: "normalized", value: "Sign On" } }, snapshot).ref,
      });

      // --- the console shell ---------------------------------------------
      snapshot = await surface.observe();
      const paths = new Set(snapshot.nodes.map((n) => n.frame.join("/")));
      expect(paths.has("navfrm")).toBe(true);
      expect(paths.has("mainfrm")).toBe(true);

      // "Member Search" exists as a nav link and as the content screen's own
      // title. Naming a frame keeps them apart.
      expect(
        match(
          { role: "link", name: { kind: "normalized", value: "Member Search" }, frame: ["navfrm"] },
          snapshot,
        ).status,
      ).toBe("unique");
      expect(
        match(
          { role: "link", name: { kind: "normalized", value: "Member Search" }, frame: ["mainfrm", "frmfrm"] },
          snapshot,
        ).status,
      ).toBe("absent");

      // --- search, resolved purely by anchoring --------------------------
      await surface.act({
        kind: "fill",
        target: resolve(
          {
            role: "textbox",
            frame: ["mainfrm"],
            anchor: {
              direction: "after",
              node: { role: "text", name: { kind: "normalized", value: "Member Number" } },
            },
          },
          snapshot,
        ).ref,
        text: "100234",
      });
      await surface.act({
        kind: "click",
        target: resolve(
          { role: "button", name: { kind: "normalized", value: "Search" }, frame: ["mainfrm"] },
          snapshot,
        ).ref,
      });

      // --- member detail --------------------------------------------------
      snapshot = await surface.observe();
      expect(hasText(snapshot, "Marguerite Delacroix-Whitfield")).toBe(true);
      expect(hasText(snapshot, "4,182.55")).toBe(true);

      await surface.act({
        kind: "click",
        target: resolve(
          { role: "link", name: { kind: "normalized", value: "Open Sub-Account" }, frame: ["mainfrm"] },
          snapshot,
        ).ref,
      });

      // --- the form, two frames deep --------------------------------------
      snapshot = await surface.observe();
      const nested = snapshot.nodes.filter((n) => n.frame.join("/") === "mainfrm/frmfrm");
      expect(nested.length, "the nested iframe should contribute nodes").toBeGreaterThan(0);

      const deposit = resolve(
        {
          role: "textbox",
          label: { kind: "normalized", value: "Initial Deposit" },
          frame: ["mainfrm", "frmfrm"],
        },
        snapshot,
      );
      expect(deposit.evidence.label).toBeGreaterThan(0.9);

      await surface.act({ kind: "fill", target: deposit.ref, text: "150.00" });
      await surface.act({
        kind: "click",
        target: resolve(
          {
            role: "button",
            name: { kind: "normalized", value: "Open Account" },
            frame: ["mainfrm", "frmfrm"],
          },
          snapshot,
        ).ref,
      });

      // --- confirmation, also two frames deep ------------------------------
      snapshot = await surface.observe();
      expect(hasText(snapshot, "opened successfully")).toBe(true);
      expect(snapshot.nodes.some((n) => /SA-\d{4}-\d{5}/.test(n.name))).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "reports a business outcome as ordinary screen content, not an exception",
    async () => {
      await surface.act({ kind: "navigate", to: `${base}/servicing/mbr.asp?fn=det&mbr=999999` });
      const snapshot = await surface.observe();
      expect(hasText(snapshot, "No member found")).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "produces a digest that is stable while the screen is",
    async () => {
      await surface.act({ kind: "navigate", to: `${base}/servicing/mbr.asp?fn=srch` });
      const first = await surface.observe();
      const second = await surface.observe();
      expect(second.digest).toBe(first.digest);
      // The identity of an observation still differs; only its content matches.
      expect(second.snapshotId).not.toBe(first.snapshotId);
    },
    TIMEOUT,
  );
});
