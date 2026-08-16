import { describe, expect, it } from "vitest";
import { acquire, initialLease } from "../../src/replay/lease.js";

describe("SessionLease", () => {
  it("starts owned by automation, token 0", () => {
    const lease = initialLease("r1", "app.cap");
    expect(lease).toEqual({ runId: "r1", capabilityId: "app.cap", owner: "automation", token: 0 });
  });

  it("increments the token on a real ownership change", () => {
    const lease = initialLease("r1", "app.cap");
    const handedOff = acquire(lease, "human");
    expect(handedOff.owner).toBe("human");
    expect(handedOff.token).toBe(1);

    const takenBack = acquire(handedOff, "automation");
    expect(takenBack.owner).toBe("automation");
    expect(takenBack.token).toBe(2);
  });

  it("is idempotent - acquiring an already-held lease does not burn a token", () => {
    const lease = initialLease("r1", "app.cap");
    const same = acquire(lease, "automation");
    expect(same).toEqual(lease);
    expect(same.token).toBe(0);
  });
});
