import type { SessionEntry } from "../config/sessions/types.js";

export const AUTO_MODEL_LEASE_MS = 5 * 60 * 1000;
export const AUTO_MODEL_POLICY_VERSION = "auto-model-lease-v1";

export function createAutoModelLease(
  now = Date.now(),
): NonNullable<SessionEntry["modelOverrideLease"]> {
  return {
    createdAt: now,
    expiresAt: now + AUTO_MODEL_LEASE_MS,
    policyVersion: AUTO_MODEL_POLICY_VERSION,
    reason: "runtime-fallback",
  };
}

/** Explicit and legacy user selections never expire through automatic routing. */
export function isAutoModelLeaseExpired(entry?: SessionEntry, now = Date.now()): boolean {
  if (entry?.modelOverrideSource !== "auto") {
    return false;
  }
  const lease = entry.modelOverrideLease;
  if (!lease) {
    return !Number.isFinite(entry.updatedAt) || now - entry.updatedAt >= AUTO_MODEL_LEASE_MS;
  }
  return (
    lease.policyVersion !== AUTO_MODEL_POLICY_VERSION ||
    !Number.isFinite(lease.expiresAt) ||
    !Number.isFinite(lease.createdAt) ||
    lease.createdAt > now ||
    lease.expiresAt - lease.createdAt > AUTO_MODEL_LEASE_MS ||
    lease.expiresAt <= now
  );
}
