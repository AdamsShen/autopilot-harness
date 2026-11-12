# DeepSeek Harness (DSH) 端口

`dsh-autopilot` 如何把 Autopilot 接进 DeepSeek Harness。

> **源码位置：** 插件已拆到独立仓库 **`dsh-autopilot`**（与 `autopilot-harness` 同级），发布为 `dsh-autopilot`。本文描述其行为；`npm test` 等命令在该仓库内运行。

相关：[install.zh-CN.md](./install.zh-CN.md)（安装矩阵）· [hosts.md](./hosts.md)（宿主能力）· [architecture.md](./architecture.md)（core/port 分层）· [config.md](./config.md)（配置语义）。

English: [dsh.md](./dsh.md)

**只想照着做？** 看 [DSH 使用指南（实操版）](./dsh-guide.zh-CN.md)。

---

## 1. 心智模型

Autopilot 本质上是一个**回合边界拦截器**。它依赖 coding agent 的一个事实：

> agent 改完代码会**停下来**，等待人类说下一句话。

Autopilot 就在这个停顿点插入自己的追问，从而在「宣布完成」之前完成自审。

DSH 把这个停顿点暴露为 `agent/turn-stopping`，本端口的全部逻辑都围绕拦截它构建。

```
        ┌──────────────────────────── DSH 宿主进程 ─────────────────────────────────┐
        │  （插件全局安装；一个进程服务多个项目）                                      │
        │                                                                          │
人类 ───┼──► agent/pre-step ──────► agent 干活 ──────► agent/turn-stopping         │
        │        │                      │                      │                  │
        │        ▼                      ▼                      ▼                  │
        │   识别 /autopilot-*       检测到改了产品代码        决定：继续(steer)     │
        │   命令 → 驱动状态机        → 标记待自审             还是关闭回合           │
        │                                │                      │                  │
        │                                └──────────────────────┘                  │
        │                                     @autopilot-harness/core              │
        │                                              │                           │
        └──────────────────────────────────────────────┼───────────────────────────┘
                                                       ▼
                                            <项目>/.autopilot/state.db
```

两个性质最关键：

- **插件全局，状态本地**：DSH 只装一次插件，但每个项目有自己的 `.autopilot/`。
- **仅显式启用**：用户没启用的项目，插件不创建任何文件。

---

## 2. DSH 的续跑机制与其它宿主不同

其它所有 Autopilot 端口都用决策对象阻断宿主的 stop 事件：

```js
// Claude Code / Cursor / Codex 的形状
return { decision: "block", reason: "Review fix round 1 …" };
```

**DSH 没有这种决策。** `agent/turn-stopping` 是 **serial** 钩子：它不返回任何东西，也无权否决。续跑靠的是**数据副作用**——loop 在钩子返回后会重新读取收件箱：

```js
// dsh-agent-loop/lib/index.js（节选）
if (turnEnds && this.inbox.nextStep.length === 0) {
    await this.dispatch.serial("agent/turn-stopping", { turn, signal });
    signal.throwIfAborted();
}
if (turnEnds && this.inbox.nextStep.length === 0) break;   // ← 钩子之后重查
target = "next-step";
```

`agent.steer(message)` 写入 `next-step` 队列：

```js
// dsh AgentLoop
steer(input)    { this.send(input, "next-step", true); }
followup(input) { this.send(input, "next-turn",  true); }
```

因此端口的 stop 返回形状是：

```ts
export interface DshStopResult {
  steerMessage?: string;   // 不是 { decision, reason }
}
```

插件层拿到 `steerMessage` 后调用 `agent.steer(...)`。这就是自动续跑的全部机制。

**必须用 `steer`，不能用 `followup`。** Autopilot 的 fix → confirm 链发生在**同一个 turn 内**；用 `followup` 每轮都会开新 turn，行为会与其它所有宿主不一致。

### 推论：没有续跑上限

DSH 没有 `loop_limit` / block-cap 之类的机制。所以本端口**不 clamp** `review.confirm_rounds` —— 它和 Cursor / Claude Code 同级，而不是像降级宿主那样（Kimi ≤1/轮、Copilot 连续 ≤8、Grok ≤8/轮）。

---

## 3. 钩子

插件注册 5 个监听器。

| 钩子 | 模式 | 作用 |
|---|---|---|
| `agent/pre-step` | waterfall | 识别 `/autopilot-*`，驱动状态机 |
| `tools/post-execute` | waterfall | 改到产品代码就武装评审 |
| `agent/turn-stopping` | **serial** | **核心**：注入追问或放行关闭 |
| `agent/error` | emit | 标记当前 turn 出错 |
| `agent/disposed` | emit | 清理按 agent 的状态 |

所有监听器都包在 `try/catch` 里，**fail-open**：Autopilot 的 bug 绝不能让宿主回合崩掉。

### 这些钩子在哪里定义

**在代码里，不在配置里。** 这是与其它所有 Autopilot 宿主最大的结构差异，也是最容易让人去找 `hooks.json` 而困惑的地方。

| 层次 | 文件 | 职责 |
|---|---|---|
| Profile 接线 | `~/.dsh/profiles/<profile>/package.json` | 把 `dsh-autopilot` 列进 `dsh.profile.bundles` |
| Bundle 声明 | `dsh-autopilot/package.json` | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| Loader 条目 | `dsh-autopilot/cordis.patch.yml` | `- id: autopilot-harness` / `name: 'dsh-autopilot/plugin'` + 插件配置 |
| **钩子注册** | **`dsh-autopilot/src/plugin.ts`** | **`apply(ctx, config)` 内调用 `ctx.on(<事件>, handler)`** |
| 事件名类型 | `dsh-autopilot/src/dsh-events.d.ts` | 仅编译期声明，运行时被擦除 |

`cordis.patch.yml` **没有任何钩子声明**——它唯一的职责是让 DSH 加载这个插件。里面出现的钩子名只在注释中。真正的注册发生在运行时，位于 `plugin.ts`（行号仅供参考，文件变动后请 grep `ctx.on(`）：

| 行号 | 调用 | 事件 |
|---:|---|---|
| 295 | `ctx.on("agent/disposed", …)` | agent 离开注册表 |
| 301 | `ctx.on("agent/error", …)` | 某步或回合出错 |
| 307 | `ctx.on("agent/pre-step", …)` | 每步之前 |
| 357 | `ctx.on("tools/post-execute", …)` | 工具调用完成后 |
| 384 | `ctx.on("agent/turn-stopping", …)` | **核心**：回合即将关闭 |

命令也以同样方式注册（`ctx.inject(["commands"], …)` → `commands.register(...)`），同一个文件。

#### 为什么没有 `hooks.json`

两种宿主模型本质不同：

```
传统 hook 宿主（Claude Code、Cursor、Codex …）
  .claude/settings.json
    "hooks": { "Stop": [{ "command": "node .autopilot/bin/… --event Stop" }] }
  → 宿主为每个事件 spawn 一个子进程

DSH（进程内插件）
  cordis.patch.yml
    name: 'dsh-autopilot/plugin'        ← 加载包
  → plugin.apply(ctx)  →  ctx.on("agent/turn-stopping", fn)
  → 宿主在同一进程内直接调 fn(...)，无子进程、无 JSON 协议
```

DSH 在进程内事件总线上分发钩子事件（形态与 `EventEmitter` 相同）。由此带来几个推论：

- 没有 `hooks.json` 需要合并，也没有东西需要打 `--platform dsh` 标记。
- 端口不 spawn 进程，所以 `init` 安装的 `vendor/runtime.mjs` 对本端口**用不上**（仅为保持项目树一致而写入）。
- 改变钩子行为要改 TypeScript 并重新构建，而不是改一个 JSON 设置文件。

事件名本身（`agent/turn-stopping`、`tools/post-execute` 等）由 DSH 在 `@deepseek-ai/dsh-agent`（`runtime-types.d.ts`）中声明。本地的 `dsh-events.d.ts` 只镜像了本端口订阅的最小面，从而让 DSH 保持可选 peer，而非常硬依赖。

### 3.1 `agent/pre-step`

每步之前运行，且**同一个 turn 内每一步都会再次运行**（见 §5.1）。它：

1. 仅当 `payload.turn` 真的变化时才重置本 turn 的续跑预算；
2. 把本 turn 状态标回 `completed`；
3. 对每条**非 Autopilot 自身注入**的消息调用 `handleDshSubmit`：

```
prompt ──► parseTrigger()
              │
              ├─ /autopilot-on   ──► applyOn()     ──► phase = planning
              ├─ /autopilot-run  ──► applyRun()    ──► phase = executing
              ├─ /autopilot-off  ──► applyOff()    ──► armed = 0, paused = 1
              ├─ /autopilot-replan ─► applyReplan()
              ├─ /autopilot-resume ─► applyResume()
              └─ 无触发          ──► clearChainPending() + 标记 platform
```

门禁失败与多 track 歧义会作为 `injectMessage` 返回，通过 `agent.inject()` 推回对话。

### 3.2 `tools/post-execute`

永不阻断。工具是写类时，抽取被改路径并武装评审链：

```
工具名 ∈ {write, edit, apply_patch, notebook_edit}
        │
        ▼
从 tool_input 抽路径（file_path / filePath / path / notebook_path）
        │
        ▼
isProductCodeEdit(path)? ── 是 ──► armCodeEdited() ──► code_edited = 1
```

`.autopilotignore` 内的路径、以及被 `.gitignore` 忽略的未跟踪路径，不会武装。

非编辑工具只标记 platform。通过 bash 改文件的场景由 **Stop dirty-arm** 兜底（§4）。

### 3.3 `agent/turn-stopping` —— 核心

```
turn-stopping
    │
    ├─ 有按 agent 的状态？        否 → 返回（什么都不做）
    ├─ steer 已在投递中？         是 → 返回（重入保护）
    ├─ 从 session.header.cwd 解析项目根
    ├─ 项目已启用？               否 → 返回（不创建任何文件）
    │
    ▼
engine.handleStop({ conversationId, status, loopCount })
    │
    ├─ { loop: false }         → 返回；回合正常关闭
    └─ { loop: true, message } → 还有预算？→ agent.steer(message)
                                             → loop 重读收件箱
                                             → 再跑一步
```

---

## 4. 评审链

一旦武装，引擎驱动：

```
fix 轮 ──► confirm 1 ──► 2 ──► 3 ──► 4 ──► 5 ──► 推进 / 完成
```

每轮确认使用**不同视角**，不是把同一份清单读五遍：

| 轮次 | 视角 |
|---:|---|
| 1 | 正确性与不变量 |
| 2 | 空值、边界与错误路径 |
| 3 | 并发、竞态与部分失败 |
| 4 | 安全与信任边界 |
| 5 | 测试缺口与回归（只记录，不在该轮加测试） |

配置 `review.confirm_rounds: 3`（轻量模式）时，视角为 **1 → 2 → 5**。

轮与轮之间，agent 应当真的改代码；某一轮**没有改动**会推进链条，而不是无限重复。

**哪些 stop 路径能续跑：**

| `review.scope` | 续跑条件 |
|---|---|
| `project`（init 默认） | 任意产品代码改动，无需 ON/RUN |
| `executing_only` | 仅当 Autopilot 处于 RUN |

**Stop dirty-arm**（Tier-B）：DSH 没有 `SubagentStop` 等价物，所以当子 agent 或 `run_code` 编辑绕过了 `tools/post-execute` 时，stop 处理器会从 git 检测产品树是否变脏并自行武装评审。

---

## 5. 实现坑（实测换来的）

这些行为只有在真机测试中才会暴露，现在每条都有单测覆盖。

### 5.1 `turn-stopping` 在同一 turn 内多次触发

实测：6 次调用，`payload.turn` 恒为 `1`。**turn 号不能当轮次计数器。** 端口自维护 `loopCount`，跨 step 累积，仅在 `payload.turn` 真的变化时归零。

若用 `payload.turn` 推导轮次，整条评审链会静默塌缩成一轮——而且看起来像是「什么都没发生」，不像报错。

### 5.2 `pending_followup` 是一次性的

引擎在首次投递时消费掉待办指令。为了「预览决策」而调一次 `handleDshTurnStopping` 会把它烧掉，随后真实的钩子就无指令可发。**永远不要试探性调用它。**

### 5.3 自家注入必须可识别

注入消息带结构化来源：

```ts
source: { kind: "plugin", plugin: "autopilot", form: "notice" }
```

DSH 会把 `source` 持久化进 `session.events` 且可回读，所以自注入用结构化 source 识别，而不是匹配文本前缀。文本前缀仅作回退。

**命令是例外**：`/autopilot-enable` 等注入时用 `source.kind: "user"`。命令是**用户意图**；若标记为 `plugin`，`pre-step` 会把它当作 Autopilot 自己的续跑消息跳过，命令就静默失效了。

### 5.4 配置变更必须重建引擎

`StateStore` + `ReviewEngine` 按项目根缓存，而引擎在**构造时**读取 `review.scope`。由于缓存条目首次建立时 `config.yml` 可能还不存在，陈旧引擎会把 `executing_only` 永久固化，评审再也不触发。

因此缓存条目保存 `config.yml` 的**指纹**（`mtime` + `size`），不匹配就丢弃重建。

### 5.5 命令必须返回 `CommandResult`

DSH 的契约是对象，不是字符串：

```ts
type CommandResult =
  | { kind: "success"; text?: string }
  | { kind: "error"; text: string };
```

返回裸字符串会在运行时报 `command "<name>" handler must return a CommandResult`。由 `tests/command-contract.test.ts` 覆盖。

---

## 6. 项目边界

DSH 插件是**全局安装**的，一个宿主进程服务多个项目的会话。`process.cwd()` 是**宿主**目录，与正在编辑的项目无关。

因此端口从**会话自己的工作目录**解析项目：

```ts
// dsh-session SessionHeader
readonly cwd?: string;
```

解析优先级：

1. `session.header.cwd` —— 正确来源
2. `config.projectRoot` —— 显式钉死，供想覆盖的用户使用
3. *(都没有)* —— 端口拒绝动作，而不是猜测

`StateStore` / `ReviewEngine` 按解析出的项目根缓存。同一进程内两个会话、两个不同项目，会得到两套独立的 `.autopilot/` 与互不可见的状态库。

---

## 7. 安装插件时做了什么

### 7.1 安装

```bash
dsh plugin --profile <profile> add dsh-autopilot
```

它只做两件事：

1. 把包装进 `~/.dsh/profiles/<profile>/node_modules/`
2. 让包的 `dsh.bundle.patch` 可用于 profile 组合

`plugin add` 只是转发给 pnpm，**不会**自动追加 bundle 条目。需要手动加：

```json
// ~/.dsh/profiles/<profile>/package.json
"dsh": {
  "profile": {
    "bundles": [..., "dsh-autopilot"]
  }
}
```

验证组合后的配置树包含该条目：

```bash
dsh --profile <profile> --dump-config | grep autopilot-harness
```

**此阶段不创建任何项目文件。** 插件只注册钩子与命令，别的什么都不做。

### 7.2 为什么必须有 `dsh.bundle`

没有它时，`plugin add` 会打印：

```
dsh: warning: dsh-autopilot declares no dsh.bundle
     — installed as a plain dependency, not a profile layer
```

本包声明了：

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

而 `cordis.patch.yml` 承载 loader 条目：

```yaml
- insert:
    - id: autopilot-harness
      name: 'dsh-autopilot/plugin'
      config:
        autoInit: false
        maxSteerPerTurn: 32
```

---

## 8. init 时做了什么

`init` 是按项目进行的初始化步骤。在 DSH 里有两种触发方式：

```
/autopilot-enable                      # 在该项目的会话里执行
npx @autopilot-harness/cli init --platform dsh --yes
```

两者产物完全相同。

### 8.1 产物

```
<项目>/
├── .autopilot/
│   ├── config.yml                  ← 配置（见 8.2）
│   ├── state.db                    ← SQLite：会话、评审链、清单
│   ├── pin.json                    ← 安装版本锚点（升级检测）
│   └── bin/
│       ├── autopilot-harness-hook.mjs
│       └── vendor/
│           ├── runtime.mjs         ← 打平的 core + ports（约 431 KB）
│           └── migrations/001..003.sql
└── docs/autopilot/
    ├── plans/README.md             ← /autopilot-on 的 brief/plan/checklist 落点
    ├── specs/README.md             ← 跨 track 的行为规格
    ├── quickstart.md
    └── workflows/
        ├── autopilot-planning.md
        └── autopilot-executing.md
```

| 产物 | 为什么需要 |
|---|---|
| `config.yml` | 钩子每次触发都读：评审策略、触发词、语言、产物路径 |
| `state.db` | Autopilot 的记忆：会话 phase、评审链（`fix_round` / `confirm_left` / `code_edited` / `pending_followup`）、清单进度 |
| `vendor/runtime.mjs` | 让消费方项目不必在 `node_modules` 里装十几个 `@autopilot-harness/*` 包 |
| `migrations/*.sql` | 状态库 schema，随版本演进 |
| `docs/autopilot/plans/` | 规划产物的落地目录 |

> **DSH 特有说明**：本端口用不到 vendored `runtime.mjs` —— DSH 是进程内直接 import 端口包，不走 shell 钩子。`init` 仍照常写入，以保持项目树与其它宿主一致。

### 8.2 `config.yml` 内容

节选 —— 文件还包含 `cli.preferred_name`、`session.stale_after_hours` 与 `runner.*`。

```yaml
platforms:
  - id: dsh
    surface: cli
integration: hook
locale: zh-CN

artifacts:
  plans_dir: docs/autopilot/plans
  specs_dir: docs/autopilot/specs

concurrency:
  mode: one_executor        # 跨会话同时只有一个执行者
  worktree: false

review:
  scope: project            # 任意产品代码改动即武装评审
  confirm_rounds: 5         # 五个轮换视角
  verify:
    enabled: false
  stuck:
    max_idle_stops: 5
  errors:
    max_before_pause: 0     # 0 = 不因错误暂停
    recover: true           # turn 出错时注入恢复提示

triggers:
  match: line_start
  on:    ["Autopilot ON", "Enable autopilot", "开启自动驾驶"]
  run:   ["Autopilot RUN", "Start execution", "开始执行"]
  off:   ["Autopilot OFF", "Disable autopilot", "关闭自动驾驶"]
  resume: ["Autopilot RESUME", "继续执行"]
  replan: ["Autopilot REPLAN", "修改方案"]

security:
  require_token: false
```

注意：当 `platforms` 里存在可安装的 `kimi-code` 绑定时，`confirm_rounds` 会写为 `1`，因为该宿主硬性把 stop-续跑限制在每轮 ≤1。DSH **不会**造成这种 clamp。

### 8.3 自动初始化（默认关闭）

插件也能自己完成同样的初始化，但**默认关闭**，必须显式开启：

```yaml
config:
  autoInit: true
```

开启后的护栏：

| 护栏 | 行为 |
|---|---|
| 项目锚点 | 优先 git 仓库根；没有 git 时退回 cwd，但要求它看起来像项目（`package.json`、`pyproject.toml`、`Cargo.toml`、`go.mod`、`src`、`lib` …） |
| 危险位置 | 拒绝 `/`、`/tmp`、`/var`、`/usr`、`/etc`、`/home` 与 `$HOME` 本身 |
| 幂等 | 只要 `.autopilot/config.yml` 存在就跳过 |
| fail-open | 任何失败只写日志，宿主正常启动 |
| CLI 解析 | `DSH_AUTOPILOT_CLI_PATH` → `<项目>/node_modules/...` → 端口自身位置及其向上 8 层 |

最后一条在实践中很关键：全局 link 安装时，用户的项目里通常**没有** `@autopilot-harness/cli`，必须从端口包自身位置向上找。

### 8.4 为什么是显式启用而不是自动

早期草稿在首次接触时自动初始化。这对全局插件是错的：它会把 `.autopilot/` 目录、SQLite 库和 vendored runtime 散落到用户从未要求接入的仓库里——包括不想要 Autopilot 的项目，或 `.autopilot/` 会被误提交的项目。

启用信号刻意做得极窄：**`.autopilot/config.yml` 是否存在**。光有 `state.db` 不算，这样误建的目录无法悄悄把项目翻成「已启用」。

关键点：守卫位于 `new StateStore(...)` **之前**，因为该构造函数本身就是一次文件写入（它会创建 `state.db`）。

```
钩子触发
  → 从 session.header.cwd 解析项目根
  → .autopilot/config.yml 存在？
       否 → 返回（根本不构造 StateStore）
       是 → 为该根构建或复用 StateStore + ReviewEngine
```

---

## 9. 命令

| 命令 | 作用 |
|---|---|
| `/autopilot-enable` | 为当前项目执行 init（**唯一**会写磁盘的命令） |
| `/autopilot-on [slug] [简述]` | 进入规划；grill 轮产出 brief/plan/checklist |
| `/autopilot-run` | 按清单逐项执行 |
| `/autopilot-off` | 暂停（`armed = 0`，`paused = 1`） |
| `/autopilot-replan` | 修改方案 |
| `/autopilot-resume` | 恢复执行 |

只有 `/autopilot-enable` 写文件。其余命令把等价的一行文本投回对话，交给 `pre-step` 驱动同一套状态机，因此命令路径与文字输入路径不会分叉。

文字触发词也有效（`Autopilot ON`、`开启自动驾驶` …），按行首匹配。

---

## 10. 端到端时序

```
1. 安装插件                  → 注册钩子，不创建项目文件
2. 打开项目并 /autopilot-enable
                            → 创建 .autopilot/，写入 config
3. /autopilot-on            → phase = planning（armed = 0：规划期不武装评审）
4. agent 改产品代码         → tools/post-execute → code_edited = 1
   或 /autopilot-run        → phase = executing（armed = 1）
5. 回合即将关闭             → turn-stopping → 引擎返回一个视角
                            → agent.steer(...) → 再跑一步
6. 五个确认视角             → 推进清单项（本地 commit，不自动 push）
7. 清单清空                 → track 完成
```

---

## 11. 已知限制

| 限制 | 说明 |
|---|---|
| 没有工作区菜单按钮 | DSH 的 `WorkspaceBrowser` 内部直接渲染行菜单，**没有暴露可注入插槽**。`sidebar.workspaces` 属于 `@deepseek-ai/dsh-client-ui-workspace`；`workspace.add` 只是 i18n 键，不是扩展点。要加「启用 Autopilot」这样的按工作区动作，需要上游提供插槽，或改做客户端设置面板。 |
| `run_code` 编辑 | 代码模式下的编辑不一定经过 `tools/post-execute`；由 git 的 Stop dirty-arm 兜底，而非工具钩子。 |
| GUI 路径未脚本化 | 端口已对真实 `AgentLoop` 与 DSH 真实 `commands.execute()` 验证；浏览器 UI 为手工验证，未做自动化测试。 |
| 完整 `init` 需要 CLI | `init` 的完整文件系统工作（vendor 运行时、迁移、工作流文档）位于 `@autopilot-harness/cli`。没有该 CLI 时，`/autopilot-enable` 退回**最小本地初始化**，只写 `config.yml`、`.autopilotignore` 与 plans/specs 骨架——这对 DSH 已经够用，因为 DSH 从不 spawn shell 钩子。 |

---

## 12. 测试

```bash
pnpm --filter dsh-autopilot run typecheck
npm test   # 在 dsh-autopilot 仓库内
```

| 套件 | 覆盖 |
|---|---|
| `tests/port-dsh.test.ts` | 常量、路径解析、submit/tool/stop 适配器、项目根解析 |
| `tests/auto-init.test.ts` | 锚点解析、危险位置、幂等、fail-open、CLI 解析 |
| `tests/command-contract.test.ts` | 每个命令都返回 `CommandResult` 对象 |

真机验证证据：[`plans/v0.19-dsh/live-artifacts/`](../plans/v0.19-dsh/live-artifacts/README.md)。
