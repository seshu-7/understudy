import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";

import { match } from "../match.js";
import { collectFrame, type RawFrame, type RawNode } from "./collect.js";
import {
  nodeRef,
  type Action,
  type Ancestor,
  type CapturedEvidence,
  type FramePath,
  type Role,
  type Surface,
  type UINode,
  type UISnapshot,
} from "../types.js";

/**
 * A browser-backed Surface.
 *
 * Playwright appears in this file and nowhere else in the system. Everything
 * above the Surface interface deals in roles, names and relationships, which
 * is what makes the desktop claim in the write-up a seam rather than a wish:
 * a UI Automation adapter would reimplement `observe` and `act` and change
 * nothing else.
 *
 * One thing worth naming rather than hiding: `observe` stamps a temporary
 * attribute on each element so that `act` can find it again. That is a handle
 * *we* assign from what we perceived, not a test id the application provides —
 * it is cleared and reassigned on every observation, and the branded NodeRef
 * type makes persisting one a compile error. The application under test still
 * has no automation hooks of its own, which is the property that matters.
 */

const HANDLE_ATTR = "data-understudy-ref";

/**
 * Builds the expression evaluated inside the page.
 *
 * The collector is written as an ordinary typed function so it can be read and
 * checked like the rest of the codebase, but it cannot simply be handed to
 * `evaluate`. This project runs TypeScript through esbuild, which compiles
 * with `keepNames` and therefore wraps every inner function in a `__name()`
 * helper. That helper exists in the Node module scope and not in the browser,
 * so passing the function directly fails at runtime with a bare
 * `ReferenceError: __name is not defined` — and, because the collector is one
 * big function, the failure takes the entire observation with it.
 *
 * Serialising the source and supplying a no-op shim removes the dependency on
 * how the toolchain happens to compile today.
 */
function collectSource(framePath: string): string {
  return `(() => {
    const __name = (fn) => fn;
    const collect = ${collectFrame.toString()};
    return collect(${JSON.stringify(framePath)});
  })()`;
}

function isTransientFrameError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes("Execution context was destroyed") ||
    message.includes("frame was detached") ||
    message.includes("Frame was detached") ||
    message.includes("Target closed")
  );
}

export interface WebSurfaceOptions {
  headless?: boolean;
  viewport?: { width: number; height: number };
  /** Per-action ceiling. Deliberately short: a legacy screen that has not
   *  responded in this long has not merely been slow. */
  actionTimeoutMs?: number;
}

function framePathOf(frame: Frame, page: Page): FramePath {
  const path: string[] = [];
  let current: Frame | null = frame;
  while (current && current !== page.mainFrame()) {
    path.unshift(current.name() || new URL(current.url()).pathname);
    current = current.parentFrame();
  }
  return path;
}

function toRole(raw: string): Role {
  const known: readonly Role[] = [
    "button", "link", "textbox", "checkbox", "radio", "combobox", "option",
    "listitem", "row", "cell", "heading", "text", "image", "dialog", "alert",
    "table", "form", "region", "tab", "unknown",
  ];
  return (known as readonly string[]).includes(raw) ? (raw as Role) : "unknown";
}

function toNode(raw: RawNode, frame: FramePath): UINode {
  const ancestry: Ancestor[] = raw.ancestry.map((a) => ({ role: toRole(a.role), name: a.name }));
  const node: UINode = {
    ref: nodeRef(raw.handle),
    role: toRole(raw.role),
    name: raw.name,
    state: {
      disabled: raw.disabled,
      readonly: raw.readonly,
      required: raw.required,
      focused: raw.focused,
      ...(raw.checked !== null ? { checked: raw.checked } : {}),
    },
    frame,
    ancestry,
    ordinal: 0,
    visible: raw.visible,
  };
  if (raw.label) node.label = raw.label;
  if (raw.value) node.value = raw.value;
  if (raw.bounds) node.bounds = raw.bounds;
  return node;
}

/** Index among same-role siblings inside the same nearest-named section. The
 *  weakest signal the matcher has, and the only one that is purely positional,
 *  so it is computed here rather than in the page where it would be guesswork. */
function assignOrdinals(nodes: UINode[]): void {
  const counters = new Map<string, number>();
  for (const node of nodes) {
    const section = node.ancestry[0]?.name ?? "";
    const key = `${node.frame.join("/")}|${section}|${node.role}`;
    const next = counters.get(key) ?? 0;
    node.ordinal = next;
    counters.set(key, next + 1);
  }
}

function digestOf(nodes: readonly UINode[]): string {
  const material = nodes
    .map((n) => `${n.frame.join("/")}|${n.role}|${n.name}|${n.label ?? ""}|${n.value ?? ""}`)
    .join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export class WebSurface implements Surface {
  readonly kind = "web" as const;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly actionTimeoutMs: number,
  ) {}

  static async launch(entryPoint: string, options: WebSurfaceOptions = {}): Promise<WebSurface> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const surface = new WebSurface(browser, context, page, options.actionTimeoutMs ?? 10_000);
    await page.goto(entryPoint, { waitUntil: "domcontentloaded" });
    return surface;
  }

  async observe(): Promise<UISnapshot> {
    await this.settle();

    const nodes: UINode[] = [];
    let title = "";
    let location = this.page.url();

    for (const frame of this.page.frames()) {
      if (frame.isDetached()) continue;
      const path = framePathOf(frame, this.page);
      let collected: RawFrame;
      try {
        collected = (await frame.evaluate(collectSource(path.join("/")))) as RawFrame;
      } catch (error) {
        // A frame that navigated out from under us mid-collection is expected
        // and the next observation picks it up. Anything else is a real
        // defect, and swallowing it yields an empty snapshot that reads as
        // "the screen has nothing on it" — a far worse failure than a throw.
        if (isTransientFrameError(error)) continue;
        throw new Error(`collecting frame ${JSON.stringify(path.join("/"))} failed: ${String(error)}`);
      }

      if (path.length === 0) {
        title = collected.title;
        location = collected.location;
      }
      for (const raw of collected.nodes) nodes.push(toNode(raw, path));
    }

    assignOrdinals(nodes);

    return {
      snapshotId: createHash("sha1").update(`${Date.now()}:${location}`).digest("hex").slice(0, 12),
      takenAt: new Date().toISOString(),
      kind: this.kind,
      location,
      title,
      nodes,
      digest: digestOf(nodes),
    };
  }

  async act(action: Action): Promise<void> {
    switch (action.kind) {
      case "click": {
        const before = this.snapshotFrameUrls();
        await this.locate(action.target).click({ timeout: this.actionTimeoutMs });
        return this.settle(before);
      }

      case "fill":
        await this.locate(action.target).fill(action.text, { timeout: this.actionTimeoutMs });
        return;

      case "select":
        await this.locate(action.target).selectOption(action.option, { timeout: this.actionTimeoutMs });
        return;

      case "press": {
        const before = this.snapshotFrameUrls();
        await this.page.keyboard.press(action.key);
        return this.settle(before);
      }

      case "navigate":
        await this.page.goto(action.to, { waitUntil: "domcontentloaded", timeout: this.actionTimeoutMs });
        return;

      case "wait":
        return this.waitFor(action);
    }
  }

  async capture(): Promise<CapturedEvidence> {
    const bytes = await this.page.screenshot({ fullPage: true });
    return { kind: "screenshot", mediaType: "image/png", bytes };
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }

  /** Exposed for the handoff seam in Phase 7: a human takes control of *this*
   *  page, not a fresh one. */
  livePage(): Page {
    return this.page;
  }

  private locate(ref: string) {
    // The handle encodes its own frame path, so the ref alone is enough to
    // find the element again without the caller tracking frames.
    const [framePart = ""] = ref.split("#");
    const path = framePart ? framePart.split("/") : [];
    const frame = this.page
      .frames()
      .find((f) => !f.isDetached() && framePathOf(f, this.page).join("/") === path.join("/"));
    const scope = frame ?? this.page.mainFrame();
    return scope.locator(`[${HANDLE_ATTR}="${ref}"]`);
  }

  /** frame identity (name, falling back to url for the unnamed top document)
   *  -> its current url. Used to detect that a navigation actually happened,
   *  as opposed to merely that nothing is currently in flight. */
  private snapshotFrameUrls(): Map<string, string> {
    const map = new Map<string, string>();
    for (const frame of this.page.frames()) {
      if (!frame.isDetached()) map.set(frame.name() || "__top__", frame.url());
    }
    return map;
  }

  /**
   * Wait for the surface to stop moving.
   *
   * Two distinct races live here, and both only show up under real timing
   * pressure - three fast, unloaded runs missed both of them.
   *
   * The first is a frameset-specific trap: the top document loads once and
   * never navigates again no matter how many screens the operator moves
   * through, so `page.waitForLoadState()` alone returns instantly and always,
   * and the next observation captures the *previous* screen. Network
   * quiescence is the signal that actually tracks a frame navigation, since
   * it is a page-level request either way.
   *
   * The second is subtler and not specific to framesets: `waitForLoadState`
   * reports whatever the *current* document's lifecycle state already is. If
   * it is called before the click's resulting navigation has started
   * dispatching requests - which becomes more likely, not less, under CPU
   * contention - the old, already-settled document satisfies "idle"
   * immediately, and settle() returns before the new page has begun loading
   * at all. `before`, when supplied, is a pre-action snapshot of every
   * frame's URL; this method first waits for at least one of them to
   * actually change, closing that race directly instead of hoping the load-
   * state heuristics happen to run late enough to see it.
   */
  private async settle(before?: ReadonlyMap<string, string>): Promise<void> {
    if (before) {
      const deadline = Date.now() + this.actionTimeoutMs;
      while (Date.now() < deadline) {
        const after = this.snapshotFrameUrls();
        let navigated = after.size !== before.size;
        if (!navigated) {
          for (const [key, url] of after) {
            if (before.get(key) !== url) {
              navigated = true;
              break;
            }
          }
        }
        if (navigated) break;
        await this.page.waitForTimeout(50);
      }
      // No frame's URL changed within the deadline. That is not necessarily
      // wrong - some actions genuinely do not navigate anything - so this
      // falls through to the load-state heuristics below rather than failing
      // outright; a step whose checkpoint actually needed a navigation will
      // catch the case where none happened.
    }

    try {
      await this.page.waitForLoadState("domcontentloaded", { timeout: this.actionTimeoutMs });
    } catch {
      // A slow page is not a failed one; the step's checkpoint decides.
    }

    try {
      await this.page.waitForLoadState("networkidle", { timeout: 3_000 });
    } catch {
      // Something is still chattering. Proceed and let the checkpoint judge.
    }

    await Promise.all(
      this.page
        .frames()
        .filter((frame) => !frame.isDetached())
        .map((frame) => frame.waitForLoadState("domcontentloaded").catch(() => undefined)),
    );
  }

  private async waitFor(action: Extract<Action, { kind: "wait" }>): Promise<void> {
    const deadline = Date.now() + action.timeoutMs;

    if (action.until.kind === "settled") {
      await this.settle();
      return;
    }

    while (Date.now() < deadline) {
      if (action.until.kind === "location_matches") {
        if (new RegExp(action.until.pattern).test(this.page.url())) return;
      } else {
        const snapshot = await this.observe();
        const result = match(action.until.descriptor, snapshot);
        const present = result.status === "unique";
        if (action.until.kind === "node_present" && present) return;
        if (action.until.kind === "node_absent" && !present) return;
      }
      await this.page.waitForTimeout(200);
    }

    throw new Error(`wait for ${action.until.kind} exceeded ${action.timeoutMs}ms`);
  }
}
