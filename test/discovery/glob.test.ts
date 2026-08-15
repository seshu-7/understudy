import { describe, expect, it } from "vitest";
import { globToRegExp, matchesAny } from "../../src/discovery/glob.js";

describe("policy globs", () => {
  it("matches ** across any number of path segments", () => {
    expect(globToRegExp("/servicing/**").test("/servicing/mbr.asp")).toBe(true);
    expect(globToRegExp("/servicing/**").test("/servicing/acct.asp/form")).toBe(true);
    expect(globToRegExp("/servicing/**").test("/admin/mbr.asp")).toBe(false);
  });

  it("matches * within a single segment only", () => {
    expect(globToRegExp("/servicing/*.asp").test("/servicing/mbr.asp")).toBe(true);
    expect(globToRegExp("/servicing/*.asp").test("/servicing/sub/mbr.asp")).toBe(false);
  });

  it("matches ** on both sides of a literal segment", () => {
    expect(globToRegExp("/servicing/**/delete").test("/servicing/acct/123/delete")).toBe(true);
    expect(globToRegExp("/servicing/**/delete").test("/servicing/acct/123/confirm")).toBe(false);
  });

  it("matchesAny is true if any one pattern hits", () => {
    expect(matchesAny("/servicing/mbr.asp", ["/admin/**", "/servicing/**"])).toBe(true);
    expect(matchesAny("/other", ["/admin/**", "/servicing/**"])).toBe(false);
  });
});
