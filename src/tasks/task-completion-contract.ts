// Defines task terminal outcome contracts used by completion handling.
import type { TaskTerminalOutcome } from "./task-registry.types.js";

/** Terminal fields required when a mandatory detached task completion is invalid. */
export type RequiredCompletionTerminalResult = {
  terminalOutcome?: Extract<TaskTerminalOutcome, "blocked">;
  terminalSummary?: string;
};

const PROGRESS_ONLY_PATTERN =
  /^(?:i(?:'|\u2019)ll|i will|i(?:'|\u2019)m|i am|i(?:'|\u2019)m going to|i am going to|let me|i need to)\s+(?:now\s+)?(?:acquir(?:e|ing)|align(?:ing)?|analyz(?:e|ing)|apply|check(?:ing)?|clos(?:e|ing)|continue|debug(?:ging)?|deploy(?:ing)?|finish(?:ing)?|fix(?:ing)?|follow(?:ing)?\s+up|implement(?:ing)?|inspect(?:ing)?|install(?:ing)?|investigat(?:e|ing)|look(?:ing)?(?:\s+into)?|map(?:ping)?|open(?:ing)?|patch(?:ing)?|read(?:ing)?|reconcil(?:e|ing)|record(?:ing)?|reload(?:ing)?|report(?:ing)?(?:\s+back)?|restart(?:ing)?|resum(?:e|ing)|review(?:ing)?|re-?run(?:ning)?|run(?:ning)?|start(?:ing)?|sync(?:ing)?|test(?:ing)?|tighten(?:ing)?|trace|trac(?:e|ing)|try(?:ing)?|update|verify(?:ing)?|work(?:ing)?|writ(?:e|ing))/i;

const BARE_PROGRESS_ONLY_PATTERN =
  /^(?:analyz(?:e|ing)|check(?:ing)?|debug(?:ging)?|inspect(?:ing)?|investigat(?:e|ing)|look(?:ing)?\s+into|map(?:ping)?|read(?:ing)?|report(?:ing)?\s+back|review(?:ing)?|run(?:ning)?|test(?:ing)?|trac(?:e|ing)|verify(?:ing)?|work(?:ing)?\s+on)\b/i;

const FOLLOW_UP_PLANNING_PREFIX_PATTERN =
  /^(?:after(?:wards|\s+that)?|from\s+there|next|once\s+(?:done|that(?:'|\u2019)?s\s+done|that\s+is\s+done)|then)[,.\s]+/i;

const FUTURE_GUARD_ONLY_PATTERN =
  /^(?:i(?:'|\u2019)ll|i will)\s+keep\b.+\b(?:blocked|locked|paused|safe|unchanged)\b/i;

function normalizeCompletionText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeCompletionFailureReason(value: string | null | undefined): string {
  const normalized = normalizeCompletionText(value);
  if (!normalized) {
    return "";
  }
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 159)}...`;
}

function matchesProgressOnlyPrefix(value: string): boolean {
  if (PROGRESS_ONLY_PATTERN.test(value) || BARE_PROGRESS_ONLY_PATTERN.test(value)) {
    return true;
  }
  const followup = value.replace(FOLLOW_UP_PLANNING_PREFIX_PATTERN, "").trim();
  return (
    followup !== value &&
    (PROGRESS_ONLY_PATTERN.test(followup) || BARE_PROGRESS_ONLY_PATTERN.test(followup))
  );
}

function hasNonProgressFollowupSentence(value: string): boolean {
  const boundary = /(?:[.!?:]|\s[-\u2013\u2014])\s+\S/.exec(value);
  if (!boundary) {
    return false;
  }
  const separatorEnd = boundary.index + boundary[0].length - 1;
  const firstSentence = value.slice(0, separatorEnd).trim();
  const rest = value.slice(separatorEnd).trim();
  return matchesProgressOnlyPrefix(firstSentence) && !isProgressOnlyCompletionText(rest);
}

export function isProgressOnlyCompletionText(value: string | null | undefined): boolean {
  const normalized = normalizeCompletionText(value);
  if (!normalized) {
    return false;
  }
  if (hasNonProgressFollowupSentence(normalized)) {
    return false;
  }
  return matchesProgressOnlyPrefix(normalized);
}

/** Returns true when the terminal sentence is still only a promise of future work. */
export function endsWithProgressOnlyCompletionText(value: string | null | undefined): boolean {
  const normalized = normalizeCompletionText(value);
  if (!normalized) {
    return false;
  }
  if (isProgressOnlyCompletionText(normalized)) {
    return true;
  }
  const sentences = normalized
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const terminalSentence = sentences.at(-1) ?? normalized;
  return (
    matchesProgressOnlyPrefix(terminalSentence) || FUTURE_GUARD_ONLY_PATTERN.test(terminalSentence)
  );
}

export function resolveRequiredCompletionTerminalResult(
  resultText: string | null | undefined,
): RequiredCompletionTerminalResult {
  const normalized = normalizeCompletionText(resultText);
  if (!normalized) {
    return {
      terminalOutcome: "blocked",
      terminalSummary: "Required completion did not produce a final deliverable.",
    };
  }
  if (isProgressOnlyCompletionText(normalized)) {
    return {
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    };
  }
  return {};
}

export function resolveRequiredCompletionDeliveryFailureTerminalResult(
  reason: string | null | undefined,
): RequiredCompletionTerminalResult {
  const normalizedReason = normalizeCompletionFailureReason(reason);
  return {
    terminalOutcome: "blocked",
    terminalSummary: normalizedReason
      ? `Required completion delivery failed before reaching the requester: ${normalizedReason}.`
      : "Required completion delivery failed before reaching the requester.",
  };
}
