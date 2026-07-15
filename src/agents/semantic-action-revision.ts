/**
 * Process-local semantic action revisions for agent sessions.
 *
 * These revisions are not durable receipts. They are a cheap freshness guard:
 * when one run completes a mutating action, another in-flight run for the same
 * session must not finalize stale options that were prepared against older
 * state.
 */

const MAX_TRACKED_SESSIONS = 1000;

const SEMANTIC_ACTION_REVISIONS_SYMBOL = Symbol.for("openclaw.semanticActionRevisions");

type GlobalWithSemanticActionRevisions = typeof globalThis & {
  [SEMANTIC_ACTION_REVISIONS_SYMBOL]?: Map<string, number>;
};

const semanticActionRevisionGlobal = globalThis as GlobalWithSemanticActionRevisions;
const revisionsBySessionKey =
  semanticActionRevisionGlobal[SEMANTIC_ACTION_REVISIONS_SYMBOL] ?? new Map<string, number>();
semanticActionRevisionGlobal[SEMANTIC_ACTION_REVISIONS_SYMBOL] = revisionsBySessionKey;

export type SemanticActionRevisionScope = {
  sessionKey?: string | null;
  sessionId?: string | null;
};

function resolveRevisionKeys(scope: SemanticActionRevisionScope): string[] {
  const keys: string[] = [];
  const sessionKey = scope.sessionKey?.trim();
  if (sessionKey) {
    keys.push(`key:${sessionKey}`);
  }
  const sessionId = scope.sessionId?.trim();
  if (sessionId) {
    keys.push(`id:${sessionId}`);
  }
  return keys;
}

function trimRevisionMap(): void {
  while (revisionsBySessionKey.size > MAX_TRACKED_SESSIONS) {
    const oldest = revisionsBySessionKey.keys().next().value;
    if (!oldest) {
      return;
    }
    revisionsBySessionKey.delete(oldest);
  }
}

export function readSemanticActionRevision(scope: SemanticActionRevisionScope): number {
  return resolveRevisionKeys(scope).reduce(
    (max, key) => Math.max(max, revisionsBySessionKey.get(key) ?? 0),
    0,
  );
}

export function recordSemanticActionRevision(scope: SemanticActionRevisionScope): number {
  const keys = resolveRevisionKeys(scope);
  if (keys.length === 0) {
    return 0;
  }
  const next = readSemanticActionRevision(scope) + 1;
  for (const key of keys) {
    revisionsBySessionKey.set(key, next);
  }
  trimRevisionMap();
  return next;
}

export function hasSemanticActionRevisionAdvanced(
  scope: SemanticActionRevisionScope,
  baseline: number,
): boolean {
  return readSemanticActionRevision(scope) > baseline;
}

export function resetSemanticActionRevisionsForTests(): void {
  revisionsBySessionKey.clear();
}
