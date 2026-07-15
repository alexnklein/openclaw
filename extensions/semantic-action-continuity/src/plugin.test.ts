// Semantic action continuity tests cover mutable workflow freshness gates.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "../api.js";
import { registerSemanticActionContinuityPlugin } from "./plugin.js";

type HookName = "before_prompt_build" | "before_agent_finalize";
type HookMap = Partial<Record<HookName, (event: never, ctx: never) => Promise<unknown>>>;

type Snapshot = {
  revision: string;
  status?: string;
  summary?: string;
  actions?: string[];
};

type FinalizeResult =
  | {
      action?: string;
      reason?: string;
      retry?: { idempotencyKey?: string; maxAttempts?: number };
    }
  | undefined;

const BASE_CONFIG = {
  adapter: {
    path: "semantic-action.json",
  },
  workflows: [
    {
      id: "merge-workflow",
      sessionPattern: "repo-session",
      actionPattern: "merge|pull request|PR",
      responseActionPattern: "wait|admin merge|merge",
    },
  ],
};

describe("semantic action continuity plugin", () => {
  it("suppresses stale wait-or-admin-merge output when external state merges before final", async () => {
    const snapshots: Snapshot[] = [
      {
        revision: "pr-open",
        status: "open",
        summary: "Pull request still open.",
        actions: ["wait", "admin merge"],
      },
      {
        revision: "pr-merged",
        status: "merged",
        summary: "Pull request merged externally.",
        actions: ["do not merge again", "report merged"],
      },
    ];
    const loadSnapshot = vi.fn(async () => snapshots.shift() ?? snapshots[0]);
    const hooks = registerForTest(BASE_CONFIG, loadSnapshot);

    const firstPrompt = await runPrompt(hooks, {
      provider: "openai",
      model: "gpt-5.5",
      prompt: "Check PR and offer merge options.",
    });
    expect(firstPrompt?.prependContext).toContain("Revision: pr-open");

    const final = await runFinalize(hooks, {
      provider: "anthropic",
      model: "sonnet-4.6",
      lastAssistantMessage: "We should wait or ask an admin merge.",
    });

    expect(final).toMatchObject({
      action: "revise",
      retry: {
        idempotencyKey:
          "semantic-action-continuity:merge-workflow:run-1:revision:pr-open:pr-merged",
        maxAttempts: 1,
      },
    });
    expect(JSON.stringify(final)).toContain("Revision: pr-merged");
    expect(JSON.stringify(final)).toContain("Pull request merged externally.");
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("refreshes fallback candidates with provider/model-independent state", async () => {
    const loadSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        revision: "pr-open",
        status: "open",
        actions: ["wait", "admin merge"],
      })
      .mockResolvedValueOnce({
        revision: "pr-merged",
        status: "merged",
        actions: ["report merged"],
      })
      .mockResolvedValue({
        revision: "pr-merged",
        status: "merged",
        actions: ["report merged"],
      });
    const hooks = registerForTest(BASE_CONFIG, loadSnapshot);

    await runPrompt(hooks, {
      provider: "openai",
      model: "gpt-5.5",
      prompt: "Check PR and offer merge options.",
    });
    const fallbackPrompt = await runPrompt(hooks, {
      provider: "anthropic",
      model: "sonnet-4.6",
      prompt: "Check PR and offer merge options.",
    });
    const final = await runFinalize(hooks, {
      provider: "anthropic",
      model: "sonnet-4.6",
      lastAssistantMessage: "It is already merged.",
    });

    expect(fallbackPrompt?.prependContext).toContain("Revision: pr-merged");
    expect(final).toBeUndefined();
    expect(
      loadSnapshot.mock.calls.map(
        ([call]) => (call as { ctx: { modelProviderId?: string } }).ctx.modelProviderId,
      ),
    ).toEqual(["openai", "anthropic", "anthropic"]);
    expect(loadSnapshot).toHaveBeenCalledTimes(3);
  });

  it("continues unchanged state", async () => {
    const loadSnapshot = vi.fn(async () => ({
      revision: "same-revision",
      status: "open",
      actions: ["wait"],
    }));
    const hooks = registerForTest(BASE_CONFIG, loadSnapshot);

    await runPrompt(hooks, { prompt: "Check PR state." });
    const final = await runFinalize(hooks, {
      lastAssistantMessage: "Wait for merge checks.",
    });

    expect(final).toBeUndefined();
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does no external lookup for unrelated turns", async () => {
    const loadSnapshot = vi.fn(async () => ({
      revision: "unused",
    }));
    const hooks = registerForTest(BASE_CONFIG, loadSnapshot);

    const promptResult = await runPrompt(hooks, {
      prompt: "Tell me a joke.",
      sessionKey: "agent:main:other-session",
    });
    const finalResult = await runFinalize(hooks, {
      sessionKey: "agent:main:other-session",
      lastAssistantMessage: "No workflow action here.",
    });

    expect(promptResult).toBeUndefined();
    expect(finalResult).toBeUndefined();
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("does not re-trigger from old workflow text in session history", async () => {
    const loadSnapshot = vi.fn(async () => ({
      revision: "pr-open",
      status: "open",
      actions: ["wait"],
    }));
    const hooks = registerForTest(BASE_CONFIG, loadSnapshot);

    await runPrompt(hooks, {
      runId: "run-1",
      prompt: "Check PR state.",
    });
    const unrelated = await runPrompt(hooks, {
      runId: "run-2",
      prompt: "Summarize today's notes.",
      messages: [
        { role: "user", content: "Earlier we discussed PR merge options." },
        { role: "user", content: "Summarize today's notes." },
      ],
    });

    expect(unrelated).toBeUndefined();
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
  });

  it("fails closed for action-bearing final responses when refresh fails", async () => {
    const loadSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ revision: "pr-open", status: "open", actions: ["wait"] })
      .mockRejectedValueOnce(new Error("snapshot source unavailable"));
    const hooks = registerForTest(BASE_CONFIG, loadSnapshot);

    await runPrompt(hooks, { prompt: "Check PR state." });
    const final = await runFinalize(hooks, {
      lastAssistantMessage: "Wait or ask an admin merge.",
    });

    expect(final).toMatchObject({
      action: "revise",
      retry: {
        idempotencyKey: "semantic-action-continuity:merge-workflow:run-1:refresh-failed",
        maxAttempts: 1,
      },
    });
    expect(JSON.stringify(final)).toContain("could not be refreshed");
  });

  it("preserves the last known revision when a fallback candidate refresh fails", async () => {
    const loadSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ revision: "pr-open", status: "open", actions: ["wait"] })
      .mockRejectedValueOnce(new Error("snapshot source unavailable"))
      .mockResolvedValueOnce({
        revision: "pr-merged",
        status: "merged",
        actions: ["report merged"],
      });
    const hooks = registerForTest(BASE_CONFIG, loadSnapshot);

    await runPrompt(hooks, { prompt: "Check PR state." });
    const fallbackPrompt = await runPrompt(hooks, {
      provider: "anthropic",
      model: "sonnet-4.6",
      prompt: "Check PR state.",
    });
    const final = await runFinalize(hooks, {
      provider: "anthropic",
      model: "sonnet-4.6",
      lastAssistantMessage: "Wait or ask an admin merge.",
    });

    expect(fallbackPrompt?.prependContext).toContain("Revision: pr-open");
    expect(fallbackPrompt?.prependContext).toContain("Refresh failed");
    expect(final).toMatchObject({
      action: "revise",
      retry: {
        idempotencyKey:
          "semantic-action-continuity:merge-workflow:run-1:revision:pr-open:pr-merged",
        maxAttempts: 1,
      },
    });
  });

  it("injects fail-closed prompt context when candidate refresh fails", async () => {
    const loadSnapshot = vi.fn(async () => {
      throw new Error("snapshot source unavailable");
    });
    const hooks = registerForTest(BASE_CONFIG, loadSnapshot);

    const promptResult = await runPrompt(hooks, { prompt: "Check PR state." });

    expect(promptResult?.prependContext).toContain("Refresh failed");
    expect(promptResult?.prependContext).toContain("Do not suggest or perform action-bearing");
  });

  it("uses stable one-attempt retry metadata to bound revision loops", async () => {
    const loadSnapshot = vi
      .fn()
      .mockResolvedValueOnce({ revision: "old", status: "open", actions: ["wait"] })
      .mockResolvedValue({ revision: "new", status: "merged", actions: ["report merged"] });
    const hooks = registerForTest(BASE_CONFIG, loadSnapshot);

    await runPrompt(hooks, { prompt: "Check PR state." });
    const first = await runFinalize(hooks, { lastAssistantMessage: "Wait for merge." });
    const second = await runFinalize(hooks, { lastAssistantMessage: "Wait for merge." });

    expect(first).toMatchObject({
      action: "revise",
      retry: {
        idempotencyKey: "semantic-action-continuity:merge-workflow:run-1:revision:old:new",
        maxAttempts: 1,
      },
    });
    expect(second).toBeUndefined();
  });

  it("rejects response-only workflows because no prompt baseline can be captured", async () => {
    const loadSnapshot = vi.fn(async () => ({ revision: "unused" }));
    const hooks = registerForTest(
      {
        adapter: {
          path: "semantic-action.json",
        },
        workflows: [
          {
            id: "response-only",
            responseActionPattern: "merge",
          },
        ],
      },
      loadSnapshot,
    );

    const final = await runFinalize(hooks, {
      lastAssistantMessage: "Admin merge this PR.",
    });

    expect(final).toBeUndefined();
    expect(loadSnapshot).not.toHaveBeenCalled();
  });

  it("loads snapshots from a configured local path adapter", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sac-path-"));
    await fs.writeFile(
      path.join(workspaceDir, "semantic-action.json"),
      JSON.stringify({ revision: "path-revision", status: "open", actions: ["wait"] }),
    );
    const hooks = registerForTest(BASE_CONFIG);

    const prompt = await runPrompt(hooks, {
      prompt: "Check PR state.",
      workspaceDir,
    });

    expect(prompt?.prependContext).toContain("Revision: path-revision");
    expect(prompt?.prependContext).toContain("Status: open");
  });

  it("loads snapshots from a configured command adapter", async () => {
    const hooks = registerForTest({
      adapter: {
        command: {
          file: process.execPath,
          cwd: process.cwd(),
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({revision:process.env.OPENCLAW_ACTION_CONTINUITY_WORKFLOW_ID + '-cmd', actions:['report']}))",
          ],
        },
      },
      workflows: BASE_CONFIG.workflows,
    });

    const prompt = await runPrompt(hooks, { prompt: "Check PR state." });

    expect(prompt?.prependContext).toContain("Revision: merge-workflow-cmd");
    expect(prompt?.prependContext).toContain("Current actions: report");
  });
});

function registerForTest(
  pluginConfig: Record<string, unknown>,
  loadSnapshot?: (params: unknown) => Promise<Snapshot>,
): HookMap {
  const hooks: HookMap = {};
  const stores = new Map<string, PluginStateKeyedStore<unknown>>();
  const api = {
    pluginConfig,
    config: buildConfig(pluginConfig),
    runtime: {
      config: {
        current: () => buildConfig(pluginConfig),
      },
      state: {
        openKeyedStore: <T>(options: OpenKeyedStoreOptions) => {
          const store =
            stores.get(options.namespace) ??
            createMemoryKeyedStore<unknown>({ maxEntries: options.maxEntries });
          stores.set(options.namespace, store);
          return store as PluginStateKeyedStore<T>;
        },
      },
    },
    on: (name: HookName, handler: (event: never, ctx: never) => Promise<unknown>) => {
      hooks[name] = handler;
    },
    logger: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as OpenClawPluginApi;
  registerSemanticActionContinuityPlugin(
    api,
    loadSnapshot ? { loadSnapshot: async (params) => loadSnapshot(params) } : {},
  );
  return hooks;
}

async function runPrompt(
  hooks: HookMap,
  params: {
    runId?: string;
    prompt: string;
    sessionKey?: string;
    provider?: string;
    model?: string;
    workspaceDir?: string;
    messages?: unknown[];
  },
): Promise<{ prependContext?: string } | undefined> {
  return (await hooks.before_prompt_build?.(
    {
      prompt: params.prompt,
      messages: params.messages ?? [{ role: "user", content: params.prompt }],
    } as never,
    buildCtx(params) as never,
  )) as { prependContext?: string } | undefined;
}

async function runFinalize(
  hooks: HookMap,
  params: {
    sessionKey?: string;
    provider?: string;
    model?: string;
    workspaceDir?: string;
    lastAssistantMessage: string;
  },
): Promise<FinalizeResult> {
  return (await hooks.before_agent_finalize?.(
    {
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: params.sessionKey ?? "agent:main:repo-session",
      provider: params.provider ?? "openai",
      model: params.model ?? "gpt-5.5",
      stopHookActive: false,
      lastAssistantMessage: params.lastAssistantMessage,
      messages: [{ role: "assistant", content: params.lastAssistantMessage }],
    } as never,
    buildCtx(params) as never,
  )) as FinalizeResult;
}

function buildCtx(params: {
  runId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
}): Record<string, string> {
  return {
    runId: params.runId ?? "run-1",
    sessionId: "session-1",
    sessionKey: params.sessionKey ?? "agent:main:repo-session",
    workspaceDir: params.workspaceDir ?? "/repo",
    modelProviderId: params.provider ?? "openai",
    modelId: params.model ?? "gpt-5.5",
  };
}

function buildConfig(pluginConfig: Record<string, unknown>): OpenClawConfig {
  return {
    plugins: {
      entries: {
        "semantic-action-continuity": {
          config: pluginConfig,
        },
      },
    },
  } as OpenClawConfig;
}

function createMemoryKeyedStore<T>(params: { maxEntries: number }): PluginStateKeyedStore<T> {
  const entries = new Map<string, T>();
  const prune = () => {
    while (entries.size > params.maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      entries.delete(oldest);
    }
  };
  return {
    async register(key, value) {
      entries.delete(key);
      entries.set(key, value);
      prune();
    },
    async registerIfAbsent(key, value) {
      if (entries.has(key)) {
        return false;
      }
      entries.set(key, value);
      prune();
      return true;
    },
    async lookup(key) {
      return entries.get(key);
    },
    async consume(key) {
      const value = entries.get(key);
      entries.delete(key);
      return value;
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].map(([key, value], index) => ({
        key,
        value,
        createdAt: index,
      }));
    },
    async clear() {
      entries.clear();
    },
  };
}
