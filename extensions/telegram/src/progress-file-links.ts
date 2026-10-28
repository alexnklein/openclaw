// Tappable file names under Telegram progress lines (HIN mesh file bridge).
//
// The HIN's other agents put a "📄 name" link under each step that names a
// file, opening it in the mesh file bridge's browser view. This does the same
// for OpenClaw's progress window: a step, thought or note that names a file on
// this host gets up to MAX_LINKS links on the line below it. The step text is
// left exactly as it was.
//
// Off unless OPENCLAW_PROGRESS_FILE_BRIDGE names the bridge's open URL, e.g.
// http://100.126.249.86:5288/open?host=housecarl (the Mac bridge reading this
// node's files over SSH). Only files that exist here are linked, by their real
// path; the bridge applies its own root and secret-name rules on open.

import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

const MAX_LINKS = 3;
const CACHE_LIMIT = 500;
// Absolute or home paths: not a URL, a host:/path, a $VAR/x or a flag value.
const ABSOLUTE_RE = /(?<![\w$@:/.~-])(~?\/[^\s'"`;|&<>(){}[\]*?$,=\\]+)/gu;
// Workspace-relative paths with a folder and an extension: artifacts/x/y.md.
const RELATIVE_RE = /(?<![\w$@:/.~-])((?:[\w.-]+\/)+[\w.-]*\.[A-Za-z0-9]{1,8})(?![\w/])/gu;
const SKIP_RE = /^\/(?:dev|proc|sys)\//u;

export type ProgressFileLinkConfig = {
  /** Bridge open URL; the file's path is added as the "path" query value. */
  base: string;
  /** Folder relative paths resolve against (the agent workspace). */
  cwd: string;
};

export function resolveProgressFileLinkConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProgressFileLinkConfig | undefined {
  const base = (env.OPENCLAW_PROGRESS_FILE_BRIDGE ?? "").trim();
  if (!/^https?:\/\//u.test(base)) {
    return undefined;
  }
  const cwd = (env.OPENCLAW_PROGRESS_FILE_BRIDGE_CWD ?? "").trim() || join(homedir(), ".openclaw", "workspace");
  return { base, cwd };
}

const realFiles = new Map<string, string | null>();

function realFile(full: string): string | null {
  if (realFiles.has(full)) {
    return realFiles.get(full) ?? null;
  }
  let found: string | null = null;
  try {
    const real = realpathSync(full);
    found = statSync(real).isFile() ? real : null;
  } catch {
    found = null;
  }
  // A missing file is not remembered: the step may be about to create it.
  if (found) {
    if (realFiles.size >= CACHE_LIMIT) {
      realFiles.delete(realFiles.keys().next().value as string);
    }
    realFiles.set(full, found);
  }
  return found;
}

function clean(raw: string): string {
  return raw.replace(/:\d+(?::\d+)?$/u, "").replace(/[.:]+$/u, "");
}

/** Real paths of the files on this host that `text` names, in order, at most MAX_LINKS. */
export function progressLineFiles(
  text: string,
  cwd: string,
  resolve: (full: string) => string | null = realFile,
): string[] {
  const found: string[] = [];
  const add = (full: string) => {
    if (found.length >= MAX_LINKS || SKIP_RE.test(full)) {
      return;
    }
    const real = resolve(full);
    if (real && !found.includes(real)) {
      found.push(real);
    }
  };
  for (const match of text.matchAll(ABSOLUTE_RE)) {
    const path = clean(match[1] ?? "");
    if (path.length > 1) {
      add(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
    }
  }
  for (const match of text.matchAll(RELATIVE_RE)) {
    const path = clean(match[1] ?? "");
    if (path && !isAbsolute(path)) {
      add(join(cwd, path));
    }
  }
  return found;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function progressFileUrl(base: string, path: string): string {
  const query = encodeURIComponent(path).replace(/%2F/gu, "/");
  return `${base}${base.includes("?") ? "&" : "?"}path=${query}`;
}

/** The "📄 name" line for `text`, as Telegram HTML, or "" when it names no file here. */
export function renderProgressFileLinks(
  text: string,
  config: ProgressFileLinkConfig | undefined,
  resolve?: (full: string) => string | null,
): string {
  if (!config || !text) {
    return "";
  }
  const files = progressLineFiles(text, config.cwd, resolve);
  return files
    .map((path) => `📄 <a href="${escapeHtml(progressFileUrl(config.base, path))}">${escapeHtml(basename(path))}</a>`)
    .join(" · ");
}
