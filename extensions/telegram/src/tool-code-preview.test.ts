import { describe, expect, it } from "vitest";
import { createTelegramToolCodePreviewTracker } from "./tool-code-preview.js";

const start = (
  t: ReturnType<typeof createTelegramToolCodePreviewTracker>,
  command: string,
  id = "a",
) => t.start({ phase: "start", toolCallId: id, name: "exec_command", args: { command } });
const finish = (
  t: ReturnType<typeof createTelegramToolCodePreviewTracker>,
  output: string,
  id = "a",
  exitCode = 0,
) => t.command({ phase: "end", toolCallId: id, exitCode, output });

describe("event-backed tool code previews", () => {
  it("uses completed native diffs, including multiple files, without rereading disk", () => {
    const t = createTelegramToolCodePreviewTracker();
    t.patch({
      phase: "end",
      toolCallId: "native",
      status: "completed",
      previews: [
        { path: "src/app.py", diff: "@@ -1 +1 @@\n-old\n+new" },
        { path: "artifacts/private/key.py", diff: "+private" },
      ],
    });
    expect(t.html()).toContain("applied diff");
    expect(t.html()).toContain("+new");
    expect(t.html()).not.toContain("private");
  });
  it("keeps exact code and range inside closed rich details", () => {
    const t = createTelegramToolCodePreviewTracker();
    start(t, "sed -n '12,14p' src/app.py");
    finish(t, 'print("<tag> & text")');
    expect(t.html()).toContain("app.py · lines 12–14");
    expect(t.html()).toContain('class="language-python"');
    expect(t.html()).toContain("&lt;tag&gt; &amp; text");
    expect(t.html()).not.toContain(" open");
  });

  it("correlates overlapping calls and ignores failed commands and repeats", () => {
    const t = createTelegramToolCodePreviewTracker();
    start(t, "cat one.ts", "one");
    start(t, "cat two.py", "two");
    finish(t, "wrong", "unknown");
    finish(t, "bad", "one", 1);
    finish(t, "good", "two");
    finish(t, "duplicate", "two");
    expect(t.html()).toContain("two.py");
    expect(t.html()).not.toMatch(/wrong|bad|duplicate|one.ts/);
  });

  it.each([
    "cat .env",
    "cat secrets/key.py",
    "cat artifacts/private/example.py",
    "cat memory/note.py",
    "cat example.py; cat secrets.py",
    "cat a.py b.py",
    "cat $(pwd)/x.py",
    "echo x.py",
    "cat a.py | head",
  ])("never uploads from ambiguous or sensitive command %s", (command) => {
    const t = createTelegramToolCodePreviewTracker();
    start(t, command);
    finish(t, "private");
    expect(t.html()).toBe("");
  });

  it("rejects sensitive literals even in code", () => {
    const t = createTelegramToolCodePreviewTracker();
    start(t, "cat src/app.py");
    finish(t, 'password = "example"');
    expect(t.html()).toBe("");
  });

  it("supports simple literal shell envelopes without running shell expansion", () => {
    const t = createTelegramToolCodePreviewTracker();
    start(t, '/bin/bash -lc "cat src/app.ts"');
    finish(t, "const x = 1;");
    expect(t.html()).toContain("app.ts");
  });

  it("shows patches only after matching successful completion", () => {
    const t = createTelegramToolCodePreviewTracker();
    const patch = "*** Begin Patch\n*** Update File: src/a.py\n@@\n-old\n+new\n*** End Patch";
    t.start({ phase: "start", toolCallId: "edit", name: "apply_patch", args: { input: patch } });
    expect(t.html()).toBe("");
    t.patch({ phase: "end", toolCallId: "other", status: "completed" });
    expect(t.html()).toBe("");
    t.patch({ phase: "end", toolCallId: "edit", status: "completed" });
    expect(t.html()).toContain("applied patch");
    expect(t.html()).toContain("language-diff");
    expect(t.html()).toContain("+new");
  });

  it.each(["failed", "cancelled", undefined])("does not present %s edits as applied", (status) => {
    const t = createTelegramToolCodePreviewTracker();
    t.start({
      phase: "start",
      toolCallId: "edit",
      name: "apply_patch",
      args: { input: "*** Begin Patch\n*** Add File: a.py\n+x\n*** End Patch" },
    });
    t.patch({ phase: "end", toolCallId: "edit", status });
    expect(t.html()).toBe("");
  });

  it("bounds escaped output and labels omissions", () => {
    const t = createTelegramToolCodePreviewTracker();
    for (let i = 0; i < 20; i++) {
      start(t, "cat src/app.py", String(i));
      finish(t, "<&>\n".repeat(2000), String(i));
    }
    expect(t.html().length).toBeLessThanOrEqual(2602);
    expect(t.html()).toContain("excerpt truncated");
    expect(t.html().match(/<details>/g)?.length).toBeLessThanOrEqual(3);
    expect(t.html()).toMatch(/<\/code><\/pre><\/details>$/);
  });
});
