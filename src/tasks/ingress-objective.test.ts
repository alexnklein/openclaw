// Verifies durable visible-turn ownership, coalescing, and safe successor fencing.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  assessIngressObjectiveRecovery,
  beginIngressObjective,
  blockIngressObjectiveWorkerDelivery,
  buildIngressObjectiveIdentity,
  isIngressObjectiveWorker,
  listActiveIngressObjectiveTypingTargets,
  recordIngressObjectiveWorkerDelivery,
} from "./ingress-objective.js";
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
      const onDetached = vi.fn(() => true);
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

  it("waits for a safe tool checkpoint before transferring to a worker", async () => {
    vi.useFakeTimers();
    await withRegistryState(async () => {
      const onDetached = vi.fn(() => true);
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

      objective.markToolStarted("external write");
      await vi.advanceTimersByTimeAsync(101);
      expect(onDetached).not.toHaveBeenCalled();

      objective.markToolCompleted("write receipt stored");
      expect(onDetached).toHaveBeenCalledWith({
        flowId: objective.flowId,
        taskId: objective.taskId,
      });
      expect(getTaskById(objective.taskId)?.notifyPolicy).toBe("silent");

      expect(
        objective.transferToWorker({
          childSessionKey: "agent:main:subagent:worker",
          runId: "worker-run",
        }),
      ).toBe(true);
      expect(getTaskFlowById(objective.flowId)).toMatchObject({
        status: "running",
        currentStep: "worker_execution",
      });
      expect(getTaskById(objective.taskId)?.status).toBe("succeeded");
    });
  });

  it("keeps worker completion owned until exact-origin delivery terminalizes the flow", async () => {
    vi.useFakeTimers();
    await withRegistryState(async () => {
      const objective = beginIngressObjective({
        ctx: createContext("Finish in the supervised worker", {
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:-1001:topic:2",
          AccountId: "default",
          MessageThreadId: 2,
        }),
        sessionKey: "agent:main:telegram:topic-2",
        agentId: "main",
        runId: "inline-run",
        onDetached: () => true,
        detachAfterMs: 1,
      });
      expect(objective.kind).toBe("created");
      if (objective.kind !== "created") {
        return;
      }
      await vi.advanceTimersByTimeAsync(2);
      expect(
        objective.transferToWorker({
          childSessionKey: "agent:main:subagent:worker",
          runId: "worker-run",
        }),
      ).toBe(true);
      expect(
        isIngressObjectiveWorker({ flowId: objective.flowId, workerRunId: "worker-run" }),
      ).toBe(true);
      expect(listActiveIngressObjectiveTypingTargets()).toEqual([
        {
          flowId: objective.flowId,
          channel: "telegram",
          to: "telegram:-1001:topic:2",
          accountId: "default",
          threadId: 2,
        },
      ]);

      expect(
        recordIngressObjectiveWorkerDelivery({
          flowId: objective.flowId,
          workerRunId: "worker-run",
          delivered: false,
          outcome: "ok",
          summary: "done",
          error: "Telegram unavailable",
        }),
      ).toBe(true);
      expect(getTaskFlowById(objective.flowId)).toMatchObject({
        status: "running",
        currentStep: "terminal_delivery_pending",
        stateJson: { checkpoint: { phase: "worker_delivery_pending" } },
      });
      expect(listActiveIngressObjectiveTypingTargets()).toEqual([]);
      expect(
        assessIngressObjectiveRecovery({
          sessionKey: "agent:main:telegram:topic-2",
          requestText: "Finish in the supervised worker",
        }),
      ).toMatchObject({ kind: "owned", phase: "worker_delivery_pending" });

      expect(
        recordIngressObjectiveWorkerDelivery({
          flowId: objective.flowId,
          workerRunId: "worker-run",
          delivered: true,
          outcome: "ok",
          summary: "done",
        }),
      ).toBe(true);
      expect(getTaskFlowById(objective.flowId)).toMatchObject({
        status: "succeeded",
        currentStep: "completed",
        stateJson: { checkpoint: { phase: "terminal", safe: true } },
      });
    });
  });

  it("keeps a worker flow nonterminal when durable terminal delivery exhausts retries", async () => {
    vi.useFakeTimers();
    await withRegistryState(async () => {
      const objective = beginIngressObjective({
        ctx: createContext("Deliver the final exactly once"),
        sessionKey: "agent:main:telegram:topic-2",
        agentId: "main",
        runId: "inline-run",
        onDetached: () => true,
        detachAfterMs: 1,
      });
      expect(objective.kind).toBe("created");
      if (objective.kind !== "created") {
        return;
      }
      await vi.advanceTimersByTimeAsync(2);
      expect(
        objective.transferToWorker({
          childSessionKey: "agent:main:subagent:worker",
          runId: "worker-run",
        }),
      ).toBe(true);
      recordIngressObjectiveWorkerDelivery({
        flowId: objective.flowId,
        workerRunId: "worker-run",
        delivered: false,
        outcome: "ok",
        error: "delivery retries exhausted",
      });
      expect(
        blockIngressObjectiveWorkerDelivery({
          flowId: objective.flowId,
          workerRunId: "worker-run",
          reason: "delivery retries exhausted",
        }),
      ).toBe(true);
      expect(getTaskFlowById(objective.flowId)).toMatchObject({
        status: "running",
        currentStep: "terminal_delivery_suspended",
        stateJson: { checkpoint: { phase: "worker_delivery_pending", safe: false } },
      });
    });
  });

  it("blocks successor replay when the inline owner fails during an in-flight tool", async () => {
    await withRegistryState(async () => {
      const onDetached = vi.fn(() => true);
      const objective = beginIngressObjective({
        ctx: createContext("Run the guarded action"),
        sessionKey: "agent:main:telegram:topic-2",
        agentId: "main",
        runId: "run-tool",
        onDetached,
        detachAfterMs: 60_000,
      });
      expect(objective.kind).toBe("created");
      if (objective.kind !== "created") {
        return;
      }

      objective.markToolStarted("external write");
      objective.fail(new Error("connection lost"));
      const blocked = getTaskFlowById(objective.flowId);
      expect(blocked?.status).toBe("blocked");
      expect(blocked?.currentStep).toBe("unsafe_checkpoint");

      const retry = beginIngressObjective({
        ctx: createContext("Run the guarded action", { MessageSid: "retry" }),
        sessionKey: "agent:main:telegram:dm",
        agentId: "main",
        runId: "retry-run",
        onDetached,
        detachAfterMs: 60_000,
      });
      expect(retry).toMatchObject({
        kind: "coalesced",
        flowId: objective.flowId,
        status: "blocked",
      });
    });
  });

  it("classifies restart recovery from the content-bound checkpoint", async () => {
    await withRegistryState(async () => {
      const sessionKey = "agent:main:telegram:topic-2";
      const objective = beginIngressObjective({
        ctx: createContext("Recover this exact objective"),
        sessionKey,
        agentId: "main",
        runId: "run-recovery",
        onDetached: () => true,
        detachAfterMs: 60_000,
      });
      expect(objective.kind).toBe("created");
      if (objective.kind !== "created") {
        return;
      }

      expect(
        assessIngressObjectiveRecovery({
          sessionKey,
          requestText: "Recover this exact objective",
        }),
      ).toMatchObject({ kind: "recoverable", flowId: objective.flowId });
      expect(
        assessIngressObjectiveRecovery({
          sessionKey,
          requestText: "Different objective",
        }),
      ).toEqual({ kind: "none" });

      objective.markToolStarted("external write");
      expect(
        assessIngressObjectiveRecovery({
          sessionKey,
          requestText: "Recover this exact objective",
        }),
      ).toMatchObject({ kind: "unsafe", flowId: objective.flowId, phase: "tool_inflight" });
      objective.fail(new Error("provider ended during write"));
      expect(
        assessIngressObjectiveRecovery({
          sessionKey,
          requestText: "Recover this exact objective",
        }),
      ).toMatchObject({ kind: "unsafe", flowId: objective.flowId, phase: "terminal" });
    });
  });
});
