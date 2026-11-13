import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installInitYes } from "../src/init/install.js";
import {
  autopilotDshPatchEntry,
  dshPatchContainsAutopilot,
  dshPatchYamlPath,
  DSH_PATCH_ENTRY_ID,
  DSH_PATCH_ENTRY_NAME,
  DSH_PATCH_REL_PATH,
  hasCompleteDshAutopilotEntry,
  mergeDshPatch,
  mergeDshPatchYaml,
  parseDshPatchYaml,
  readDshPatch,
  resolveDshHome,
  stripAutopilotDshPatch,
  stripAutopilotDshPatchYaml,
  summarizeDshAutopilotEntry,
  validateDshPatchShape,
} from "../src/init/dsh-patch-merge.js";

const USER_PATCH = `# 我自己的补丁层
- insert:
    - id: my-plugin          # 用户的插件
      name: 'my-plugin/entry'
      config:
        flag: true        # 用户自己的配置
`;

// 超 80 列的长标量 + 顶层注释：整树序列化会折行并把注释缩进，这里当回归基线。
const LONG_SCALAR_LINE = `          - 'npx -y @modelcontextprotocol/server-postgres "$SOUL_HAVEN_PROD_DB_MCP_URL"'`;
const USER_PATCH_LONG = `# 机器级补丁层（用户手写）
- insert:
    - id: mcp-postgres-prod
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        command: zsh
        args:
          - -lc
${LONG_SCALAR_LINE}

# ===== 关闭列表 =====
    - id: mcp-xinyu
      name: '@deepseek-ai/dsh-mcp-client'
      disabled: true
`;

describe("DSH home / patch path resolution", () => {
  it("honors DSH_HOME and defaults to ~/.dsh", () => {
    expect(resolveDshHome({ DSH_HOME: "/tmp/dsh-home" })).toBe("/tmp/dsh-home");
    expect(resolveDshHome({ DSH_HOME: "  " })).toBe(
      path.join(os.homedir(), ".dsh"),
    );
    expect(resolveDshHome({})).toBe(path.join(os.homedir(), ".dsh"));
    // 控制字符被剥掉，不能变成另一条路径
    expect(resolveDshHome({ DSH_HOME: "/tmp/a\u0000b" })).toBe("/tmp/ab");
  });

  it("builds the cordis patch path under the home", () => {
    expect(dshPatchYamlPath("/tmp/dsh-home")).toBe(
      path.join("/tmp/dsh-home", DSH_PATCH_REL_PATH),
    );
    expect(DSH_PATCH_REL_PATH).toBe("cordis.patch.yml");
  });
});

describe("DSH patch shape validation", () => {
  it("accepts empty / list roots and rejects maps", () => {
    expect(validateDshPatchShape(null)).toBeNull();
    expect(validateDshPatchShape([])).toBeNull();
    expect(validateDshPatchShape([{ insert: [] }])).toBeNull();
    expect(validateDshPatchShape({ insert: [] })).toMatch(/root must be a list/);
  });

  it("rejects non-list insert, non-object entries and unsafe keys", () => {
    expect(validateDshPatchShape([{ insert: {} }])).toMatch(
      /"insert" must be a list/,
    );
    expect(validateDshPatchShape([{ insert: [1] }])).toMatch(
      /non-object plugin entry/,
    );
    expect(
      validateDshPatchShape([{ insert: [{ config: "nope" }] }]),
    ).toMatch(/"config" must be a mapping/);
    expect(
      validateDshPatchShape([
        JSON.parse('{"insert":[{"__proto__":{"x":1}}]}') as unknown,
      ]),
    ).toMatch(/not allowed/);
    expect(validateDshPatchShape([{ insert: [{ id: 1 }] }])).toMatch(
      /"id" must be a string/,
    );
  });
});

describe("DSH patch YAML parsing", () => {
  it("treats blank and null as an empty list", () => {
    expect(parseDshPatchYaml("")).toEqual([]);
    expect(parseDshPatchYaml("\n\n")).toEqual([]);
    expect(parseDshPatchYaml("null")).toEqual([]);
    expect(parseDshPatchYaml(null)).toEqual([]);
  });

  it("throws on broken YAML and on a non-list root", () => {
    expect(() => parseDshPatchYaml("insert: [")).toThrow(/not valid YAML/);
    expect(() => parseDshPatchYaml("insert:\n  - id: x\n")).toThrow(
      /root must be a list/,
    );
  });
});

describe("DSH patch merge (object level)", () => {
  it("appends our entry exactly once and is idempotent", () => {
    const once = mergeDshPatch([]);
    const twice = mergeDshPatch(once);
    expect(twice).toEqual(once);

    const summary = summarizeDshAutopilotEntry(
      parseDshPatchYaml(mergeDshPatchYaml("")),
    );
    expect(summary.entries).toBe(1);
  });

  it("keeps foreign operations and inserts", () => {
    const userDoc = parseDshPatchYaml(USER_PATCH);
    const merged = mergeDshPatch(userDoc);
    const flat = JSON.stringify(merged);
    expect(flat).toContain("my-plugin");
    expect(flat).toContain(DSH_PATCH_ENTRY_ID);
    expect(hasCompleteDshAutopilotEntry(merged)).toBe(true);
  });

  it("strips only our entry", () => {
    const merged = mergeDshPatch(parseDshPatchYaml(USER_PATCH));
    const stripped = stripAutopilotDshPatch(merged);
    expect(JSON.stringify(stripped)).toContain("my-plugin");
    expect(JSON.stringify(stripped)).not.toContain(DSH_PATCH_ENTRY_ID);
    expect(summarizeDshAutopilotEntry(stripped).entries).toBe(0);
  });

  it("builds the canonical entry", () => {
    const entry = autopilotDshPatchEntry();
    expect(entry.id).toBe(DSH_PATCH_ENTRY_ID);
    expect(entry.name).toBe(DSH_PATCH_ENTRY_NAME);
    expect(entry.config).toEqual({ autoInit: false, maxSteerPerTurn: 32 });
    // 每次返回新对象，调用方改了也不影响下一次
    (entry.config as Record<string, unknown>).autoInit = true;
    expect(
      (autopilotDshPatchEntry().config as Record<string, unknown>).autoInit,
    ).toBe(false);
  });
});

describe("DSH patch merge (YAML text level)", () => {
  it("preserves user comments and other entries", () => {
    const out = mergeDshPatchYaml(USER_PATCH);
    expect(out).toContain("# 我自己的补丁层");
    expect(out).toContain("# 用户的插件");
    expect(out).toContain("# 用户自己的配置");
    expect(out).toContain("my-plugin/entry");
    expect(out).toContain(DSH_PATCH_ENTRY_NAME);
    // 结果仍是合法 YAML，且形状可校验
    expect(validateDshPatchShape(parseDshPatchYaml(out))).toBeNull();
  });

  it("is byte-identical when run twice", () => {
    const first = mergeDshPatchYaml(USER_PATCH);
    const second = mergeDshPatchYaml(first);
    expect(second).toBe(first);
    // 从零开始也一样幂等
    const fromEmpty = mergeDshPatchYaml("");
    expect(mergeDshPatchYaml(fromEmpty)).toBe(fromEmpty);
  });

  it("migrates a legacy entry name in place without duplicating", () => {
    const legacy = `- insert:\n    - id: ${DSH_PATCH_ENTRY_ID}\n      name: 'dsh-autopilot-harness/plugin'\n      config:\n        autoInit: false\n        maxSteerPerTurn: 32\n`;
    const out = mergeDshPatchYaml(legacy);
    const doc = parseDshPatchYaml(out);
    const summary = summarizeDshAutopilotEntry(doc);
    expect(summary.entries).toBe(1);
    expect(summary.legacyName).toBe(false);
    expect(summary.problems).toEqual([]);
    expect(out).not.toContain("dsh-autopilot-harness/plugin");
    expect(out).toContain(DSH_PATCH_ENTRY_NAME);
  });

  it("only appends its own block and leaves every other byte alone", () => {
    // 真实场景：机器级补丁层里有长标量（超 80 列）和顶层注释。
    // 整树序列化会把它们折行/缩进，产生整文件 diff —— 这里断言零漂移。
    const out = mergeDshPatchYaml(USER_PATCH_LONG);
    expect(out.startsWith(USER_PATCH_LONG)).toBe(true);
    expect(out.slice(USER_PATCH_LONG.length)).toBe(
      `- insert:\n    - id: ${DSH_PATCH_ENTRY_ID}\n      name: "${DSH_PATCH_ENTRY_NAME}"\n      config:\n        autoInit: false\n        maxSteerPerTurn: 32\n`,
    );
    expect(out).toContain(LONG_SCALAR_LINE);
    expect(out).toContain("\n# ===== 关闭列表 =====\n");
    expect(mergeDshPatchYaml(out)).toBe(out);
  });

  it("keeps the user's extra fields on our own entry while migrating", () => {
    const legacy = `- insert:\n    - id: ${DSH_PATCH_ENTRY_ID}\n      name: 'dsh-autopilot-harness/plugin'\n      disabled: true\n      config:\n        autoInit: true\n        maxSteerPerTurn: 8\n`;
    const out = mergeDshPatchYaml(legacy);
    expect(out).toContain("disabled: true");
    expect(out).not.toContain("dsh-autopilot-harness/plugin");
    const summary = summarizeDshAutopilotEntry(parseDshPatchYaml(out));
    expect(summary.entries).toBe(1);
    expect(summary.problems).toEqual([]);
  });

  it("keeps CRLF line endings on insert and strip", () => {
    const crlf = "- insert:\r\n    - id: user\r\n      name: user/plugin\r\n";
    const out = mergeDshPatchYaml(crlf);
    expect(out).toContain("\r\n- insert:\r\n");
    expect(/(?<!\r)\n/.test(out)).toBe(false);
    expect(mergeDshPatchYaml(out)).toBe(out);

    const stripped = stripAutopilotDshPatchYaml(out);
    expect(stripped).toBe(crlf);
  });

  it("refuses to merge into a non-list root", () => {
    expect(() => mergeDshPatchYaml("insert:\n  - id: x\n")).toThrow(
      /root must be a list/,
    );
    expect(() => mergeDshPatchYaml("insert: [")).toThrow(/not valid YAML/);
  });

  it("strips our entry and keeps the rest; empty result for autopilot-only", () => {
    const merged = mergeDshPatchYaml(USER_PATCH);
    const stripped = stripAutopilotDshPatchYaml(merged);
    expect(stripped).toContain("my-plugin/entry");
    expect(stripped).not.toContain(DSH_PATCH_ENTRY_NAME);
    expect(dshPatchContainsAutopilot(stripped)).toBe(false);

    const oursOnly = mergeDshPatchYaml("");
    expect(stripAutopilotDshPatchYaml(oursOnly)).toBe("");
    expect(stripAutopilotDshPatchYaml("")).toBe("");
  });
});

describe("DSH patch summaries", () => {
  it("detects missing / duplicated / mismatched entries", () => {
    expect(summarizeDshAutopilotEntry([]).entries).toBe(0);
    expect(hasCompleteDshAutopilotEntry([])).toBe(false);

    const good = mergeDshPatch([]);
    expect(hasCompleteDshAutopilotEntry(good)).toBe(true);

    const duplicated = parseDshPatchYaml(
      mergeDshPatchYaml(mergeDshPatchYaml("")),
    );
    const dupSummary = summarizeDshAutopilotEntry(duplicated);
    expect(dupSummary.entries).toBe(1); // 合并已去重

    const wrongName = [
      { insert: [{ id: DSH_PATCH_ENTRY_ID, name: "other/plugin" }] },
    ];
    const wrongSummary = summarizeDshAutopilotEntry(wrongName);
    expect(wrongSummary.entries).toBe(1);
    expect(wrongSummary.problems.join(" ")).toMatch(/name must be/);
    expect(hasCompleteDshAutopilotEntry(wrongName)).toBe(false);

    const missingConfig = [{ insert: [{ id: DSH_PATCH_ENTRY_ID, name: DSH_PATCH_ENTRY_NAME }] }];
    expect(
      summarizeDshAutopilotEntry(missingConfig).problems.join(" "),
    ).toMatch(/config must be a mapping/);
  });

  it("fingerprints our entry in raw text even when YAML is broken", () => {
    expect(dshPatchContainsAutopilot("")).toBe(false);
    expect(dshPatchContainsAutopilot(mergeDshPatchYaml(""))).toBe(true);
    expect(
      dshPatchContainsAutopilot(`insert: [\n  name: ${DSH_PATCH_ENTRY_NAME}\n`),
    ).toBe(true);
  });
});

describe("reading the patch file", () => {
  it("treats a missing file as empty and reads existing content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-dsh-patch-"));
    try {
      const p = path.join(dir, "cordis.patch.yml");
      const missing = readDshPatch(p);
      expect(missing.ok).toBe(true);
      expect(missing.value).toBe("");

      fs.writeFileSync(p, USER_PATCH);
      const hit = readDshPatch(p);
      expect(hit.ok).toBe(true);
      expect(hit.value).toContain("my-plugin");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("init --platform dsh merges the patch layer", () => {
  let root = "";
  let dshHome = "";
  let prevHome: string | undefined;

  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (dshHome) fs.rmSync(dshHome, { recursive: true, force: true });
    root = "";
    dshHome = "";
    prevHome = undefined;
  });

  function withDshHome(): { project: string; patchPath: string } {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-dsh-init-proj-"));
    dshHome = fs.mkdtempSync(path.join(os.tmpdir(), "ap-dsh-init-home-"));
    prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;
    return { project: root, patchPath: dshPatchYamlPath(dshHome) };
  }

  it("writes the entry, records the path and stays byte-identical on rerun", () => {
    const { project, patchPath } = withDshHome();
    const first = installInitYes({
      projectRoot: project,
      platform: "dsh",
      surface: "cli",
      locale: "en",
      force: false,
    });
    expect(first.ok).toBe(true);
    expect(first.written ?? []).toContain(patchPath);

    const bytes = fs.readFileSync(patchPath, "utf8");
    expect(dshPatchContainsAutopilot(bytes)).toBe(true);
    expect(
      hasCompleteDshAutopilotEntry(parseDshPatchYaml(bytes)),
    ).toBe(true);

    const second = installInitYes({
      projectRoot: project,
      platform: "dsh",
      surface: "cli",
      locale: "en",
      force: true,
    });
    expect(second.ok).toBe(true);
    expect(fs.readFileSync(patchPath, "utf8")).toBe(bytes);
  });

  it("preserves user entries and comments already in the patch layer", () => {
    const { project, patchPath } = withDshHome();
    fs.writeFileSync(patchPath, USER_PATCH, "utf8");
    const out = installInitYes({
      projectRoot: project,
      platform: "dsh",
      surface: "cli",
      locale: "en",
      force: false,
    });
    expect(out.ok).toBe(true);
    const bytes = fs.readFileSync(patchPath, "utf8");
    expect(bytes).toContain("# 我自己的补丁层");
    expect(bytes).toContain("my-plugin/entry");
    expect(bytes).toContain(DSH_PATCH_ENTRY_NAME);
  });

  it("fails closed on an invalid patch shape", () => {
    const { project, patchPath } = withDshHome();
    fs.writeFileSync(patchPath, "insert:\n  - id: x\n", "utf8");
    const out = installInitYes({
      projectRoot: project,
      platform: "dsh",
      surface: "cli",
      locale: "en",
      force: false,
    });
    expect(out.ok).toBe(false);
    expect(out.error ?? "").toMatch(/root must be a list/);
    // 失败不得改写用户文件
    expect(fs.readFileSync(patchPath, "utf8")).toBe("insert:\n  - id: x\n");
  });

  it("re-merges on a repeat run (legacy entry name migrates)", () => {
    const { project, patchPath } = withDshHome();
    // 模拟旧版本 init 写下的条目：证明非首次（force）路径真的重跑了合并，
    // 而不是「文件已存在就跳过」。
    fs.writeFileSync(
      patchPath,
      `- insert:\n    - id: ${DSH_PATCH_ENTRY_ID}\n      name: 'dsh-autopilot-harness/plugin'\n      config:\n        autoInit: false\n        maxSteerPerTurn: 32\n`,
      "utf8",
    );
    const out = installInitYes({
      projectRoot: project,
      platform: "dsh",
      surface: "cli",
      locale: "en",
      force: true,
    });
    expect(out.ok).toBe(true);
    const bytes = fs.readFileSync(patchPath, "utf8");
    expect(bytes).not.toContain("dsh-autopilot-harness/plugin");
    const summary = summarizeDshAutopilotEntry(parseDshPatchYaml(bytes));
    expect(summary.entries).toBe(1);
    expect(summary.problems).toEqual([]);
  });

  it("fails closed when the DSH home path is a file", () => {
    const { project } = withDshHome();
    fs.rmSync(dshHome, { recursive: true, force: true });
    fs.writeFileSync(dshHome, "not a dir\n", "utf8");
    const out = installInitYes({
      projectRoot: project,
      platform: "dsh",
      surface: "cli",
      locale: "en",
      force: false,
    });
    expect(out.ok).toBe(false);
    expect(out.error ?? "").toMatch(/not a directory/);
  });

  it("fails closed when the patch file is a symlink", () => {
    const { project, patchPath } = withDshHome();
    const target = path.join(dshHome, "elsewhere.yml");
    fs.writeFileSync(target, "- insert: []\n", "utf8");
    fs.symlinkSync(target, patchPath);
    const out = installInitYes({
      projectRoot: project,
      platform: "dsh",
      surface: "cli",
      locale: "en",
      force: false,
    });
    expect(out.ok).toBe(false);
    expect(out.error ?? "").toMatch(/symlink/);
    // 符号链接指向的文件不得被改写
    expect(fs.readFileSync(target, "utf8")).toBe("- insert: []\n");
  });
});
