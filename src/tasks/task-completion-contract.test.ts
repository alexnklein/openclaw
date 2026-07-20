import { describe, expect, it } from "vitest";
import {
  endsWithProgressOnlyCompletionText,
  isProgressOnlyCompletionText,
} from "./task-completion-contract.js";

describe("task completion contract", () => {
  it("recognizes the exact continuity-failure promise as progress-only", () => {
    const text =
      "I’m implementing the continuity fixes now, starting with the exact forensic action list and live timeout/proxy/handoff code. " +
      "I’ll keep MTL paused and treat each repair as a separately verified gate.";

    expect(endsWithProgressOnlyCompletionText(text)).toBe(true);
  });

  it("recognizes an unfinished terminal sentence after substantive progress", () => {
    expect(
      endsWithProgressOnlyCompletionText(
        "Parser tests passed. I’m tightening both guards, then rerunning regressions.",
      ),
    ).toBe(true);
  });

  it("preserves real terminal results", () => {
    expect(isProgressOnlyCompletionText("Fixed. All 45 focused tests pass. done")).toBe(false);
    expect(endsWithProgressOnlyCompletionText("Fixed. All 45 focused tests pass. done")).toBe(
      false,
    );
    expect(
      endsWithProgressOnlyCompletionText(
        "I’m implementing the continuity guard. The deployed runtime is healthy and 153 tests pass. done",
      ),
    ).toBe(false);
    expect(
      endsWithProgressOnlyCompletionText(
        "I’ll keep MTL paused. Continuity recovery is active and verified. done",
      ),
    ).toBe(false);
  });
});
