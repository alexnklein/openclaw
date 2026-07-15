// Covers semantic action freshness across overlapping/fallback attempts.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  recordSemanticActionRevision,
  resetSemanticActionRevisionsForTests,
} from "../../semantic-action-revision.js";
import { makeAttemptResult } from "../run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedBuildEmbeddedRunPayloads,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "../run.overflow-compaction.harness.js";

let runEmbeddedAgent: typeof import("../run.js").runEmbeddedAgent;

describe("runEmbeddedAgent semantic action continuity", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    resetSemanticActionRevisionsForTests();
    mockedBuildEmbeddedRunPayloads.mockImplementation((params) =>
      params.assistantTexts.map((text) => ({ text })),
    );
  });

  it("retries a non-mutating final when session action state changed while it was running", async () => {
    mockedRunEmbeddedAttempt.mockImplementation(async () => {
      throw new Error("unexpected extra semantic action refresh attempt");
    });
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      recordSemanticActionRevision({
        sessionKey: overflowBaseRunParams.sessionKey,
        sessionId: overflowBaseRunParams.sessionId,
      });
      return makeAttemptResult({ assistantTexts: ["Choose wait or admin-merge."] });
    });
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({ assistantTexts: ["PR already merged; calibration is running."] }),
    );

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-semantic-stale-final",
      prompt: "Can that be replay merged?",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.map((payload) => payload.text)).toEqual([
      "PR already merged; calibration is running.",
    ]);
    const retryPrompt = (mockedRunEmbeddedAttempt.mock.calls[1]?.[0] as { prompt?: string }).prompt;
    expect(retryPrompt).toContain("Semantic state changed while the previous answer was running.");
  });

  it("does not stale its own final after the same attempt records a semantic action", async () => {
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
      (
        params as { onSemanticAction?: (event: { toolName: string; runId: string }) => void }
      ).onSemanticAction?.({ toolName: "gateway", runId: "run-semantic-own-action" });
      return makeAttemptResult({ assistantTexts: ["Admin merge completed."] });
    });

    const result = await runEmbeddedAgent({
      ...overflowBaseRunParams,
      runId: "run-semantic-own-action",
      prompt: "Merge it.",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads?.map((payload) => payload.text)).toEqual(["Admin merge completed."]);
  });
});
