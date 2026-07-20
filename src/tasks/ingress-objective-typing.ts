// Renews exact-origin typing while a durable ingress worker owns visible work.
import { getLoadedChannelPluginForRead } from "../channels/plugins/registry-loaded-read.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { listActiveIngressObjectiveTypingTargets } from "./ingress-objective.js";

const log = createSubsystemLogger("tasks/ingress-objective-typing");
const TYPING_INTERVAL_MS = 3_000;

type IngressTypingRuntime = {
  getConfig: () => OpenClawConfig | null;
  listTargets: typeof listActiveIngressObjectiveTypingTargets;
  sendTyping: (params: {
    cfg: OpenClawConfig;
    channel: string;
    to: string;
    accountId?: string;
    threadId?: string | number;
  }) => Promise<void>;
};

const defaultRuntime: IngressTypingRuntime = {
  getConfig: getRuntimeConfigSnapshot,
  listTargets: listActiveIngressObjectiveTypingTargets,
  sendTyping: async ({ cfg, channel, to, accountId, threadId }) => {
    const sendTyping = getLoadedChannelPluginForRead(channel as ChannelId)?.heartbeat?.sendTyping;
    if (!sendTyping) {
      return;
    }
    await sendTyping({ cfg, to, accountId, threadId });
  },
};

let runtime = defaultRuntime;
let timer: NodeJS.Timeout | null = null;
let pulseInProgress = false;

export async function pulseIngressObjectiveTyping(): Promise<void> {
  if (pulseInProgress) {
    return;
  }
  const cfg = runtime.getConfig();
  if (!cfg) {
    return;
  }
  pulseInProgress = true;
  try {
    const targets = runtime.listTargets();
    await Promise.allSettled(
      targets.map(async (target) => {
        try {
          await runtime.sendTyping({
            cfg,
            channel: target.channel,
            to: target.to,
            accountId: target.accountId,
            threadId: target.threadId,
          });
        } catch (error) {
          log.debug("durable ingress typing pulse failed", {
            error: String(error),
            channel: target.channel,
            flowId: target.flowId,
          });
        }
      }),
    );
  } finally {
    pulseInProgress = false;
  }
}

export function startIngressObjectiveTyping(): void {
  if (timer) {
    return;
  }
  void pulseIngressObjectiveTyping();
  timer = setInterval(() => void pulseIngressObjectiveTyping(), TYPING_INTERVAL_MS);
  timer.unref?.();
}

export function stopIngressObjectiveTyping(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  pulseInProgress = false;
}

export const testing = {
  setRuntime(next: IngressTypingRuntime): void {
    runtime = next;
  },
  resetRuntime(): void {
    runtime = defaultRuntime;
    stopIngressObjectiveTyping();
  },
};
