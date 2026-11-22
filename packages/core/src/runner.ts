import type { Capability } from "./provider";

/**
 * Declares a runner (the environment that executes checks) and what it can do.
 * Results are stored per monitor × runner, so `id` must be stable.
 */
export interface RunnerDeclaration {
	/** Stable identifier, for example `"cloudflare"` for the built-in runner. */
	readonly id: string;
	readonly capabilities: readonly Capability[];
	/**
	 * The longest monitor `timeout` this runner accepts, in milliseconds. A monitor with a
	 * longer timeout is rejected when the configuration is loaded. Omit for no limit.
	 */
	readonly maxTimeoutMs?: number;
}

/** Returns the capabilities in `required` that `runner` does not provide. */
export function missingCapabilities(
	required: readonly Capability[],
	runner: RunnerDeclaration,
): Capability[] {
	return required.filter((capability) => !runner.capabilities.includes(capability));
}
