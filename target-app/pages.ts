import { MINIMUM_DEPOSIT, SUB_ACCOUNT_KINDS, type Member } from "./data.js";
import { bare, esc, hidden, message, money, row, screen, selectInput, submit, textInput } from "./html.js";

/**
 * The screens.
 *
 * Flow: login -> search -> member detail -> open sub-account -> confirmation.
 * Search->detail->action->confirm is the shape the brief asks for, and it is
 * the shape most back-office servicing work actually takes.
 *
 * Two structural details worth knowing before reading:
 *
 *   1. The console shell is a real `<frameset>`. Navigating inside the content
 *      frame does not change the address bar, so "what page am I on" cannot be
 *      answered from the URL alone. Legacy banking software does this
 *      constantly and it is precisely what a naive URL checkpoint gets wrong.
 *
 *   2. The sub-account form lives in an `<iframe>` *inside* that content
 *      frame, and its confirmation renders there too. So the final checkpoint
 *      and the value to extract are two frames deep. If the frame path in a
 *      descriptor were decorative, this is where it would fall over.
 */

const PRODUCT = "CoreVantage Servicing";

export function loginPage(error?: string): string {
  return screen(
    "Sign On",
    `${error ? message("error", error) : ""}
<FORM METHOD="POST" ACTION="/servicing/logon.asp">
<TABLE BORDER="0" CELLPADDING="3" CELLSPACING="0">
${row("Operator ID", textInput("uid", "", 16))}
${row("Password", `<INPUT TYPE="PASSWORD" NAME="pwd" SIZE="16">`)}
  <TR><TD></TD><TD><BR>${submit("Sign On")}</TD></TR>
</TABLE>
</FORM>
<BR>
<FONT FACE="Verdana, Arial" SIZE="1" COLOR="#666666">
Demonstration system. Any operator id and password are accepted; no credential is stored or checked.
</FONT>`,
  );
}

/** The console shell. Note this is a frameset document, not a page. */
export function framesetDoc(): string {
  return `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Frameset//EN">
<HTML>
<HEAD><TITLE>${PRODUCT}</TITLE></HEAD>
<FRAMESET COLS="168,*" FRAMEBORDER="1" BORDER="2" FRAMESPACING="0">
  <FRAME NAME="navfrm" SRC="/servicing/nav.asp" SCROLLING="NO" MARGINWIDTH="0" MARGINHEIGHT="0">
  <FRAME NAME="mainfrm" SRC="/servicing/mbr.asp?fn=srch" MARGINWIDTH="4" MARGINHEIGHT="4">
</FRAMESET>
<NOFRAMES><BODY>This application requires frame support.</BODY></NOFRAMES>
</HTML>`;
}

export function navPage(): string {
  const item = (label: string, href: string) =>
    `<TR><TD BGCOLOR="#DDE4EC"><FONT FACE="Verdana, Arial" SIZE="1">&nbsp;<A HREF="${esc(href)}" TARGET="mainfrm">${esc(label)}</A></FONT></TD></TR>`;
  return bare(
    "Navigation",
    `<TABLE WIDTH="100%" BORDER="0" CELLPADDING="0" CELLSPACING="1" BGCOLOR="#AABBCC">
  <TR><TD BGCOLOR="#003366"><FONT FACE="Verdana, Arial" SIZE="1" COLOR="#FFFFFF">&nbsp;<B>SERVICING</B></FONT></TD></TR>
${item("Member Search", "/servicing/mbr.asp?fn=srch")}
${item("Account Inquiry", "/servicing/mbr.asp?fn=srch")}
${item("Transaction Journal", "/servicing/mbr.asp?fn=srch")}
  <TR><TD BGCOLOR="#003366"><FONT FACE="Verdana, Arial" SIZE="1" COLOR="#FFFFFF">&nbsp;<B>ADMIN</B></FONT></TD></TR>
${item("Sign Off", "/servicing/logoff.asp")}
</TABLE>`,
  );
}

export function searchPage(opts: { error?: string; value?: string } = {}): string {
  return screen(
    "Member Search",
    `${opts.error ? message("error", opts.error) : ""}
<FORM METHOD="GET" ACTION="/servicing/mbr.asp">
${hidden("fn", "det")}
<TABLE BORDER="0" CELLPADDING="3" CELLSPACING="0">
${row("Member Number", textInput("mbr", opts.value ?? "", 12, 6), "(6 digits)")}
  <TR><TD></TD><TD><BR>${submit("Search")}</TD></TR>
</TABLE>
</FORM>`,
    { crumb: "Servicing &gt; Member Search" },
  );
}

export function memberDetailPage(member: Member): string {
  const rows = member.accounts
    .map(
      (a) => `  <TR>
    <TD BGCOLOR="#FFFFFF"><FONT FACE="Verdana, Arial" SIZE="1">${esc(a.number)}</FONT></TD>
    <TD BGCOLOR="#FFFFFF"><FONT FACE="Verdana, Arial" SIZE="1">${esc(a.kind)}</FONT></TD>
    <TD BGCOLOR="#FFFFFF" ALIGN="RIGHT"><FONT FACE="Verdana, Arial" SIZE="1">${money(a.balance)}</FONT></TD>
    <TD BGCOLOR="#FFFFFF"><FONT FACE="Verdana, Arial" SIZE="1">${esc(a.opened)}</FONT></TD>
  </TR>`,
    )
    .join("\n");

  const head = (t: string, align = "LEFT") =>
    `<TD BGCOLOR="#CCD5DE" ALIGN="${align}"><FONT FACE="Verdana, Arial" SIZE="1"><B>${esc(t)}</B></FONT></TD>`;

  return screen(
    "Member Detail",
    `<TABLE BORDER="0" CELLPADDING="3" CELLSPACING="0">
${row("Member Number", `<FONT FACE="Verdana, Arial" SIZE="1"><B>${esc(member.id)}</B></FONT>`)}
${row("Member Name", `<FONT FACE="Verdana, Arial" SIZE="1"><B>${esc(member.name)}</B></FONT>`)}
${row("Status", `<FONT FACE="Verdana, Arial" SIZE="1">${esc(member.status.toUpperCase())}</FONT>`)}
${row("Home Branch", `<FONT FACE="Verdana, Arial" SIZE="1">${esc(member.branch)}</FONT>`)}
${row("Member Since", `<FONT FACE="Verdana, Arial" SIZE="1">${esc(member.joined)}</FONT>`)}
</TABLE>
<BR>
<FONT FACE="Verdana, Arial" SIZE="1"><B>Accounts</B></FONT>
<TABLE BORDER="0" CELLPADDING="3" CELLSPACING="1" BGCOLOR="#AABBCC">
  <TR>${head("Account")}${head("Type")}${head("Balance", "RIGHT")}${head("Opened")}</TR>
${rows || `  <TR><TD BGCOLOR="#FFFFFF" COLSPAN="4"><FONT FACE="Verdana, Arial" SIZE="1">No open accounts.</FONT></TD></TR>`}
</TABLE>
<BR>
<FONT FACE="Verdana, Arial" SIZE="1">
<A HREF="/servicing/acct.asp?fn=new&amp;mbr=${esc(member.id)}">Open Sub-Account</A>
&nbsp;|&nbsp;
<A HREF="/servicing/mbr.asp?fn=srch">New Search</A>
</FONT>`,
    { crumb: `Servicing &gt; Member Search &gt; ${esc(member.id)}` },
  );
}

/** The shell page. Its only job is to host the form in a nested iframe. */
export function subAccountShellPage(member: Member): string {
  return screen(
    "Open Sub-Account",
    `<FONT FACE="Verdana, Arial" SIZE="1">Member <B>${esc(member.id)}</B> &mdash; ${esc(member.name)}</FONT>
<BR><BR>
<IFRAME NAME="frmfrm" SRC="/servicing/acct.asp?fn=form&amp;mbr=${esc(member.id)}" WIDTH="100%" HEIGHT="300" FRAMEBORDER="0" SCROLLING="AUTO"></IFRAME>`,
    { crumb: `Servicing &gt; Member Search &gt; ${esc(member.id)} &gt; Open Sub-Account` },
  );
}

export function subAccountFormPage(
  member: Member,
  opts: { error?: string; kind?: string; nickname?: string; deposit?: string } = {},
): string {
  return bare(
    "New Sub-Account",
    `${opts.error ? message("error", opts.error) : ""}
<FORM METHOD="POST" ACTION="/servicing/acct.asp">
${hidden("fn", "cfm")}
${hidden("mbr", member.id)}
<TABLE BORDER="0" CELLPADDING="3" CELLSPACING="0">
${row("Account Type", selectInput("typ", SUB_ACCOUNT_KINDS, opts.kind))}
${row("Nickname", textInput("nick", opts.nickname ?? "", 24, 32), "(optional)")}
${row("Initial Deposit", textInput("dep", opts.deposit ?? "", 12), `(minimum ${money(MINIMUM_DEPOSIT)})`)}
  <TR><TD></TD><TD><BR>${submit("Open Account")}</TD></TR>
</TABLE>
</FORM>`,
  );
}

export function confirmationPage(
  member: Member,
  reference: string,
  detail: { kind: string; nickname: string; deposit: number },
): string {
  return bare(
    "Sub-Account Confirmation",
    `${message("notice", "Sub-account opened successfully.")}
<TABLE BORDER="0" CELLPADDING="3" CELLSPACING="0">
${row("Reference Number", `<FONT FACE="Verdana, Arial" SIZE="1"><B>${esc(reference)}</B></FONT>`)}
${row("Member Number", `<FONT FACE="Verdana, Arial" SIZE="1">${esc(member.id)}</FONT>`)}
${row("Account Type", `<FONT FACE="Verdana, Arial" SIZE="1">${esc(detail.kind)}</FONT>`)}
${row("Nickname", `<FONT FACE="Verdana, Arial" SIZE="1">${esc(detail.nickname || "(none)")}</FONT>`)}
${row("Opening Deposit", `<FONT FACE="Verdana, Arial" SIZE="1">${money(detail.deposit)}</FONT>`)}
</TABLE>`,
  );
}

/**
 * The unexpected dialog. Recoverable: dismiss and continue. Note it is not a
 * real dialog — it is a whole page that replaced the one that was asked for,
 * which is how these actually behave in server-rendered applications and is
 * harder to detect than a modal.
 */
export function interstitialPage(path: string, params: Record<string, string>): string {
  // The query string is carried as hidden fields rather than left on the
  // action URL, because a GET form discards an action's existing query string.
  const carried = Object.entries(params)
    .map(([k, v]) => hidden(k, v))
    .join("\n");
  return screen(
    "Session Notice",
    `${message("notice", "Your session has been idle. Confirm you are still working to continue.")}
<FONT FACE="Verdana, Arial" SIZE="1">This confirmation appears periodically as required by policy.</FONT>
<BR><BR>
<FORM METHOD="GET" ACTION="${esc(path)}">
${carried}
${submit("Continue Working")}
</FORM>`,
  );
}

/** Not recoverable by automation. Re-authenticating would need a credential
 *  the system deliberately does not hold, so this is the escalation case. */
export function sessionExpiredPage(): string {
  return screen(
    "Session Expired",
    `${message("error", "Your session has timed out. Please sign on again.")}
<FONT FACE="Verdana, Arial" SIZE="1">
Unsaved work has been discarded.
<A HREF="/servicing/login.asp">Return to Sign On</A>
</FONT>`,
  );
}

export function serverErrorPage(): string {
  return bare(
    "Server Error",
    `<BR>
<TABLE BORDER="0" CELLPADDING="4" CELLSPACING="0">
  <TR><TD><FONT FACE="Verdana, Arial" SIZE="3"><B>HTTP 500 - Internal Server Error</B></FONT></TD></TR>
  <TR><TD><FONT FACE="Verdana, Arial" SIZE="1">The request could not be completed. Reference CVS-0x8007005E.</FONT></TD></TR>
  <TR><TD><FONT FACE="Verdana, Arial" SIZE="1">If the problem persists contact the service desk.</FONT></TD></TR>
</TABLE>`,
  );
}

export function notFoundPage(): string {
  return bare("Not Found", `<FONT FACE="Verdana, Arial" SIZE="2">HTTP 404 - Page not found.</FONT>`);
}
