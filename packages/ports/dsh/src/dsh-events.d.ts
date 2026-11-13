/**
 * DSH（DeepSeek Harness）宿主的**环境声明**（ambient），只为让本包在没有
 * `@deepseek-ai/*` 安装的情况下通过类型检查。
 *
 * 为什么是这个形态（重要）：
 *   DSH 的事件名通过 `declare module '@deepseek-ai/cordis' { interface Events }`
 *   做模块增强，只有装了 `@deepseek-ai/cordis` / `dsh-agent` 才被 tsc 看见。
 *   本 port 刻意不声明这些依赖（rc 版本、peer 链复杂、运行时由宿主提供），
 *   于是这里**自己创建**这两个模块声明。
 *
 *   因此本文件必须是「脚本式」声明文件：顶层不能出现 import/export，
 *   否则 `declare module` 会退化成「模块增强」，而模块不存在时增强无效
 *   （表现为 plugin.ts 报 TS2307 Cannot find module）。
 *   需要被 import 的结构类型放在 `dsh-types.ts`，这里用 `import("...")` 引用。
 *
 * 约束：
 *   - 只声明本 port 实际用到的最小面，不追求覆盖 DSH 全集；
 *   - 事件形状须与 `dsh-agent@0.2.1-rc.5` 的 runtime-types.d.ts 保持一致，
 *     宿主升级若签名漂移需要同步更新本文件（契约测试在 dsh-port-tests 项）。
 *
 * 对应 DSH 源（核对日期 2026-11）：
 *   packages/dsh-agent/lib/types/runtime-types.d.ts  'agent/turn-stopping'
 *   packages/dsh-agent/lib/types/runtime-types.d.ts  'agent/error'
 *   packages/dsh-agent/lib/types/runtime-types.d.ts  'agent/disposed'
 *   packages/dsh-agent/lib/types/runtime-types.d.ts  'agent/pre-step'
 *   packages/dsh-tools/lib/types/index.d.ts          'tools/post-execute'
 */

declare module "@deepseek-ai/cordis" {
  /**
   * 事件表。真实宿主里由 `dsh-agent` 增强；这里给出本 port 订阅的 5 个。
   */
  interface Events {
    /** agent 离开注册表（驱动静止之后）。 */
    "agent/disposed"(payload: {
      agent: import("./dsh-types.js").DshAgentLike;
    }): void;

    /** 某回合内发生错误。 */
    "agent/error"(payload: {
      agent: import("./dsh-types.js").DshAgentLike;
      turn: number;
      step: number;
      error: unknown;
    }): void;

    /**
     * 即将进入某一步：waterfall 模式，listener 通过 `next()` 拿上游决策，
     * 可改写为 `{ kind: "enter", messages }` 替换本步消息。
     */
    "agent/pre-step"(
      payload: {
        agent: import("./dsh-types.js").DshAgentLike;
        messages: readonly import("./dsh-types.js").DshMessageLike[];
        turn: number;
        step: number;
        signal: AbortSignal;
      },
      next: () => Promise<
        | { kind: "reject" }
        | {
            kind: "enter";
            messages: readonly import("./dsh-types.js").DshMessageLike[];
          }
      >,
    ): Promise<
      | { kind: "reject" }
      | {
          kind: "enter";
          messages: readonly import("./dsh-types.js").DshMessageLike[];
        }
    >;

    /**
     * 回合即将关闭时触发（serial 模式）。
     * 续跑方式：listener 调 `agent.steer()` 投递数据，机器随后重读 inbox。
     * ⚠️ 同一 turn 内会多次触发，turn 号不变。
     */
    "agent/turn-stopping"(payload: {
      agent: import("./dsh-types.js").DshAgentLike;
      turn: number;
      signal: AbortSignal;
    }): Promise<void> | void;

    /** 工具执行完成后的 waterfall 钩子。 */
    "tools/post-execute"(
      exec: {
        name: string;
        arguments?: Record<string, unknown>;
        agent?: import("./dsh-types.js").DshAgentLike;
        [key: string]: unknown;
      },
      result: Readonly<unknown>,
      next: () => Promise<unknown>,
    ): Promise<unknown>;
  }

  /**
   * 插件上下文的最小面。
   *
   * 真实 cordis 的 Context 有几十个成员，本 port 只用 `on` / `inject`；
   * `logger` 走结构化 cast 读取（见 plugin.ts 的 makeLog），故不在此声明，
   * 避免与宿主实际形状产生不必要的耦合。
   */
  interface Context {
    on<K extends keyof Events>(
      event: K,
      listener: Events[K],
      prepend?: boolean,
    ): unknown;

    inject(
      deps: readonly string[],
      callback: (scoped: Context) => void,
    ): unknown;
  }
}

declare module "@deepseek-ai/schemastery" {
  /** 仅用于给 `Config` 做可选的运行时校验；缺席时 Config 为 undefined。 */
  interface SchemaLike {
    object(shape: Record<string, unknown>): {
      description(text: string): unknown;
    };
    string(): { description(text: string): unknown };
    number(): {
      default(value: number): { description(text: string): unknown };
    };
    boolean(): {
      default(value: boolean): { description(text: string): unknown };
    };
  }

  const Schema: SchemaLike;
  export default Schema;
}
