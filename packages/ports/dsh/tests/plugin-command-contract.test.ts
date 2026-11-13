import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apply, name as pluginName } from "../src/plugin.js";

/**
 * fake cordis ctx：只实现本插件用到的两件事（on / inject），
 * 并把注册结果收集出来，用于校验「5 事件 + 6 命令」的装配契约。
 * 不 mock core —— 状态机行为走真实实现，避免用假替身掩盖回归。
 */
type Listener = (...args: unknown[]) => unknown;
interface FakeCommand {
  name: string;
  description: string;
  handler: (invocation: unknown) => Promise<{ kind: string; text?: string }>;
}

function makeCtx(): {
  ctx: unknown;
  listeners: Map<string, Listener[]>;
  commands: FakeCommand[];
} {
  const listeners = new Map<string, Listener[]>();
  const commands: FakeCommand[] = [];
  const ctx = {
    on(event: string, fn: Listener) {
      const arr = listeners.get(event) ?? [];
      arr.push(fn);
      listeners.set(event, arr);
      return { dispose() {} };
    },
    inject(_deps: readonly string[], cb: (scoped: unknown) => void) {
      cb({
        get: (name: string) =>
          name === "commands"
            ? { register: (cmd: FakeCommand) => commands.push(cmd) }
            : undefined,
      });
      return undefined;
    },
    // 宿主 logger；插件内部仍会 try/catch，这里只是让路径可走
    logger: { info() {}, debug() {}, warn() {} },
  };
  return { ctx, listeners, commands };
}

function tmpProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ap-dsh-plugin-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}\n");
  return root;
}

function fakeAgent(id: string, cwd?: string) {
  const followups: Array<Record<string, unknown>> = [];
  const steers: Array<Record<string, unknown>> = [];
  return {
    agent: {
      id,
      session: { id, header: cwd ? { cwd } : {} },
      followup: (m: Record<string, unknown>) => followups.push(m),
      steer: (m: Record<string, unknown>) => steers.push(m),
    },
    followups,
    steers,
  };
}

describe("port-dsh plugin wiring", () => {
  it("subscribes the 5 events and registers the 6 command facade entries", () => {
    const { ctx, listeners, commands } = makeCtx();
    apply(ctx as never, {});

    expect(pluginName).toBe("autopilot");
    expect([...listeners.keys()].sort()).toEqual([
      "agent/disposed",
      "agent/error",
      "agent/pre-step",
      "agent/turn-stopping",
      "tools/post-execute",
    ]);
    // 每个事件只挂一个 listener（重复挂会让状态机被驱动两次）
    for (const [, fns] of listeners) expect(fns).toHaveLength(1);

    expect(commands.map((c) => c.name).sort()).toEqual([
      "autopilot-enable",
      "autopilot-off",
      "autopilot-on",
      "autopilot-replan",
      "autopilot-resume",
      "autopilot-run",
    ]);
    for (const c of commands) {
      expect(typeof c.description).toBe("string");
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it("state-machine commands replay their own /text as a user message", async () => {
    const { ctx, commands } = makeCtx();
    apply(ctx as never, {});
    const root = tmpProject();
    try {
      for (const name of [
        "autopilot-on",
        "autopilot-run",
        "autopilot-off",
        "autopilot-replan",
        "autopilot-resume",
      ]) {
        const cmd = commands.find((c) => c.name === name);
        expect(cmd).toBeDefined();
        const { agent, followups } = fakeAgent(`sess-${name}`, root);
        const res = await cmd!.handler({ agent, rawInput: "" });
        // DSH 契约：handler 必须返回 CommandResult 对象，不能返回裸字符串
        expect(res).toEqual({ kind: "success" });
        expect(followups).toHaveLength(1);
        const msg = followups[0] as {
          id?: string;
          role?: string;
          content?: Array<{ text?: string }>;
          source?: { kind?: string };
        };
        expect(typeof msg.id).toBe("string");
        expect((msg.id ?? "").length).toBeGreaterThan(0);
        expect(msg.role).toBe("user");
        // 必须标记 user 来源：plugin 来源会被 pre-step 当成自注入而跳过
        expect(msg.source?.kind).toBe("user");
        expect(msg.content?.[0]?.text).toBe(`/${name}`);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the raw input when replaying a command", async () => {
    const { ctx, commands } = makeCtx();
    apply(ctx as never, {});
    const root = tmpProject();
    try {
      const run = commands.find((c) => c.name === "autopilot-run");
      const { agent, followups } = fakeAgent("sess-raw", root);
      await run!.handler({ agent, rawInput: "  dsh-in-repo  " });
      const msg = followups[0] as { content?: Array<{ text?: string }> };
      expect(msg.content?.[0]?.text).toBe("/autopilot-run dsh-in-repo");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("enable fails closed when the session has no cwd", async () => {
    const { ctx, commands } = makeCtx();
    apply(ctx as never, {});
    const enable = commands.find((c) => c.name === "autopilot-enable")!;
    const { agent } = fakeAgent("sess-no-cwd");
    const res = await enable.handler({ agent });
    expect(res.kind).toBe("error");
    expect(res.text ?? "").toContain("项目目录");
  });

  it("commands fail open when the agent is unusable", async () => {
    const { ctx, commands } = makeCtx();
    apply(ctx as never, {});
    const run = commands.find((c) => c.name === "autopilot-run")!;
    // 无 id → 拿不到会话，返回 error 而不是抛出
    const res = await run.handler({ agent: {} });
    expect(res.kind).toBe("error");
  });
});

describe("port-dsh plugin hook fail-open", () => {
  it("does not create .autopilot/ for a project that was never enabled", async () => {
    const { ctx, listeners } = makeCtx();
    // autoInit 关闭（默认）：未启用项目必须零写盘
    apply(ctx as never, { autoInit: false });
    const root = tmpProject();
    try {
      const { agent } = fakeAgent("sess-idle", root);
      const msg = {
        id: "m1",
        role: "user",
        content: [{ type: "text", text: "hello" }],
        source: { kind: "user" },
      };
      const decision = await listeners.get("agent/pre-step")![0](
        { agent, messages: [msg], turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: "enter", messages: [msg] }),
      );
      expect(decision).toEqual({ kind: "enter", messages: [msg] });
      expect(fs.existsSync(path.join(root, ".autopilot"))).toBe(false);

      // stop 也不该 steer，更不该建库
      const { agent: a2, steers } = fakeAgent("sess-idle", root);
      listeners.get("agent/turn-stopping")![0]({
        agent: a2,
        turn: 1,
        signal: new AbortController().signal,
      });
      expect(steers).toHaveLength(0);
      expect(fs.existsSync(path.join(root, ".autopilot"))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("every handler swallows exceptions (broken agent object)", async () => {
    const { ctx, listeners } = makeCtx();
    apply(ctx as never, { autoInit: false });
    const boom: Record<string, unknown> = {};
    Object.defineProperty(boom, "id", {
      get() {
        throw new Error("host agent exploded");
      },
    });

    expect(() =>
      listeners.get("agent/disposed")![0]({ agent: boom }),
    ).not.toThrow();
    expect(() => listeners.get("agent/error")![0]({ agent: boom })).not.toThrow();
    expect(() =>
      listeners.get("agent/turn-stopping")![0]({
        agent: boom,
        turn: 1,
        signal: new AbortController().signal,
      }),
    ).not.toThrow();

    const msg = { id: "m1", role: "user", content: [], source: { kind: "user" } };
    await expect(
      listeners.get("agent/pre-step")![0](
        { agent: boom, messages: [msg], turn: 1, step: 1, signal: new AbortController().signal },
        async () => ({ kind: "enter", messages: [msg] }),
      ),
    ).resolves.toEqual({ kind: "enter", messages: [msg] });

    await expect(
      listeners.get("tools/post-execute")![0](
        { name: "edit", arguments: { file_path: "/tmp/x.ts" }, agent: boom },
        {},
        async () => "ok",
      ),
    ).resolves.toBe("ok");
  });

  it("passes through non-user sources untouched", async () => {
    const { ctx, listeners } = makeCtx();
    apply(ctx as never, { autoInit: false });
    const root = tmpProject();
    try {
      const { agent } = fakeAgent("sess-src", root);
      const runtime = {
        id: "m-rt",
        role: "user",
        content: [{ type: "text", text: "runtime context" }],
        source: { kind: "plugin:runtime-context" },
      };
      const decision = (await listeners.get("agent/pre-step")![0](
        {
          agent,
          messages: [runtime],
          turn: 1,
          step: 1,
          signal: new AbortController().signal,
        },
        async () => ({ kind: "enter", messages: [runtime] }),
      )) as { kind: string; messages: unknown[] };
      expect(decision.messages).toEqual([runtime]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
