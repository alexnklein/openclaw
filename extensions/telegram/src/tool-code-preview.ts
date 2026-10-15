// Event-backed previews only. Never open a path mentioned by a tool: the
// originating tool owns access, output bounds, and the exact version displayed.
type Call = { path: string; range: string; language: string; patch?: string };
type Event = { itemId?: string; toolCallId?: string; phase?: string; status?: string };

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const languages: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  rs: "rust",
  go: "go",
  sh: "bash",
  css: "css",
  html: "html",
  sql: "sql",
  c: "c",
  h: "c",
  cpp: "cpp",
  swift: "swift",
  kt: "kotlin",
};

function language(path: string): string | undefined {
  // Private stores and common credential paths must never become previews.
  if (
    /(?:^|[/. _-])(?:private|secrets?|credentials?|tokens?|passwords?|memory|media|documents|\.ssh|\.env)(?:[/. _-]|$)/i.test(
      path,
    )
  )
    return;
  return languages[path.split(".").pop() ?? ""];
}

function readCall(args: Record<string, unknown>): Call | undefined {
  const command = typeof args.command === "string" ? args.command : args.cmd;
  if (typeof command !== "string") return;
  let literal = command.trim();
  const wrapper = literal.match(/^(?:\/bin\/)?bash\s+-lc\s+(["'])([\s\S]*)\1$/);
  if (wrapper) {
    if (/[$`\\]/.test(wrapper[2])) return;
    literal = wrapper[2];
  }
  // One literal file, no pipes, interpolation, redirects, or command chains.
  const match = literal.match(
    /^(?:cat\s+|sed\s+-n\s+'(\d+),(\d+)p'\s+|head\s+-n\s+(\d+)\s+)([\w./-]+)$/,
  );
  if (!match) return;
  const path = match[4];
  const lang = language(path);
  if (!lang) return;
  const start = match[1] ? Number(match[1]) : 1;
  const end = match[2] ? Number(match[2]) : match[3] ? Number(match[3]) : undefined;
  if (end !== undefined && end < start) return;
  return { path, language: lang, range: end ? `lines ${start}–${end}` : "file read" };
}

function patchCall(args: Record<string, unknown>): Call | undefined {
  const patch = args.patch ?? args.input;
  if (typeof patch !== "string" || patch.length > 100_000) return;
  const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)];
  if (files.length !== 1 || /^\*\*\* Move to:/m.test(patch)) return;
  const path = files[0][1];
  if (!language(path)) return;
  return { path, language: "diff", range: "applied patch", patch };
}

export function createTelegramToolCodePreviewTracker() {
  const pending = new Map<string, Call>();
  const completedPatches = new Set<string>();
  const previews: string[] = [];
  let budget = 2600; // HTML-escaped budget; keep summary within one message.
  const id = (e: Event) => e.toolCallId ?? e.itemId;
  function render(call: Call, content: string) {
    // Fail closed for recognizable sensitive content, including code literals.
    if (
      !content.trim() ||
      /-----BEGIN .*PRIVATE KEY|\b(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]/i.test(
        content,
      )
    )
      return;
    const lines = content.split("\n");
    let body = "";
    let used = 0;
    for (const line of lines.slice(0, 60)) {
      const next = escape(line) + "\n";
      if (body.length + next.length > Math.min(1200, budget - 350)) break;
      body += next;
      used++;
    }
    if (!body) return;
    const truncated = used < lines.length;
    const name = escape(call.path.split("/").pop()!);
    const label = `${name} · ${call.range}${truncated ? " · excerpt truncated" : ""}`;
    const block = `<details><summary>${label}</summary><pre><code class="language-${call.language}">${body}</code></pre></details>`;
    if (block.length > budget) return;
    previews.push(block);
    budget -= block.length;
  }
  return {
    start(e: Event & { name?: string; args?: Record<string, unknown> }) {
      const key = id(e);
      if (!key || e.phase !== "start" || !e.args || pending.size >= 100) return;
      const name = e.name?.replace(/^.*[./]/, "");
      const call =
        name === "apply_patch"
          ? patchCall(e.args)
          : /^(?:bash|exec|exec_command)$/.test(name ?? "")
            ? readCall(e.args)
            : undefined;
      if (call) pending.set(key, call);
    },
    command(e: Event & { exitCode?: number | null; output?: string }) {
      const key = id(e);
      if (!key || e.phase !== "end") return;
      const call = pending.get(key);
      pending.delete(key);
      if (call && !call.patch && e.exitCode === 0 && e.output && previews.length < 3)
        render(call, e.output);
    },
    patch(e: Event & { kind?: string; previews?: Array<{ path: string; diff: string }> }) {
      const key = id(e);
      if (!key || e.phase !== "end") return;
      if (completedPatches.has(key) || completedPatches.size >= 100) return;
      completedPatches.add(key);
      if (e.previews && /^(?:completed|success|succeeded)$/.test(e.status ?? "")) {
        for (const change of e.previews) {
          if (previews.length >= 3) break;
          if (language(change.path))
            render({ path: change.path, language: "diff", range: "applied diff" }, change.diff);
        }
        pending.delete(key);
        return;
      }
      const call = pending.get(key);
      if (!call?.patch) return;
      pending.delete(key);
      // A summary alone is not success evidence.
      if (
        call?.patch &&
        /^(?:completed|success|succeeded)$/.test(e.status ?? "") &&
        previews.length < 3
      )
        render(call, call.patch);
    },
    html() {
      return previews.join("\n");
    },
  };
}
