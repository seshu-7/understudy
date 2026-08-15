/**
 * The servicing console.
 *
 * Plain `node:http` and hand-written HTML, no framework and no dependencies.
 * That is a deliberate choice twice over: a framework would hand us clean
 * semantic markup, which is exactly what this application must not have, and
 * a dependency-free prop keeps `npm install` honest for whoever reviews this.
 *
 * Run: npm run target-app
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import { MINIMUM_DEPOSIT, SUB_ACCOUNT_KINDS, lookupMember, referenceFor, type Member } from "./data.js";
import * as faults from "./faults.js";
import {
  confirmationPage,
  framesetDoc,
  interstitialPage,
  loginPage,
  memberDetailPage,
  navPage,
  notFoundPage,
  searchPage,
  serverErrorPage,
  sessionExpiredPage,
  subAccountFormPage,
  subAccountShellPage,
} from "./pages.js";

const PORT = Number(process.env["TARGET_APP_PORT"] ?? 4501);
const SESSION_COOKIE = "CVSESS";

/** Live sessions. A restart signs everybody out, which is fine for a prop. */
const sessions = new Set<string>();

/** Per-member counter so confirmation references are stable within a run. */
const openedCount = new Map<string, number>();

function html(res: ServerResponse, body: string, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=iso-8859-1",
    // Legacy servers do this, and it stops a stale frame masking a real
    // navigation while a run is being observed.
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    ...headers,
  });
  res.end(body);
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(302, { Location: to });
  res.end();
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function cookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function signedOn(req: IncomingMessage): boolean {
  const sid = cookies(req)[SESSION_COOKIE];
  return sid !== undefined && sessions.has(sid);
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  return Object.fromEntries(params.entries());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Applies whatever fault is armed for this request. Returns true when the
 * fault produced the response and routing should stop.
 */
async function applyFault(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const mode = faults.take(url.pathname);
  switch (mode) {
    case "none":
      return false;

    case "slow":
      // Still serves the real page — this is transient slowness, not an
      // error, and a replay that gives up here has its timeout set wrong.
      await sleep(faults.currentSlowMs());
      return false;

    case "error_500":
      html(res, serverErrorPage(), 500);
      return true;

    case "session_expired": {
      const sid = cookies(req)[SESSION_COOKIE];
      if (sid) sessions.delete(sid);
      html(res, sessionExpiredPage(), 200, {
        "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0`,
      });
      return true;
    }

    case "interstitial": {
      const params = Object.fromEntries(url.searchParams.entries());
      html(res, interstitialPage(url.pathname, params));
      return true;
    }
  }
}

function handleControl(url: URL, res: ServerResponse): void {
  switch (url.pathname) {
    case "/__control/status":
      return json(res, faults.status());

    case "/__control/reset":
      faults.reset();
      return json(res, { ok: true, ...faults.status() });

    case "/__control/fault": {
      const mode = url.searchParams.get("mode") ?? "none";
      if (!faults.isFaultMode(mode)) {
        return json(res, { ok: false, error: `unknown mode "${mode}"`, modes: faults.FAULT_MODES }, 400);
      }
      const once = url.searchParams.get("once") !== "0";
      const path = url.searchParams.get("path") ?? "";
      const slow = url.searchParams.get("slowMs");
      faults.arm(mode, { once, path, ...(slow ? { slowMs: Number(slow) } : {}) });
      return json(res, { ok: true, ...faults.status() });
    }

    default:
      return json(res, { ok: false, error: "unknown control endpoint" }, 404);
  }
}

function handleMember(url: URL, res: ServerResponse): void {
  const fn = url.searchParams.get("fn") ?? "srch";
  if (fn === "srch") return html(res, searchPage());

  const raw = url.searchParams.get("mbr") ?? "";
  const result = lookupMember(raw);
  switch (result.kind) {
    case "ok":
      return html(res, memberDetailPage(result.member));
    // Everything below re-renders the search screen carrying a message. That
    // is what this product does, and it matters for the replay contract: the
    // automation lands on a page that looks like where it started, so "did I
    // navigate?" is not a sufficient checkpoint.
    case "invalid_id":
    case "not_found":
    case "restricted":
      return html(res, searchPage({ error: result.message, value: raw }));
  }
}

function requireMember(url: URL, res: ServerResponse): Member | null {
  const result = lookupMember(url.searchParams.get("mbr") ?? "");
  if (result.kind !== "ok") {
    html(res, searchPage({ error: result.message }));
    return null;
  }
  return result.member;
}

async function handleAccount(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
  if (req.method === "POST") {
    const form = await readForm(req);
    const lookup = lookupMember(form["mbr"] ?? "");
    if (lookup.kind !== "ok") return html(res, searchPage({ error: lookup.message }));
    const member = lookup.member;

    const kind = form["typ"] ?? SUB_ACCOUNT_KINDS[0];
    const nickname = (form["nick"] ?? "").trim();
    const rawDeposit = (form["dep"] ?? "").trim();
    const deposit = Number(rawDeposit.replace(/[$,]/g, ""));

    const reject = (error: string) =>
      html(res, subAccountFormPage(member, { error, kind, nickname, deposit: rawDeposit }));

    if (rawDeposit === "") return reject("Initial deposit is required.");
    if (!Number.isFinite(deposit)) return reject(`"${rawDeposit}" is not a valid amount.`);
    if (deposit < MINIMUM_DEPOSIT) {
      return reject(`Initial deposit must be at least ${MINIMUM_DEPOSIT.toFixed(2)}.`);
    }

    const seq = (openedCount.get(member.id) ?? 0) + 1;
    openedCount.set(member.id, seq);
    return html(res, confirmationPage(member, referenceFor(member.id, seq), { kind, nickname, deposit }));
  }

  const fn = url.searchParams.get("fn") ?? "new";
  const member = requireMember(url, res);
  if (!member) return;
  return html(res, fn === "form" ? subAccountFormPage(member) : subAccountShellPage(member));
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname;

  if (path.startsWith("/__control/")) return handleControl(url, res);

  if (path === "/" || path === "/servicing" || path === "/servicing/") {
    return signedOn(req) ? html(res, framesetDoc()) : redirect(res, "/servicing/login.asp");
  }

  if (path === "/servicing/login.asp") return html(res, loginPage());

  if (path === "/servicing/logon.asp" && req.method === "POST") {
    const form = await readForm(req);
    if (!(form["uid"] ?? "").trim()) return html(res, loginPage("Operator ID is required."));
    const sid = randomUUID();
    sessions.add(sid);
    res.writeHead(302, {
      Location: "/servicing/",
      "Set-Cookie": `${SESSION_COOKIE}=${sid}; Path=/; HttpOnly`,
    });
    res.end();
    return;
  }

  if (path === "/servicing/logoff.asp") {
    const sid = cookies(req)[SESSION_COOKIE];
    if (sid) sessions.delete(sid);
    return html(res, loginPage("You have been signed off."), 200, {
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0`,
    });
  }

  // Everything past this point needs a session, and can carry a fault.
  if (!signedOn(req)) return html(res, sessionExpiredPage());
  if (await applyFault(req, res, url)) return;

  if (path === "/servicing/nav.asp") return html(res, navPage());
  if (path === "/servicing/mbr.asp") return handleMember(url, res);
  if (path === "/servicing/acct.asp") return handleAccount(req, url, res);

  return html(res, notFoundPage(), 404);
}

/** Built without listening so tests can bind an ephemeral port and run the
 *  real application rather than a stand-in for it. */
export function createServicingServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    route(req, res, url).catch((err: unknown) => {
      process.stderr.write(`[target-app] ${String(err)}\n`);
      if (!res.headersSent) html(res, serverErrorPage(), 500);
    });
  });
}

/** Clears every piece of in-memory state, so one test cannot leak a session
 *  or an armed fault into the next. */
export function resetState(): void {
  sessions.clear();
  openedCount.clear();
  faults.reset();
}

export const DEFAULT_PORT = PORT;
