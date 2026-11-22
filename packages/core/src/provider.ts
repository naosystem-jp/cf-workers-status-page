import type { ZodType } from "zod";
import type { SecretsResolved } from "./secret";

/**
 * Something a runner can do on behalf of a provider.
 * Runners declare the capabilities they provide; providers declare the ones they require.
 */
export const CAPABILITIES = ["fetch", "tcp", "icmp"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** States a provider can report. `unknown` is never returned by a provider; it is derived from missing or stale results. */
export type CheckState = "up" | "degraded" | "down";

export interface CheckResult {
	state: CheckState;
	latencyMs?: number;
	message?: string;
	/** Provider-specific data, such as the HTTP status or an external status page's original state. */
	details?: Record<string, unknown>;
}

/**
 * A TCP connection opened through the runner. Modelled on the Sockets API proposal
 * (`connect()` returning readable and writable streams) without depending on a specific runtime.
 * Provisional: no built-in provider uses TCP yet.
 */
export interface TcpSocket {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
	readonly opened: Promise<unknown>;
	readonly closed: Promise<void>;
	close(): Promise<void>;
}

export type TcpConnect = (
	address: { hostname: string; port: number },
	options?: { secureTransport?: "off" | "on" | "starttls" },
) => TcpSocket;

/**
 * What a runner hands to a provider for one check. Built by `runCheck`.
 *
 * Providers must use only what is passed here. In particular they must call
 * `ctx.fetch`, never the global `fetch`: the runner's fetch applies the monitor's
 * timeout and the runner's User-Agent, and other runners may not have a global fetch.
 * This is enforced by lint (`.oxlintrc.json`) and by tests, not at run time.
 */
export interface CheckContext {
	/** Provided by the runner. Requests are aborted with `signal` unless given their own. */
	fetch: typeof fetch;
	/** Present only when the runner provides the `tcp` capability. */
	connect?: TcpConnect;
	/**
	 * Aborted when the monitor's timeout passes or the runner gives up. Once it is aborted
	 * a provider may simply throw: `runCheck` turns a timeout into a `down` result.
	 */
	signal: AbortSignal;
}

/**
 * A kind of check, such as HTTP.
 *
 * `Options` is the validated option type; `Input` is what users write in
 * `status.config.ts` before defaults are applied. The options schema must be an object
 * schema whose keys do not clash with monitor settings (see `defineProvider`).
 */
export interface CheckProvider<Options = unknown, Input = Options> {
	/** Identifier such as `"http"`. */
	readonly type: string;
	/**
	 * Defines and validates the provider's options. Where a value may be secret, accept a
	 * `secret()` reference with `secretOr()`; `check` then receives the secret's value.
	 */
	readonly options: ZodType<Options, Input>;
	/** Capabilities the assigned runner must provide; checked when the configuration is loaded. */
	readonly requires: readonly Capability[];
	/**
	 * Runs one check. `options` has secrets already resolved. Anything returned or thrown
	 * has secret values redacted by `runCheck`, but providers should not echo them anyway.
	 */
	check(options: SecretsResolved<Options>, ctx: CheckContext): Promise<CheckResult>;
}
