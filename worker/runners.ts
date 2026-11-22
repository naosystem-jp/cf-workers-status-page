import type { RunnerDeclaration } from "@naosystem/cf-workers-status-page-core";

/**
 * The built-in runner: `CloudflareRunner` (worker/cloudflare-runner.ts), a
 * `WorkerEntrypoint` in this Worker that Monitor DOs call through `ctx.exports`. Its
 * implementation must provide every capability declared here, because the configuration is
 * validated against this declaration.
 *
 * `maxTimeoutMs` keeps a check, plus the grace periods below, well inside the 15-minute
 * wall-clock limit of the Durable Object alarm that runs it.
 */
export const CLOUDFLARE_RUNNER = {
	id: "cloudflare",
	capabilities: ["fetch"],
	maxTimeoutMs: 5 * 60_000,
} as const satisfies RunnerDeclaration;

/** Runners available to this hub. The first one checks every monitor for now. */
export const RUNNERS: readonly RunnerDeclaration[] = [CLOUDFLARE_RUNNER];

/**
 * Sent with every request the built-in runner makes, unless the monitor sets its own
 * `User-Agent` header. Follows the usual convention for monitoring bots so that firewalls
 * can recognise and allow it.
 */
export const USER_AGENT = "Mozilla/5.0 (compatible; cf-workers-status-page; +https://github.com/naosystem-jp/cf-workers-status-page)";

/**
 * How the timeouts combine, from the inside out:
 *
 * 1. The monitor's `timeout` bounds the check itself. `runCheck` aborts the provider when it
 *    passes and records `down` ("No response within …"): the target was too slow.
 * 2. The runner gives up `RUNNER_GRACE_MS` later, in case something other than the provider
 *    hangs (for example, resolving secrets). That produces no result (an error, not `down`):
 *    the runner, not the target, failed.
 * 3. The Monitor DO stops waiting for the runner `RUNNER_GRACE_MS` after that, in case the
 *    call to the runner itself is lost. That is also recorded as an error without a state.
 *
 * The monitor's timeout is validated against `CLOUDFLARE_RUNNER.maxTimeoutMs` when the
 * configuration loads, so no layer silently shortens it.
 */
export const RUNNER_GRACE_MS = 5_000;
