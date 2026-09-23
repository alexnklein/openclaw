import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

export type TelegramModelIdentity = {
  provider: string;
  model: string;
  effort?: string;
};

type ModelSelectionContext = {
  provider?: unknown;
  model?: unknown;
  thinkLevel?: unknown;
};

function normalizeIdentityPart(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function resolveTelegramModelIdentity(
  selection: ModelSelectionContext | undefined,
): TelegramModelIdentity | undefined {
  const provider = normalizeIdentityPart(selection?.provider);
  const model = normalizeIdentityPart(selection?.model);
  if (!provider || !model) {
    return undefined;
  }
  const effort = normalizeIdentityPart(selection?.thinkLevel);
  return { provider, model, ...(effort ? { effort } : {}) };
}

export function formatTelegramModelIdentity(identity: TelegramModelIdentity | undefined): string {
  if (!identity) {
    return "unknown";
  }
  const model = `${identity.provider}/${identity.model}`;
  return identity.effort ? `${model} · effort ${identity.effort}` : model;
}

export function renderTelegramModelIdentityMarkdown(
  identity: TelegramModelIdentity | undefined,
): string {
  const value = formatTelegramModelIdentity(identity);
  const longestBacktickRun = Math.max(0, ...(value.match(/`+/gu)?.map((run) => run.length) ?? []));
  const delimiter = "`".repeat(longestBacktickRun + 1);
  return `**model_identity** ${delimiter}${value}${delimiter}`;
}

export function renderTelegramModelIdentityHtml(
  identity: TelegramModelIdentity | undefined,
  escapeHtml: (value: string) => string,
): string {
  return `<b>model_identity</b> <code>${escapeHtml(formatTelegramModelIdentity(identity))}</code>`;
}

export function withTelegramModelIdentity(
  payload: ReplyPayload,
  identity: TelegramModelIdentity | undefined,
): ReplyPayload {
  const telegram =
    payload.channelData?.telegram && typeof payload.channelData.telegram === "object"
      ? (payload.channelData.telegram as Record<string, unknown>)
      : {};
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      telegram: { ...telegram, modelIdentity: identity },
    },
  };
}
