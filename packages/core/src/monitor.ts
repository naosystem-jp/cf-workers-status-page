import type { Duration } from "./duration";
import type { LocationHint } from "./location";
import type { CheckProvider } from "./provider";

/** How a monitor's state is confirmed from consecutive results. */
export interface ConfirmationSettings {
	/** Consecutive failed checks needed to confirm `down`. Default: 2. */
	failureThreshold?: number;
	/** Consecutive successful checks needed to return to `up`. Default: 1. */
	successThreshold?: number;
	/**
	 * How soon to re-check after a failure, instead of waiting for the next interval.
	 * Default: `"15s"`. Must not be longer than `interval`.
	 */
	recheckInterval?: Duration;
}

/** Settings every monitor has, whatever its provider. */
export interface MonitorSettings {
	/**
	 * Unique, stable identifier: 1–64 characters of lowercase letters, digits, `-` and `_`,
	 * starting with a letter or digit. Changing it starts a new monitor with an empty history.
	 */
	id: string;
	/** Display name. Defaults to `id`. */
	name?: string;
	/** Time between scheduled checks, such as `"1m"`. */
	interval: Duration;
	/**
	 * How long one check may take before it counts as `down`. Default: `"10s"`. Must be shorter
	 * than `interval`, and no longer than the runner allows (5 minutes for the built-in runner).
	 */
	timeout?: Duration;
	/**
	 * Overrides the configuration-wide `location`. A monitor never moves after it is
	 * created, so changing this requires a new `id`.
	 */
	location?: LocationHint;
	confirmation?: ConfirmationSettings;
}

/** Keys of {@link MonitorSettings}. */
export const MONITOR_SETTING_KEYS = [
	"id",
	"name",
	"interval",
	"timeout",
	"location",
	"confirmation",
] as const satisfies readonly (keyof MonitorSettings)[];

/** Keys kept free for monitor settings that may be added later (for example, choosing runners). */
export const RESERVED_MONITOR_KEYS = ["runner", "runners", "enabled", "description", "tags"] as const;

/** Provider option schemas must not use these keys: in `http({ … })` they belong to the monitor. */
export const RESERVED_OPTION_KEYS: ReadonlySet<string> = new Set([
	...MONITOR_SETTING_KEYS,
	...RESERVED_MONITOR_KEYS,
]);

/**
 * One monitor in `status.config.ts`, as returned by a provider's factory such as `http({ … })`.
 * Nothing here is validated yet; `resolveConfig` validates it when the configuration is loaded.
 */
export interface MonitorDefinition {
	readonly provider: CheckProvider;
	/** Monitor settings, plus any reserved keys that were given (rejected by `resolveConfig`). */
	readonly settings: MonitorSettings;
	/** The provider's options as written, before validation and defaults. */
	readonly options: Readonly<Record<string, unknown>>;
}

/**
 * The function users call in `status.config.ts`. It takes the monitor settings and the
 * provider's options in one flat object, e.g. `http({ id, interval, url })`.
 */
export interface MonitorFactory<Options, Input> {
	(input: MonitorSettings & Input): MonitorDefinition;
	readonly provider: CheckProvider<Options, Input>;
}

interface SchemaDef {
	type?: string;
	shape?: Record<string, unknown>;
	in?: SchemaLike;
	innerType?: SchemaLike;
	options?: readonly SchemaLike[];
	left?: SchemaLike;
	right?: SchemaLike;
}
/** A Zod schema, as far as {@link optionKeys} looks into it. */
export interface SchemaLike {
	_zod?: { def?: SchemaDef };
}

/**
 * Top-level keys an options schema accepts, read from Zod's schema definition.
 * `undefined` when the schema is not (a wrapper around) an object schema.
 */
export function optionKeys(schema: SchemaLike | undefined): string[] | undefined {
	const def = schema?._zod?.def;
	switch (def?.type) {
		case "object":
			return Object.keys(def.shape ?? {});
		case "pipe":
			return optionKeys(def.in);
		case "optional":
		case "nonoptional":
		case "default":
		case "prefault":
		case "readonly":
		case "catch":
			return optionKeys(def.innerType);
		case "union": {
			const keys = def.options?.map(optionKeys);
			if (!keys || keys.some((k) => k === undefined)) return undefined;
			return [...new Set(keys.flat() as string[])];
		}
		case "intersection": {
			const left = optionKeys(def.left);
			const right = optionKeys(def.right);
			return left && right ? [...new Set([...left, ...right])] : undefined;
		}
		default:
			return undefined;
	}
}

/**
 * Declares a check provider and returns the monitor factory for it.
 *
 * ```ts
 * export const http = defineProvider({ type: "http", options, requires: ["fetch"], check });
 * // status.config.ts: monitors: [http({ id: "api", interval: "1m", url: "https://…" })]
 * ```
 *
 * @throws TypeError if the options schema is not an object schema, or uses a key that
 *   belongs to monitor settings (see {@link RESERVED_OPTION_KEYS}).
 */
export function defineProvider<Options, Input extends object>(
	provider: CheckProvider<Options, Input>,
): MonitorFactory<Options, Input> {
	const keys = optionKeys(provider.options as SchemaLike);
	if (keys === undefined) {
		throw new TypeError(`Provider "${provider.type}": options must be an object schema`);
	}
	const clashes = keys.filter((key) => RESERVED_OPTION_KEYS.has(key));
	if (clashes.length > 0) {
		throw new TypeError(
			`Provider "${provider.type}": option ${clashes.map((k) => `"${k}"`).join(", ")} ` +
				`clashes with monitor settings; reserved keys are ${[...RESERVED_OPTION_KEYS].join(", ")}`,
		);
	}

	const factory = (input: MonitorSettings & Input): MonitorDefinition => {
		const settings: Record<string, unknown> = {};
		const options: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(input)) {
			(RESERVED_OPTION_KEYS.has(key) ? settings : options)[key] = value;
		}
		return { provider, settings: settings as unknown as MonitorSettings, options };
	};
	return Object.assign(factory, { provider });
}
