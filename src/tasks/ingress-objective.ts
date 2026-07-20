// Owns visible channel work before it can outlive the inbound request lifecycle.
import { createHash, randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import { createRunningTaskRun, finalizeTaskRunByRunId } from "./detached-task-runtime.js";
import { updateTaskNotifyPolicyById } from "./runtime-internal.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import {
  createManagedTaskFlow,
  getTaskFlowById,
  listTaskFlowRecords,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-runtime-internal.js";

const CONTROLLER_ID = "core/channel-ingress";
export const INGRESS_OBJECTIVE_DETACH_MS = 120_000;
const TERMINAL_STATUSES = new Set<TaskFlowRecord["status"]>([
  "succeeded",
  "blocked",
  "failed",
  "cancelled",
  "lost",
]);

type IngressCheckpoint = {
  safe: boolean;
  phase: "accepted" | "tool_inflight" | "after_tool" | "waiting_successor" | "terminal";
  summary?: string;
  updatedAt: number;
};

type IngressObjectiveState = {
  kind: "channel_ingress";
  version: 1;
  identity: string;
  requestHash: string;
  runId: string;
  taskId: string;
  attempt: number;
  checkpoint: IngressCheckpoint;
  detachedAt?: number;
  retrySeenAt?: number;
};

export type IngressObjectiveHandle = {
  kind: "created";
  flowId: string;
  taskId: string;
  runId: string;
  isDetached: () => boolean;
  markToolStarted: (summary?: string) => void;
  markToolCompleted: (summary?: string) => void;
  complete: (summary?: string) => void;
  fail: (error: unknown) => void;
  cancel: (summary?: string) => void;
  dispose: () => void;
};

export type BeginIngressObjectiveResult =
  | IngressObjectiveHandle
  | { kind: "coalesced"; flowId: string; status: TaskFlowRecord["status"] }
  | { kind: "unavailable"; reason: string };

type BeginIngressObjectiveParams = {
  ctx: FinalizedMsgContext;
  sessionKey: string;
  agentId: string;
  runId?: string;
  onDetached: (receipt: { flowId: string; taskId: string }) => void | Promise<void>;
  detachAfterMs?: number;
};

function canonicalizeRequest(text: string): string {
  return text.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
}

function resolveRequestText(ctx: FinalizedMsgContext): string {
  return canonicalizeRequest(
    normalizeOptionalString(ctx.BodyForCommands) ??
      normalizeOptionalString(ctx.CommandBody) ??
      normalizeOptionalString(ctx.RawBody) ??
      normalizeOptionalString(ctx.Body) ??
      "",
  );
}

function resolveSenderSubject(ctx: FinalizedMsgContext): string {
  return (
    normalizeOptionalString(ctx.SenderId) ??
    normalizeOptionalString(ctx.SenderE164) ??
    normalizeOptionalString(ctx.SenderUsername) ??
    ""
  );
}

export function buildIngressObjectiveIdentity(params: {
  ctx: FinalizedMsgContext;
  agentId: string;
}): { identity: string; requestHash: string } | null {
  const request = resolveRequestText(params.ctx);
  const sender = resolveSenderSubject(params.ctx);
  if (!request || !sender) {
    return null;
  }
  const requestHash = createHash("sha256").update(request).digest("hex");
  const identity = createHash("sha256")
    .update(JSON.stringify([params.agentId, sender, requestHash]))
    .digest("hex");
  return { identity, requestHash };
}

function readIngressState(flow: TaskFlowRecord): IngressObjectiveState | null {
  const value = flow.stateJson;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const checkpoint = raw.checkpoint;
  if (
    raw.kind !== "channel_ingress" ||
    raw.version !== 1 ||
    typeof raw.identity !== "string" ||
    typeof raw.requestHash !== "string" ||
    typeof raw.runId !== "string" ||
    typeof raw.taskId !== "string" ||
    typeof raw.attempt !== "number" ||
    !checkpoint ||
    typeof checkpoint !== "object" ||
    Array.isArray(checkpoint)
  ) {
    return null;
  }
  const checkpointRecord = checkpoint as Record<string, unknown>;
  if (
    typeof checkpointRecord.safe !== "boolean" ||
    typeof checkpointRecord.phase !== "string" ||
    typeof checkpointRecord.updatedAt !== "number"
  ) {
    return null;
  }
  return value as IngressObjectiveState;
}

function findMatchingFlow(identity: string): TaskFlowRecord | undefined {
  return listTaskFlowRecords()
    .filter((flow) => flow.controllerId === CONTROLLER_ID)
    .filter((flow) => readIngressState(flow)?.identity === identity)
    .toSorted((left, right) => right.updatedAt - left.updatedAt)[0];
}

function updateFlow(
  flowId: string,
  mutate: (
    flow: TaskFlowRecord,
    state: IngressObjectiveState,
  ) => {
    status?: TaskFlowRecord["status"];
    currentStep?: string;
    state: IngressObjectiveState;
    endedAt?: number | null;
  },
): TaskFlowRecord | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = getTaskFlowById(flowId);
    if (!current) {
      return null;
    }
    const state = readIngressState(current);
    if (!state) {
      return null;
    }
    const next = mutate(current, structuredClone(state));
    const result = updateFlowRecordByIdExpectedRevision({
      flowId,
      expectedRevision: current.revision,
      patch: {
        ...(next.status ? { status: next.status } : {}),
        ...(next.currentStep ? { currentStep: next.currentStep } : {}),
        stateJson: next.state,
        ...(next.endedAt !== undefined ? { endedAt: next.endedAt } : {}),
        updatedAt: Date.now(),
      },
    });
    if (result.applied) {
      return result.flow;
    }
    if (result.reason !== "revision_conflict") {
      return null;
    }
  }
  return null;
}

function createTask(params: {
  flow: TaskFlowRecord;
  sessionKey: string;
  runId: string;
  task: string;
  ctx: FinalizedMsgContext;
}) {
  return createRunningTaskRun({
    runtime: "cli",
    taskKind: "channel_ingress",
    sourceId: params.runId,
    requesterSessionKey: params.sessionKey,
    ownerKey: params.flow.ownerKey,
    scopeKind: "session",
    requesterOrigin: {
      channel: params.ctx.OriginatingChannel ?? params.ctx.Provider ?? params.ctx.Surface,
      to: params.ctx.OriginatingTo ?? params.ctx.To ?? params.ctx.From,
      accountId: params.ctx.AccountId,
      threadId: params.ctx.MessageThreadId,
    },
    childSessionKey: params.sessionKey,
    parentFlowId: params.flow.flowId,
    runId: params.runId,
    label: "Visible channel objective",
    task: params.task,
    deliveryStatus: "pending",
    notifyPolicy: "silent",
    startedAt: Date.now(),
  });
}

function createObjective(
  params: BeginIngressObjectiveParams & {
    identity: string;
    requestHash: string;
    prior?: TaskFlowRecord;
    priorState?: IngressObjectiveState;
  },
): BeginIngressObjectiveResult {
  const now = Date.now();
  const runId = params.runId?.trim() || randomUUID();
  const taskText = resolveRequestText(params.ctx);
  const attempt = (params.priorState?.attempt ?? 0) + 1;
  let flow = params.prior;
  if (flow) {
    const resumed = updateFlow(flow.flowId, (_current, state) => ({
      status: "running",
      currentStep: "inline_execution",
      endedAt: null,
      state: {
        ...state,
        runId,
        taskId: "pending",
        attempt,
        checkpoint: { safe: true, phase: "accepted", updatedAt: now },
      },
    }));
    if (!resumed) {
      return { kind: "unavailable", reason: "failed to claim successor objective" };
    }
    flow = resumed ?? undefined;
  } else {
    const created = createManagedTaskFlow({
      controllerId: CONTROLLER_ID,
      ownerKey: params.sessionKey,
      requesterOrigin: {
        channel: params.ctx.OriginatingChannel ?? params.ctx.Provider ?? params.ctx.Surface,
        to: params.ctx.OriginatingTo ?? params.ctx.To ?? params.ctx.From,
        accountId: params.ctx.AccountId,
        threadId: params.ctx.MessageThreadId,
      },
      status: "running",
      notifyPolicy: "done_only",
      goal: taskText,
      currentStep: "inline_execution",
      stateJson: {
        kind: "channel_ingress",
        version: 1,
        identity: params.identity,
        requestHash: params.requestHash,
        runId,
        taskId: "pending",
        attempt,
        checkpoint: { safe: true, phase: "accepted", updatedAt: now },
      },
    });
    if (!created) {
      return { kind: "unavailable", reason: "failed to persist ingress objective" };
    }
    flow = created;
  }

  const task = createTask({
    flow,
    sessionKey: params.sessionKey,
    runId,
    task: taskText,
    ctx: params.ctx,
  });
  if (!task) {
    updateFlow(flow.flowId, (_current, state) => ({
      status: "failed",
      currentStep: "task_persistence_failed",
      endedAt: Date.now(),
      state: {
        ...state,
        checkpoint: {
          safe: false,
          phase: "terminal",
          summary: "task persistence failed",
          updatedAt: Date.now(),
        },
      },
    }));
    return { kind: "unavailable", reason: "failed to persist ingress task" };
  }
  updateFlow(flow.flowId, (_current, state) => ({
    state: { ...state, taskId: task.taskId },
  }));

  let detached = false;
  let disposed = false;
  const detachAfterMs = Math.max(1, params.detachAfterMs ?? INGRESS_OBJECTIVE_DETACH_MS);
  const timer = setTimeout(() => {
    if (disposed) {
      return;
    }
    detached = true;
    updateTaskNotifyPolicyById({ taskId: task.taskId, notifyPolicy: "done_only" });
    updateFlow(flow.flowId, (_current, state) => ({
      currentStep: "detached_execution",
      state: { ...state, detachedAt: Date.now() },
    }));
    void Promise.resolve(params.onDetached({ flowId: flow.flowId, taskId: task.taskId })).catch(
      () => undefined,
    );
  }, detachAfterMs);
  timer.unref?.();

  const updateCheckpoint = (checkpoint: IngressCheckpoint) => {
    updateFlow(flow.flowId, (_current, state) => ({ state: { ...state, checkpoint } }));
  };
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimeout(timer);
  };

  return {
    kind: "created",
    flowId: flow.flowId,
    taskId: task.taskId,
    runId,
    isDetached: () => detached,
    markToolStarted: (summary) =>
      updateCheckpoint({
        safe: false,
        phase: "tool_inflight",
        ...(normalizeOptionalString(summary) ? { summary: normalizeOptionalString(summary) } : {}),
        updatedAt: Date.now(),
      }),
    markToolCompleted: (summary) =>
      updateCheckpoint({
        safe: true,
        phase: "after_tool",
        ...(normalizeOptionalString(summary) ? { summary: normalizeOptionalString(summary) } : {}),
        updatedAt: Date.now(),
      }),
    complete: (summary) => {
      dispose();
      updateTaskNotifyPolicyById({ taskId: task.taskId, notifyPolicy: "silent" });
      finalizeTaskRunByRunId({
        runId,
        runtime: "cli",
        status: "succeeded",
        endedAt: Date.now(),
        terminalSummary: normalizeOptionalString(summary) ?? "completed",
      });
      updateFlow(flow.flowId, (_current, state) => ({
        status: "succeeded",
        currentStep: "completed",
        endedAt: Date.now(),
        state: {
          ...state,
          checkpoint: {
            safe: true,
            phase: "terminal",
            ...(normalizeOptionalString(summary)
              ? { summary: normalizeOptionalString(summary) }
              : {}),
            updatedAt: Date.now(),
          },
        },
      }));
    },
    fail: (error) => {
      dispose();
      const current = getTaskFlowById(flow.flowId);
      const state = current ? readIngressState(current) : null;
      const safe = state?.checkpoint.safe === true;
      const summary = error instanceof Error ? error.message : String(error);
      finalizeTaskRunByRunId({
        runId,
        runtime: "cli",
        status: "failed",
        endedAt: Date.now(),
        error: summary,
        terminalSummary: summary,
      });
      updateFlow(flow.flowId, (_current, nextState) => ({
        status: safe ? "waiting" : "blocked",
        currentStep: safe ? "successor_pending" : "unsafe_checkpoint",
        ...(safe ? { endedAt: null } : { endedAt: Date.now() }),
        state: {
          ...nextState,
          checkpoint: {
            safe,
            phase: safe ? "waiting_successor" : "terminal",
            summary,
            updatedAt: Date.now(),
          },
        },
      }));
    },
    cancel: (summary) => {
      dispose();
      const terminalSummary = normalizeOptionalString(summary) ?? "cancelled";
      updateTaskNotifyPolicyById({ taskId: task.taskId, notifyPolicy: "silent" });
      finalizeTaskRunByRunId({
        runId,
        runtime: "cli",
        status: "cancelled",
        endedAt: Date.now(),
        terminalSummary,
      });
      updateFlow(flow.flowId, (_current, state) => ({
        status: "cancelled",
        currentStep: "cancelled",
        endedAt: Date.now(),
        state: {
          ...state,
          checkpoint: {
            safe: false,
            phase: "terminal",
            summary: terminalSummary,
            updatedAt: Date.now(),
          },
        },
      }));
    },
    dispose,
  };
}

export function beginIngressObjective(
  params: BeginIngressObjectiveParams,
): BeginIngressObjectiveResult {
  const identity = buildIngressObjectiveIdentity({ ctx: params.ctx, agentId: params.agentId });
  if (!identity) {
    return { kind: "unavailable", reason: "missing stable sender or request content" };
  }
  const existing = findMatchingFlow(identity.identity);
  if (existing && !TERMINAL_STATUSES.has(existing.status)) {
    const state = readIngressState(existing);
    if (existing.status === "waiting" && state?.checkpoint.safe === true) {
      return createObjective({ ...params, ...identity, prior: existing, priorState: state });
    }
    updateFlow(existing.flowId, (_current, currentState) => ({
      state: { ...currentState, retrySeenAt: Date.now() },
    }));
    return { kind: "coalesced", flowId: existing.flowId, status: existing.status };
  }
  return createObjective({ ...params, ...identity });
}
