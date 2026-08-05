// Telegram tests cover telegram reply fence plugin behavior.
import { describe, expect, it, vi } from "vitest";
import {
  beginTelegramReplyFence,
  buildTelegramReplyFenceLaneKey,
  buildTelegramNonInterruptingReplyFenceKey,
  resetTelegramReplyFenceForTests,
  shouldSupersedeTelegramReplyFence,
  supersedeTelegramReplyFence,
  supersedeTelegramReplyFenceLane,
  terminalizeTelegramReplyFenceLane,
  testing,
} from "./telegram-reply-fence.js";

describe("shouldSupersedeTelegramReplyFence", () => {
  it("keeps non-interrupting side and status commands from superseding active runs", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/btw what changed?",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/status",
        CommandAuthorized: true,
      }),
    ).toBe(false);
  });

  it("queues normal turns while keeping authorized aborts and commands interrupting", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "@bot answer this",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/stop",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/stop",
        CommandAuthorized: false,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/export-trajectory bundle",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/diagnostics confirm abc123def456",
        CommandAuthorized: true,
      }),
    ).toBe(true);
  });

  it("keeps normal direct turns deliverable while preserving direct aborts", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "answer this",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/stop",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/diagnostics confirm abc123def456",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/diagnostics confirm abc123def456",
        CommandAuthorized: false,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/var/log error",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        ChatType: "direct",
        CommandBody: "/plugin_command",
        CommandAuthorized: true,
        CommandTurn: {
          kind: "text-slash",
          source: "text",
          authorized: true,
          commandName: "plugin_command",
          body: "/plugin_command",
        },
      }),
    ).toBe(true);
  });
});

describe("telegram reply fence supersede", () => {
  it("cascades base supersedes to non-interrupting child fences", () => {
    resetTelegramReplyFenceForTests();
    const activeKey = "agent:main:telegram:group:-100123";
    const sideController = new AbortController();
    const mainController = new AbortController();
    beginTelegramReplyFence({
      key: activeKey,
      supersede: true,
      abortController: mainController,
    });
    beginTelegramReplyFence({
      key: buildTelegramNonInterruptingReplyFenceKey({
        activeKey,
        laneKey: "default\0telegram:-100123:btw:100",
      }),
      supersede: false,
      abortController: sideController,
    });

    expect(supersedeTelegramReplyFence(activeKey)).toBe(true);
    expect(mainController.signal.aborted).toBe(true);
    expect(sideController.signal.aborted).toBe(true);
    resetTelegramReplyFenceForTests();
  });

  it("terminalizes handler-timeout lanes without treating supersession as terminal", async () => {
    resetTelegramReplyFenceForTests();
    const terminalizer = vi.fn();
    const controller = new AbortController();
    const laneKey = buildTelegramReplyFenceLaneKey({
      accountId: "default",
      sequentialKey: "telegram:123",
    });
    beginTelegramReplyFence({
      key: "agent:main:telegram:direct:123",
      supersede: true,
      abortController: controller,
      laneKey,
      terminalizer,
    });

    expect(supersedeTelegramReplyFenceLane(laneKey)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(terminalizer).not.toHaveBeenCalled();

    await terminalizeTelegramReplyFenceLane(laneKey, { reason: "handler-timeout" });
    expect(terminalizer).toHaveBeenCalledWith({ reason: "handler-timeout" });
    resetTelegramReplyFenceForTests();
  });

  it("keeps terminalizer rejection best-effort so the lane can still be superseded", async () => {
    resetTelegramReplyFenceForTests();
    const terminalizer = vi.fn(async () => {
      throw new Error("telegram edit failed");
    });
    const controller = new AbortController();
    const laneKey = buildTelegramReplyFenceLaneKey({
      accountId: "default",
      sequentialKey: "telegram:rejecting",
    });
    beginTelegramReplyFence({
      key: "agent:main:telegram:direct:rejecting",
      supersede: true,
      abortController: controller,
      laneKey,
      terminalizer,
    });

    await expect(
      terminalizeTelegramReplyFenceLane(laneKey, { reason: "handler-timeout" }),
    ).resolves.toBe(true);
    expect(supersedeTelegramReplyFenceLane(laneKey)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    resetTelegramReplyFenceForTests();
  });

  it("bounds a never-settling terminalizer so the lane can still be superseded", async () => {
    vi.useFakeTimers();
    resetTelegramReplyFenceForTests();
    const terminalizer = vi.fn(() => new Promise<void>(() => undefined));
    const controller = new AbortController();
    const laneKey = buildTelegramReplyFenceLaneKey({
      accountId: "default",
      sequentialKey: "telegram:hung",
    });
    beginTelegramReplyFence({
      key: "agent:main:telegram:direct:hung",
      supersede: true,
      abortController: controller,
      laneKey,
      terminalizer,
    });

    try {
      const terminalization = terminalizeTelegramReplyFenceLane(laneKey, {
        reason: "handler-timeout",
      });
      await vi.advanceTimersByTimeAsync(testing.terminalizerTimeoutMs);
      await expect(terminalization).resolves.toBe(true);
      expect(supersedeTelegramReplyFenceLane(laneKey)).toBe(true);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      resetTelegramReplyFenceForTests();
      vi.useRealTimers();
    }
  });
});
