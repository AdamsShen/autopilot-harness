/**
 * Replace Autopilot hooks in CodeBuddy Code `.codebuddy/settings.json`.
 * 形状与 Claude settings 类似：`{ hooks: { Event: [{matcher?, hooks:[{type,command,timeout}]}] } }`。
 * 不写 `env`（CodeBuddy 无文档化的 stop block cap 环境变量），保留所有外来键。
 */
import {
  CODEBUDDY_AUTOPILOT_EVENTS,
  CODEBUDDY_HOOK_TIMEOUT_SEC,
  CODEBUDDY_POST_TOOL_USE_MATCHER,
  codebuddyHookCommandLine,
  type CodebuddyHookEvent,
} from "@autopilot-harness/port-codebuddy";
import {
  HOOK_PLATFORM_CODEBUDDY,
  commandHasPlatformStamp,
  isAutopilotCommand,
} from "./hooks-merge.js";

export {
  CODEBUDDY_AUTOPILOT_EVENTS,
  CODEBUDDY_HOOK_TIMEOUT_SEC,
  CODEBUDDY_POST_TOOL_USE_MATCHER,
};

/** 项目级 hooks 文件（不含 `.codebuddy/settings.local.json`）。 */
export const CODEBUDDY_SETTINGS_REL_PATH = [".codebuddy", "settings.json"].join(
  "/",
);

/** 本机覆盖文件；Autopilot 不写，doctor 仅提示残留。 */
export const CODEBUDDY_SETTINGS_LOCAL_REL_PATH = [
  ".codebuddy",
  "settings.local.json",
].join("/");

/**
 * CodeBuddy IDE（桌面端）每轮最多允许的 Stop 续跑次数；`-1` = 不限。
 * CLI 2.181 忽略该未知字段，IDE 4.12 用它替代默认的 1 次上限。
 */
export const CODEBUDDY_IDE_STOP_LOOP_LIMIT = -1;

export interface CodebuddyHookHandler {
  type?: string;
  command?: string;
  timeout?: number;
  loop_limit?: number;
  [key: string]: unknown;
}

export interface CodebuddyMatcherGroup {
  matcher?: string;
  hooks?: CodebuddyHookHandler[];
  [key: string]: unknown;
}

export interface CodebuddySettingsFile {
  hooks?: Record<string, CodebuddyMatcherGroup[] | unknown>;
  [key: string]: unknown;
}

const CODEBUDDY_EVENT_SET = new Set<string>(CODEBUDDY_AUTOPILOT_EVENTS);

function safeKeyLabel(key: string): string {
  const cleaned = key
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
  return cleaned || "?";
}

/** 禁止从 JSON 复制进合并对象的键（与 config-merge 策略一致）。 */
function isUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

export function autopilotCodebuddyHookCommandLine(
  event: CodebuddyHookEvent,
): string {
  return codebuddyHookCommandLine(event);
}

/** Autopilot 为单个 CodeBuddy 事件写入的 matcher group。 */
export function autopilotCodebuddyMatcherGroup(
  event: CodebuddyHookEvent,
): CodebuddyMatcherGroup {
  const handler: CodebuddyHookHandler = {
    type: "command",
    command: autopilotCodebuddyHookCommandLine(event),
    timeout: CODEBUDDY_HOOK_TIMEOUT_SEC,
  };
  // IDE 桌面端默认 loopLimit=1（每轮只续跑一次）；Autopilot 的 fix/confirm
  // 需要多轮，桌面端靠 loop_limit 提升。-1 = 不限（宿主只接受 -1 或 1..100）。
  if (event === "Stop") handler.loop_limit = CODEBUDDY_IDE_STOP_LOOP_LIMIT;
  if (event === "PostToolUse") {
    return { matcher: CODEBUDDY_POST_TOOL_USE_MATCHER, hooks: [handler] };
  }
  return { hooks: [handler] };
}

/** settings.json 形状可合并才继续；否则拒绝（不覆盖用户配置）。 */
export function validateCodebuddySettingsShape(
  settings: CodebuddySettingsFile,
): string | null {
  for (const key of Object.keys(settings)) {
    if (isUnsafeKey(key)) {
      return `settings.json key "${safeKeyLabel(key)}" is not allowed.`;
    }
  }
  if (settings.hooks == null) return null;
  if (
    typeof settings.hooks !== "object" ||
    Array.isArray(settings.hooks) ||
    settings.hooks === null
  ) {
    return 'settings.json "hooks" must be an object.';
  }
  for (const [key, value] of Object.entries(settings.hooks)) {
    const label = safeKeyLabel(key);
    if (isUnsafeKey(key)) {
      return `settings.json hooks key "${label}" is not allowed.`;
    }
    if (value == null) continue;
    if (!Array.isArray(value)) {
      return `settings.json hooks.${label} must be an array of matcher groups.`;
    }
    for (const group of value) {
      if (!group || typeof group !== "object" || Array.isArray(group)) {
        return `settings.json hooks.${label} contains a non-object matcher group.`;
      }
      const g = group as CodebuddyMatcherGroup;
      if (g.matcher != null && typeof g.matcher !== "string") {
        return `settings.json hooks.${label} has a non-string matcher.`;
      }
      if (g.hooks == null) continue;
      if (!Array.isArray(g.hooks)) {
        return `settings.json hooks.${label} matcher group hooks must be an array.`;
      }
      for (const h of g.hooks) {
        if (!h || typeof h !== "object" || Array.isArray(h)) {
          return `settings.json hooks.${label} contains a non-object hook handler.`;
        }
        if (h.command != null && typeof h.command !== "string") {
          return `settings.json hooks.${label} has a non-string command.`;
        }
        if (h.type != null && typeof h.type !== "string") {
          return `settings.json hooks.${label} has a non-string type.`;
        }
        if (
          h.timeout != null &&
          (typeof h.timeout !== "number" || !Number.isFinite(h.timeout))
        ) {
          return `settings.json hooks.${label} has a non-finite timeout.`;
        }
      }
    }
  }
  return null;
}

function stripAutopilotFromGroups(
  groups: CodebuddyMatcherGroup[],
): CodebuddyMatcherGroup[] {
  const out: CodebuddyMatcherGroup[] = [];
  for (const group of groups) {
    if (!Array.isArray(group.hooks)) {
      out.push({ ...group });
      continue;
    }
    const kept = group.hooks.filter((h) => !isAutopilotCommand(h?.command));
    if (kept.length === 0) {
      // 丢掉 Autopilot-only group；保留用户刻意留的空 group。
      if (group.hooks.length === 0) {
        out.push({ ...group, hooks: [] });
      }
      continue;
    }
    out.push({ ...group, hooks: kept });
  }
  return out;
}

/** 合并 Autopilot CodeBuddy hooks 进现有（或空）settings。 */
export function mergeCodebuddySettings(
  existing: CodebuddySettingsFile | null,
): CodebuddySettingsFile {
  const base: CodebuddySettingsFile = {};
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    const shapeError = validateCodebuddySettingsShape(existing);
    if (shapeError) throw new Error(shapeError);
    for (const [key, value] of Object.entries(existing)) {
      if (isUnsafeKey(key)) continue;
      base[key] = value;
    }
  }

  const nextHooks: Record<string, CodebuddyMatcherGroup[]> = Object.create(null);
  if (
    base.hooks &&
    typeof base.hooks === "object" &&
    !Array.isArray(base.hooks)
  ) {
    for (const [key, value] of Object.entries(base.hooks)) {
      if (isUnsafeKey(key)) continue;
      if (!Array.isArray(value)) continue;
      nextHooks[key] = stripAutopilotFromGroups(
        value as CodebuddyMatcherGroup[],
      );
    }
  }

  for (const event of CODEBUDDY_AUTOPILOT_EVENTS) {
    const current = Array.isArray(nextHooks[event])
      ? [...nextHooks[event]!]
      : [];
    const stripped = stripAutopilotFromGroups(current);
    stripped.push(autopilotCodebuddyMatcherGroup(event));
    nextHooks[event] = stripped;
  }

  base.hooks = nextHooks;
  return base;
}

/**
 * 移除 Autopilot CodeBuddy hooks；保留外来 hooks 与其它设置键。
 * 不删除文件 —— 由调用方决定写回或 unlink。
 */
export function stripAutopilotCodebuddySettings(
  existing: CodebuddySettingsFile,
): CodebuddySettingsFile {
  const shapeError = validateCodebuddySettingsShape(existing);
  if (shapeError) throw new Error(shapeError);

  const base: CodebuddySettingsFile = {};
  for (const [key, value] of Object.entries(existing)) {
    if (isUnsafeKey(key)) continue;
    base[key] = value;
  }

  const prevHooks = base.hooks;
  if (prevHooks && typeof prevHooks === "object" && !Array.isArray(prevHooks)) {
    const nextHooks: Record<string, CodebuddyMatcherGroup[]> = Object.create(
      null,
    );
    for (const [key, value] of Object.entries(prevHooks)) {
      if (isUnsafeKey(key)) continue;
      if (!Array.isArray(value)) continue;
      const kept = stripAutopilotFromGroups(value as CodebuddyMatcherGroup[]);
      // 去掉空事件数组，避免 uninstall 残留 `Stop: []`。
      if (kept.length > 0) nextHooks[key] = kept;
    }
    if (Object.keys(nextHooks).length === 0) {
      delete base.hooks;
    } else {
      base.hooks = nextHooks;
    }
  }

  return base;
}

/** 文件里是否还有 Autopilot 痕迹（hook 命令）。 */
export function codebuddySettingsContainAutopilot(
  settings: unknown,
): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return false;
  }
  const hooks = (settings as CodebuddySettingsFile).hooks;
  const bag =
    hooks && typeof hooks === "object" && !Array.isArray(hooks) ? hooks : {};
  for (const value of Object.values(bag)) {
    if (!Array.isArray(value)) continue;
    for (const g of value as CodebuddyMatcherGroup[]) {
      const hooks = Array.isArray(g?.hooks) ? g.hooks : [];
      if (hooks.some((h) => isAutopilotCommand(h?.command))) return true;
    }
  }
  return false;
}

/**
 * Stop 上的 Autopilot handler 是否缺少 IDE 需要的 `loop_limit: -1`。
 * IDE 4.12 默认每轮只续跑 1 次；CLI 忽略该字段，所以缺失只会影响桌面端。
 */
export function codebuddyAutopilotHasOmittedIdeLoopLimit(
  settings: CodebuddySettingsFile,
): boolean {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const stop = (hooks as Record<string, unknown>).Stop;
  if (!Array.isArray(stop)) return false;
  for (const group of stop as CodebuddyMatcherGroup[]) {
    const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
    for (const h of handlers) {
      if (!isAutopilotCommand(h?.command)) continue;
      if (!String(h?.command).includes("--event Stop")) continue;
      if (h.loop_limit !== CODEBUDDY_IDE_STOP_LOOP_LIMIT) return true;
    }
  }
  return false;
}

/** 每个必需事件各恰好一个 Autopilot handler 的统计。 */
export function summarizeCodebuddyAutopilotHooks(
  settings: CodebuddySettingsFile,
): { missingEvents: string[]; duplicates: number } {
  const bag =
    settings.hooks &&
    typeof settings.hooks === "object" &&
    !Array.isArray(settings.hooks)
      ? settings.hooks
      : {};
  const missingEvents: string[] = [];
  let duplicates = 0;
  for (const event of CODEBUDDY_AUTOPILOT_EVENTS) {
    const groups = Array.isArray(bag[event])
      ? (bag[event] as CodebuddyMatcherGroup[])
      : [];
    let n = 0;
    for (const g of groups) {
      const hooks = Array.isArray(g.hooks) ? g.hooks : [];
      n += hooks.filter((h) => isAutopilotCommand(h?.command)).length;
    }
    if (n === 0) missingEvents.push(event);
    if (n > 1) duplicates += n - 1;
  }
  return { missingEvents, duplicates };
}

export function hasCompleteCodebuddyAutopilotHooks(
  settings: CodebuddySettingsFile,
): boolean {
  const { missingEvents, duplicates } =
    summarizeCodebuddyAutopilotHooks(settings);
  return missingEvents.length === 0 && duplicates === 0;
}

/** 所有 Autopilot 命令都 stamp `--platform codebuddy` 才为 true。 */
export function codebuddyHooksHavePlatformStamp(
  settings: CodebuddySettingsFile,
): boolean {
  const bag =
    settings.hooks &&
    typeof settings.hooks === "object" &&
    !Array.isArray(settings.hooks)
      ? settings.hooks
      : {};
  let seen = 0;
  for (const event of CODEBUDDY_AUTOPILOT_EVENTS) {
    const groups = Array.isArray(bag[event])
      ? (bag[event] as CodebuddyMatcherGroup[])
      : [];
    for (const g of groups) {
      const hooks = Array.isArray(g.hooks) ? g.hooks : [];
      for (const h of hooks) {
        if (!isAutopilotCommand(h?.command)) continue;
        seen += 1;
        if (
          !commandHasPlatformStamp(h.command, HOOK_PLATFORM_CODEBUDDY)
        ) {
          return false;
        }
      }
    }
  }
  return seen > 0;
}

/** 任一 Autopilot handler 省略 timeout 或 < 120。 */
export function codebuddyAutopilotHasOmittedOrSmallTimeout(
  settings: CodebuddySettingsFile,
): boolean {
  const bag =
    settings.hooks &&
    typeof settings.hooks === "object" &&
    !Array.isArray(settings.hooks)
      ? settings.hooks
      : {};
  for (const event of CODEBUDDY_EVENT_SET) {
    const groups = Array.isArray(bag[event])
      ? (bag[event] as CodebuddyMatcherGroup[])
      : [];
    for (const g of groups) {
      const hooks = Array.isArray(g.hooks) ? g.hooks : [];
      for (const h of hooks) {
        if (!isAutopilotCommand(h?.command)) continue;
        if (h.timeout == null) return true;
        if (
          typeof h.timeout === "number" &&
          Number.isFinite(h.timeout) &&
          h.timeout < CODEBUDDY_HOOK_TIMEOUT_SEC
        ) {
          return true;
        }
      }
    }
  }
  return false;
}
