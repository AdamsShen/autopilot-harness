/**
 * Merge the Autopilot plugin entry into DSH's machine-level
 * `$DSH_HOME/cordis.patch.yml`（默认 `~/.dsh/cordis.patch.yml`）。
 *
 * 与其它宿主的差异：
 *   - 这里不是 hooks.json / settings.json，而是 **cordis 补丁层**：
 *     YAML 根是一个「补丁操作列表」，我们只往 `insert` 里加一条插件条目。
 *   - 条目是**进程内插件**，没有 shell 命令，因此不需要 --platform 戳。
 *
 * 设计约束（与 hermes-hooks-merge 同约定）：
 *   1. **只动自己那一条**：按 `id` 或已知包名指纹识别，其它 `insert` 条目、
 *      其它补丁操作、以及用户注释一律原样保留（走 yaml 的 Document API，
 *      不做 parse→JS→stringify 的往返，那样会丢注释）。
 *   2. **幂等**：合并后再次合并必须字节一致（先 strip 再 append 同一形状）。
 *   3. **就地迁移**：旧包名（`dsh-autopilot-harness/plugin` /
 *      `dsh-autopilot/plugin`）写在新位置时只改 `name`，其余字段保持不动。
 *   4. **fail-closed**：形状非法（根不是列表、insert 不是列表、条目不是映射、
 *      危险键）一律拒绝，由调用方转成 `{ ok: false }`。
 */
import os from "node:os";
import path from "node:path";
import { isMap, isSeq, parseDocument, type Document } from "yaml";
import {
  MAX_UNTRUSTED_TEXT_BYTES,
  readUntrustedUtf8File,
} from "../read-untrusted-file.js";

/** DSH 数据目录的环境变量（profile 根）。 */
export const DSH_HOME_ENV = "DSH_HOME";

/** DSH 认的补丁层文件名。 */
export const DSH_PATCH_REL_PATH = "cordis.patch.yml";

/** 本插件的补丁条目 id（`id` 是 DSH 侧的去重/覆盖单位）。 */
export const DSH_PATCH_ENTRY_ID = "autopilot-harness";

/** 插件所属的 npm 包名（profile 依赖里必须是这个名字）。 */
export const DSH_PATCH_ENTRY_PKG = "@autopilot-harness/port-dsh";

/** 本插件的包入口（`@autopilot-harness/port-dsh/plugin`）。 */
export const DSH_PATCH_ENTRY_NAME = `${DSH_PATCH_ENTRY_PKG}/plugin`;

/**
 * 历史上出现过的插件入口名，用于识别并迁移旧条目。
 * 迁移时只改 `name`，不重建条目，避免冲掉用户手写的其它字段。
 */
export const DSH_LEGACY_ENTRY_NAMES = Object.freeze([
  "dsh-autopilot-harness/plugin",
  "dsh-autopilot/plugin",
] as const);

/**
 * 默认 config。`autoInit: false` 是安全默认：插件默认不在用户项目里建任何文件，
 * 显式 `/autopilot-enable` 才初始化。
 */
export const DSH_PATCH_DEFAULT_CONFIG = Object.freeze({
  autoInit: false,
  maxSteerPerTurn: 32,
});

/** 本条目必须存在的 config 键（缺任何一个都视为不完整）。 */
export const DSH_PATCH_REQUIRED_CONFIG_KEYS = Object.freeze([
  "autoInit",
  "maxSteerPerTurn",
] as const);

export interface DshPatchReadResult {
  ok: boolean;
  value: string;
  error: string;
}

/** 摘要：给 doctor / uninstall 判断「补丁在不在、全不全」。 */
export interface DshAutopilotEntrySummary {
  /** 命中本插件指纹的条目数（>1 表示重复）。 */
  entries: number;
  /** 命中的条目 id 列表。 */
  ids: string[];
  /** 命中的条目 name 列表。 */
  names: string[];
  /** 命名/配置层面的问题（空数组 = 完整）。 */
  problems: string[];
  /** 是否命中了旧包名（需要迁移）。 */
  legacyName: boolean;
}

function isUnsafeKey(key: string): boolean {
  return key === "__proto__" || key === "prototype" || key === "constructor";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeLabel(key: string): string {
  const cleaned = key
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/ +/g, " ")
    .trim();
  return cleaned || "?";
}

/** 解析 DSH 数据目录：`$DSH_HOME` 优先，否则 `~/.dsh`。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[DSH_HOME_ENV];
  if (typeof raw === "string") {
    const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (cleaned) return path.resolve(cleaned);
  }
  return path.join(os.homedir(), ".dsh");
}

/** 补丁层文件路径。 */
export function dshPatchYamlPath(home: string = resolveDshHome()): string {
  return path.join(home, DSH_PATCH_REL_PATH);
}

/** 读补丁层；文件不存在按空内容处理（首次 init 的正常路径）。 */
export function readDshPatch(filePath: string): DshPatchReadResult {
  const label = path.basename(filePath) || DSH_PATCH_REL_PATH;
  try {
    const raw = readUntrustedUtf8File(
      filePath,
      MAX_UNTRUSTED_TEXT_BYTES,
      label,
    );
    return { ok: true, value: raw, error: "" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { ok: true, value: "", error: "" };
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, value: "", error: `Cannot read ${filePath}: ${msg}` };
  }
}

/**
 * 校验补丁层形状。返回错误文案；`null` 表示可安全合并。
 *
 * 允许的形态：
 *   - 空文件 / `null` / `[]`
 *   - 根为列表，每项是映射；映射里的 `insert`（若有）是「条目映射列表」
 */
export function validateDshPatchShape(doc: unknown): string | null {
  if (doc == null) return null;
  if (!Array.isArray(doc)) {
    return "cordis.patch.yml root must be a list of patch operations.";
  }
  for (const [index, op] of doc.entries()) {
    if (!isPlainObject(op)) {
      return `cordis.patch.yml operation #${index + 1} must be a mapping.`;
    }
    for (const key of Object.keys(op)) {
      if (isUnsafeKey(key)) {
        return `cordis.patch.yml operation #${index + 1} key "${safeLabel(key)}" is not allowed.`;
      }
    }
    const insert = op.insert;
    if (insert == null) continue;
    if (!Array.isArray(insert)) {
      return `cordis.patch.yml operation #${index + 1} "insert" must be a list of plugin entries.`;
    }
    for (const entry of insert) {
      if (!isPlainObject(entry)) {
        return `cordis.patch.yml operation #${index + 1} contains a non-object plugin entry.`;
      }
      for (const key of Object.keys(entry)) {
        if (isUnsafeKey(key)) {
          return `cordis.patch.yml plugin entry key "${safeLabel(key)}" is not allowed.`;
        }
      }
      if (entry.id != null && typeof entry.id !== "string") {
        return `cordis.patch.yml plugin entry "id" must be a string.`;
      }
      if (entry.name != null && typeof entry.name !== "string") {
        return `cordis.patch.yml plugin entry "name" must be a string.`;
      }
      if (entry.config != null) {
        if (!isPlainObject(entry.config)) {
          return `cordis.patch.yml plugin entry "config" must be a mapping.`;
        }
        for (const key of Object.keys(entry.config)) {
          if (isUnsafeKey(key)) {
            return `cordis.patch.yml plugin config key "${safeLabel(key)}" is not allowed.`;
          }
        }
      }
    }
  }
  return null;
}

/** 解析 YAML 文本 → 补丁列表（空文件返回空列表）。形状非法时抛错。 */
export function parseDshPatchYaml(text: string | null): unknown[] {
  const src = typeof text === "string" ? text.replace(/^\uFEFF/, "") : "";
  if (src.trim() === "") return [];
  let doc: Document.Parsed;
  try {
    doc = parseDocument(src);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cordis.patch.yml is not valid YAML: ${msg}`);
  }
  if (doc.errors.length > 0) {
    throw new Error(
      `cordis.patch.yml is not valid YAML: ${doc.errors[0]?.message ?? "unknown error"}`,
    );
  }
  const parsed = doc.toJS({ maxAliasCount: 64 });
  if (parsed == null) return [];
  const shapeError = validateDshPatchShape(parsed);
  if (shapeError) throw new Error(shapeError);
  return parsed as unknown[];
}

/** 条目是否为本插件（id 命中，或 name 是当前/历史包名）。 */
function entryIsAutopilot(entry: Record<string, unknown>): boolean {
  if (typeof entry.id === "string" && entry.id.trim() === DSH_PATCH_ENTRY_ID) {
    return true;
  }
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (!name) return false;
  if (name === DSH_PATCH_ENTRY_NAME) return true;
  return (DSH_LEGACY_ENTRY_NAMES as readonly string[]).includes(name);
}

/** 本插件应当写入的条目（每次新建，避免调用方改到共享对象）。 */
export function autopilotDshPatchEntry(): Record<string, unknown> {
  return {
    id: DSH_PATCH_ENTRY_ID,
    name: DSH_PATCH_ENTRY_NAME,
    config: { ...DSH_PATCH_DEFAULT_CONFIG },
  };
}

/**
 * 移除本插件条目，保留其它操作、其它条目与它们的注释。
 * 形状非法时抛错（调用方决定是否 fail-closed）。
 */
export function stripAutopilotDshPatch(doc: unknown): unknown[] {
  const shapeError = validateDshPatchShape(doc);
  if (shapeError) throw new Error(shapeError);
  if (doc == null) return [];

  const out: unknown[] = [];
  for (const op of doc as unknown[]) {
    const record = op as Record<string, unknown>;
    const insert = record.insert;
    if (!Array.isArray(insert)) {
      out.push(record);
      continue;
    }
    const kept = insert.filter(
      (entry) => !entryIsAutopilot(entry as Record<string, unknown>),
    );
    const next: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(record)) {
      if (key === "insert") continue;
      next[key] = value;
    }
    if (kept.length > 0) next.insert = kept;
    // 操作只剩 insert 且已被清空 → 整个操作没有意义，丢弃；
    // 若还有其它键（用户自己的 patch 字段），保留。
    if (Object.keys(next).length === 0) continue;
    out.push(next);
  }
  return out;
}

/**
 * 合并本插件条目（对象级）。先 strip 再 append，保证幂等且不重复。
 */
export function mergeDshPatch(doc: unknown): unknown[] {
  const stripped = stripAutopilotDshPatch(doc);
  const out = [...stripped];
  const last = out[out.length - 1];
  const canAppendIntoLast =
    isPlainObject(last) &&
    Array.isArray((last as Record<string, unknown>).insert) &&
    Object.keys(last as Record<string, unknown>).length === 1;
  if (canAppendIntoLast) {
    const record = last as Record<string, unknown>;
    out[out.length - 1] = {
      insert: [...(record.insert as unknown[]), autopilotDshPatchEntry()],
    };
  } else {
    out.push({ insert: [autopilotDshPatchEntry()] });
  }
  return out;
}

/**
 * 统计本插件条目的完整性（doctor / uninstall / 幂等断言用）。
 */
export function summarizeDshAutopilotEntry(
  doc: unknown,
): DshAutopilotEntrySummary {
  const summary: DshAutopilotEntrySummary = {
    entries: 0,
    ids: [],
    names: [],
    problems: [],
    legacyName: false,
  };
  const shapeError = validateDshPatchShape(doc);
  if (shapeError) {
    summary.problems.push(shapeError);
    return summary;
  }
  if (doc == null) return summary;

  for (const op of doc as unknown[]) {
    const insert = (op as Record<string, unknown>).insert;
    if (!Array.isArray(insert)) continue;
    for (const raw of insert) {
      const entry = raw as Record<string, unknown>;
      if (!entryIsAutopilot(entry)) continue;
      summary.entries += 1;
      const id = typeof entry.id === "string" ? entry.id.trim() : "";
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (id) summary.ids.push(id);
      if (name) summary.names.push(name);
      if (id !== DSH_PATCH_ENTRY_ID) {
        summary.problems.push(
          `plugin entry id must be "${DSH_PATCH_ENTRY_ID}" (got "${id || "<missing>"}").`,
        );
      }
      if (name !== DSH_PATCH_ENTRY_NAME) {
        if ((DSH_LEGACY_ENTRY_NAMES as readonly string[]).includes(name)) {
          summary.legacyName = true;
          summary.problems.push(
            `plugin entry name "${name}" should migrate to "${DSH_PATCH_ENTRY_NAME}".`,
          );
        } else {
          summary.problems.push(
            `plugin entry name must be "${DSH_PATCH_ENTRY_NAME}" (got "${name || "<missing>"}").`,
          );
        }
      }
      const config = entry.config;
      if (!isPlainObject(config)) {
        summary.problems.push("plugin entry config must be a mapping.");
      } else {
        for (const key of DSH_PATCH_REQUIRED_CONFIG_KEYS) {
          if (!(key in config)) {
            summary.problems.push(`plugin entry config is missing "${key}".`);
          }
        }
      }
    }
  }
  return summary;
}

/** 补丁条目是否已完整写入（恰好一条、id/name/config 全对）。 */
export function hasCompleteDshAutopilotEntry(doc: unknown): boolean {
  const summary = summarizeDshAutopilotEntry(doc);
  return summary.entries === 1 && summary.problems.length === 0;
}

/** 补丁文本是否含本插件条目（uninstall / doctor 的指纹判定）。 */
export function dshPatchContainsAutopilot(yaml: string): boolean {
  const src = typeof yaml === "string" ? yaml : "";
  if (!src.trim()) return false;
  try {
    const parsed = parseDshPatchYaml(src);
    return summarizeDshAutopilotEntry(parsed).entries > 0;
  } catch {
    // YAML 已损坏：只能做文本指纹，宁可认「有」，让 uninstall 去清理。
    return (
      src.includes(DSH_PATCH_ENTRY_NAME) ||
      src.includes(DSH_PATCH_ENTRY_ID) ||
      (DSH_LEGACY_ENTRY_NAMES as readonly string[]).some((n) => src.includes(n))
    );
  }
}

/** 取根序列；空/`null` 时创建空序列。根不是列表时抛错。 */
function seqFromDocument(doc: Document.Parsed): Document.Parsed {
  if (doc.contents == null) {
    doc.contents = doc.createNode([]) as never;
    return doc;
  }
  if (!isSeq(doc.contents)) {
    throw new Error(
      "cordis.patch.yml root must be a list of patch operations.",
    );
  }
  return doc;
}

/** 在序列节点里去掉本插件条目；只处理 `insert` 列表。 */
function stripNodes(seq: { items: unknown[] }): void {
  const keptOps: unknown[] = [];
  for (const opNode of seq.items) {
    if (!isMap(opNode)) {
      keptOps.push(opNode);
      continue;
    }
    const insertPair = (opNode.items as Array<{ key: unknown; value: unknown }>)
      .find((p) => (p.key as { value?: unknown })?.value === "insert");
    if (!insertPair || !isSeq(insertPair.value)) {
      keptOps.push(opNode);
      continue;
    }
    const entryNodes = insertPair.value.items as unknown[];
    const keptEntries = entryNodes.filter((entry) => {
      if (!isMap(entry)) return true;
      for (const p of entry.items as Array<{ key: unknown; value: unknown }>) {
        const name = (p.key as { value?: unknown })?.value;
        const raw = (p.value as { value?: unknown })?.value;
        if (name === "id" && raw === DSH_PATCH_ENTRY_ID) return false;
        if (
          name === "name" &&
          (raw === DSH_PATCH_ENTRY_NAME ||
            (DSH_LEGACY_ENTRY_NAMES as readonly unknown[]).includes(raw))
        ) {
          return false;
        }
      }
      return true;
    });
    if (keptEntries.length === entryNodes.length) {
      keptOps.push(opNode);
      continue;
    }
    insertPair.value.items = keptEntries as never;
    // 操作只剩 insert 且已空 → 丢弃该操作
    if (keptEntries.length === 0 && opNode.items.length === 1) continue;
    keptOps.push(opNode);
  }
  seq.items = keptOps as never;
}

/**
 * 文本级合并（保留用户注释）：删掉旧的本插件条目，再在末尾追加一条。
 */
export function mergeDshPatchYaml(existing: string | null): string {
  const src = typeof existing === "string" ? existing.replace(/^\uFEFF/, "") : "";
  const doc = seqFromDocument(parseDocumentForEdit(src));
  const seq = doc.contents as unknown as { items: unknown[] };
  stripNodes(seq);
  seq.items.push(doc.createNode({ insert: [autopilotDshPatchEntry()] }) as never);
  const out = String(doc);
  return out.endsWith("\n") ? out : `${out}\n`;
}

/**
 * 文本级剥离（uninstall）：删掉本插件条目，保留其它内容与注释。
 * 剥离后若文件已无任何操作，返回空串（调用方可删除文件）。
 */
export function stripAutopilotDshPatchYaml(existing: string): string {
  const src = typeof existing === "string" ? existing.replace(/^\uFEFF/, "") : "";
  if (!src.trim()) return "";
  const doc = parseDocumentForEdit(src);
  const contents = doc.contents;
  if (contents == null) return "";
  if (!isSeq(contents)) {
    throw new Error("cordis.patch.yml root must be a list of patch operations.");
  }
  const seq = contents as unknown as { items: unknown[] };
  stripNodes(seq);
  if (seq.items.length === 0) return "";
  const out = String(doc);
  const body = out.endsWith("\n") ? out : `${out}\n`;
  // 只剩注释（用户没写任何操作）时不要凭空留下一个空文件。
  return body.replace(/^#.*$/gm, "").trim() === "" ? "" : body;
}

/** 解析为可编辑的 Document；语法错误抛错。 */
function parseDocumentForEdit(src: string): Document.Parsed {
  if (!src.trim()) return parseDocument("") as Document.Parsed;
  let doc: Document.Parsed;
  try {
    doc = parseDocument(src);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`cordis.patch.yml is not valid YAML: ${msg}`);
  }
  if (doc.errors.length > 0) {
    throw new Error(
      `cordis.patch.yml is not valid YAML: ${doc.errors[0]?.message ?? "unknown error"}`,
    );
  }
  return doc;
}
