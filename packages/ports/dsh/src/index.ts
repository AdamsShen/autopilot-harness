/**
 * Autopilot host port for DeepSeek Harness (DSH).
 *
 * DSH is an **in-process plugin host**: there is no `hooks.json` and no shell
 * runtime, so nothing here shells out. The cordis plugin entry (`./plugin`)
 * subscribes to `agent/pre-step`, `tools/post-execute` and
 * `agent/turn-stopping`, then steers the running agent via `agent.steer()`
 * instead of returning a block decision to a Stop hook.
 *
 * This module stays pure — no `@deepseek-ai/*` imports and no fs writes — so it
 * can be unit-tested and vendored exactly like every other port.
 */

/** Host id used in `.autopilot/config.yml` `platforms[].id`. */
export const DSH_PLATFORM = "dsh";
