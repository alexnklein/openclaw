import { describe, expect, it } from "vitest";
import { resolveStoredModelOverride } from "../auto-reply/reply/stored-model-override.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  AUTO_MODEL_LEASE_MS,
  createAutoModelLease,
  isAutoModelLeaseExpired,
} from "./model-override-lease.js";
import { applyModelOverrideToSessionEntry } from "./model-overrides.js";

function entry(source: "auto" | "user", now: number): SessionEntry {
  return {
    sessionId: "lease-test",
    updatedAt: now,
    providerOverride: "fallback",
    modelOverride: "model-b",
    modelOverrideSource: source,
    modelOverrideLease: createAutoModelLease(now),
  };
}

describe("automatic model preferences", () => {
  it("expires without extending when unrelated session activity advances", () => {
    const value = entry("auto", 1000);
    value.updatedAt = 1000 + AUTO_MODEL_LEASE_MS;
    expect(isAutoModelLeaseExpired(value, value.updatedAt)).toBe(true);
  });
  it("does not expire an explicit user pin", () => {
    expect(isAutoModelLeaseExpired(entry("user", 1000), 900000)).toBe(false);
  });
  it("invalidates an automatic pin from a different policy generation", () => {
    const value = entry("auto", 1000);
    value.modelOverrideLease!.policyVersion = "old-policy";
    expect(isAutoModelLeaseExpired(value, 1001)).toBe(true);
  });
  it("excludes expired direct and inherited pins at model admission", () => {
    const value = entry("auto", Date.now() - AUTO_MODEL_LEASE_MS - 1);
    expect(
      resolveStoredModelOverride({ sessionEntry: value, defaultProvider: "primary" }),
    ).toBeNull();
    expect(
      resolveStoredModelOverride({
        sessionKey: "child",
        parentSessionKey: "parent",
        sessionStore: { parent: value },
        defaultProvider: "primary",
      }),
    ).toBeNull();
  });
  it("preserves a live preference and clears its lease when a user selects a model", () => {
    const value = entry("auto", Date.now());
    expect(
      resolveStoredModelOverride({ sessionEntry: value, defaultProvider: "primary" })?.model,
    ).toBe("model-b");
    applyModelOverrideToSessionEntry({
      entry: value,
      selection: { provider: "chosen", model: "model-c" },
    });
    expect(value.modelOverrideLease).toBeUndefined();
    expect(value.modelOverrideSource).toBe("user");
  });
});
