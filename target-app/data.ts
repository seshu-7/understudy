/**
 * Seeded records for the servicing console. In memory, reset on restart.
 * This is a prop, not a system of record.
 *
 * The data is shaped to produce the outcome classes the replay engine has to
 * tell apart, from ordinary inputs rather than injected faults:
 *   - an unknown id gives "member not found"      (business outcome)
 *   - a malformed id gives a validation error      (business outcome)
 *   - a restricted member gives a permission denial (hard failure)
 *   - a closed member gives a different business outcome again
 *
 * Names are deliberately awkward (accents, hyphens, varying length), because
 * accessible-name matching that only works on "John Smith" isn't matching.
 */

export type MemberStatus = "active" | "closed" | "restricted";

export interface Account {
  number: string;
  kind: string;
  balance: number;
  opened: string;
}

export interface Member {
  id: string;
  name: string;
  status: MemberStatus;
  branch: string;
  joined: string;
  accounts: Account[];
}

export const MEMBERS: ReadonlyMap<string, Member> = new Map(
  (
    [
      {
        id: "100234",
        name: "Marguerite Delacroix-Whitfield",
        status: "active",
        branch: "Northgate",
        joined: "1998-04-17",
        accounts: [
          { number: "100234-01", kind: "Regular Savings", balance: 4182.55, opened: "1998-04-17" },
          { number: "100234-02", kind: "Checking", balance: 1204.1, opened: "2003-11-02" },
        ],
      },
      {
        id: "100235",
        name: "Aaron Villanueva",
        status: "active",
        branch: "Northgate",
        joined: "2011-09-30",
        accounts: [
          { number: "100235-01", kind: "Regular Savings", balance: 812.0, opened: "2011-09-30" },
        ],
      },
      {
        id: "100412",
        name: "Priya Raghunathan",
        status: "active",
        branch: "Eastfield",
        joined: "2006-01-23",
        accounts: [
          { number: "100412-01", kind: "Regular Savings", balance: 22940.18, opened: "2006-01-23" },
          { number: "100412-02", kind: "Checking", balance: 3311.47, opened: "2006-01-23" },
          { number: "100412-03", kind: "Holiday Club", balance: 640.0, opened: "2019-06-11" },
        ],
      },
      {
        // Reaching this member's detail screen is a permission denial. It is
        // the case where the automation is doing everything right and still
        // must stop — a hard failure, not a business answer.
        id: "100599",
        name: "Desmond Okonkwo-Bright",
        status: "restricted",
        branch: "Eastfield",
        joined: "2014-03-08",
        accounts: [
          { number: "100599-01", kind: "Regular Savings", balance: 0, opened: "2014-03-08" },
        ],
      },
      {
        id: "100777",
        name: "Yuki Tanaka",
        status: "active",
        branch: "Riverside",
        joined: "2021-07-19",
        accounts: [
          { number: "100777-01", kind: "Regular Savings", balance: 158.92, opened: "2021-07-19" },
        ],
      },
      {
        id: "100801",
        name: "Rosalind Achebe",
        status: "closed",
        branch: "Riverside",
        joined: "1989-02-14",
        accounts: [],
      },
    ] satisfies Member[]
  ).map((m) => [m.id, m]),
);

export const SUB_ACCOUNT_KINDS = [
  "Regular Savings",
  "Holiday Club",
  "Certificate (12mo)",
] as const;

/** Minimum opening deposit. Below this the form rejects with a message, which
 *  is a business outcome the caller needs rather than a crash. */
export const MINIMUM_DEPOSIT = 25;

const MEMBER_ID = /^\d{6}$/;

export type LookupResult =
  | { kind: "ok"; member: Member }
  | { kind: "invalid_id"; message: string }
  | { kind: "not_found"; message: string }
  | { kind: "restricted"; message: string };

export function lookupMember(rawId: string): LookupResult {
  const id = rawId.trim();
  if (!MEMBER_ID.test(id)) {
    return {
      kind: "invalid_id",
      message: "Member number must be exactly 6 digits.",
    };
  }
  const member = MEMBERS.get(id);
  if (!member) {
    return { kind: "not_found", message: `No member found for number ${id}.` };
  }
  if (member.status === "restricted") {
    return {
      kind: "restricted",
      message: `Access to member ${id} is restricted. Contact Compliance (ext. 4180).`,
    };
  }
  return { kind: "ok", member };
}

/** Deterministic so the same run produces the same reference every time — an
 *  artifact that extracts a confirmation number should be diffable. */
export function referenceFor(memberId: string, seq: number): string {
  const check = [...memberId].reduce((a, c) => a + Number(c), 0) * 7 + seq;
  return `SA-${memberId.slice(-4)}-${String(check).padStart(5, "0")}`;
}
