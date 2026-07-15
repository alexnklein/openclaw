// Semantic action continuity hooks keep mutable workflow actions fresh.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "../api.js";
import { buildJsonPluginConfigSchema } from "../api.js";

const execFileAsync = promisify(execFile);
const PLUGIN_ID = "semantic-action-continuity";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LEDGER_ENTRIES = 500;
const DEFAULT_REVISION_INSTRUCTION =
  "Authoritative workflow state changed after the prior answer draft. Re-read the semantic action snapshot below, discard obsolete wait/admin-merge/action options, and produce one updated final answer from the current state.";

type SnapshotCommandConfig = {
  file: string;
  args?: string[];
  cwd?: string;
};

type SnapshotAdapterConfig = {
  path?: string;
  command?: SnapshotCommandConfig;
  timeoutMs?: number;
};

type WorkflowConfig = {
  id: string;
  sessionPattern?: string;
  actionPattern?: string;
  responseActionPattern?: string;
};

type SemanticActionContinuityConfig = {
  adapter?: SnapshotAdapterConfig;
  workflows: WorkflowConfig[];
  maxLedgerEntries: number;
  revisionInstruction: string;
};

type ActionSnapshot = {
  revision: string;
  status?: string;
  summary?: string;
  actions?: string[];
  raw?: unknown;
};

type RunLedgerRecord = {
  workflowId: string;
  runId: string;
  revision?: string;
  summary?: string;
  status?: string;
  actions?: string[];
  observedAt: number;
  refreshFailed?: boolean;
  failureReason?: string;
};

type ObservationLedgerRecord = RunLedgerRecord & {
  revision: string;
};

type SemanticActionContinuityStores = {
  runs: PluginStateKeyedStore<RunLedgerRecord>;
  observations: PluginStateKeyedStore<ObservationLedgerRecord>;
};

type HookContext = {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  channel?: string;
  channelId?: string;
  trigger?: string;
};

type PromptEvent = {
  prompt: string;
  messages: unknown[];
};

type FinalizeEvent = {
  runId?: string;
  sessionId: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  lastAssistantMessage?: string;
  messages?: unknown[];
};

export type SemanticActionContinuityDependencies = {
  loadSnapshot?: (params: {
    adapter: SnapshotAdapterConfig;
    workflow: WorkflowConfig;
    event: PromptEvent | FinalizeEvent;
    ctx: HookContext;
  }) => Promise<ActionSnapshot>;
};

const semanticActionContinuityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    adapter: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", minLength: 1 },
        command: {
          type: "object",
          additionalProperties: false,
          properties: {
            file: { type: "string", minLength: 1 },
            args: { type: "array", items: { type: "string" }, default: [] },
            cwd: { type: "string", minLength: 1 },
          },
        },
        timeoutMs: { type: "integer", minimum: 100, maximum: 30_000, default: DEFAULT_TIMEOUT_MS },
      },
    },
    workflows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        anyOf: [{ required: ["sessionPattern"] }, { required: ["actionPattern"] }],
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$" },
          sessionPattern: { type: "string", minLength: 1 },
          actionPattern: { type: "string", minLength: 1 },
          responseActionPattern: { type: "string", minLength: 1 },
        },
      },
      default: [],
    },
    maxLedgerEntries: {
      type: "integer",
      minimum: 10,
      maximum: 5_000,
      default: DEFAULT_LEDGER_ENTRIES,
    },
    revisionInstruction: { type: "string", minLength: 1 },
  },
} as const;

export const semanticActionContinuityConfigSchema = buildJsonPluginConfigSchema(
  semanticActionContinuityJsonSchema,
);

export function registerSemanticActionContinuityPlugin(
  api: OpenClawPluginApi,
  deps: SemanticActionContinuityDependencies = {},
): void {
  const loadSnapshot = deps.loadSnapshot ?? loadAuthoritativeSnapshot;
  const resolveConfig = () =>
    normalizeConfig(
      resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        PLUGIN_ID,
        api.pluginConfig as Record<string, unknown>,
      ),
    );
  const stores = lazyStores(api);

  api.on("before_prompt_build", async (event, ctx) => {
    const config = resolveConfig();
    const workflow = selectPromptWorkflow(config, event, ctx as HookContext);
    if (!workflow) {
      return undefined;
    }
    const runId = resolveRunId(event, ctx as HookContext);
    try {
      const refreshed = await refreshWorkflowSnapshot({
        config,
        workflow,
        event,
        ctx: ctx as HookContext,
        runId,
        stores: stores(),
        loadSnapshot,
      });
      return { prependContext: formatPromptContext(workflow, refreshed.record) };
    } catch {
      const failedRecord = await stores().runs.lookup(runKey(workflow.id, runId));
      return {
        prependContext: formatPromptContext(
          workflow,
          failedRecord ?? {
            workflowId: workflow.id,
            runId,
            observedAt: Date.now(),
            refreshFailed: true,
          },
        ),
      };
    }
  });

  api.on("before_agent_finalize", async (event, ctx) => {
    const config = resolveConfig();
    const runId = resolveRunId(event, ctx as HookContext);
    const workflow = await selectFinalizeWorkflow({
      config,
      event,
      ctx: ctx as HookContext,
      runId,
      runs: stores().runs,
    });
    if (!workflow) {
      return undefined;
    }
    const previous = await stores().runs.lookup(runKey(workflow.id, runId));
    const actionBearing = isFinalizeActionBearing(workflow, event, previous);
    let refreshed: RefreshResult;
    try {
      refreshed = await refreshWorkflowSnapshot({
        config,
        workflow,
        event,
        ctx: ctx as HookContext,
        runId,
        stores: stores(),
        loadSnapshot,
      });
    } catch (error) {
      if (!actionBearing) {
        return undefined;
      }
      return reviseForRefreshFailure({ config, workflow, runId, error });
    }
    if (!previous?.revision || previous.revision === refreshed.record.revision) {
      return undefined;
    }
    return reviseForChangedRevision({
      config,
      workflow,
      runId,
      previousRevision: previous.revision,
      next: refreshed.record,
    });
  });
}

type RefreshResult = {
  record: RunLedgerRecord;
};

async function refreshWorkflowSnapshot(params: {
  config: SemanticActionContinuityConfig;
  workflow: WorkflowConfig;
  event: PromptEvent | FinalizeEvent;
  ctx: HookContext;
  runId: string;
  stores: SemanticActionContinuityStores;
  loadSnapshot: NonNullable<SemanticActionContinuityDependencies["loadSnapshot"]>;
}): Promise<RefreshResult> {
  try {
    const snapshot = await params.loadSnapshot({
      adapter: params.config.adapter ?? {},
      workflow: params.workflow,
      event: params.event,
      ctx: params.ctx,
    });
    const record: RunLedgerRecord = {
      workflowId: params.workflow.id,
      runId: params.runId,
      revision: snapshot.revision,
      ...(snapshot.summary ? { summary: snapshot.summary } : {}),
      ...(snapshot.status ? { status: snapshot.status } : {}),
      ...(snapshot.actions?.length ? { actions: snapshot.actions } : {}),
      observedAt: Date.now(),
    };
    await params.stores.runs.register(runKey(params.workflow.id, params.runId), record);
    await params.stores.observations.registerIfAbsent(
      observationKey(params.workflow.id, params.runId, snapshot.revision),
      { ...record, revision: snapshot.revision },
    );
    return { record };
  } catch (error) {
    const previous = await params.stores.runs.lookup(runKey(params.workflow.id, params.runId));
    const record: RunLedgerRecord = {
      ...(previous?.revision ? { revision: previous.revision } : {}),
      ...(previous?.summary ? { summary: previous.summary } : {}),
      ...(previous?.status ? { status: previous.status } : {}),
      ...(previous?.actions?.length ? { actions: previous.actions } : {}),
      workflowId: params.workflow.id,
      runId: params.runId,
      observedAt: Date.now(),
      refreshFailed: true,
      failureReason: errorMessage(error),
    };
    await params.stores.runs.register(runKey(params.workflow.id, params.runId), record);
    throw error;
  }
}

async function loadAuthoritativeSnapshot(params: {
  adapter: SnapshotAdapterConfig;
  workflow: WorkflowConfig;
  event: PromptEvent | FinalizeEvent;
  ctx: HookContext;
}): Promise<ActionSnapshot> {
  if (params.adapter.path) {
    const snapshotPath = resolveLocalAdapterPath(params.adapter.path, params.ctx.workspaceDir);
    return parseSnapshotJson(await readTextFileWithTimeout(snapshotPath, params.adapter.timeoutMs));
  }
  if (params.adapter.command?.file) {
    const controller = new AbortController();
    const timeoutMs = normalizeTimeoutMs(params.adapter.timeoutMs);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();
    try {
      const { stdout } = await execFileAsync(
        params.adapter.command.file,
        params.adapter.command.args ?? [],
        {
          cwd: params.adapter.command.cwd ?? params.ctx.workspaceDir,
          signal: controller.signal,
          timeout: timeoutMs,
          env: {
            ...process.env,
            OPENCLAW_ACTION_CONTINUITY_WORKFLOW_ID: params.workflow.id,
            ...(params.ctx.runId ? { OPENCLAW_ACTION_CONTINUITY_RUN_ID: params.ctx.runId } : {}),
            ...(params.ctx.sessionKey
              ? { OPENCLAW_ACTION_CONTINUITY_SESSION_KEY: params.ctx.sessionKey }
              : {}),
          },
          maxBuffer: 256 * 1024,
        },
      );
      return parseSnapshotJson(stdout);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("semantic action continuity adapter requires path or command.file");
}

function parseSnapshotJson(raw: string): ActionSnapshot {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("semantic action snapshot must be a JSON object");
  }
  const value = parsed as Record<string, unknown>;
  const revisionValue = value.revision;
  const revision =
    typeof revisionValue === "string" || typeof revisionValue === "number"
      ? String(revisionValue).trim()
      : "";
  if (!revision) {
    throw new Error("semantic action snapshot missing revision");
  }
  return {
    revision,
    ...(typeof value.status === "string" && value.status.trim()
      ? { status: value.status.trim() }
      : {}),
    ...(typeof value.summary === "string" && value.summary.trim()
      ? { summary: value.summary.trim() }
      : {}),
    ...(Array.isArray(value.actions)
      ? { actions: value.actions.filter((action): action is string => typeof action === "string") }
      : {}),
    raw: parsed,
  };
}

function normalizeConfig(raw: Record<string, unknown> | undefined): SemanticActionContinuityConfig {
  const adapter = normalizeAdapter(raw?.adapter);
  const workflows = Array.isArray(raw?.workflows)
    ? raw.workflows.flatMap((item) => normalizeWorkflow(item))
    : [];
  return {
    ...(adapter ? { adapter } : {}),
    workflows,
    maxLedgerEntries: normalizeInteger(raw?.maxLedgerEntries, DEFAULT_LEDGER_ENTRIES, 10, 5_000),
    revisionInstruction:
      typeof raw?.revisionInstruction === "string" && raw.revisionInstruction.trim()
        ? raw.revisionInstruction.trim()
        : DEFAULT_REVISION_INSTRUCTION,
  };
}

function normalizeAdapter(raw: unknown): SnapshotAdapterConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const command =
    value.command && typeof value.command === "object" && !Array.isArray(value.command)
      ? normalizeCommand(value.command as Record<string, unknown>)
      : undefined;
  const adapter: SnapshotAdapterConfig = {
    ...(typeof value.path === "string" && value.path.trim() ? { path: value.path.trim() } : {}),
    ...(command ? { command } : {}),
    timeoutMs: normalizeTimeoutMs(value.timeoutMs),
  };
  return adapter.path || adapter.command ? adapter : undefined;
}

function normalizeCommand(raw: Record<string, unknown>): SnapshotCommandConfig | undefined {
  if (typeof raw.file !== "string" || !raw.file.trim()) {
    return undefined;
  }
  return {
    file: raw.file.trim(),
    ...(Array.isArray(raw.args)
      ? { args: raw.args.filter((arg): arg is string => typeof arg === "string") }
      : {}),
    ...(typeof raw.cwd === "string" && raw.cwd.trim() ? { cwd: raw.cwd.trim() } : {}),
  };
}

function normalizeWorkflow(raw: unknown): WorkflowConfig[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value.id)) {
    return [];
  }
  const workflow: WorkflowConfig = {
    id: value.id,
    ...(stringField(value.sessionPattern)
      ? { sessionPattern: stringField(value.sessionPattern) }
      : {}),
    ...(stringField(value.actionPattern)
      ? { actionPattern: stringField(value.actionPattern) }
      : {}),
    ...(stringField(value.responseActionPattern)
      ? { responseActionPattern: stringField(value.responseActionPattern) }
      : {}),
  };
  return workflow.sessionPattern || workflow.actionPattern ? [workflow] : [];
}

function selectPromptWorkflow(
  config: SemanticActionContinuityConfig,
  event: PromptEvent,
  ctx: HookContext,
): WorkflowConfig | undefined {
  if (!config.adapter) {
    return undefined;
  }
  return config.workflows.find((workflow) => {
    const sessionOk =
      !workflow.sessionPattern || matches(workflow.sessionPattern, sessionText(ctx));
    const actionOk =
      !workflow.actionPattern || matches(workflow.actionPattern, promptActionText(event));
    return sessionOk && actionOk && (workflow.sessionPattern || workflow.actionPattern);
  });
}

async function selectFinalizeWorkflow(params: {
  config: SemanticActionContinuityConfig;
  event: FinalizeEvent;
  ctx: HookContext;
  runId: string;
  runs: PluginStateKeyedStore<RunLedgerRecord>;
}): Promise<WorkflowConfig | undefined> {
  if (!params.config.adapter) {
    return undefined;
  }
  for (const workflow of params.config.workflows) {
    const sessionOk =
      !workflow.sessionPattern ||
      matches(
        workflow.sessionPattern,
        sessionText({ ...params.ctx, sessionKey: params.event.sessionKey }),
      );
    if (!sessionOk) {
      continue;
    }
    const existing = await params.runs.lookup(runKey(workflow.id, params.runId));
    if (existing) {
      return workflow;
    }
    if (
      workflow.responseActionPattern &&
      matches(workflow.responseActionPattern, params.event.lastAssistantMessage ?? "")
    ) {
      return workflow;
    }
  }
  return undefined;
}

function isFinalizeActionBearing(
  workflow: WorkflowConfig,
  event: FinalizeEvent,
  previous: RunLedgerRecord | undefined,
): boolean {
  if (previous) {
    return true;
  }
  return workflow.responseActionPattern
    ? matches(workflow.responseActionPattern, event.lastAssistantMessage ?? "")
    : false;
}

function reviseForChangedRevision(params: {
  config: SemanticActionContinuityConfig;
  workflow: WorkflowConfig;
  runId: string;
  previousRevision: string;
  next: RunLedgerRecord;
}) {
  const instruction = [
    params.config.revisionInstruction,
    formatPromptContext(params.workflow, params.next),
    `Previous snapshot revision: ${params.previousRevision}`,
    `Current snapshot revision: ${params.next.revision ?? "unknown"}`,
  ].join("\n\n");
  return {
    action: "revise" as const,
    reason: instruction,
    retry: {
      instruction,
      idempotencyKey: revisionTransitionRetryKey({
        workflowId: params.workflow.id,
        runId: params.runId,
        previousRevision: params.previousRevision,
        nextRevision: params.next.revision ?? "unknown",
      }),
      maxAttempts: 1,
    },
  };
}

function reviseForRefreshFailure(params: {
  config: SemanticActionContinuityConfig;
  workflow: WorkflowConfig;
  runId: string;
  error: unknown;
}) {
  const instruction = [
    "Authoritative workflow state refresh failed immediately before final delivery.",
    "Do not emit action-bearing workflow options from stale state. Tell the user the workflow state could not be refreshed and ask them to retry after checking the authoritative source.",
    `Workflow: ${params.workflow.id}`,
    `Refresh error: ${errorMessage(params.error)}`,
  ].join("\n\n");
  return {
    action: "revise" as const,
    reason: instruction,
    retry: {
      instruction,
      idempotencyKey: retryKey(params.workflow.id, params.runId, "refresh-failed"),
      maxAttempts: 1,
    },
  };
}

function formatPromptContext(workflow: WorkflowConfig, record: RunLedgerRecord): string {
  const lines = [
    "Authoritative semantic action snapshot",
    `Workflow: ${workflow.id}`,
    `Revision: ${record.revision ?? "unavailable"}`,
  ];
  if (record.status) {
    lines.push(`Status: ${record.status}`);
  }
  if (record.summary) {
    lines.push(`Summary: ${record.summary}`);
  }
  if (record.actions?.length) {
    lines.push(`Current actions: ${record.actions.join("; ")}`);
  }
  if (record.refreshFailed) {
    lines.push(
      "Refresh failed. Do not suggest or perform action-bearing workflow choices until authoritative state refresh succeeds.",
    );
  }
  return lines.join("\n");
}

function lazyStores(api: OpenClawPluginApi): () => SemanticActionContinuityStores {
  let stores: SemanticActionContinuityStores | undefined;
  return () => {
    if (!stores) {
      const maxEntries = normalizeConfig(
        api.pluginConfig as Record<string, unknown> | undefined,
      ).maxLedgerEntries;
      const open = <T>(options: OpenKeyedStoreOptions) =>
        api.runtime.state.openKeyedStore<T>(options);
      stores = {
        runs: open<RunLedgerRecord>({ namespace: "semantic-action-continuity-runs", maxEntries }),
        observations: open<ObservationLedgerRecord>({
          namespace: "semantic-action-continuity-observations",
          maxEntries,
        }),
      };
    }
    return stores;
  };
}

function runKey(workflowId: string, runId: string): string {
  return `${workflowId}:${runId}`;
}

function observationKey(workflowId: string, runId: string, revision: string): string {
  return `${workflowId}:${runId}:${revision}`;
}

function retryKey(workflowId: string, runId: string, kind: string): string {
  return `semantic-action-continuity:${workflowId}:${runId}:${kind}`;
}

function revisionTransitionRetryKey(params: {
  workflowId: string;
  runId: string;
  previousRevision: string;
  nextRevision: string;
}): string {
  return [
    "semantic-action-continuity",
    safeKeySegment(params.workflowId),
    safeKeySegment(params.runId),
    "revision",
    safeKeySegment(params.previousRevision),
    safeKeySegment(params.nextRevision),
  ].join(":");
}

function safeKeySegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/gu, "_").replace(/^_+|_+$/gu, "");
  return (normalized || "empty").slice(0, 80);
}

function resolveRunId(event: PromptEvent | FinalizeEvent, ctx: HookContext): string {
  const maybeEvent = event as { runId?: string; sessionId?: string };
  return (
    maybeEvent.runId ??
    ctx.runId ??
    maybeEvent.sessionId ??
    ctx.sessionId ??
    ctx.sessionKey ??
    "unknown"
  );
}

function promptActionText(event: PromptEvent): string {
  return event.prompt;
}

function sessionText(ctx: HookContext): string {
  return [ctx.sessionKey, ctx.sessionId, ctx.workspaceDir, ctx.channel, ctx.channelId, ctx.trigger]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function matches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "iu").test(text);
  } catch {
    return false;
  }
}

function resolveLocalAdapterPath(value: string, workspaceDir: string | undefined): string {
  return path.isAbsolute(value) ? value : path.resolve(workspaceDir ?? process.cwd(), value);
}

function normalizeTimeoutMs(value: unknown): number {
  return normalizeInteger(value, DEFAULT_TIMEOUT_MS, 100, 30_000);
}

async function readTextFileWithTimeout(filePath: string, timeoutMsRaw: unknown): Promise<string> {
  const timeoutMs = normalizeTimeoutMs(timeoutMsRaw);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    return await fs.readFile(filePath, { encoding: "utf8", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
