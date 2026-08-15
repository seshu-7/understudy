/**
 * Markup helpers for the servicing console.
 *
 * This is deliberately bad HTML, and every ugly thing in it is doing a job.
 *
 *   - HTML 4.01 Transitional, `<font>`, `bgcolor`, nested layout tables:
 *     there is no semantic structure to lean on.
 *   - Inputs carry `name` and nothing else. No `id`, no `<label for>`, no
 *     `data-testid`, no ARIA. A control's only textual association with its
 *     label is that the label sits in the table cell to its left.
 *   - Buttons are `<input type="submit" value="...">`, so their accessible
 *     name comes from the value attribute rather than element text.
 *
 * That combination is the point. It means a locator strategy cannot fall back
 * on a test id or a clean role tree, and has to work from what a human
 * operator actually perceives — which is the constraint the brief sets, and
 * the reason the descriptor matcher exists.
 */

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function money(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A bare document. Used for frames, which must not carry the page chrome. */
export function bare(title: string, body: string): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">
<HTML>
<HEAD>
<TITLE>${esc(title)}</TITLE>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=iso-8859-1">
</HEAD>
<BODY BGCOLOR="#FFFFFF" TEXT="#000000" LINK="#000080" VLINK="#000080" MARGINHEIGHT="4" MARGINWIDTH="4">
<FONT FACE="Verdana, Arial" SIZE="1">
${body}
</FONT>
</BODY>
</HTML>`;
}

/** The standard content-frame page: a title bar, then the body, then the
 *  status strip every screen in this product carries. */
export function screen(title: string, body: string, opts: { crumb?: string } = {}): string {
  return bare(
    title,
    `<TABLE WIDTH="100%" BORDER="0" CELLPADDING="0" CELLSPACING="0">
  <TR>
    <TD BGCOLOR="#003366">
      <TABLE WIDTH="100%" BORDER="0" CELLPADDING="3" CELLSPACING="0">
        <TR>
          <TD><FONT FACE="Verdana, Arial" SIZE="2" COLOR="#FFFFFF"><B>${esc(title)}</B></FONT></TD>
          <TD ALIGN="RIGHT"><FONT FACE="Verdana, Arial" SIZE="1" COLOR="#CCDDEE">CoreVantage Servicing 7.2</FONT></TD>
        </TR>
      </TABLE>
    </TD>
  </TR>
</TABLE>
${opts.crumb ? `<TABLE WIDTH="100%" BORDER="0" CELLPADDING="2" CELLSPACING="0"><TR><TD BGCOLOR="#EEEEEE"><FONT FACE="Verdana, Arial" SIZE="1">${opts.crumb}</FONT></TD></TR></TABLE>` : ""}
<BR>
<TABLE BORDER="0" CELLPADDING="2" CELLSPACING="0" WIDTH="100%">
  <TR><TD>
${body}
  </TD></TR>
</TABLE>
<BR><BR>
<TABLE WIDTH="100%" BORDER="0" CELLPADDING="2" CELLSPACING="0">
  <TR><TD BGCOLOR="#EEEEEE"><FONT FACE="Verdana, Arial" SIZE="1" COLOR="#666666">Teller: OPERATOR &nbsp;|&nbsp; Branch: Northgate &nbsp;|&nbsp; F1=Help F3=Exit</FONT></TD></TR>
</TABLE>`,
  );
}

/**
 * A form row. The label is plain text in the cell to the left of the input —
 * there is no programmatic association at all. This is the single most
 * important piece of hostility in the whole application: it is why the
 * descriptor needs a relative anchor ("the textbox after the text 'Member
 * Number'") rather than a label lookup.
 */
export function row(label: string, control: string, note?: string): string {
  return `  <TR>
    <TD ALIGN="RIGHT" VALIGN="TOP" NOWRAP><FONT FACE="Verdana, Arial" SIZE="1">${esc(label)}</FONT></TD>
    <TD VALIGN="TOP">${control}${note ? ` <FONT FACE="Verdana, Arial" SIZE="1" COLOR="#666666">${esc(note)}</FONT>` : ""}</TD>
  </TR>`;
}

export function textInput(name: string, value = "", size = 20, maxlength?: number): string {
  return `<INPUT TYPE="TEXT" NAME="${esc(name)}" VALUE="${esc(value)}" SIZE="${size}"${
    maxlength ? ` MAXLENGTH="${maxlength}"` : ""
  }>`;
}

export function selectInput(name: string, options: readonly string[], selected?: string): string {
  const opts = options
    .map((o) => `<OPTION VALUE="${esc(o)}"${o === selected ? " SELECTED" : ""}>${esc(o)}</OPTION>`)
    .join("");
  return `<SELECT NAME="${esc(name)}">${opts}</SELECT>`;
}

export function submit(value: string): string {
  return `<INPUT TYPE="SUBMIT" VALUE="${esc(value)}">`;
}

export function hidden(name: string, value: string): string {
  return `<INPUT TYPE="HIDDEN" NAME="${esc(name)}" VALUE="${esc(value)}">`;
}

/** A message block. Colour is the only thing distinguishing an error from a
 *  notice — there is no role, no alert semantics, nothing programmatic. The
 *  matcher has to find these by their text. */
export function message(kind: "error" | "notice", text: string): string {
  const bg = kind === "error" ? "#FFEEEE" : "#EEFFEE";
  const fg = kind === "error" ? "#990000" : "#006600";
  return `<TABLE BORDER="1" CELLPADDING="4" CELLSPACING="0" BORDERCOLOR="${fg}" BGCOLOR="${bg}">
  <TR><TD><FONT FACE="Verdana, Arial" SIZE="1" COLOR="${fg}"><B>${esc(text)}</B></FONT></TD></TR>
</TABLE><BR>`;
}
