/// <reference lib="dom" />

/**
 * The in-page collector.
 *
 * This function is serialised and executed inside the browser, once per frame,
 * so it must be entirely self-contained — no imports, no closure over module
 * scope. It returns plain data; the adapter brands and assembles it.
 *
 * Its job is to answer, for every element a human operator could perceive:
 * what kind of control is this, what is it called, what is it called *by the
 * text next to it*, where does it sit, and what contains it. That last pair is
 * what makes the legacy screens addressable at all — the controls there have
 * no accessible name and no label association, so their only identity is
 * positional.
 */

/** The wire shape. Deliberately not the branded `UINode`: this crosses a
 *  serialisation boundary, and brands do not survive that trip. */
export interface RawNode {
  handle: string;
  role: string;
  name: string;
  label: string;
  value: string;
  disabled: boolean;
  readonly: boolean;
  required: boolean;
  focused: boolean;
  checked: boolean | null;
  bounds: { x: number; y: number; width: number; height: number } | null;
  ancestry: { role: string; name: string }[];
  visible: boolean;
}

export interface RawFrame {
  title: string;
  location: string;
  nodes: RawNode[];
}

/**
 * Runs in the page. `framePath` is the dotted path used to build the handle
 * attribute, so a handle is unique across every frame in one snapshot.
 */
export function collectFrame(framePath: string): RawFrame {
  const HANDLE_ATTR = "data-understudy-ref";

  const text = (el: Element | null): string =>
    el ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : "";

  const isVisible = (el: Element): boolean => {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const roleOf = (el: Element): string | null => {
    const tag = el.tagName.toUpperCase();
    if (tag === "INPUT") {
      const type = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (type === "hidden") return null;
      if (type === "submit" || type === "button" || type === "reset" || type === "image") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      return "textbox";
    }
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "SELECT") return "combobox";
    if (tag === "OPTION") return "option";
    if (tag === "BUTTON") return "button";
    if (tag === "A") return el.hasAttribute("href") ? "link" : null;
    if (tag === "IMG") return "image";
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "TABLE") return "table";
    if (tag === "FORM") return "form";
    if (tag === "FIELDSET") return "region";
    return null;
  };

  /** Accessible name, computed the way a screen reader would and no further.
   *  For the text inputs in this application the honest answer is "" — there
   *  is nothing to compute a name from, and pretending otherwise would hide
   *  the exact problem the matcher exists to solve. */
  const nameOf = (el: Element, role: string): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.trim();

    const id = el.getAttribute("id");
    if (id) {
      const labelled = el.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (labelled) return text(labelled);
    }

    const tag = el.tagName.toUpperCase();
    if (tag === "INPUT") {
      const input = el as HTMLInputElement;
      const type = (input.type || "text").toLowerCase();
      // A submit button's name comes from its value attribute, which is why
      // this application's buttons are addressable at all.
      if (type === "submit" || type === "button" || type === "reset") return (input.value || "").trim();
      return "";
    }
    if (tag === "IMG") return (el.getAttribute("alt") ?? "").trim();
    if (role === "link" || role === "button" || role === "heading" || role === "option") return text(el);
    if (role === "textbox" || role === "combobox") return "";
    return text(el);
  };

  /**
   * The label a human reads beside the control.
   *
   * Legacy forms put the label in the table cell to the left and associate it
   * with nothing. So: look left within the row, then fall back to text
   * immediately preceding the control. This is the single most valuable signal
   * on these screens and it is invisible to every DOM-based locator strategy.
   */
  const labelOf = (el: Element): string => {
    const cell = el.closest("td, th");
    if (cell) {
      let previous = cell.previousElementSibling;
      while (previous) {
        const candidate = text(previous);
        if (candidate) return candidate;
        previous = previous.previousElementSibling;
      }
    }
    let sibling = el.previousSibling;
    while (sibling) {
      const candidate =
        sibling.nodeType === Node.TEXT_NODE
          ? (sibling.textContent ?? "").replace(/\s+/g, " ").trim()
          : text(sibling as Element);
      if (candidate) return candidate;
      sibling = sibling.previousSibling;
    }
    return "";
  };

  /** Name a containing section by its caption, legend, or the nearest text
   *  that precedes it — which is how "Accounts" ends up naming the account
   *  grid despite there being no markup saying so. */
  const sectionName = (el: Element): string => {
    const caption = el.querySelector(":scope > caption, :scope > legend");
    if (caption) return text(caption);
    let previous = el.previousElementSibling;
    let hops = 0;
    while (previous && hops < 4) {
      const candidate = text(previous);
      if (candidate && candidate.length <= 60) return candidate;
      previous = previous.previousElementSibling;
      hops++;
    }
    return "";
  };

  const ancestryOf = (el: Element): { role: string; name: string }[] => {
    const chain: { role: string; name: string }[] = [];
    let parent = el.parentElement;
    while (parent) {
      const tag = parent.tagName.toUpperCase();
      if (tag === "FORM" || tag === "FIELDSET" || tag === "TABLE") {
        const name = sectionName(parent);
        if (name) chain.push({ role: tag === "FORM" ? "form" : tag === "TABLE" ? "table" : "region", name });
      }
      parent = parent.parentElement;
    }
    // The screen itself, always available and always meaningful. It is how an
    // operator would describe location: "the Member Number field on Member
    // Detail".
    chain.push({ role: "region", name: document.title });
    return chain;
  };

  // Clear handles from any previous observation so refs never survive a
  // snapshot. They are meaningless across observations by design.
  for (const stale of Array.from(document.querySelectorAll(`[${HANDLE_ATTR}]`))) {
    stale.removeAttribute(HANDLE_ATTR);
  }

  const nodes: RawNode[] = [];
  let index = 0;

  for (const el of Array.from(document.querySelectorAll("*"))) {
    const role = roleOf(el);
    if (!role) continue;

    const handle = `${framePath}#${index++}`;
    el.setAttribute(HANDLE_ATTR, handle);

    const rect = el.getBoundingClientRect();
    const input = el as HTMLInputElement;
    const isFormControl = role === "textbox" || role === "combobox" || role === "checkbox" || role === "radio";

    nodes.push({
      handle,
      role,
      name: nameOf(el, role),
      label: isFormControl ? labelOf(el) : "",
      value: isFormControl ? (input.value ?? "") : "",
      disabled: Boolean((el as HTMLInputElement).disabled),
      readonly: Boolean((el as HTMLInputElement).readOnly),
      required: Boolean((el as HTMLInputElement).required),
      focused: document.activeElement === el,
      checked: role === "checkbox" || role === "radio" ? Boolean(input.checked) : null,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      ancestry: ancestryOf(el),
      visible: isVisible(el),
    });
  }

  // Text-bearing leaves, collected separately so that a `<td>` wrapping a
  // `<font>` wrapping the words does not yield three copies of one string.
  const seen = new Set<Element>();
  for (const el of Array.from(document.querySelectorAll("td, th, p, li, span, font, b, div"))) {
    if (el.children.length > 0) continue;
    const content = text(el);
    if (!content) continue;

    // Skip when an ancestor already contributed exactly this text.
    let ancestor = el.parentElement;
    let duplicate = false;
    while (ancestor) {
      if (seen.has(ancestor) && text(ancestor) === content) {
        duplicate = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (duplicate) continue;
    seen.add(el);

    const handle = `${framePath}#${index++}`;
    el.setAttribute(HANDLE_ATTR, handle);
    const rect = el.getBoundingClientRect();

    nodes.push({
      handle,
      role: "text",
      name: content,
      label: "",
      value: "",
      disabled: false,
      readonly: false,
      required: false,
      focused: false,
      checked: null,
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      ancestry: ancestryOf(el),
      visible: isVisible(el),
    });
  }

  // Document order, so "the first textbox after the text 'Member Number'"
  // means what it says. Elements and text leaves were collected in separate
  // passes, so this re-interleaves them.
  nodes.sort((a, b) => {
    const left = document.querySelector(`[${HANDLE_ATTR}="${a.handle}"]`);
    const right = document.querySelector(`[${HANDLE_ATTR}="${b.handle}"]`);
    if (!left || !right) return 0;
    const relation = left.compareDocumentPosition(right);
    if (relation & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (relation & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  return { title: document.title, location: location.href, nodes };
}
