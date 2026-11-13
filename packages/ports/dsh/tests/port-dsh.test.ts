import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewEngine, StateStore } from "@autopilot-harness/core";
import {
  buildNeedPickMessage,
  conversationIdFromDshPayload,
  DSH_EDIT_TOOLS,
  DSH_PLATFORM,
  DSH_PLUGIN_SOURCE,
  DSH_PLUGIN_SOURCE_KIND,
  DSH_STOP_CAP_RAISE_FOUND,
  filePathsFromDshToolInput,
  handleDshSubmit,
  handleDshToolResult,
  handleDshTurnStopping,
  isDshEditTool,
  isDshHarnessMessage,
  MAX_DSH_PATH_CHARS,
  MAX_DSH_PATHS,
  MAX_NEED_PICK_CONTEXT_CHARS,
  MAX_NEED_PICK_SLUGS,
  resolveDshWorkspaceRoot,
} from "../src/index.js";

function tmpRoot(prefix = "ap-dsh-port-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeChecklist(root: string, slug: string, body: string): string {
  const dir = path.join(root, "plans", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.md"), `# ${slug}\n`);
  const cp = path.join(dir, "checklist.md");
  fs.writeFileSync(cp, body);
  return cp;
}

describe("port-dsh constants", () => {
  it("stamps the platform and the producer-owned source kind", () => {
    expect(DSH_PLATFORM).toBe("dsh");
    expect(DSH_PLUGIN_SOURCE).toBe("autopilot");
    // v4 拒绝 kind:"plugin"，必须是生产者自有的 `plugin:<name>`。
    expect(DSH_PLUGIN_SOURCE_KIND).toBe("plugin:autopilot");
    expect(DSH_PLUGIN_SOURCE_KIND).not.toBe("plugin");
    expect(DSH_STOP_CAP_RAISE_FOUND).toBe(false);
  });

  it("declares the edit tool allowlist and hook caps", () => {
    expect(Object.isFrozen(DSH_EDIT_TOOLS)).toBe(true);
    expect([...DSH_EDIT_TOOLS]).toEqual([
      "write",
      "edit",
      "apply_patch",
      "notebook_edit",
    ]);
    expect(isDshEditTool("write")).toBe(true);
    expect(isDshEditTool("edit")).toBe(true);
    expect(isDshEditTool("apply_patch")).toBe(true);
    expect(isDshEditTool("notebook_edit")).toBe(true);
    expect(isDshEditTool("read")).toBe(false);
    expect(isDshEditTool(null)).toBe(false);
    expect(MAX_DSH_PATH_CHARS).toBe(4_096);
    expect(MAX_DSH_PATHS).toBe(256);
    expect(MAX_NEED_PICK_SLUGS).toBe(40);
    expect(MAX_NEED_PICK_CONTEXT_CHARS).toBe(2_000);
  });
});

describe("port-dsh conversation id + self-injection recognition", () => {
  it("normalizes agent.id and rejects unusable ids", () => {
    expect(conversationIdFromDshPayload({ conversationId: " s1 " })).toBe("s1");
    expect(conversationIdFromDshPayload({ conversationId: "" })).toBe("");
    expect(conversationIdFromDshPayload({ conversationId: null })).toBe("");
    expect(conversationIdFromDshPayload({})).toBe("");
    expect(
      conversationIdFromDshPayload({ conversationId: "x".repeat(257) }),
    ).toBe("");
    // NUL 会让落盘/日志层行为未定义，一律拒绝。
    expect(conversationIdFromDshPayload({ conversationId: "s\u00001" })).toBe("");
  });

  it("recognizes its own injected messages by structured source, then by text", () => {
    expect(isDshHarnessMessage({ sourceKind: DSH_PLUGIN_SOURCE_KIND })).toBe(true);
    // v4 之前落盘的历史形态
    expect(
      isDshHarnessMessage({ sourceKind: "plugin", sourcePlugin: "autopilot" }),
    ).toBe(true);
    expect(
      isDshHarnessMessage({ sourceKind: "plugin", sourcePlugin: "someone-else" }),
    ).toBe(false);
    expect(isDshHarnessMessage({ sourceKind: "user", prompt: "你好" })).toBe(false);
    // 文本回退：宿主可能抹掉 source，但续跑文案有固定前缀。
    expect(
      isDshHarnessMessage({ sourceKind: "user", prompt: "Review fix round 1" }),
    ).toBe(true);
    expect(
      isDshHarnessMessage({ sourceKind: "user", prompt: "自审确认" }),
    ).toBe(true);
  });
});

describe("port-dsh workspace root resolution", () => {
  it("prefers the session cwd over the configured root", () => {
    expect(
      resolveDshWorkspaceRoot({
        sessionCwd: "/tmp/proj-a",
        configuredRoot: "/tmp/proj-b",
        fallbackCwd: "/tmp/proj-c",
      }),
    ).toBe("/tmp/proj-a");
  });

  it("falls back to configuredRoot then fallbackCwd", () => {
    expect(
      resolveDshWorkspaceRoot({ configuredRoot: "/tmp/proj-b", fallbackCwd: "/tmp/c" }),
    ).toBe("/tmp/proj-b");
    expect(resolveDshWorkspaceRoot({ fallbackCwd: "/tmp/c" })).toBe("/tmp/c");
  });

  it("never accepts relative or tilde paths (they resolve against the host cwd)", () => {
    expect(resolveDshWorkspaceRoot({ sessionCwd: "proj-a" })).toBeNull();
    expect(resolveDshWorkspaceRoot({ sessionCwd: "./proj-a" })).toBeNull();
    expect(resolveDshWorkspaceRoot({ sessionCwd: "~/proj-a" })).toBeNull();
    expect(
      resolveDshWorkspaceRoot({ sessionCwd: "rel", configuredRoot: "~/p" }),
    ).toBeNull();
    expect(resolveDshWorkspaceRoot({})).toBeNull();
  });
});

describe("port-dsh tool input path extraction", () => {
  it("extracts every supported key, dedupes, resolves relatives against cwd", () => {
    const out = filePathsFromDshToolInput(
      {
        file_path: "/abs/a.ts",
        filePath: "/abs/a.ts",
        path: "b/c.ts",
        notebook_path: 42,
      },
      "/proj",
    );
    expect(out).toEqual(["/abs/a.ts", path.resolve("/proj", "b/c.ts")]);
  });

  it("skips unsafe / empty fragments and tolerates junk input", () => {
    expect(filePathsFromDshToolInput(null)).toEqual([]);
    expect(filePathsFromDshToolInput({ file_path: "" })).toEqual([]);
    expect(filePathsFromDshToolInput({ file_path: "a\u0000b" })).toEqual([]);
    expect(
      filePathsFromDshToolInput({ file_path: "x".repeat(MAX_DSH_PATH_CHARS + 1) }),
    ).toEqual([]);
    // 相对路径无 cwd 时保留原样，交由 core 的 projectRoot 归一化。
    expect(filePathsFromDshToolInput({ path: "rel.ts" })).toEqual(["rel.ts"]);
  });
});

describe("port-dsh need-pick message", () => {
  it("lists candidate slugs and caps the payload", () => {
    const msg = buildNeedPickMessage("Pick one:", [{ slug: "a" }, { slug: "b" }]);
    expect(msg).toContain("Pick one:");
    expect(msg).toContain("- a");
    expect(msg).toContain("- b");

    const many = Array.from({ length: MAX_NEED_PICK_SLUGS + 10 }, (_, i) => ({
      slug: `s${i}`,
    }));
    const capped = buildNeedPickMessage("", many);
    expect(capped.split("\n").filter((l) => l.startsWith("- ")).length).toBe(
      MAX_NEED_PICK_SLUGS,
    );
    expect(capped.length).toBeLessThanOrEqual(MAX_NEED_PICK_CONTEXT_CHARS + 20);
  });

  it("falls back to the built-in english hint", () => {
    expect(buildNeedPickMessage(undefined)).toContain("Multiple tracks found");
  });
});

describe("port-dsh submit + tool arm + stop", () => {
  let root: string;
  let store: StateStore;

  beforeEach(() => {
    root = tmpRoot();
    fs.mkdirSync(path.join(root, ".autopilot"), { recursive: true });
    store = StateStore.openMemory(root);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("submit: ignores its own followup messages (no self-trigger)", () => {
    // 先进入 planning，再送入「自注入续跑文案」——状态机不得被再驱动一次。
    handleDshSubmit(
      store,
      { conversationId: "dsh-self", prompt: "/autopilot-on", sourceKind: "user" },
      root,
    );
    const before = store.getSession("dsh-self");
    const out = handleDshSubmit(
      store,
      {
        conversationId: "dsh-self",
        prompt: "Review fix round 1",
        sourceKind: DSH_PLUGIN_SOURCE_KIND,
      },
      root,
    );
    expect(out).toEqual({});
    const after = store.getSession("dsh-self");
    expect(after?.platform).toBe(DSH_PLATFORM);
    expect(after?.phase).toBe(before?.phase);
  });

  it("submit: /autopilot-run with several tracks injects a need-pick gate", () => {
    writeChecklist(root, "alpha", "- [ ] a — A\n");
    writeChecklist(root, "beta", "- [ ] b — B\n");
    const out = handleDshSubmit(
      store,
      { conversationId: "dsh-pick", prompt: "/autopilot-run", sourceKind: "user" },
      root,
    );
    expect(typeof out.injectMessage).toBe("string");
    expect(out.injectMessage).toContain("alpha");
    expect(out.injectMessage).toContain("beta");
  });

  it("submit: /autopilot-on stamps the dsh platform on the session", () => {
    handleDshSubmit(
      store,
      { conversationId: "dsh-on", prompt: "/autopilot-on", sourceKind: "user" },
      root,
    );
    expect(store.getSession("dsh-on")?.platform).toBe(DSH_PLATFORM);
  });

  it("submit: missing conversation id is a no-op", () => {
    expect(
      handleDshSubmit(store, { prompt: "/autopilot-on" }, root),
    ).toEqual({});
  });

  it("tool: an edit tool arms code_edited, a read tool does not", () => {
    store.upsertSession({
      conversation_id: "dsh-arm",
      project_root: root,
      code_root: root,
      platform: DSH_PLATFORM,
      phase: "executing",
      track_id: "demo",
      checklist_path: writeChecklist(root, "demo", "- [ ] a — A\n"),
      armed: 1,
    });

    handleDshToolResult(
      store,
      { conversationId: "dsh-arm", toolName: "read", toolInput: { file_path: "src.ts" }, cwd: root },
      root,
    );
    expect(store.getReviewChain("dsh-arm")?.code_edited ?? 0).toBe(0);

    handleDshToolResult(
      store,
      {
        conversationId: "dsh-arm",
        toolName: "edit",
        toolInput: { file_path: path.join(root, "src.ts") },
        cwd: root,
      },
      root,
    );
    expect(store.getReviewChain("dsh-arm")?.code_edited).toBe(1);
  });

  it("tool: unknown conversation id and junk payload never throw", () => {
    expect(() =>
      handleDshToolResult(store, { toolName: "edit" }, root),
    ).not.toThrow();
    expect(() =>
      handleDshToolResult(store, { conversationId: "x", toolName: null }, root),
    ).not.toThrow();
  });

  it("stop: returns { steerMessage } instead of a block decision", () => {
    writeChecklist(root, "demo", "# Checklist\n\n- [ ] a — A\n");
    store.upsertSession({
      conversation_id: "dsh-stop",
      project_root: root,
      code_root: root,
      platform: DSH_PLATFORM,
      phase: "executing",
      track_id: "demo",
      checklist_path: path.join(root, "plans", "demo", "checklist.md"),
      armed: 1,
    });
    store.markCodeEdited("dsh-stop", () => "a");

    const engine = new ReviewEngine(store, {
      confirmRounds: 5,
      reviewScope: "executing_only",
      verifyEnabled: false,
      verifyCommands: [],
      maxIdleStops: 5,
      maxErrorsBeforePause: 0,
      projectRoot: root,
      recoverDebounceMs: 0,
    });

    const out = handleDshTurnStopping(
      engine,
      store,
      { conversationId: "dsh-stop", status: "completed", loopCount: 0 },
      root,
    );
    expect(typeof out.steerMessage).toBe("string");
    expect(out.steerMessage?.length ?? 0).toBeGreaterThan(0);
    // 契约：DSH 端口不产出 block/reason 形状的决策。
    expect(Object.keys(out)).toEqual(["steerMessage"]);
  });

  it("stop: idle or unknown sessions return {}", () => {
    const engine = new ReviewEngine(store, {
      confirmRounds: 5,
      reviewScope: "executing_only",
      verifyEnabled: false,
      verifyCommands: [],
      maxIdleStops: 5,
      maxErrorsBeforePause: 0,
      projectRoot: root,
      recoverDebounceMs: 0,
    });
    expect(
      handleDshTurnStopping(
        engine,
        store,
        { conversationId: "dsh-idle", status: "completed", loopCount: 0 },
        root,
      ),
    ).toEqual({});
    expect(handleDshTurnStopping(engine, store, { status: "completed" }, root)).toEqual(
      {},
    );
  });

  it("stop: engine failure is swallowed (fail-open)", () => {
    const boom = {
      handleStop() {
        throw new Error("engine exploded");
      },
    } as unknown as ReviewEngine;
    expect(
      handleDshTurnStopping(
        boom,
        store,
        { conversationId: "dsh-boom", status: "completed", loopCount: 0 },
        root,
      ),
    ).toEqual({});
  });
});
