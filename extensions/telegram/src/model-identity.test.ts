import { describe, expect, it } from "vitest";
import {
  formatTelegramModelIdentity,
  renderTelegramModelIdentityHtml,
  renderTelegramModelIdentityMarkdown,
  resolveTelegramModelIdentity,
  withTelegramModelIdentity,
} from "./model-identity.js";

describe("Telegram model identity", () => {
  it("uses the runtime-selected provider, model, and effort", () => {
    const identity = resolveTelegramModelIdentity({
      provider: "openai",
      model: "gpt-5.6-sol",
      thinkLevel: "high",
    });

    expect(formatTelegramModelIdentity(identity)).toBe("openai/gpt-5.6-sol · effort high");
  });

  it("omits effort when the runtime does not report it", () => {
    const identity = resolveTelegramModelIdentity({
      provider: "anthropic",
      model: "claude-opus-5",
    });

    expect(formatTelegramModelIdentity(identity)).toBe("anthropic/claude-opus-5");
  });

  it("reports unknown when runtime identity cannot be proved", () => {
    expect(resolveTelegramModelIdentity({ provider: "openai", model: " " })).toBeUndefined();
    expect(renderTelegramModelIdentityMarkdown(undefined)).toBe("**model_identity** `unknown`");
    expect(renderTelegramModelIdentityHtml(undefined, (value) => value)).toBe(
      "<b>model_identity</b> <code>unknown</code>",
    );
  });

  it("uses a longer Markdown code delimiter when identity contains backticks", () => {
    expect(renderTelegramModelIdentityMarkdown({ provider: "openai", model: "gpt`test" })).toBe(
      "**model_identity** ``openai/gpt`test``",
    );
  });

  it("adds delivery metadata without changing answer text", () => {
    const payload = withTelegramModelIdentity(
      { text: "Answer", channelData: { telegram: { pin: true } } },
      { provider: "openai", model: "gpt-5.6-sol", effort: "high" },
    );

    expect(payload.text).toBe("Answer");
    expect(payload.channelData).toEqual({
      telegram: {
        pin: true,
        modelIdentity: { provider: "openai", model: "gpt-5.6-sol", effort: "high" },
      },
    });
  });
});
