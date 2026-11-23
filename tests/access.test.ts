import { describe, expect, it, beforeEach } from "vitest";
import { rateLimit, resetRateLimitsForTests } from "@/lib/ratelimit";

describe("rateLimit", () => {
  beforeEach(() => resetRateLimitsForTests());
  it("allows up to the limit, then blocks until the window resets", () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 60_000, t).ok).toBe(true);
    const blocked = rateLimit("k", 3, 60_000, t + 10);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(rateLimit("k", 3, 60_000, t + 60_001).ok).toBe(true);
  });
  it("keeps keys separate", () => {
    expect(rateLimit("a", 1, 60_000, 0).ok).toBe(true);
    expect(rateLimit("b", 1, 60_000, 0).ok).toBe(true);
    expect(rateLimit("a", 1, 60_000, 1).ok).toBe(false);
  });
});
