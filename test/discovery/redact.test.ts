import { describe, expect, it } from "vitest";
import { fieldIsSensitiveByName, loadRedactionPolicy, redactText, redactValue } from "../../src/discovery/redact.js";

const policy = loadRedactionPolicy({
  patterns: [
    { name: "ssn", regex: "\\b\\d{3}-\\d{2}-\\d{4}\\b" },
    { name: "email", regex: "[\\w.+-]+@[\\w-]+\\.[\\w.]+" },
  ],
  fieldNames: ["password", "ssn", "pin"],
  placeholder: "[redacted:{name}]",
});

describe("redaction at the perception boundary", () => {
  it("replaces a pattern match with the named placeholder", () => {
    expect(redactText("SSN on file: 123-45-6789", policy)).toBe("SSN on file: [redacted:ssn]");
  });

  it("redacts every match in a string, not just the first", () => {
    const out = redactText("contact a@b.com or c@d.com", policy);
    expect(out).toBe("contact [redacted:email] or [redacted:email]");
  });

  it("leaves text with no matches untouched", () => {
    expect(redactText("Marguerite Delacroix-Whitfield", policy)).toBe("Marguerite Delacroix-Whitfield");
  });

  it("flags a field as sensitive by its label regardless of casing", () => {
    expect(fieldIsSensitiveByName("Password", policy)).toBe(true);
    expect(fieldIsSensitiveByName("PIN Number", policy)).toBe(true);
    expect(fieldIsSensitiveByName("Member Number", policy)).toBe(false);
  });

  it("redacts a sensitive field's value even when it matches no pattern", () => {
    // A password does not look like an SSN or an email, so pattern matching
    // alone would let it straight through - the field-name check is what
    // actually catches it.
    expect(redactValue("hunter2", "Password", policy)).toBe("[redacted:field]");
  });

  it("still applies pattern redaction to a value from a non-sensitive field", () => {
    expect(redactValue("call 123-45-6789 for help", "Notes", policy)).toBe("call [redacted:ssn] for help");
  });
});
