import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "@autopilot-harness/core";
import {
  CODEBUDDY_HOOK_TIMEOUT_SEC,
  CODEBUDDY_POST_TOOL_USE_MATCHER,
  CODEBUDDY_SETTINGS_REL_PATH,
  autopilotCodebuddyMatcherGroup,
  codebuddyAutopilotHasOmittedIdeLoopLimit,
  codebuddyHooksHavePlatformStamp,
  hasCompleteCodebuddyAutopilotHooks,
  mergeCodebuddySettings,
  stripAutopilotCodebuddySettings,
} from "../src/init/codebuddy-settings-merge.js";
import {
  INSTALLABLE_BINDINGS,
  defaultSurfaceFor,
  formatBindingOptionLabel,
  isInstallableBinding,
  normalizeBinding,
} from "../src/init/platforms.js";
import { commandHasPlatformStamp } from "../src/init/hooks-merge.js";
import { installInitYes } from "../src/init/install.js";
import { runDoctor } from "../src/status-doctor.js";
import { uninstallProject } from "../src/uninstall.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ap-codebuddy-"));
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

describe("codebuddy init merge", () => {
  it("is installable as codebuddy/cli with an independent label", () => {
    expect(
      INSTALLABLE_BINDINGS.some(
        (b) => b.id === "codebuddy" && b.surface === "cli",
      ),
    ).toBe(true);
    expect(defaultSurfaceFor("codebuddy")).toBe("cli");
    expect(isInstallableBinding({ id: "codebuddy", surface: "cli" })).toBe(true);
    expect(normalizeBinding("codebuddy")).toEqual({
      id: "codebuddy",
      surface: "cli",
    });
    expect(
      formatBindingOptionLabel({ id: "codebuddy", surface: "cli" }),
    ).toMatch(/CodeBuddy/);
  });

  it("merges three events with timeout 120 + anchored matcher, keeping foreign hooks", () => {
    const merged = mergeCodebuddySettings({
      permissions: { allow: ["Read"] },
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: "echo foreign-stop" }],
          },
        ],
      },
    });
    const hooks = merged.hooks as Record<
      string,
      Array<{ matcher?: string; hooks?: Array<Record<string, unknown>> }>
    >;
    expect(Object.keys(hooks).sort()).toEqual(
      ["PostToolUse", "Stop", "UserPromptSubmit"].sort(),
    );
    const stopHooks = hooks.Stop ?? [];
    expect(stopHooks.length).toBe(2);
    expect(
      stopHooks.some((g) =>
        (g.hooks ?? []).some((h) => h.command === "echo foreign-stop"),
      ),
    ).toBe(true);
    const post = hooks.PostToolUse ?? [];
    expect(post[0]?.matcher).toBe(CODEBUDDY_POST_TOOL_USE_MATCHER);
    const apHandlers = Object.values(hooks)
      .flat()
      .flatMap((g) => g.hooks ?? [])
      .filter((h) =>
        String(h.command ?? "").includes("autopilot-harness-hook.mjs"),
      );
    expect(apHandlers.length).toBe(3);
    for (const h of apHandlers) {
      expect(h.timeout).toBe(CODEBUDDY_HOOK_TIMEOUT_SEC);
      expect(String(h.command)).toContain("--platform codebuddy");
    }
    expect(merged.permissions).toEqual({ allow: ["Read"] });
    expect(hasCompleteCodebuddyAutopilotHooks(merged)).toBe(true);
    expect(codebuddyHooksHavePlatformStamp(merged)).toBe(true);
    const stopGroup = autopilotCodebuddyMatcherGroup("Stop");
    expect(stopGroup.matcher).toBeUndefined();
    expect(stopGroup.hooks?.[0]?.timeout).toBe(CODEBUDDY_HOOK_TIMEOUT_SEC);
    // IDE 桌面端默认每轮只续跑 1 次；Stop 必须在 matcher group 层带 loop_limit: -1
    //（宿主 resolveStopHookLoopLimit 只读 group 层），handler 层保留同值。
    expect(stopGroup.loop_limit).toBe(-1);
    expect(stopGroup.hooks?.[0]?.loop_limit).toBe(-1);
    expect(
      autopilotCodebuddyMatcherGroup("UserPromptSubmit").loop_limit,
    ).toBeUndefined();
    expect(
      autopilotCodebuddyMatcherGroup("UserPromptSubmit").hooks?.[0]?.loop_limit,
    ).toBeUndefined();
  });

  it("upgrade migrates legacy handler-level loop_limit onto the Stop matcher group", () => {
    // 旧版 init 把 loop_limit 写在 handler 里；宿主只读 group 层 → 一轮后续跑被截断。
    const legacy = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "node .autopilot/bin/autopilot-harness-hook.mjs --platform codebuddy --event Stop",
                timeout: 120,
                loop_limit: -1,
              },
            ],
          },
        ],
      },
    };
    expect(codebuddyAutopilotHasOmittedIdeLoopLimit(legacy)).toBe(true);

    const merged = mergeCodebuddySettings(legacy);
    expect(codebuddyAutopilotHasOmittedIdeLoopLimit(merged)).toBe(false);
    expect(hasCompleteCodebuddyAutopilotHooks(merged)).toBe(true);

    const stopGroups =
      (merged.hooks as Record<string, Array<Record<string, unknown>>>)?.Stop ??
      [];
    const autopilotGroups = stopGroups.filter((g) =>
      (Array.isArray(g.hooks) ? (g.hooks as Array<Record<string, unknown>>) : [])
        .some((h) =>
          String(h.command ?? "").includes("autopilot-harness-hook.mjs"),
        ),
    );
    // 旧组被替换（不重复注册），且上限落在 group 层。
    expect(autopilotGroups.length).toBe(1);
    expect(autopilotGroups[0]?.loop_limit).toBe(-1);
  });

  it("strips Autopilot only, keeping foreign hooks and settings keys", () => {
    const merged = mergeCodebuddySettings({
      model: "x",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo foreign" }] }],
      },
    });
    const stripped = stripAutopilotCodebuddySettings(merged);
    const raw = JSON.stringify(stripped);
    expect(raw).not.toContain("autopilot-harness-hook.mjs");
    expect(raw).toContain("echo foreign");
    expect(stripped.model).toBe("x");
    expect(commandHasPlatformStamp(raw, "codebuddy")).toBe(false);
  });
});

describe("codebuddy init / doctor / uninstall", () => {
  it("writes settings + skills, doctor OK, uninstall strips Autopilot only", () => {
    const root = tmpRoot();
    try {
      const inst = installInitYes({
        projectRoot: root,
        platform: "codebuddy",
        surface: "cli",
        platforms: [{ id: "codebuddy", surface: "cli" }],
        locale: "en",
        force: false,
        writeQuickstart: false,
      });
      expect(inst.ok, inst.ok ? "" : inst.error).toBe(true);

      const settingsPath = path.join(root, CODEBUDDY_SETTINGS_REL_PATH);
      expect(fs.existsSync(settingsPath)).toBe(true);
      const settings = readJson(settingsPath);
      expect(hasCompleteCodebuddyAutopilotHooks(settings)).toBe(true);
      const raw = fs.readFileSync(settingsPath, "utf8");
      expect(commandHasPlatformStamp(raw, "codebuddy")).toBe(true);
      expect(raw).not.toMatch(/claude-code/);
      expect(
        fs.existsSync(
          path.join(root, ".codebuddy", "skills", "autopilot-on", "SKILL.md"),
        ),
      ).toBe(true);

      const cfg = fs.readFileSync(
        path.join(root, ".autopilot", "config.yml"),
        "utf8",
      );
      expect(cfg).toMatch(/^\s*-\s*id:\s*codebuddy\s*$/m);

      const doctor = runDoctor(root);
      const text = doctor.lines.join("\n");
      expect(doctor.ok, text).toBe(true);
      expect(text).toMatch(
        new RegExp(
          `OK\\s+${CODEBUDDY_SETTINGS_REL_PATH.replace(/\./g, "\\.")} Autopilot entries`,
        ),
      );

      // Foreign settings survive uninstall; Autopilot handlers do not.
      const withForeign = {
        ...readJson(settingsPath),
        permissions: { allow: ["Read"] },
      };
      fs.writeFileSync(
        settingsPath,
        JSON.stringify(withForeign, null, 2) + "\n",
      );

      const un = uninstallProject({ projectRoot: root, dryRun: false });
      expect(un.ok, un.ok ? "" : un.error).toBe(true);
      const after = fs.readFileSync(settingsPath, "utf8");
      expect(after).not.toContain("autopilot-harness-hook.mjs");
      expect(after).toContain("permissions");
      expect(
        fs.existsSync(
          path.join(root, ".codebuddy", "skills", "autopilot-on"),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("installed hook dispatches --platform codebuddy with CodeBuddy shapes", () => {
    const root = tmpRoot();
    try {
      const inst = installInitYes({
        projectRoot: root,
        platform: "codebuddy",
        surface: "cli",
        platforms: [{ id: "codebuddy", surface: "cli" }],
        locale: "en",
        force: false,
        writeQuickstart: false,
      });
      expect(inst.ok, inst.ok ? "" : inst.error).toBe(true);

      const hook = path.join(
        root,
        ".autopilot",
        "bin",
        "autopilot-harness-hook.mjs",
      );
      const run = (event: string, payload: Record<string, unknown>) => {
        const proc = spawnSync(
          process.execPath,
          [hook, "--platform", "codebuddy", "--event", event],
          {
            cwd: root,
            input: JSON.stringify(payload),
            encoding: "utf8",
            timeout: 15_000,
          },
        );
        expect(proc.status, proc.stderr).toBe(0);
        return JSON.parse(proc.stdout.trim() || "{}") as Record<
          string,
          unknown
        >;
      };

      // Gate block: continue:false + reason (never decision:block).
      const blocked = run("UserPromptSubmit", {
        session_id: "cb-spawn-ups",
        prompt: "/autopilot-run no-such-track",
      });
      expect(blocked.continue).toBe(false);
      expect(typeof blocked.reason).toBe("string");
      expect(blocked).not.toHaveProperty("decision");
      expect(blocked).not.toHaveProperty("hookSpecificOutput");

      // Unknown session Stop: allow `{}` (no decision / continue).
      const allowed = run("Stop", { session_id: "cb-spawn-unknown" });
      expect(allowed).toEqual({});

      // Non-CodeBuddy event under the stamp aborts before the FSM.
      const foreign = run("subagentStop", { session_id: "cb-spawn-x" });
      expect(foreign).toEqual({});

      // Stop 续跑必须走 blocking（exit 2 + stderr），不能是 continue:false JSON：
      // CLI 2.181 把 Stop 的 continue:false 当 non-blocking failure，不会重唤模型。
      const cid = "cb-spawn-stop-continue";
      const planDir = path.join(root, "docs", "autopilot", "plans", "cb-wire");
      fs.mkdirSync(planDir, { recursive: true });
      fs.writeFileSync(path.join(planDir, "plan.md"), "# cb-wire\n");
      fs.writeFileSync(path.join(planDir, "checklist.md"), "- [ ] a — A\n");
      const store = new StateStore(root);
      store.upsertSession({
        conversation_id: cid,
        project_root: root,
        code_root: root,
        platform: "codebuddy",
        phase: "executing",
        armed: 1,
        paused: 0,
        track_id: "cb-wire",
        checklist_path: path.join(planDir, "checklist.md"),
      });
      store.updateReviewChain(cid, { code_edited: 1 });
      store.close();

      const stopped = spawnSync(
        process.execPath,
        [hook, "--platform", "codebuddy", "--event", "Stop"],
        {
          cwd: root,
          input: JSON.stringify({
            session_id: cid,
            hook_event_name: "Stop",
            stop_hook_active: false,
          }),
          encoding: "utf8",
          timeout: 15_000,
        },
      );
      expect(stopped.status, stopped.stderr).toBe(2);
      expect(stopped.stdout.trim()).toBe("");
      expect(stopped.stderr.trim().length).toBeGreaterThan(0);
      expect(stopped.stderr).not.toMatch(/"decision"\s*:\s*"block"/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
