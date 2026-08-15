import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createServicingServer, resetState } from "../target-app/server.js";

/**
 * The target application is a prop, but it is a load-bearing one: every claim
 * the rest of the system makes about detecting business outcomes, recovering
 * from interruptions and escalating is only as true as this application's
 * behaviour. So it gets tested.
 *
 * The last group is the unusual one. It asserts the application stays
 * *hostile* — no ids, no ARIA, no test hooks, frames still nested. If someone
 * later "improves" the markup, the premise of the whole project quietly
 * evaporates and nothing else would catch it.
 */

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServicingServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => resetState());

async function signOn(): Promise<string> {
  const res = await fetch(`${base}/servicing/logon.asp`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ uid: "OPERATOR", pwd: "x" }),
    redirect: "manual",
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

function get(path: string, cookie: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { Cookie: cookie }, redirect: "manual" });
}

function post(path: string, body: Record<string, string>, cookie: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    redirect: "manual",
  });
}

const text = (r: Response) => r.text();

describe("business outcomes arise from ordinary input, not injection", () => {
  it("reports an unknown member number as a result, not an error", async () => {
    const cookie = await signOn();
    const body = await text(await get("/servicing/mbr.asp?fn=det&mbr=999999", cookie));
    expect(body).toContain("No member found");
  });

  it("rejects a malformed member number with a stated rule", async () => {
    const cookie = await signOn();
    const body = await text(await get("/servicing/mbr.asp?fn=det&mbr=12ab", cookie));
    expect(body).toContain("exactly 6 digits");
  });

  it("denies access to a restricted member", async () => {
    const cookie = await signOn();
    const body = await text(await get("/servicing/mbr.asp?fn=det&mbr=100599", cookie));
    expect(body).toContain("restricted");
  });

  it("shows the savings balance on a valid member", async () => {
    const cookie = await signOn();
    const body = await text(await get("/servicing/mbr.asp?fn=det&mbr=100234", cookie));
    expect(body).toContain("Marguerite Delacroix-Whitfield");
    expect(body).toContain("4,182.55");
  });

  it("confirms a valid sub-account with a reference number", async () => {
    const cookie = await signOn();
    const body = await text(
      await post(
        "/servicing/acct.asp",
        { fn: "cfm", mbr: "100234", typ: "Holiday Club", nick: "Vacation", dep: "150.00" },
        cookie,
      ),
    );
    expect(body).toContain("opened successfully");
    expect(body).toMatch(/SA-0234-\d{5}/);
  });

  it("rejects a deposit below the minimum", async () => {
    const cookie = await signOn();
    const body = await text(
      await post("/servicing/acct.asp", { fn: "cfm", mbr: "100234", typ: "Holiday Club", dep: "5" }, cookie),
    );
    expect(body).toContain("at least 25.00");
  });

  it("rejects a non-numeric deposit", async () => {
    const cookie = await signOn();
    const body = await text(
      await post("/servicing/acct.asp", { fn: "cfm", mbr: "100234", typ: "Holiday Club", dep: "abc" }, cookie),
    );
    expect(body).toContain("not a valid amount");
  });

  it("issues stable reference numbers within a run", async () => {
    const cookie = await signOn();
    const one = await text(
      await post("/servicing/acct.asp", { fn: "cfm", mbr: "100234", typ: "Holiday Club", dep: "50" }, cookie),
    );
    const two = await text(
      await post("/servicing/acct.asp", { fn: "cfm", mbr: "100234", typ: "Holiday Club", dep: "50" }, cookie),
    );
    const ref = (b: string) => /SA-\d{4}-\d{5}/.exec(b)?.[0];
    expect(ref(one)).toBeDefined();
    expect(ref(two)).toBeDefined();
    expect(ref(one)).not.toBe(ref(two));
  });
});

describe("injected faults", () => {
  it("serves a 500 when armed", async () => {
    const cookie = await signOn();
    await get("/__control/fault?mode=error_500", cookie);
    const res = await get("/servicing/mbr.asp?fn=srch", cookie);
    expect(res.status).toBe(500);
  });

  it("interposes a dismissable interstitial, once", async () => {
    const cookie = await signOn();
    await get("/__control/fault?mode=interstitial", cookie);
    expect(await text(await get("/servicing/mbr.asp?fn=srch", cookie))).toContain("Continue Working");
    // A fault that stays armed turns a demonstration into an infinite loop.
    expect(await text(await get("/servicing/mbr.asp?fn=srch", cookie))).toContain("Member Number");
  });

  it("expires the session and refuses to serve until sign-on", async () => {
    const cookie = await signOn();
    await get("/__control/fault?mode=session_expired", cookie);
    expect(await text(await get("/servicing/mbr.asp?fn=srch", cookie))).toContain("timed out");
    // The session is genuinely gone, not merely reported as gone.
    expect(await text(await get("/servicing/mbr.asp?fn=srch", cookie))).toContain("timed out");
  });

  it("still serves the real page when merely slow", async () => {
    const cookie = await signOn();
    await get("/__control/fault?mode=slow&slowMs=150", cookie);
    const started = Date.now();
    const body = await text(await get("/servicing/mbr.asp?fn=srch", cookie));
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(body).toContain("Member Number");
  });

  it("rejects an unknown fault mode", async () => {
    const cookie = await signOn();
    const res = await get("/__control/fault?mode=nonsense", cookie);
    expect(res.status).toBe(400);
  });
});

describe("the surface stays hostile", () => {
  it("exposes no element ids, ARIA or test hooks anywhere in the flow", async () => {
    const cookie = await signOn();
    const pages = await Promise.all(
      [
        "/servicing/login.asp",
        "/servicing/nav.asp",
        "/servicing/mbr.asp?fn=srch",
        "/servicing/mbr.asp?fn=det&mbr=100234",
        "/servicing/acct.asp?fn=new&mbr=100234",
        "/servicing/acct.asp?fn=form&mbr=100234",
      ].map(async (p) => ({ p, body: await text(await get(p, cookie)) })),
    );

    for (const { p, body } of pages) {
      expect(body, `${p} must not carry element ids`).not.toMatch(/\sid\s*=/i);
      expect(body, `${p} must not carry ARIA`).not.toMatch(/\saria-/i);
      expect(body, `${p} must not carry test hooks`).not.toMatch(/data-test/i);
      expect(body, `${p} must not label inputs programmatically`).not.toMatch(/<label/i);
    }
  });

  it("keeps the console inside a real frameset", async () => {
    const cookie = await signOn();
    const body = await text(await get("/servicing/", cookie));
    expect(body).toMatch(/<FRAMESET/i);
    expect(body).toMatch(/NAME="mainfrm"/i);
  });

  it("keeps the sub-account form one frame deeper still", async () => {
    const cookie = await signOn();
    const shell = await text(await get("/servicing/acct.asp?fn=new&mbr=100234", cookie));
    expect(shell).toMatch(/<IFRAME/i);
    // The shell must not contain the form itself — that is the whole point.
    expect(shell).not.toMatch(/NAME="dep"/i);

    const inner = await text(await get("/servicing/acct.asp?fn=form&mbr=100234", cookie));
    expect(inner).toMatch(/NAME="dep"/i);
  });
});
