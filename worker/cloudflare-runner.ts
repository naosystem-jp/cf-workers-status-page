import { WorkerEntrypoint } from "cloudflare:workers";
import { runCheck } from "@naosystem/cf-workers-status-page-core";
import { type CheckOutcome, checkError, normalizeResult } from "./check-result";
import { config, RESERVED_SECRETS } from "./config";
import { CLOUDFLARE_RUNNER, RUNNER_GRACE_MS, USER_AGENT } from "./runners";

export interface RunRequest {
	/** The monitor to check, as configured in the version of the Worker this runner runs. */
	readonly monitorId: string;
}

/** The runner's fetch: the global fetch with the runner's User-Agent applied. */
export function runnerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const request = new Request(input, init);
	if (!request.headers.has("User-Agent")) request.headers.set("User-Agent", USER_AGENT);
	// Looked up at call time, so that tests can replace the global fetch.
	return globalThis.fetch(request);
}

/**
 * The built-in runner: runs checks from the Cloudflare network, inside this
 * Worker. Monitor DOs call it through `this.ctx.exports.CloudflareRunner`, so it needs no
 * binding and is deployed with the hub by one Deploy button.
 *
 * It provides the `fetch` capability declared in `CLOUDFLARE_RUNNER`, applies its
 * User-Agent, resolves `secret()` references from the Worker's secrets (`env`) and runs the
 * check with `runCheck` from core. See `RUNNER_GRACE_MS` for how timeouts combine.
 */
export class CloudflareRunner extends WorkerEntrypoint<Env> {
	async run(request: RunRequest): Promise<CheckOutcome> {
		const monitor = config.monitors.find((candidate) => candidate.id === request.monitorId);
		if (monitor === undefined) {
			return {
				ok: false,
				error: { name: "UnknownMonitorError", message: `Monitor "${request.monitorId}" is not configured` },
			};
		}
		const timeoutMs = Math.min(monitor.timeoutMs, CLOUDFLARE_RUNNER.maxTimeoutMs);
		const env: Readonly<Record<string, unknown>> = this.env as unknown as Record<string, unknown>;
		try {
			const result = await runCheck(
				{ provider: monitor.provider, options: monitor.options, timeoutMs },
				{
					fetch: runnerFetch as typeof fetch,
					signal: AbortSignal.timeout(timeoutMs + RUNNER_GRACE_MS),
					secret: (name) => {
						// Also refused when the configuration is loaded; never handed to a check.
						if (RESERVED_SECRETS.includes(name)) return undefined;
						const value = env[name];
						return typeof value === "string" ? value : undefined;
					},
				},
			);
			return normalizeResult(result);
		} catch (error) {
			return { ok: false, error: checkError(error) };
		}
	}
}
