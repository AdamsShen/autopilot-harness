/**
 * DSH 宿主侧的**最小结构面**（纯类型，编译期擦除）。
 *
 * 为什么要单独一个真模块：
 *   本 port 不声明任何 `@deepseek-ai/*` 依赖（它们是 rc 版本、peer 链复杂，
 *   运行时由宿主 cordis 注入）。`src/dsh-events.d.ts` 必须是「脚本式」声明
 *   文件才能为不存在的包建立 ambient module，而脚本式文件不能有顶层
 *   export —— 所以这些可被本包其它模块 import 的类型放到这里，
 *   dsh-events.d.ts 再用 `import("./dsh-types.js")` 类型查询引用。
 *
 * 对应 DSH 源（核对日期 2026-11，dsh-agent@0.2.1-rc.5）：
 *   packages/dsh-agent/lib/types/runtime-types.d.ts
 */

/** DSH Agent 的最小结构面（只用本 port 需要的方法）。 */
export interface DshAgentLike {
  id: string;
  session?: { id: string };
  steer?(message: DshMessageLike): void;
  inject?(message: DshMessageLike): void;
  followup?(message: DshMessageLike): void;
}

/**
 * DSH Message 的最小结构面。
 *
 * `id` 必填（DSH 侧为不变量，不是可选装饰）：
 *   - 落盘成 `user/message` 后，重开会话时持久化层要求 `id` 为非空字符串，
 *     否则抛 `lacks an identified message`，整个会话被判为损坏；
 *   - inbox 待处理队列按 `id` 去重，两条无 id 消息同时排队会抛
 *     `message "undefined" is already pending`。
 * 插件自己构造消息时必须生成唯一 id。
 */
export interface DshMessageLike {
  id: string;
  role: "user" | "assistant" | "system";
  content: readonly { type: string; text?: string }[];
  source?: { kind?: string; plugin?: string; form?: string };
}
