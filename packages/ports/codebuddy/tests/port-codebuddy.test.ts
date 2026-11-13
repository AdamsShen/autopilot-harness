import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewEngine, StateStore } from "@autopilot-harness/core";
import {
  CODEBUDDY_AUTOPILOT_EVENTS,
  CODEBUDDY_HOOK_TIMEOUT_SEC,
  CODEBUDDY_PLATFORM,
  CODEBUDDY_POST_TOOL_USE_MATCHER,
  CODEBUDDY_STOP_CAP_RAISE_FOUND,
  codebuddyHookCommandLine,
  filePathFromCodebuddyEdit,
  handleCodebuddyPostToolUse,
  handleCodebuddyStop,
  handleCodebuddyUserPromptSubmit,
  isCodebuddyEditTool,
  isCodebuddyHookFingerprint,
  isCodebuddySilentAllow,
  loopCountFromCodebuddyStopHookActive,
  resolveCodebuddyTranscriptPath,
} from "../src/index.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ap-codebuddy-port-"));
}

describe("port-codebuddy", () => {
  it("uses an independent --platform codebuddy fingerprint (never claude-code)", () => {
    const line = codebuddyHookCommandLine("Stop");
    expect(line).toBe(
      "node .autopilot/bin/autopilot-harness-hook.mjs --platform codebuddy --event Stop",
    );
    expect(isCodebuddyHookFingerprint(line)).toBe(true);
    expect(
      isCodebuddyHookFingerprint(
        "node .autopilot/bin/autopilot-harness-hook.mjs --platform claude-code --event Stop",
      ),
    ).toBe(false);
    expect(isCodebuddyHookFingerprint("--platform codebuddy")).toBe(false);
    expect(() => codebuddyHookCommandLine("StopFailure")).toThrow(
      /invalid event/,
    );
    expect(CODEBUDDY_PLATFORM).toBe("codebuddy");
    expect(CODEBUDDY_HOOK_TIMEOUT_SEC).toBe(120);
    expect(CODEBUDDY_AUTOPILOT_EVENTS).toEqual([
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
    ]);
    expect(CODEBUDDY_POST_TOOL_USE_MATCHER).toBe(
      "^(Edit|Write|MultiEdit|NotebookEdit)$",
    );
    expect(CODEBUDDY_STOP_CAP_RAISE_FOUND).toBe(false);
  });

  it("edit tools are anchored PascalCase; payload paths are parsed", () => {
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(isCodebuddyEditTool(tool)).toBe(true);
    }
    expect(isCodebuddyEditTool("edit")).toBe(false);
    expect(isCodebuddyEditTool("EditFile")).toBe(false);
    expect(isCodebuddyEditTool("Bash")).toBe(false);
    expect(
      filePathFromCodebuddyEdit({
        tool_name: "Edit",
        tool_input: { file_path: "src/a.ts" },
      }),
    ).toBe("src/a.ts");
    // Stringified tool_input is also accepted.
    expect(
      filePathFromCodebuddyEdit({
        toolName: "Write",
        toolInput: JSON.stringify({ path: "src/b.ts" }),
      }),
    ).toBe("src/b.ts");
    expect(
      filePathFromCodebuddyEdit({
        tool_name: "Bash",
        tool_input: { file_path: "src/a.ts" },
      }),
    ).toBe("");
  });

  it("maps stop_hook_active strictly to loopCount", () => {
    expect(loopCountFromCodebuddyStopHookActive({ stop_hook_active: true })).toBe(
      1,
    );
    expect(loopCountFromCodebuddyStopHookActive({ stopHookActive: true })).toBe(
      1,
    );
    expect(loopCountFromCodebuddyStopHookActive({})).toBe(0);
    expect(
      loopCountFromCodebuddyStopHookActive({ stop_hook_active: "true" }),
    ).toBe(0);
  });

  it("UPS block is continue:false+reason — never decision:block", () => {
    const root = tmpRoot();
    const store = new StateStore(root);
    try {
      const res = handleCodebuddyUserPromptSubmit(
        store,
        { session_id: "cb-ups-1", prompt: "/autopilot-run no-such-track" },
        root,
      );
      expect(res.continue).toBe(false);
      expect(typeof res.reason).toBe("string");
      expect(res.reason?.length).toBeGreaterThan(0);
      expect(res).not.toHaveProperty("decision");
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("Stop with no session returns allow {} and never decision:block", () => {
    const root = tmpRoot();
    const store = new StateStore(root);
    const engine = new ReviewEngine(store, { projectRoot: root });
    try {
      const res = handleCodebuddyStop(engine, {
        session_id: "cb-stop-unknown",
        stop_hook_active: false,
      });
      expect(res).toEqual({});
      expect(isCodebuddySilentAllow(res)).toBe(true);
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("transcript_path is only trusted when it is a regular JSONL file", () => {
    const root = tmpRoot();
    try {
      // IDE 传的是会话目录：不能当 transcript，否则 pending 永远判定未投递而反复重投。
      const dir = path.join(root, "history", "cb-session");
      fs.mkdirSync(dir, { recursive: true });
      expect(resolveCodebuddyTranscriptPath(dir)).toBeUndefined();

      const file = path.join(dir, "transcript.jsonl");
      fs.writeFileSync(file, "{}\n");
      expect(resolveCodebuddyTranscriptPath(file)).toBe(file);

      // 普通文件但非 JSONL（IDE 的 index.json 聚合文件）同样不能当事件流。
      const aggregate = path.join(dir, "index.json");
      fs.writeFileSync(aggregate, '{\n  "messages": []\n}\n');
      expect(resolveCodebuddyTranscriptPath(aggregate)).toBeUndefined();

      // 符号链接即便指向普通文件也不信任（与 readTranscriptTail 的 fail-closed 对齐）。
      const link = path.join(root, "transcript-link.jsonl");
      try {
        fs.symlinkSync(file, link);
        expect(resolveCodebuddyTranscriptPath(link)).toBeUndefined();
      } catch {
        /* 平台不支持创建符号链接时跳过该断言 */
      }

      expect(
        resolveCodebuddyTranscriptPath(path.join(root, "missing.jsonl")),
      ).toBeUndefined();
      expect(resolveCodebuddyTranscriptPath("a\0b")).toBeUndefined();
      expect(resolveCodebuddyTranscriptPath("")).toBeUndefined();
      expect(resolveCodebuddyTranscriptPath(undefined)).toBeUndefined();
      expect(resolveCodebuddyTranscriptPath(42)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("PostToolUse never blocks and tolerates junk payloads", () => {
    const root = tmpRoot();
    const store = new StateStore(root);
    try {
      expect(() =>
        handleCodebuddyPostToolUse(
          store,
          { session_id: "cb-post-1", tool_name: "Edit" },
          root,
        ),
      ).not.toThrow();
      expect(() =>
        handleCodebuddyPostToolUse(
          store,
          {
            session_id: "cb-post-1",
            tool_name: "Write",
            tool_input: "{not-json",
          },
          root,
        ),
      ).not.toThrow();
    } finally {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
