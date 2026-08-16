/**
 * Two institutions running the same vendor software.
 *
 * `TargetBinding` (src/artifact/schema.ts) has always separated `app` (the
 * vendor product) from `tenant` (one institution's instance) - the whole
 * point being that a capability recorded against one tenant should be
 * reusable against another running the *same* underlying software, not
 * re-recorded per institution. This file is what makes that a checkable
 * claim rather than a paragraph of intent: a second tenant, same server
 * code, same seeded data, with the one rebrand this project's design
 * write-up has used throughout as its canonical example - "Search" becomes
 * "Find Member" - actually present on a real screen.
 */

export interface TenantBranding {
  id: string;
  /** Shown top-right on every content screen. */
  productLabel: string;
  /** The member-search button's own label. */
  searchButtonLabel: string;
}

export const MERIDIAN: TenantBranding = {
  id: "meridian",
  productLabel: "CoreVantage Servicing 7.2",
  searchButtonLabel: "Search",
};

export const NORTHSTAR: TenantBranding = {
  id: "northstar",
  productLabel: "CoreVantage Servicing 7.2 — Northstar Credit Union",
  searchButtonLabel: "Find Member",
};

export const TENANTS: Readonly<Record<string, TenantBranding>> = { meridian: MERIDIAN, northstar: NORTHSTAR };
