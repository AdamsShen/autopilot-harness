import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  autoInitProject,
  findGitRoot,
  isAlreadyInitialized,
  resolveAutoInitRoot,
} from "../src/auto-init.js";
import { minimalInit } from "../src/minimal-init.js";

function tmpRoot(prefix = "ap-dsh-init-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("resolveAutoInitRoot safety anchors", () => {
  it("refuses dangerous locations", () => {
    for (const bad of ["/", "/tmp", "/var", "/usr", "/etc", "/home"]) {
      const out = resolveAutoInitRoot({ configuredRoot: bad, cwd: null });
      expect(out.root).toBeNull();
    }
  });

  it("refuses the home directory and tilde paths", () => {
    const home = process.env.HOME;
    if (home) {
      expect(resolveAutoInitRoot({ configuredRoot: home, cwd: null }).root).toBeNull();
    }
    // `~` 不是绝对路径的展开结果，绝不能当项目根
    expect(resolveAutoInitRoot({ configuredRoot: "~", cwd: null }).root).toBeNull();
    expect(resolveAutoInitRoot({ sessionCwd: "~" } as never).root ?? null).toBeNull();
  });

  it("requires the configured root to look like a project", () => {
    const empty = tmpRoot();
    try {
      const out = resolveAutoInitRoot({ configuredRoot: empty, cwd: null });
      expect(out.root).toBeNull();
      expect(out.reason).toContain("does not look like a project");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("prefers the git repository root over a nested cwd", () => {
    const repo = tmpRoot();
    try {
      fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
      const nested = path.join(repo, "packages", "app");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(path.join(nested, "package.json"), "{}\n");

      // macOS 上 /var 与 /private/var 是同一个位置，断言前统一 realpath。
      expect(fs.realpathSync(findGitRoot(nested) ?? "")).toBe(fs.realpathSync(repo));
      const out = resolveAutoInitRoot({ cwd: nested });
      expect(fs.realpathSync(out.root ?? "")).toBe(fs.realpathSync(repo));
      expect(out.reason).toBe("git repository root");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to a project-like cwd when there is no git", () => {
    const dir = tmpRoot();
    try {
      fs.writeFileSync(path.join(dir, "pyproject.toml"), "\n");
      const out = resolveAutoInitRoot({ cwd: dir });
      expect(fs.realpathSync(out.root ?? "")).toBe(fs.realpathSync(dir));
      expect(out.reason).toBe("cwd (project-like)");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for an empty or non-project cwd", () => {
    expect(resolveAutoInitRoot({ cwd: null }).root).toBeNull();
    const empty = tmpRoot();
    try {
      expect(resolveAutoInitRoot({ cwd: empty }).root).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("minimalInit", () => {
  it("writes the minimal product set and stays idempotent", () => {
    const root = tmpRoot();
    try {
      fs.writeFileSync(path.join(root, "package.json"), "{}\n");
      expect(isAlreadyInitialized(root)).toBe(false);

      const first = minimalInit(root, "zh-CN");
      expect(first.performed).toBe(true);
      expect(first.written).toContain(".autopilot/config.yml");
      expect(first.written).toContain(".autopilotignore");
      expect(first.written).toContain("docs/autopilot/plans/README.md");
      expect(first.written).toContain("docs/autopilot/specs/README.md");

      const cfg = fs.readFileSync(path.join(root, ".autopilot", "config.yml"), "utf8");
      expect(cfg).toContain("id: dsh");
      expect(cfg).toContain("surface: cli");
      expect(cfg).toContain("locale: zh-CN");

      expect(isAlreadyInitialized(root)).toBe(true);
      // 第二次必须完全跳过，不能覆盖用户改动
      const second = minimalInit(root, "en");
      expect(second.performed).toBe(false);
      expect(second.reason).toBe("already initialized");
      expect(
        fs.readFileSync(path.join(root, ".autopilot", "config.yml"), "utf8"),
      ).toBe(cfg);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never overwrites an existing .autopilotignore", () => {
    const root = tmpRoot();
    try {
      fs.writeFileSync(path.join(root, "package.json"), "{}\n");
      fs.writeFileSync(path.join(root, ".autopilotignore"), "custom/**\n");
      const out = minimalInit(root, "en");
      expect(out.written).not.toContain(".autopilotignore");
      expect(fs.readFileSync(path.join(root, ".autopilotignore"), "utf8")).toBe(
        "custom/**\n",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("autoInitProject", () => {
  it("skips already-initialized projects", async () => {
    const root = tmpRoot();
    try {
      fs.writeFileSync(path.join(root, "package.json"), "{}\n");
      minimalInit(root, "en");
      const out = await autoInitProject({ configuredRoot: root, cwd: root });
      expect(out.performed).toBe(false);
      expect(out.reason).toBe("already initialized");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to minimal init when the CLI cannot be resolved", async () => {
    const root = tmpRoot();
    try {
      fs.writeFileSync(path.join(root, "package.json"), "{}\n");
      const out = await autoInitProject({
        configuredRoot: root,
        cwd: root,
        deps: { loadInitYes: async () => null },
      });
      expect(out.performed).toBe(true);
      expect(out.reason).toContain("minimal local init");
      expect(out.written).toContain(".autopilot/config.yml");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the CLI result and reports its written paths", async () => {
    const root = tmpRoot();
    try {
      fs.writeFileSync(path.join(root, "package.json"), "{}\n");
      const seen: Array<Record<string, unknown>> = [];
      const out = await autoInitProject({
        configuredRoot: root,
        cwd: root,
        locale: "zh-CN",
        deps: {
          loadInitYes: async () => (opts) => {
            seen.push(opts as unknown as Record<string, unknown>);
            return { ok: true, written: [".autopilot/config.yml"] };
          },
        },
      });
      expect(out.performed).toBe(true);
      expect(out.reason).toBe("initialized");
      expect(out.written).toEqual([".autopilot/config.yml"]);
      expect(seen[0]?.platform).toBe("dsh");
      expect(seen[0]?.surface).toBe("cli");
      expect(seen[0]?.force).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("surfaces CLI failures without throwing", async () => {
    const root = tmpRoot();
    try {
      fs.writeFileSync(path.join(root, "package.json"), "{}\n");
      const failed = await autoInitProject({
        configuredRoot: root,
        cwd: root,
        deps: { loadInitYes: async () => () => ({ ok: false, error: "nope" }) },
      });
      expect(failed.performed).toBe(false);
      expect(failed.reason).toContain("nope");

      const threw = await autoInitProject({
        configuredRoot: root,
        cwd: root,
        deps: {
          loadInitYes: async () => () => {
            throw new Error("kaboom");
          },
        },
      });
      expect(threw.performed).toBe(false);
      expect(threw.reason).toContain("kaboom");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does nothing when the root cannot be trusted", async () => {
    const out = await autoInitProject({ configuredRoot: "/tmp", cwd: null });
    expect(out.performed).toBe(false);
    expect(out.projectRoot).toBeNull();
    expect(out.written).toEqual([]);
  });
});
