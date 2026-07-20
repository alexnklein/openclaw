import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pulseIngressObjectiveTyping,
  startIngressObjectiveTyping,
  stopIngressObjectiveTyping,
  testing,
} from "./ingress-objective-typing.js";

describe("durable ingress typing", () => {
  afterEach(() => {
    vi.useRealTimers();
    testing.resetRuntime();
  });

  it("renews typing on the exact originating topic while a worker owns the flow", async () => {
    vi.useFakeTimers();
    const sendTyping = vi.fn(async () => undefined);
    testing.setRuntime({
      getConfig: () => ({}),
      listTargets: () => [
        {
          flowId: "flow-1",
          channel: "telegram",
          to: "-1003755488173",
          accountId: "housecarl",
          threadId: 2,
        },
      ],
      sendTyping,
    });

    startIngressObjectiveTyping();
    await vi.advanceTimersByTimeAsync(0);
    expect(sendTyping).toHaveBeenCalledWith({
      cfg: {},
      channel: "telegram",
      to: "-1003755488173",
      accountId: "housecarl",
      threadId: 2,
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(sendTyping).toHaveBeenCalledTimes(2);
    stopIngressObjectiveTyping();
  });

  it("does nothing when no durable worker owns visible work", async () => {
    const sendTyping = vi.fn(async () => undefined);
    testing.setRuntime({
      getConfig: () => ({}),
      listTargets: () => [],
      sendTyping,
    });

    await pulseIngressObjectiveTyping();
    expect(sendTyping).not.toHaveBeenCalled();
  });
});
