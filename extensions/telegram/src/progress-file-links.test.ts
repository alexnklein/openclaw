import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  progressFileUrl,
  progressLineFiles,
  renderProgressFileLinks,
  resolveProgressFileLinkConfig,
} from "./progress-file-links.js";

const BASE = "http://100.126.249.86:5288/open?host=housecarl";

function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "progress-file-links-")));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "artifacts", "product-frustrations"), { recursive: true });
  writeFileSync(join(root, "scripts", "backup_report_publish.py"), "print('hi')\n");
  writeFileSync(join(root, "artifacts", "product-frustrations", "follow-through.md"), "# notes\n");
  return root;
}

describe("progress file links", () => {
  it("is off unless the bridge URL is set", () => {
    expect(resolveProgressFileLinkConfig({})).toBeUndefined();
    expect(resolveProgressFileLinkConfig({ OPENCLAW_PROGRESS_FILE_BRIDGE: "nope" })).toBeUndefined();
    expect(
      resolveProgressFileLinkConfig({ OPENCLAW_PROGRESS_FILE_BRIDGE: BASE, OPENCLAW_PROGRESS_FILE_BRIDGE_CWD: "/w" }),
    ).toEqual({ base: BASE, cwd: "/w" });
    expect(renderProgressFileLinks("sed -n 1,20p /etc/hosts", undefined)).toBe("");
  });

  it("links the files a bash step names, absolute and workspace-relative", () => {
    const root = workspace();
    const script = join(root, "scripts", "backup_report_publish.py");
    const step = `sed -n '1,220p' ${script} rg -n 'caption|LABEL' x; tail -18 artifacts/product-frustrations/follow-through.md`;
    expect(progressLineFiles(step, root)).toEqual([
      script,
      join(root, "artifacts", "product-frustrations", "follow-through.md"),
    ]);
    const html = renderProgressFileLinks(step, { base: BASE, cwd: root });
    expect(html).toContain(`📄 <a href="${progressFileUrl(BASE, script).replaceAll("&", "&amp;")}">backup_report_publish.py</a>`);
    expect(html).toContain(">follow-through.md</a>");
    expect(html.split(" · ")).toHaveLength(2);
  });

  it("skips missing files, URLs, devices and repeats, and stops at three", () => {
    const root = workspace();
    const script = join(root, "scripts", "backup_report_publish.py");
    expect(progressLineFiles(`curl https://x.io/a/b.py > /dev/null; cat ${root}/nope.py`, root)).toEqual([]);
    expect(progressLineFiles(`cat ${script} ${script}:40`, root)).toEqual([script]);
    const many = ["a", "b", "c", "d"].map((n) => {
      const p = join(root, `${n}.txt`);
      writeFileSync(p, n);
      return p;
    });
    expect(progressLineFiles(`cat ${many.join(" ")}`, root)).toEqual(many.slice(0, 3));
  });

  it("puts the path in the bridge URL's query", () => {
    expect(progressFileUrl(BASE, "/home/housecarl/a b.py")).toBe(`${BASE}&path=/home/housecarl/a%20b.py`);
    expect(progressFileUrl("http://h:5288/open", "/x.py")).toBe("http://h:5288/open?path=/x.py");
  });
});
