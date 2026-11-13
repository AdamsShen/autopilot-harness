import {
  applyOff,
  applyOn,
  applyReplan,
  applyResume,
  applyResumeReview,
  applyRun,
  applyTrackPick,
  ensureAmbientReviewSession,
  effectiveReviewingItemId,
  firstUnchecked,
  isChannelANeedPick,
  isHarnessFollowupMessage,
  isProductCodeEdit,
  isRecoverOrStuckFollowupMessage,
  isSafeTrackSlug,
  loadProjectHookConfig,
  loadProjectReviewConfig,
  notePlansDirEdit,
  parseAdvanceNextItemId,
  parseChecklist,
  parseTrigger,
  type FollowupAction,
  type PhaseActionConfig,
  type ReviewEngine,
  type StateStore,
} from "@autopilot-harness/core";

/**
 * CodeBuddy Code (腾讯云代码助手 CLI) hook port.
 *
 * Host facts (official Hooks Reference, CodeBuddy Code v1.16.0+, Beta):
 * - Project config: `<root>/.codebuddy/settings.json`（另有 settings.local.json）。
 * - Payload 形状与 Claude Code 基本一致：`session_id` / `transcript_path` / `cwd` /
 *   `hook_event_name`；Stop/SubagentStop 带 `stop_hook_active`；PostToolUse 带
 *   `tool_name` / `tool_input`；UserPromptSubmit 带 `prompt`。
 * - 续跑语义与 Claude **相反**：Stop 用 `{ "continue": false, "reason": "…" }`
 *   让 agent 继续干活；UPS 拦截同样用 `continue: false` + reason。
 *   `decision: "block"` 在 CodeBuddy 已废弃，禁止发出。
 * - `hookSpecificOutput.additionalContext` 可向模型注入上下文。
 * - 命令 hook 超时默认 60s（init 显式写 120）。
 * - 文档未给出 Stop 连续续跑硬上限；靠 `stop_hook_active` 与脚本自行控制。
 */
export const CODEBUDDY_PLATFORM = "codebuddy";

/** 秒。命令 hook 宿主默认 60s，Autopilot 显式抬高。 */
export const CODEBUDDY_HOOK_TIMEOUT_SEC = 120;

/**
 * PostToolUse matcher：锚定精确工具名，避免 `Edit` 子串误命中
 * （CodeBuddy matcher 是大小写敏感正则）。
 */
export const CODEBUDDY_POST_TOOL_USE_MATCHER =
  "^(Edit|Write|MultiEdit|NotebookEdit)$";

export const CODEBUDDY_AUTOPILOT_EVENTS = [
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
] as const;

export type CodebuddyHookEvent =
  (typeof CODEBUDDY_AUTOPILOT_EVENTS)[number];

/** 公开研究未找到 Stop 连续续跑硬上限 / 抬高开关 → doctor 只 WARN。 */
export const CODEBUDDY_STOP_CAP_RAISE_FOUND = false;

/** CodeBuddy UserPromptSubmit stdin（Claude-shaped）。 */
export interface CodebuddySubmitPayload {
  session_id?: string;
  sessionId?: string;
  prompt?: string;
  /** 信息字段；store 始终使用安装根，不信任 payload.cwd。 */
  cwd?: string;
  transcript_path?: string;
  transcriptPath?: string;
  hook_event_name?: string;
  hookEventName?: string;
  generation_id?: string;
}

/** CodeBuddy PostToolUse stdin（Edit / Write / MultiEdit / NotebookEdit）。 */
export interface CodebuddyEditPayload {
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  tool_name?: string;
  toolName?: string;
  tool_input?: Record<string, unknown> | string;
  toolInput?: Record<string, unknown> | string;
  tool_response?: unknown;
  hook_event_name?: string;
  hookEventName?: string;
}

/** CodeBuddy Stop stdin。 */
export interface CodebuddyStopPayload {
  session_id?: string;
  sessionId?: string;
  cwd?: string;
  transcript_path?: string;
  transcriptPath?: string;
  status?: string;
  /** true 表示本次停止已由 stop hook 续跑过（非数字上限）。 */
  stop_hook_active?: boolean;
  stopHookActive?: boolean;
  hook_event_name?: string;
  hookEventName?: string;
}

export interface CodebuddyPortConfig {
  phaseActions?: PhaseActionConfig;
}

/**
 * UPS stdout。允许 = `{}`；拦截 = `{continue:false, reason}`；
 * needPick 注入 = `hookSpecificOutput.additionalContext`。
 */
export interface CodebuddySubmitResult {
  /** false = 阻止本次提示词处理（reason 显示给用户）。 */
  continue?: boolean;
  reason?: string;
  stopReason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: "UserPromptSubmit";
    additionalContext?: string;
  };
}

/**
 * Stop stdout。允许 = `{}`；续跑 = `{continue:false, reason}`；
 * 只投递不续跑（loop:false）= `{continue:true, systemMessage}`。
 */
export interface CodebuddyStopResult {
  continue?: boolean;
  reason?: string;
  stopReason?: string;
  systemMessage?: string;
}

export const MAX_NEED_PICK_SLUGS = 40;
export const MAX_NEED_PICK_CONTEXT_CHARS = 2_000;
export const MAX_HOOK_TEXT_CHARS = 8_192;
/** 拒绝超大字符串化 tool_input 再 JSON.parse。 */
export const MAX_TOOL_INPUT_JSON_CHARS = 1_048_576;

const PATH_KEYS = [
  "file_path",
  "filePath",
  "path",
  "notebook_path",
  "notebookPath",
  "target_file",
  "targetFile",
] as const;

/** 与 Claude 端口使用相对命令（hook cwd = 项目根）；独立 `--platform codebuddy` 指纹。 */
export function codebuddyHookCommandLine(event: string): string {
  if (typeof event !== "string") {
    throw new Error("codebuddyHookCommandLine: invalid event");
  }
  const safeEvent = event.replace(/[^A-Za-z0-9._+-]/g, "").slice(0, 64);
  if (
    !safeEvent ||
    safeEvent !== event ||
    !CODEBUDDY_AUTOPILOT_EVENTS.includes(event as CodebuddyHookEvent)
  ) {
    throw new Error("codebuddyHookCommandLine: invalid event");
  }
  return `node .autopilot/bin/autopilot-harness-hook.mjs --platform ${CODEBUDDY_PLATFORM} --event ${safeEvent}`;
}

/** 只匹配本端口的 stamp；Claude / Devin 命令不算命中。 */
export function isCodebuddyHookFingerprint(command: string | undefined): boolean {
  if (typeof command !== "string") return false;
  if (!command.includes("autopilot-harness-hook.mjs")) return false;
  if (/(?:^|\s)--platform claude-code(?:\s|$)/.test(command)) return false;
  return /(?:^|\s)--platform codebuddy(?:\s|$)/.test(command);
}

/**
 * `stop_hook_active` 两个拼写任一严格 true → loopCount 1。
 * 缺失 / false / 字符串 "true" → 0（不臆测布尔）。
 */
export function loopCountFromCodebuddyStopHookActive(
  payload: CodebuddyStopPayload | null | undefined,
): number {
  if (!payload || typeof payload !== "object") return 0;
  return payload.stop_hook_active === true || payload.stopHookActive === true
    ? 1
    : 0;
}

const CODEBUDDY_EDIT_TOOL_RE = new RegExp(CODEBUDDY_POST_TOOL_USE_MATCHER);

export function isCodebuddyEditTool(toolName: string): boolean {
  if (typeof toolName !== "string") return false;
  return CODEBUDDY_EDIT_TOOL_RE.test(toolName.trim());
}

export function normalizeCodebuddyStopStatus(
  payload: CodebuddyStopPayload,
  opts?: { status?: "completed" | "error" | "aborted" },
): "completed" | "error" | "aborted" {
  const statusRaw = String(payload?.status ?? "")
    .toLowerCase()
    .trim();
  if (
    statusRaw === "aborted" ||
    statusRaw === "cancelled" ||
    statusRaw === "canceled" ||
    opts?.status === "aborted"
  ) {
    return "aborted";
  }
  if (
    statusRaw === "error" ||
    statusRaw === "failed" ||
    opts?.status === "error"
  ) {
    return "error";
  }
  return "completed";
}

export function isCodebuddySilentAllow(
  result:
    | CodebuddySubmitResult
    | CodebuddyStopResult
    | null
    | undefined,
): boolean {
  if (result == null || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  for (const value of Object.values(result)) {
    if (value !== undefined && value !== null) return false;
  }
  return true;
}

function sessionIdOnly(
  payload:
    | {
        session_id?: string;
        sessionId?: string;
      }
    | null
    | undefined,
): string {
  if (!payload || typeof payload !== "object") return "";
  for (const raw of [payload.session_id, payload.sessionId]) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    // 与 StateStore 对齐：控制字符不是会话键。
    if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) continue;
    return trimmed;
  }
  return "";
}

function clipText(text: string, max = MAX_HOOK_TEXT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function blockReason(message: unknown, fallback: string): string {
  const text = typeof message === "string" ? message.trim() : "";
  return clipText(text || fallback);
}

function firstNonBlankString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function toolNameOf(payload: CodebuddyEditPayload | null | undefined): string {
  if (!payload || typeof payload !== "object") return "";
  return firstNonBlankString(payload.tool_name, payload.toolName);
}

function asToolInputObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  if (value.length > MAX_TOOL_INPUT_JSON_CHARS) return null;
  const text = value.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pathText(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return "";
  return trimmed;
}

function objectHasPath(input: Record<string, unknown>): boolean {
  return PATH_KEYS.some((key) => pathText(input[key]).length > 0);
}

function toolInputObject(
  payload: CodebuddyEditPayload,
): Record<string, unknown> | null {
  const snake = asToolInputObject(payload.tool_input);
  const camel = asToolInputObject(payload.toolInput);
  if (snake && objectHasPath(snake)) return snake;
  if (camel && objectHasPath(camel)) return camel;
  return snake ?? camel;
}

function pathsFromToolInput(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const filePath = pathText(input[key]);
    if (!filePath || out.includes(filePath)) continue;
    out.push(filePath);
  }
  return out;
}

function editPaths(payload: CodebuddyEditPayload | null | undefined): string[] {
  if (!payload || typeof payload !== "object") return [];
  if (!isCodebuddyEditTool(toolNameOf(payload))) return [];
  const input = toolInputObject(payload);
  if (!input) return [];
  return pathsFromToolInput(input);
}

/** 首个可用路径；前面的坏键不会遮蔽后面的好键。 */
export function filePathFromCodebuddyEdit(
  payload: CodebuddyEditPayload | null | undefined,
): string {
  return editPaths(payload)[0] ?? "";
}

function allowNeedPick(
  userMessage: unknown,
  candidates?: ReadonlyArray<{ slug?: string }>,
): CodebuddySubmitResult {
  const fromMessage =
    typeof userMessage === "string" && userMessage.trim().length > 0
      ? userMessage.trim()
      : "";
  const slugs = [
    ...new Set(
      (candidates ?? [])
        .map((c) => (c && typeof c.slug === "string" ? c.slug.trim() : ""))
        .filter((s) => s.length > 0 && isSafeTrackSlug(s)),
    ),
  ].slice(0, MAX_NEED_PICK_SLUGS);
  let ctx =
    fromMessage ||
    (slugs.length > 0
      ? `Select a plan to execute:\n\n${slugs
          .map((s, i) => `  ${i + 1}. ${s}`)
          .join("\n")}\n\nReply with a number or /autopilot-run <slug>.`
      : "Select a plan to execute. Reply with a number or /autopilot-run <slug>.");
  if (ctx.length > MAX_NEED_PICK_CONTEXT_CHARS) {
    ctx = `${ctx.slice(0, MAX_NEED_PICK_CONTEXT_CHARS - 1)}…`;
  }
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: ctx,
    },
  };
}

/** CodeBuddy 拦截 UPS：`continue:false` + reason（不是 decision:block）。 */
function blockSubmit(
  message: unknown,
  fallback: string,
): CodebuddySubmitResult {
  return { continue: false, reason: blockReason(message, fallback) };
}

function stampCodebuddyPlatform(
  store: StateStore,
  conversationId: string,
  projectRoot: string,
): void {
  const session = store.getSession(conversationId);
  if (!session || session.platform === CODEBUDDY_PLATFORM) return;
  store.upsertSession({
    conversation_id: conversationId,
    project_root: session.project_root || projectRoot,
    code_root: session.code_root || projectRoot,
    platform: CODEBUDDY_PLATFORM,
  });
}

function armCodeEdited(
  store: StateStore,
  conversationId: string,
  projectRoot: string,
): void {
  const cfg = loadProjectReviewConfig(projectRoot);
  if (cfg.reviewScope === "project") {
    ensureAmbientReviewSession(
      store,
      conversationId,
      projectRoot,
      cfg.reviewScope,
      CODEBUDDY_PLATFORM,
    );
  }
  stampCodebuddyPlatform(store, conversationId, projectRoot);
  const session = store.getSession(conversationId);
  const checklistPath = session?.checklist_path?.trim() ?? "";
  let checklistSnap: ReturnType<typeof parseChecklist> | null = null;
  if (checklistPath) {
    try {
      checklistSnap = parseChecklist(checklistPath, { projectRoot });
    } catch {
      /* checklist 读不了仍然 arm code_edited */
    }
  }
  store.markCodeEdited(conversationId, (chain) => {
    const fromPending = parseAdvanceNextItemId(chain.pending_followup);
    if (checklistSnap) {
      if (fromPending && effectiveReviewingItemId(checklistSnap, fromPending)) {
        return fromPending;
      }
      return firstUnchecked(checklistSnap)?.id ?? null;
    }
    return fromPending;
  });
}

/**
 * UserPromptSubmit：触发 ON/RUN/… 或放行。
 * harness 自己的 followup 不当作 ON/RUN；异常一律 fail-open `{}`。
 */
export function handleCodebuddyUserPromptSubmit(
  store: StateStore,
  payload: CodebuddySubmitPayload,
  projectRoot: string,
  portConfig?: CodebuddyPortConfig,
): CodebuddySubmitResult {
  try {
    return handleCodebuddyUserPromptSubmitInner(
      store,
      payload,
      projectRoot,
      portConfig,
    );
  } catch {
    return {};
  }
}

function handleCodebuddyUserPromptSubmitInner(
  store: StateStore,
  payload: CodebuddySubmitPayload,
  projectRoot: string,
  portConfig?: CodebuddyPortConfig,
): CodebuddySubmitResult {
  const conversationId = sessionIdOnly(payload);
  if (!conversationId) return {};

  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (isHarnessFollowupMessage(prompt)) {
    stampCodebuddyPlatform(store, conversationId, projectRoot);
    return {};
  }

  try {
    store.clearPendingFollowupIf(
      conversationId,
      isRecoverOrStuckFollowupMessage,
    );
  } catch {
    /* best-effort */
  }

  const session = store.getSession(conversationId);
  const hookCfg = loadProjectHookConfig(projectRoot);
  const trigger = parseTrigger({
    prompt,
    conversationId,
    projectRoot,
    pendingAction: session?.pending_action,
    triggers: hookCfg.triggers,
  });
  const actionConfig: PhaseActionConfig = {
    ...portConfig?.phaseActions,
    plansDir: portConfig?.phaseActions?.plansDir ?? hookCfg.plansDir,
  };
  const gateFallback =
    "Autopilot rejected this prompt. Check `npx autopilot-harness status`.";

  if (trigger?.kind === "off") {
    applyOff(store, conversationId);
    stampCodebuddyPlatform(store, conversationId, projectRoot);
    return {};
  }
  if (trigger?.kind === "on") {
    const result = applyOn(store, conversationId, projectRoot, {
      initialBrief: trigger.initialBrief,
      slug: trigger.slug,
      platform: CODEBUDDY_PLATFORM,
    });
    stampCodebuddyPlatform(store, conversationId, projectRoot);
    if (!result.ok) return blockSubmit(result.userMessage, gateFallback);
    return {};
  }
  if (trigger?.kind === "resume") {
    const result = applyResume(store, conversationId, { slug: trigger.slug });
    stampCodebuddyPlatform(store, conversationId, projectRoot);
    if (!result.ok) return blockSubmit(result.userMessage, gateFallback);
    return {};
  }
  if (trigger?.kind === "resume_review") {
    applyResumeReview(store, conversationId);
    stampCodebuddyPlatform(store, conversationId, projectRoot);
    return {};
  }
  if (trigger?.kind === "run") {
    const result = applyRun(store, conversationId, projectRoot, {
      slug: trigger.slug,
      config: actionConfig,
      platform: CODEBUDDY_PLATFORM,
    });
    stampCodebuddyPlatform(store, conversationId, projectRoot);
    if (!result.ok) {
      if (isChannelANeedPick(result)) {
        return allowNeedPick(result.userMessage, result.candidates);
      }
      return blockSubmit(result.userMessage, gateFallback);
    }
    return {};
  }
  if (trigger?.kind === "replan") {
    const result = applyReplan(store, conversationId, projectRoot, {
      slug: trigger.slug,
      config: actionConfig,
      platform: CODEBUDDY_PLATFORM,
    });
    stampCodebuddyPlatform(store, conversationId, projectRoot);
    if (!result.ok) {
      if (isChannelANeedPick(result)) {
        return allowNeedPick(result.userMessage, result.candidates);
      }
      return blockSubmit(result.userMessage, gateFallback);
    }
    return {};
  }
  if (trigger?.kind === "track_pick" && trigger.trackPick) {
    const result = applyTrackPick(
      store,
      conversationId,
      projectRoot,
      trigger.trackPick,
      { config: actionConfig, platform: CODEBUDDY_PLATFORM },
    );
    stampCodebuddyPlatform(store, conversationId, projectRoot);
    if (!result.ok) {
      if (isChannelANeedPick(result)) {
        return allowNeedPick(result.userMessage, result.candidates);
      }
      return blockSubmit(result.userMessage, gateFallback);
    }
    return {};
  }

  store.clearChainPending(conversationId);
  stampCodebuddyPlatform(store, conversationId, projectRoot);
  return {};
}

/**
 * PostToolUse：编辑工具 → arm `code_edited`。
 * 永不返回拦截决策（工具已执行）。
 */
export function handleCodebuddyPostToolUse(
  store: StateStore,
  payload: CodebuddyEditPayload,
  projectRoot: string,
): void {
  try {
    handleCodebuddyPostToolUseInner(store, payload, projectRoot);
  } catch {
    /* fail-open：exit 0 */
  }
}

function handleCodebuddyPostToolUseInner(
  store: StateStore,
  payload: CodebuddyEditPayload,
  projectRoot: string,
): void {
  if (!payload || typeof payload !== "object") return;
  const conversationId = sessionIdOnly(payload);
  const toolName = toolNameOf(payload);
  if (!conversationId || !isCodebuddyEditTool(toolName)) return;

  const paths = editPaths(payload);
  if (paths.length === 0) {
    stampCodebuddyPlatform(store, conversationId, projectRoot);
    return;
  }

  let plansDir: string | undefined;
  try {
    plansDir = loadProjectHookConfig(projectRoot).plansDir;
  } catch {
    plansDir = undefined;
  }

  let armed = false;
  for (const filePath of paths) {
    try {
      notePlansDirEdit(
        store,
        conversationId,
        projectRoot,
        filePath,
        plansDir,
      );
    } catch {
      /* best-effort */
    }
    if (armed || !isProductCodeEdit(filePath, { projectRoot })) continue;
    armCodeEdited(store, conversationId, projectRoot);
    armed = true;
  }
  if (!armed) stampCodebuddyPlatform(store, conversationId, projectRoot);
}

/**
 * Stop → ReviewEngine。需要续跑时返回 `{continue:false, reason}`，由 hook
 * writer 转成宿主要的 blocking 通道（exit 2 + stderr）：CLI 2.181 对 Stop
 * 的 `continue:false` 只记 non-blocking failure，不会重新唤起模型。
 * `loop:false` 只投递（`continue:true` + systemMessage，不请求新一轮）。
 */
export function handleCodebuddyStop(
  engine: ReviewEngine,
  payload: CodebuddyStopPayload,
  opts?: { status?: "completed" | "error" | "aborted" },
): CodebuddyStopResult {
  try {
    return handleCodebuddyStopInner(engine, payload, opts);
  } catch {
    return {};
  }
}

function handleCodebuddyStopInner(
  engine: ReviewEngine,
  payload: CodebuddyStopPayload,
  opts?: { status?: "completed" | "error" | "aborted" },
): CodebuddyStopResult {
  const conversationId = sessionIdOnly(payload);
  if (!conversationId) return {};

  const transcriptTrimmed = firstNonBlankString(
    payload.transcript_path,
    payload.transcriptPath,
  );
  const transcriptPath =
    transcriptTrimmed && !/[\u0000-\u001f\u007f]/.test(transcriptTrimmed)
      ? transcriptTrimmed
      : undefined;

  const action: FollowupAction | null = engine.handleStop({
    conversationId,
    status: normalizeCodebuddyStopStatus(payload, opts),
    loopCount: loopCountFromCodebuddyStopHookActive(payload),
    transcriptPath,
    platform: CODEBUDDY_PLATFORM,
  });

  if (!action?.message) return {};

  const reason = blockReason(action.message, "Autopilot followup");
  if (!action.loop) {
    // 只提示用户、不续跑：CodeBuddy 的 systemMessage 不传给 agent。
    return { continue: true, systemMessage: reason };
  }
  return { continue: false, reason };
}

/** 包级裸导出别名（与其它 port 一致，便于 package-only 加载）。 */
export const handleUserPromptSubmit = handleCodebuddyUserPromptSubmit;
export const handlePostToolUse = handleCodebuddyPostToolUse;
export const handleStop = handleCodebuddyStop;
