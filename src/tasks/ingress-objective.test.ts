// Verifies durable visible-turn ownership, coalescing, and safe successor fencing.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { beginIngressObjective, buildIngressObjectiveIdentity } from "./ingress-objective.js";
import { getTaskFlowById, resetTaskFlowRegistryForTests } from "./task-flow-registry.js";
import { getTaskById, resetTaskRegistryForTests } from "./task-registry.js";

function createContext(body: string, overrides: Partial<FinalizedMsgContext> = {}) {
  return {
    Body: body,
    RawBody: body,
    BodyForCommands: body,
    SenderId: "operator-1",
    Provider: "telegram",
    Surface: "telegram",
    From: "telegram:operator-1",
    To: "telegram:topic-2",
    ...overrides,
  } as FinalizedMsgContext;
}

async function withRegistryState(run: () => Promise<void>) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-ingress-objective-" },
    async () => {
      resetTaskFlowRegistryForTests();
      resetTaskRegistryForTests();
      try {
        await run();
      } finally {
        resetTaskRegistryForTests();
        resetTaskFlowRegistryForTests();
      }
    },
  );
}

describe("ingress-objective", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetTaskRegistryForTests();
    resetTaskFlowRegistryForTests();
  });

  it("binds identity to normalized content and stable sender, not transport ids", () => {
    const first = buildIngressObjectiveIdentity({
      ctx: createContext("Fix this\r\nnow", { MessageSid: "message-a" }),
      agentId: "main",
    });
    const retry = buildIngressObjectiveIdentity({
      ctx: createContext("Fix this\nnow", {
        MessageSid: "message-b",
        Surface: "telegram-dm",
      }),
      agentId: "main",
    });
    const different = buildIngressObjectiveIdentity({
      ctx: createContext("Fix something else", { MessageSid: "message-a" }),
      agentId: "main",
    });

    expect(first).toEqual(retry);
    expect(different?.identity).not.toBe(first?.identity);
  });

  it("coalesces one active objective and admits one successor only from a safe wait", async () => {
    await withRegistryState(async () => {
      const onDetached = vi.fn();
      const first = beginIngressObjective({
        ctx: createContext("Finish the continuity repair"),
        sessionKey: "agent:main:telegram:topic-2",
        agentId: "main",
        runId: "run-1",
        onDetached,
        detachAfterMs: 60_000,
      });
      expect(first.kind).toBe("created");
      if (first.kind !== "created") {
        return;
      }

      const duplicate = beginIngressObjective({
        ctx: createContext("Finish the continuity repair", { MessageSid: "retry" }),
        sessionKey: "agent:main:telegram:dm",
        agentId: "main",
        runId: "run-2",
        onDetached,
        detachAfterMs: 60_000,
      });
      expect(duplicate).toMatchObject({ kind: "coalesced", flowId: first.flowId });

      first.fail(new Error("provider lane ended"));
      expect(getTaskFlowById(first.flowId)?.status).toBe("waiting");

      const successor = beginIngressObjective({
        ctx: createContext("Finish the continuity repair", { MessageSid: "successor" }),
        sessionKey: "agent:main:telegram:dm",
        agentId: "main",
        runId: "run-3",
        onDetached,
        detachAfterMs: 60_000,
      });
      expect(successor.kind).toBe("created");
      if (successor.kind !== "created") {
        return;
      }
      expect(successor.flowId).toBe(first.flowId);

      const competingSuccessor = beginIngressObjective({
        ctx: createContext("Finish the continuity repair", { MessageSid: "competitor" }),
        sessionKey: "agent:main:signal:dm",
        agentId: "main",
        runId: "run-4",
        onDetached,
        detachAfterMs: 60_000,
      });
      expect(competingSuccessor).toMatchObject({ kind: "coalesced", flowId: first.flowId });
      successor.complete("continuity repaired");
      expect(getTaskFlowById(first.flowId)?.status).toBe("succeeded");
    });
  });

  it("detaches with a receipt and blocks replay across an in-flight tool", async () => {
    vi.useFakeTimers();
    await withRegistryState(async () => {
      const onDetached = vi.fn();
      const objective = beginIngressObjective({
        ctx: createContext("Run the guarded action"),
        sessionKey: "agent:main:telegram:topic-2",
        agentId: "main",
        runId: "run-tool",
        onDetached,
        detachAfterMs: 100,
      });
      expect(objective.kind).toBe("created");
      if (objective.kind !== "created") {
        return;
      }

      await vi.advanceTimersByTimeAsync(101);
      expect(onDetached).toHaveBeenCalledWith({
        flowId: objective.flowId,
        taskId: objective.taskId,
      });
      expect(getTaskById(objective.taskId)?.notifyPolicy).toBe("done_only");

      objective.markToolStarted("external write");
      objective.fail(new Error("connection lost"));
      const blocked = getTaskFlowById(objective.flowId);
      expect(blocked?.status).toBe("blocked");
      expect(blocked?.currentStep).toBe("unsafe_checkpoint");
    });
  });
});
