# DeepSeek Harness (DSH) Port

How `dsh-autopilot` plugs Autopilot into DeepSeek Harness.

> **Source split:** the plugin lives in its own repository, **`dsh-autopilot`** (sibling of `autopilot-harness`), published as `dsh-autopilot`. This document describes its behaviour; commands like `npm test` run in that repo.

Related: [install.md](./install.md) (per-host matrix) · [hosts.md](./hosts.md) (capability table) · [architecture.md](./architecture.md) (core/port split) · [config.md](./config.md) (config semantics).

[中文](./dsh.zh-CN.md) · [中文实操指南](./dsh-guide.zh-CN.md)

---

## 1. Mental model

Autopilot is a **turn-boundary interceptor**. It relies on one fact about coding agents:

> when the agent finishes editing code, it **stops** and waits for the next human message.

Autopilot inserts its own follow-up at that pause, so work is reviewed before the item is called done.

DSH exposes that pause as `agent/turn-stopping`. Everything in this port is built around intercepting it.

```
        ┌──────────────────────────── DSH host process ────────────────────────────┐
        │  (plugins load globally; one process serves many projects)               │
        │                                                                          │
human ──┼──► agent/pre-step ──────► agent works ──────► agent/turn-stopping       │
        │        │                      │                      │                  │
        │        │                      │                      │                  │
        │        ▼                      ▼                      ▼                  │
        │   Autopilot               Autopilot              Autopilot              │
        │   detects               detects product        decides: keep           │
        │   /autopilot-*          code edit →            going (steer) or        │
        │   command               arms review             close the turn         │
        │                                │                      │                  │
        │                                └──────────────────────┘                  │
        │                                     @autopilot-harness/core              │
        │                                              │                           │
        └──────────────────────────────────────────────┼───────────────────────────┘
                                                       ▼
                                            <project>/.autopilot/state.db
```

Two properties matter:

- **Global plugin, local state.** DSH installs the plugin once for the whole app, but each project keeps its own `.autopilot/`.
- **Opt-in only.** The plugin creates no files until a project is explicitly enabled.

---

## 2. Why DSH's continue mechanism is different

Every other Autopilot port blocks the host's stop event with a decision object:

```js
// Claude Code / Cursor / Codex shape
return { decision: "block", reason: "Review fix round 1 …" };
```

**DSH has no such decision.** `agent/turn-stopping` is a **serial** hook: it returns nothing and cannot veto. Continuation is a *data side effect*. The loop re-reads its inbox after the hook returns:

```js
// dsh-agent-loop/lib/index.js (abridged)
if (turnEnds && this.inbox.nextStep.length === 0) {
    await this.dispatch.serial("agent/turn-stopping", { turn, signal });
    signal.throwIfAborted();
}
if (turnEnds && this.inbox.nextStep.length === 0) break;   // ← re-check after the hook
target = "next-step";
```

`agent.steer(message)` writes to the `next-step` queue:

```js
// dsh AgentLoop
steer(input)    { this.send(input, "next-step", true); }
followup(input) { this.send(input, "next-turn",  true); }
```

So the port's stop result is:

```ts
export interface DshStopResult {
  steerMessage?: string;   // NOT { decision, reason }
}
```

The plugin layer receives `steerMessage` and calls `agent.steer(...)`. That is the entire auto-continue mechanism.

**Use `steer`, not `followup`.** Autopilot's fix → confirm chain happens *inside one turn*; `followup` would open a new turn each round, diverging from every other host's behaviour.

### Consequence: no continuation cap

DSH publishes no `loop_limit` / block-cap equivalent. The port therefore does **not** clamp `review.confirm_rounds` — it behaves like Cursor / Claude Code rather than like the degraded hosts (Kimi ≤1/turn, Copilot ≤8 consecutive, Grok ≤8/turn).

---

## 3. Hooks

The plugin registers five listeners.

| Hook | Mode | Purpose |
|---|---|---|
| `agent/pre-step` | waterfall | Recognise `/autopilot-*`, drive the state machine |
| `tools/post-execute` | waterfall | Arm review when product code changed |
| `agent/turn-stopping` | **serial** | **Core** — inject follow-up or let the turn close |
| `agent/error` | emit | Mark the current turn errored |
| `agent/disposed` | emit | Drop per-agent bookkeeping |

All listeners are wrapped in `try/catch` and **fail open**: an Autopilot bug must never break the host's turn.

### Where the hooks are defined

**In code, not in configuration.** This is the biggest structural difference from every other Autopilot host, and the thing most likely to confuse someone looking for a `hooks.json`.

| Layer | File | Role |
|---|---|---|
| Profile wiring | `~/.dsh/profiles/<profile>/package.json` | lists `dsh-autopilot` under `dsh.profile.bundles` |
| Bundle declaration | `dsh-autopilot/package.json` | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` |
| Loader entry | `dsh-autopilot/cordis.patch.yml` | `- id: autopilot-harness` / `name: 'dsh-autopilot/plugin'` + plugin config |
| **Hook registration** | **`dsh-autopilot/src/plugin.ts`** | **`ctx.on(<event>, handler)` inside `apply(ctx, config)`** |
| Event name types | `dsh-autopilot/src/dsh-events.d.ts` | compile-time declarations only; erased at runtime |

`cordis.patch.yml` contains **no hook declarations** — its only job is to make DSH load the plugin. The event names it mentions appear only in comments. Registration happens at runtime in `plugin.ts` (line numbers are indicative — grep `ctx.on(` if the file has moved):

| Line | Call | Event |
|---:|---|---|
| 295 | `ctx.on("agent/disposed", …)` | agent left the registry |
| 301 | `ctx.on("agent/error", …)` | a step or turn errored |
| 307 | `ctx.on("agent/pre-step", …)` | before each step |
| 357 | `ctx.on("tools/post-execute", …)` | after a tool call settles |
| 384 | `ctx.on("agent/turn-stopping", …)` | **core** — turn about to close |

Commands are registered the same way (`ctx.inject(["commands"], …)` → `commands.register(...)`), in the same file.

#### Why there is no `hooks.json`

The two hosting models are fundamentally different:

```
Traditional hook host (Claude Code, Cursor, Codex …)
  .claude/settings.json
    "hooks": { "Stop": [{ "command": "node .autopilot/bin/… --event Stop" }] }
  → the host spawns a child process per event

DSH (in-process plugin)
  cordis.patch.yml
    name: 'dsh-autopilot/plugin'        ← loads the package
  → plugin.apply(ctx)  →  ctx.on("agent/turn-stopping", fn)
  → the host calls fn(...) in the same process, no subprocess, no JSON protocol
```

DSH dispatches hook events on an in-process event bus (the same shape as `EventEmitter`). Consequences:

- There is no `hooks.json` to merge, and nothing to stamp with `--platform dsh`.
- Ports do not spawn processes, so `vendor/runtime.mjs` is installed by `init` for tree parity but is **unused** by this port.
- Hook behaviour is changed by editing TypeScript and rebuilding — not by editing a JSON settings file.

The event names themselves (`agent/turn-stopping`, `tools/post-execute`, …) are declared by DSH in `@deepseek-ai/dsh-agent` (`runtime-types.d.ts`). The local `dsh-events.d.ts` only mirrors the minimal surface this port subscribes to, so DSH stays an optional peer rather than a hard dependency.

### 3.1 `agent/pre-step`

Runs before each step, and **again for every step inside the same turn** (see §5.1). It:

1. Resets the per-turn steering budget only when `payload.turn` actually changes.
2. Marks the turn's status back to `completed`.
3. For each incoming message that is **not** Autopilot's own injection, calls `handleDshSubmit`:

```
prompt ──► parseTrigger()
              │
              ├─ /autopilot-on  ──► applyOn()      ──► phase = planning
              ├─ /autopilot-run ──► applyRun()     ──► phase = executing
              ├─ /autopilot-off ──► applyOff()     ──► armed = 0, paused = 1
              ├─ /autopilot-replan ─► applyReplan()
              ├─ /autopilot-resume ─► applyResume()
              └─ (no trigger)   ──► clearChainPending(), stamp platform
```

Gate failures and ambiguous track picks are returned as `injectMessage` and pushed back into the conversation via `agent.inject()`.

### 3.2 `tools/post-execute`

Never blocks. When the tool is a write/edit kind, it extracts the touched paths and arms the review chain:

```
tool name ∈ {write, edit, apply_patch, notebook_edit}
        │
        ▼
extract paths from tool_input (file_path / filePath / path / notebook_path)
        │
        ▼
isProductCodeEdit(path)?  ── yes ──► armCodeEdited()  ──► code_edited = 1
```

Paths under `.autopilotignore`, and untracked paths ignored by `.gitignore`, do not arm.

Non-edit tools only stamp the platform. Bash-driven edits are covered by the **Stop dirty-arm** fallback (§4).

### 3.3 `agent/turn-stopping` — the core

```
turn-stopping
    │
    ├─ per-agent state exists?  no → return (do nothing)
    ├─ steer already in flight? yes → return (re-entrancy guard)
    ├─ resolve project root from session.header.cwd
    ├─ project enabled?         no → return (creates nothing)
    │
    ▼
engine.handleStop({ conversationId, status, loopCount })
    │
    ├─ { loop: false }        → return; turn closes normally
    └─ { loop: true, message } → budget left? → agent.steer(message)
                                                → loop re-reads inbox
                                                → another step runs
```

---

## 4. The review chain

Once armed, the engine drives:

```
fix round ──► confirm round 1 ──► 2 ──► 3 ──► 4 ──► 5 ──► advance / done
```

Each confirm round uses a **different lens**, so it is not the same checklist reread five times:

| Round | Lens |
|---:|---|
| 1 | Correctness & invariants |
| 2 | Nulls, boundaries & error paths |
| 3 | Concurrency, races & partial failure |
| 4 | Security & trust boundaries |
| 5 | Test gaps & regression (read-only — record gaps, do not add tests in this round) |

With `review.confirm_rounds: 3` (light mode) the lenses are **1 → 2 → 5**.

Between rounds the agent is expected to actually change code; a round with **no edits** advances the chain rather than repeating forever.

**Which stop paths can continue:**

| `review.scope` | Continues on |
|---|---|
| `project` (init default) | any product-code edit, no ON/RUN required |
| `executing_only` | only while Autopilot is in RUN |

**Stop dirty-arm** (Tier-B): DSH has no `SubagentStop` equivalent, so when a subagent or a `run_code` edit bypasses `tools/post-execute`, the stop handler detects a dirty product tree from git and arms review itself.

---

## 5. Implementation gotchas

These are behaviours that only surfaced under live testing. Each is now covered by a unit test.

### 5.1 `turn-stopping` fires multiple times per turn

Measured: six calls, `payload.turn` constant at `1`. **The turn number cannot be used as a round counter.** The port keeps its own `loopCount`, accumulated across steps and reset only when `payload.turn` actually changes.

Deriving rounds from `payload.turn` silently collapses the entire review chain into a single round — and it looks like a no-op rather than an error.

### 5.2 `pending_followup` is one-shot

The engine consumes the pending instruction on first delivery. Calling `handleDshTurnStopping` "just to preview the decision" burns it, and the real hook then has nothing to send. Never probe it speculatively.

### 5.3 Self-injection must be recognisable

Injected messages carry a structured source:

```ts
source: { kind: "plugin", plugin: "autopilot", form: "notice" }
```

DSH persists `source` into `session.events` and it is readable back, so self-injection is detected structurally rather than by matching a text prefix. Text-prefix matching remains only as a fallback.

**Commands are the exception**: `/autopilot-enable` et al. inject with `source.kind: "user"`. A command is *user intent*; tagging it `plugin` would make `pre-step` skip it as Autopilot's own follow-up, and the command would silently do nothing.

### 5.4 Config changes must rebuild the engine

`StateStore` + `ReviewEngine` are cached per project root, and the engine reads `review.scope` **at construction**. Because `config.yml` may not exist yet when the cache entry is first built, a stale engine would freeze `executing_only` forever and never run review.

The cache entry therefore stores a **fingerprint** of `config.yml` (`mtime` + `size`); a mismatch discards the entry and rebuilds.

### 5.5 Commands must return `CommandResult`

DSH's contract is an object, not a string:

```ts
type CommandResult =
  | { kind: "success"; text?: string }
  | { kind: "error"; text: string };
```

Returning a bare string fails at runtime with `command "<name>" handler must return a CommandResult`. Covered by `tests/command-contract.test.ts`.

---

## 6. Project boundary

DSH installs plugins **globally**, so one host process serves sessions from many projects. `process.cwd()` is the *host* directory and has nothing to do with the project being edited.

The port therefore resolves the project from **the session's own working directory**:

```ts
// dsh-session SessionHeader
readonly cwd?: string;
```

Resolution order:

1. `session.header.cwd` — the correct source
2. `config.projectRoot` — explicit pin, for users who want to override
3. *(nothing)* — the port declines to act rather than guessing

`StateStore` / `ReviewEngine` are cached per resolved root. Two sessions in one process, in two different projects, get two independent `.autopilot/` trees and disjoint state DBs.

---

## 7. What install does

### 7.1 Installing the plugin

```bash
dsh plugin --profile <profile> add dsh-autopilot
```

This only:

1. installs the package into `~/.dsh/profiles/<profile>/node_modules/`
2. makes the package's `dsh.bundle.patch` available for profile composition

`plugin add` forwards to pnpm; it **does not** append the bundle entry. Add it by hand:

```json
// ~/.dsh/profiles/<profile>/package.json
"dsh": {
  "profile": {
    "bundles": [..., "dsh-autopilot"]
  }
}
```

Verify the composed tree contains the entry:

```bash
dsh --profile <profile> --dump-config | grep autopilot-harness
```

**No project files are created at this stage.** The plugin registers its hooks and commands and does nothing else.

### 7.2 Why `dsh.bundle` is required

Without it, `plugin add` prints:

```
dsh: warning: dsh-autopilot declares no dsh.bundle
     — installed as a plain dependency, not a profile layer
```

The package declares:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

and `cordis.patch.yml` holds the loader entry:

```yaml
- insert:
    - id: autopilot-harness
      name: 'dsh-autopilot/plugin'
      config:
        autoInit: false
        maxSteerPerTurn: 32
```

---

## 8. What `init` does

`init` is the per-project setup step. In DSH it is triggered by either:

```
/autopilot-enable                      # inside a session for that project
npx @autopilot-harness/cli init --platform dsh --yes
```

Both produce the same tree.

### 8.1 Artifacts

```
<project>/
├── .autopilot/
│   ├── config.yml                  ← settings (see 8.2)
│   ├── state.db                    ← SQLite: sessions, review chains, checklist
│   ├── pin.json                    ← installed version anchor (upgrade detection)
│   └── bin/
│       ├── autopilot-harness-hook.mjs
│       └── vendor/
│           ├── runtime.mjs         ← bundled core + ports (~431 KB)
│           └── migrations/001..003.sql
└── docs/autopilot/
    ├── plans/README.md             ← where /autopilot-on writes brief/plan/checklist
    ├── specs/README.md             ← cross-track behaviour specs
    ├── quickstart.md
    └── workflows/
        ├── autopilot-planning.md
        └── autopilot-executing.md
```

| Artifact | Why it exists |
|---|---|
| `config.yml` | Read on every hook: review policy, triggers, locale, artifact paths |
| `state.db` | Autopilot's memory: session phase, review chain (`fix_round` / `confirm_left` / `code_edited` / `pending_followup`), checklist progress |
| `vendor/runtime.mjs` | Lets consumer projects avoid installing a dozen `@autopilot-harness/*` packages into `node_modules` |
| `migrations/*.sql` | State schema, versioned across releases |
| `docs/autopilot/plans/` | Landing area for planning artifacts |

> **DSH-specific note:** the vendored `runtime.mjs` is not used by this port — DSH imports the port package in-process instead of spawning a shell hook. `init` still writes it so the project tree stays identical to other hosts.

### 8.2 `config.yml` contents

Abridged — the file also carries `cli.preferred_name`, `session.stale_after_hours`, and the `runner.*` keys.

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
  mode: one_executor        # one executor at a time across sessions
  worktree: false

review:
  scope: project            # any product-code edit arms review
  confirm_rounds: 5         # five rotating lenses
  verify:
    enabled: false
  stuck:
    max_idle_stops: 5
  errors:
    max_before_pause: 0     # 0 = never pause on errors
    recover: true           # inject recover hints on turn errors

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

Note that `confirm_rounds` is written as `1` when an installable `kimi-code` binding is present, because that host hard-caps stop-continue at ≤1 per turn. DSH does **not** cause that clamp.

### 8.3 Auto-init (default off)

The plugin can perform the same initialisation itself. It is **off by default** and must be enabled explicitly:

```yaml
config:
  autoInit: true
```

Guardrails when enabled:

| Guardrail | Behaviour |
|---|---|
| Project anchor | prefers the git repository root; falls back to cwd only when it looks like a project (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `src`, `lib`, …) |
| Unsafe locations | refuses `/`, `/tmp`, `/var`, `/usr`, `/etc`, `/home`, and `$HOME` itself |
| Idempotent | skips whenever `.autopilot/config.yml` already exists |
| Fail-open | every failure is logged and the host boots normally |
| CLI resolution | `DSH_AUTOPILOT_CLI_PATH` → `<project>/node_modules/...` → the port's own location and its ancestors up to 8 levels |

The last one matters in practice: with a globally linked plugin, the user's project usually has **no** `@autopilot-harness/cli`, so resolution has to walk up from the port package itself.

### 8.4 Why opt-in rather than automatic

An earlier draft auto-initialised on first contact. That is wrong for a global plugin: it would scatter `.autopilot/` directories, a SQLite database, and a vendored runtime into repositories the user never asked to instrument — including ones where Autopilot is unwanted or where `.autopilot/` would be committed by accident.

The enable signal is deliberately narrow: **presence of `.autopilot/config.yml`**. A stray `state.db` does not count, so a mis-created directory cannot silently flip a project to “enabled”.

Critically, the guard sits **before** `new StateStore(...)`, because that constructor is itself a filesystem write (it creates `state.db`).

```
hook fires
  → resolve project root from session.header.cwd
  → .autopilot/config.yml present?
       no  → return (no StateStore is constructed)
       yes → build or reuse StateStore + ReviewEngine for that root
```

---

## 9. Commands

| Command | Effect |
|---|---|
| `/autopilot-enable` | Run init for the current project (the **only** command that writes to disk) |
| `/autopilot-on [slug] [brief]` | Enter planning; grill rounds produce brief/plan/checklist |
| `/autopilot-run` | Execute the checklist item by item |
| `/autopilot-off` | Pause (`armed = 0`, `paused = 1`) |
| `/autopilot-replan` | Revise the plan |
| `/autopilot-resume` | Resume execution |

Only `/autopilot-enable` writes files. The rest feed an equivalent line back into the conversation and let `pre-step` drive the single shared state machine, so the command path and the typed-text path cannot diverge.

Text triggers also work without the command surface (`Autopilot ON`, `开启自动驾驶`, …), matched at line start.

---

## 10. End-to-end sequence

```
1. install plugin           → hooks registered, no project files
2. open project, /autopilot-enable
                            → .autopilot/ created, config written
3. /autopilot-on            → phase = planning (armed = 0: planning does not arm review)
4. agent edits product code → tools/post-execute → code_edited = 1
   … or /autopilot-run      → phase = executing (armed = 1)
5. turn about to close      → turn-stopping → engine returns a lens
                            → agent.steer(...) → another step runs
6. five confirm lenses      → advance checklist item (local commit, no auto-push)
7. checklist clear          → track done
```

---

## 11. Known limitations

| Limitation | Detail |
|---|---|
| No workspace-menu button | DSH's `WorkspaceBrowser` renders its row menu internally and exposes **no injectable slot**. `sidebar.workspaces` belongs to `@deepseek-ai/dsh-client-ui-workspace`; `workspace.add` is only an i18n key, not an extension point. Adding a per-workspace “Enable Autopilot” action needs an upstream slot or a client-side settings section instead. |
| `run_code` edits | Code-mode edits do not necessarily traverse `tools/post-execute`; they are covered by the Stop dirty-arm from git rather than by the tool hook. |
| GUI path not scripted | The port is verified against a real `AgentLoop` and against DSH's real `commands.execute()`; the browser UI is exercised manually rather than by automated test. |
| Full `init` needs the CLI | `init`'s complete filesystem work (vendor runtime, migrations, workflow docs) lives in `@autopilot-harness/cli`. Absent that CLI, `/autopilot-enable` falls back to a **minimal local init** that writes only `config.yml`, `.autopilotignore`, and the plans/specs skeleton — enough for DSH, which never spawns shell hooks. |

---

## 12. Testing

```bash
pnpm --filter dsh-autopilot run typecheck
npm test   # in the dsh-autopilot repo
```

| Suite | Covers |
|---|---|
| `tests/port-dsh.test.ts` | constants, path parsing, submit/tool/stop adapters, project-root resolution |
| `tests/auto-init.test.ts` | anchor resolution, unsafe locations, idempotency, fail-open, CLI resolution |
| `tests/command-contract.test.ts` | every command returns a `CommandResult` object |

Live verification evidence: [`plans/v0.19-dsh/live-artifacts/`](../plans/v0.19-dsh/live-artifacts/README.md).
