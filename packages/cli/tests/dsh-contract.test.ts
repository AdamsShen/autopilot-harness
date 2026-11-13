/**
 * DSH 宿主接入契约：
 * - 平台登记（INSTALLABLE_BINDINGS + 显示名 + outro）与 shell hook 入口的 non-shell 隔离；
 * - vendor runtime / 打包脚本里确实带上了 DSH 适配器；
 * - doctor 能报「补丁缺失 / 不完整」与「补丁在但 profile 未装包」；
 * - uninstall 只 strip Autopilot 条目，保留用户自己的 patch 操作。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DSH_PATCH_ENTRY_NAME,
  DSH_PATCH_ENTRY_PKG,
  DSH_PATCH_REL_PATH,
  dshPatchYamlPath,
  summarizeDshAutopilotEntry,
  parseDshPatchYaml,
} from "../src/init/dsh-patch-merge.js";
import { installInitYes } from "../src/init/install.js";
import {
  INSTALLABLE_BINDINGS,
  defaultSurfaceFor,
} from "../src/init/platforms.js";
import {
  formatHostDisplayName,
  formatPostInstallOutro,
} from "../src/init/wizard-helpers.js";
import { runDoctor } from "../src/status-doctor.js";
import { uninstallProject } from "../src/uninstall.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_ASSET = path.join(cliRoot, "assets/autopilot-harness-hook.mjs");
const VENDOR_ENTRY = path.join(cliRoot, "src/vendor-entry.ts");
const BUNDLE_SCRIPT = path.join(cliRoot, "scripts/bundle-vendor.mjs");
const VENDOR_RUNTIME = path.join(cliRoot, "assets/vendor/runtime.mjs");

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hookPath(root: string): string {
  return path.join(root, ".autopilot", "bin", "autopilot-harness-hook.mjs");
}

function runHook(
  root: string,
  event: string,
  payload: Record<string, unknown>,
  platform: string,
): { status: number | null; stdout: string; stderr: string } {
  const proc = spawnSync(
    process.execPath,
    [hookPath(root), "--platform", platform, "--event", event],
    {
      cwd: root,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  if (proc.error) throw proc.error;
  if (proc.status == null) {
    throw new Error(
      `dsh contract hook killed: event=${event} signal=${proc.signal}`,
    );
  }
  return {
    status: proc.status,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
  };
}

describe("DSH host contract", () => {
  let root = "";
  let dshHome = "";
  let prevDshHome: string | undefined;

  afterEach(() => {
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    prevDshHome = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (dshHome) fs.rmSync(dshHome, { recursive: true, force: true });
    root = "";
    dshHome = "";
  });

  /** 临时项目 + 临时 $DSH_HOME；两者都装进清理队列。 */
  function withProjectAndHome(): { root: string; dshHome: string } {
    root = tmpDir("ap-dsh-proj-");
    dshHome = tmpDir("ap-dsh-home-");
    prevDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = dshHome;
    return { root, dshHome };
  }

  function installDsh(projectRoot: string): void {
    const r = installInitYes({
      projectRoot,
      platform: "dsh",
      surface: "cli",
      locale: "en",
      force: false,
    });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
  }

  it("registers dsh as an installable cli host with display name and outro", () => {
    expect(INSTALLABLE_BINDINGS.some((b) => b.id === "dsh")).toBe(true);
    expect(defaultSurfaceFor("dsh")).toBe("cli");
    expect(formatHostDisplayName("dsh")).toBe("DeepSeek Harness");

    const outro = formatPostInstallOutro("dsh");
    expect(outro).toContain("DeepSeek Harness");
    expect(outro).toContain(DSH_PATCH_REL_PATH);
    expect(outro).toContain(`dsh plugin --profile <profile> add ${DSH_PATCH_ENTRY_PKG}`);
  });

  it("keeps dsh out of the shell KNOWN_PLATFORMS and aborts a stray stamp", () => {
    const src = fs.readFileSync(HOOK_ASSET, "utf8");
    expect(src).toMatch(/NON_SHELL_PLATFORMS\s*=\s*new Set\(\[[^\]]*"dsh"/);

    withProjectAndHome();
    installDsh(root);
    const dbPath = path.join(root, ".autopilot", "state.db");
    expect(fs.existsSync(dbPath)).toBe(false);

    const events: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["beforeSubmitPrompt", { prompt: "/autopilot-on" }],
      [
        "UserPromptSubmit",
        { prompt: "/autopilot-on", session_id: "dsh-abort-sess" },
      ],
      ["Stop", { session_id: "dsh-abort-sess", status: "completed" }],
    ];
    for (const [event, payload] of events) {
      const r = runHook(root, event, payload, "dsh");
      expect(r.status).toBe(0);
      expect(r.stderr.trim()).toBe("");
      expect(r.stdout.trim()).toBe("{}");
    }
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it("ships the DSH adapters in the vendor bundle", () => {
    const entry = fs.readFileSync(VENDOR_ENTRY, "utf8");
    expect(entry).toContain("@autopilot-harness/port-dsh");
    expect(entry).toContain("handleDshTurnStopping");

    const bundle = fs.readFileSync(BUNDLE_SCRIPT, "utf8");
    expect(bundle).toContain('"@autopilot-harness/port-dsh"');

    const runtime = fs.readFileSync(VENDOR_RUNTIME, "utf8");
    expect(runtime).toContain("handleDshTurnStopping");
    expect(runtime).toContain("handleDshSubmit");
  });

  it("doctor reports OK for a complete patch entry", () => {
    withProjectAndHome();
    installDsh(root);

    const r = runDoctor(root, { dshHome });
    expect(r.lines.join("\n")).toMatch(
      new RegExp(`OK\\s+${DSH_PATCH_REL_PATH} Autopilot patch entry`),
    );
  });

  it("doctor FAILs when the patch entry was stripped from the machine layer", () => {
    withProjectAndHome();
    installDsh(root);
    fs.writeFileSync(dshPatchYamlPath(dshHome), "[]\n", "utf8");

    const r = runDoctor(root, { dshHome });
    expect(r.ok).toBe(false);
    expect(r.lines.join("\n")).toMatch(
      new RegExp(`FAIL\\s+${DSH_PATCH_REL_PATH} missing the Autopilot patch entry`),
    );
  });

  it("doctor WARNs when the patch exists but the profile does not declare the package", () => {
    withProjectAndHome();
    installDsh(root);
    const profileDir = path.join(dshHome, "profiles", "default");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "package.json"),
      JSON.stringify({ name: "dsh-profile-default", dependencies: {} }),
      "utf8",
    );

    const r = runDoctor(root, { dshHome });
    const joined = r.lines.join("\n");
    expect(joined).toMatch(
      new RegExp(`WARN\\s+DSH profile "default" does not declare`),
    );
    expect(joined).toContain(`dsh plugin --profile default add ${DSH_PATCH_ENTRY_PKG}`);

    // 声明依赖后不应再报。
    fs.writeFileSync(
      path.join(profileDir, "package.json"),
      JSON.stringify({
        name: "dsh-profile-default",
        dependencies: { [DSH_PATCH_ENTRY_PKG]: "^0.18.5" },
      }),
      "utf8",
    );
    const after = runDoctor(root, { dshHome });
    expect(after.lines.join("\n")).not.toMatch(
      /DSH profile "default" does not declare/,
    );
  });

  it("uninstall strips only the Autopilot patch entry", () => {
    withProjectAndHome();
    installDsh(root);

    const patchPath = dshPatchYamlPath(dshHome);
    const before = fs.readFileSync(patchPath, "utf8");
    // 模拟用户自有的补丁操作：uninstall 必须原样保留。
    fs.writeFileSync(
      patchPath,
      `${before.trimEnd()}\n- insert:\n    - id: user-plugin\n      name: some-user-plugin\n`,
      "utf8",
    );

    const r = uninstallProject({ projectRoot: root });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);

    const after = fs.readFileSync(patchPath, "utf8");
    expect(after).toContain("user-plugin");
    expect(after).not.toContain(DSH_PATCH_ENTRY_NAME);
    const summary = summarizeDshAutopilotEntry(parseDshPatchYaml(after));
    expect(summary.entries).toBe(0);
  });
});
