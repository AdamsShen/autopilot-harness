# DSH 使用指南（中文实操版）

从安装到日常使用的完整操作手册。想了解**原理**请看 [dsh.zh-CN.md](./dsh.zh-CN.md)；本文只讲**怎么做**。

---

## 目录

- [1. 安装（一次性）](#1-安装一次性)
- [2. 启用项目](#2-启用项目)
- [3. 日常使用](#3-日常使用)
- [4. 产物说明](#4-产物说明)
- [5. 配置调整](#5-配置调整)
- [6. 排障](#6-排障)
- [7. 卸载](#7-卸载)

---

## 1. 安装（一次性）

只做一次，装完之后对所有项目生效。

### 1.1 装插件到 DSH profile

```bash
dsh plugin --profile <profile名> add @autopilot-harness/port-dsh
```

> 不确定 profile 名？默认是 `desktop`。可用 `ls ~/.dsh/profiles/` 查看。

### 1.2 把插件加入 bundles（**不能省**）

`plugin add` 只装依赖，不会自动把插件加进 profile 层。手动改：

```bash
# 编辑 ~/.dsh/profiles/<profile名>/package.json
```

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@autopilot-harness/port-dsh"
      ]
    }
  }
}
```

### 1.3 验证

```bash
dsh --profile <profile名> --dump-config | grep autopilot
```

期望看到：

```yaml
- id: autopilot-harness
  name: '@autopilot-harness/port-dsh/plugin'
  config:
    autoInit: false
    maxSteerPerTurn: 32
```

### 1.4 重启 DSH

**完全退出再打开**（不是刷新页面）。Node 模块缓存需要重启才能加载新插件。

### ⚠️ 此时不会创建任何项目文件

安装完插件后，在任意项目里聊天都不会产生 `.autopilot/`。这是刻意设计——必须显式启用。

---

## 2. 启用项目

在哪一个项目里要用 Autopilot，就在**那个项目的会话**里执行。

### 2.1 执行启用命令

```
/autopilot-enable
```

成功时返回：

```
已在 /Users/you/code/my-app 启用 Autopilot。
接下来可以用 /autopilot-on 开始规划。
```

重复执行是安全的，会返回「本项目已启用」。

### 2.2 确认启用成功

```bash
ls -a <项目目录>/.autopilot/
```

应该看到：

```
config.yml   state.db   pin.json   bin/
```

### 2.3 停用某个项目

目前没有 `/autopilot-disable`。停用方式有两种：

```bash
# 方式一：删掉整个目录（推荐，干净）
rm -rf <项目>/.autopilot/ <项目>/docs/autopilot/

# 方式二：只删 config.yml（保留 state.db 里的历史）
rm <项目>/.autopilot/config.yml
```

删掉 `config.yml` 后插件就认为该项目未启用，不再干预。

---

## 3. 日常使用

### 3.1 两种工作模式

**模式 A：随手改代码（默认）**

直接说「帮我改个功能」，改完自动进入自审，5 轮确认后结束。**不需要**任何命令。

配置项 `review.scope: project`（init 默认），任意产品代码改动都会触发。

**模式 B：清单式开发**

适合有明确范围的任务：

```
/autopilot-on 用户登录
                    ↓
      Autopilot 逐轮提问（Q1、Q2...）
      每轮给出建议答案，你只需回答
                    ↓
      产出 docs/autopilot/plans/用户登录/
        ├── brief.md      需求摘要
        ├── plan.md       实现方案
        └── checklist.md  可勾选清单
                    ↓
/autopilot-run
                    ↓
      逐项实现 → 每项自审 → 勾掉 → 下一项
```

### 3.2 命令速查

| 命令 | 什么时候用 |
|---|---|
| `/autopilot-enable` | 新项目第一次用（唯一写磁盘的命令） |
| `/autopilot-on [slug] [简述]` | 开始一个有规划的任务 |
| `/autopilot-run` | 开始执行清单 |
| `/autopilot-off` | 暂停，暂时不想让它干预 |
| `/autopilot-replan` | 方案要改 |
| `/autopilot-resume` | 从暂停恢复 |

> **`/autopilot-on` 的参数规则**（容易踩坑）：
> - 只有一个词且形如 slug（小写、连字符）→ 当作 track 名：`/autopilot-on user-login`
> - 其它情况 → 整个字符串当作需求描述，track 名稍后自动生成：`/autopilot-on 实现手机号登录`
> - 要同时指定两者，用 **`·`（间隔号）** 分隔：`/autopilot-on user-login · 实现手机号+验证码登录`

**文字触发词也可以**（不用斜杠）：

```
Autopilot ON     开启自动驾驶
Autopilot RUN    开始执行
Autopilot OFF    关闭自动驾驶
Autopilot RESUME 继续执行
Autopilot REPLAN 修改方案
```

必须**行首**匹配。

### 3.3 自审是什么

改完产品代码后，Autopilot 会自动驱动 5 轮不同视角的检查：

| 轮次 | 看什么 |
|---:|---|
| 1 | 正确性与不变量 |
| 2 | 空值、边界、错误路径 |
| 3 | 并发、竞态、部分失败 |
| 4 | 安全与信任边界 |
| 5 | 测试缺口（只记录，不加测试） |

每轮之间 agent 会真的去改代码。某轮没有改动就推进到下一轮。

**它会自动本地 commit，但不会自动 push。**

### 3.4 中断与恢复

| 情况 | 怎么办 |
|---|---|
| 中途想停 | `/autopilot-off` |
| 停了想继续 | `/autopilot-resume` |
| 发现方案错了 | `/autopilot-replan` |
| 命令没反应 | 检查项目是否已启用（§2.2） |

---

## 4. 产物说明

启用后项目里会多出这些：

```
<项目>/
├── .autopilot/                     ← 运行时状态（建议加入 .gitignore）
│   ├── config.yml                  配置
│   ├── state.db                    状态库（SQLite）
│   ├── pin.json                    版本锚点
│   └── bin/                        钩子运行时
│
└── docs/autopilot/                 ← 规划产物（建议提交）
    ├── plans/<slug>/
    │   ├── brief.md
    │   ├── plan.md
    │   └── checklist.md            ← 进度权威来源
    ├── specs/                      跨任务行为规格
    ├── quickstart.md
    └── workflows/
```

### 该提交什么

```gitignore
# 建议加入 .gitignore
.autopilot/state.db
.autopilot/bin/
.autopilot/pin.json
```

**建议提交** `docs/autopilot/`，因为 brief/plan/checklist 是团队共享的规划资产。

`init` 会自动生成 `.autopilotignore`，把 `docs/autopilot/**` 排除在「产品代码」判定之外，所以编辑规划文档不会触发自审。

---

## 5. 配置调整

改 `.autopilot/config.yml`，**下一步操作时生效**（插件按文件指纹自动重建引擎，无需重启 DSH）。

### 5.1 常用配置

```yaml
review:
  scope: project            # project=任意改动都自审；executing_only=仅 RUN 期间
  confirm_rounds: 5         # 确认轮数：5=完整，3=轻量（视角1→2→5）
  verify:
    enabled: false          # 是否跑测试命令
    # commands:
    #   - id: test
    #     run: "pnpm test"
    #     required: true
  stuck:
    max_idle_stops: 5       # 连续空转多少次算卡住
  errors:
    max_before_pause: 0     # 连续出错多少次暂停；0=永不暂停
    recover: true           # 出错时是否注入恢复提示

concurrency:
  mode: one_executor        # 同时只允许一个执行者
```

### 5.2 性能敏感场景

如果觉得自审太啰嗦：

```yaml
review:
  confirm_rounds: 3         # 从 5 降到 3
```

如果只在做清单任务时才想自审：

```yaml
review:
  scope: executing_only
```

### 5.3 插件级配置

改 `~/.dsh/profiles/<profile>/package.json` 里插件的 `config`：

```json
{
  "name": "@autopilot-harness/port-dsh/plugin",
  "config": {
    "autoInit": false,
    "maxSteerPerTurn": 32,
    "projectRoot": ""
  }
}
```

| 配置项 | 默认 | 说明 |
|---|---|---|
| `autoInit` | `false` | 是否自动初始化。**保持 false**，用 `/autopilot-enable` 更可控 |
| `maxSteerPerTurn` | `32` | 单回合最大续跑次数，防死循环 |
| `projectRoot` | 空 | 留空=按会话目录自动判定。**一般不要填** |

---

## 6. 排障

### 6.1 命令不存在

**现象**：敲 `/autopilot-enable` 没出现补全，或提示未知命令。

**排查**：

```bash
# 1. 插件装了吗
ls ~/.dsh/profiles/<profile>/node_modules/@autopilot-harness/

# 2. 在 bundles 里吗
python3 -c "import json;print(json.load(open('$HOME/.dsh/profiles/<profile>/package.json'))['dsh']['profile']['bundles'])"

# 3. 能加载吗
cd ~/.dsh/profiles/<profile> && node -e "import('@autopilot-harness/port-dsh/plugin').then(m=>console.log(m.name))"
```

前两项都正常的话，**重启 DSH**。

> **常见困惑**：DSH 插件**没有 `hooks.json`**。钩子是在代码里用 `ctx.on(...)` 注册的，配置文件只负责加载插件。详见 [DSH 端口原理 §3](./dsh.zh-CN.md#3-钩子)。

### 6.2 `handler must return a CommandResult`

这是旧版本的 bug（已修）。如果还出现，说明 profile 里是旧代码：

```bash
cd <@autopilot-harness/port-dsh 仓库> && npm run build
# 然后重启 DSH
```

### 6.3 `autopilot CLI not resolvable from this profile`

**原因**：找不到 `@autopilot-harness/cli` 包，无法执行 init。

**解法**：在项目里装一次 CLI：

```bash
cd <项目>
npm i -D @autopilot-harness/cli
```

或者手动跑 init 代替 `/autopilot-enable`：

```bash
npx @autopilot-harness/cli init --platform dsh --yes
```

### 6.4 改了代码但没触发自审

**按顺序检查**：

```bash
# 1. 项目启用了吗
ls <项目>/.autopilot/config.yml

# 2. review.scope 是什么
grep -A2 "^review:" <项目>/.autopilot/config.yml

# 3. 改的文件被排除了吗
cat <项目>/.autopilotignore
git check-ignore <你改的文件>       # 被 gitignore 忽略的文件不算产品代码
```

`review.scope: executing_only` 时，**只有** RUN 期间才自审。

### 6.5 自审停不下来

```yaml
review:
  confirm_rounds: 3        # 减少轮数
  stuck:
    max_idle_stops: 3      # 更早判定卡住
```

或者临时 `/autopilot-off`。

### 6.6 看当前状态

```bash
cd <项目>
npx @autopilot-harness/cli status
```

会显示各会话的 phase、评审链进度、清单完成情况。

---

## 7. 卸载

### 7.1 从单个项目移除

```bash
rm -rf <项目>/.autopilot/ <项目>/docs/autopilot/
```

### 7.2 从 DSH 彻底卸载

```bash
# 1. 从 bundles 移除（编辑 package.json）
# 2. 卸依赖
dsh plugin --profile <profile> remove @autopilot-harness/port-dsh
# 3. 重启 DSH
```

### 7.3 清理已启用项目的残留

卸载插件**不会**自动清理各项目里的 `.autopilot/`（插件无从知道有哪些项目）。需要逐个删除：

```bash
# 找出所有启用过的项目
find ~/code -maxdepth 3 -name ".autopilot" -type d 2>/dev/null
```

---

## 附：一分钟快速开始

```bash
# ① 装（一次性）
dsh plugin --profile desktop add @autopilot-harness/port-dsh
# 手动把 @autopilot-harness/port-dsh 加进 package.json 的 dsh.profile.bundles
# 重启 DSH

# ② 启用（每个项目一次）
# 在该项目会话里执行：
/autopilot-enable

# ③ 用
/autopilot-on 我的任务 一句话描述需求
# 回答几轮提问后
/autopilot-run
```

**判断是否正常工作的最快方法**：改一个源文件，然后什么都不说。如果几秒后 agent 开始自审，说明一切正常。
