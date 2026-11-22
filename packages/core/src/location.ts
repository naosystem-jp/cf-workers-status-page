/**
 * Where the hub places a monitor's Durable Object, and so where the built-in runner
 * checks from. Values are Durable Object location hints.
 *
 * The Worker verifies at type-check time that this list matches the runtime's
 * `DurableObjectLocationHint`, so core stays free of Cloudflare runtime types.
 */
export const LOCATION_HINTS = [
	"wnam",
	"enam",
	"sam",
	"weur",
	"eeur",
	"apac",
	"apac-ne",
	"apac-se",
	"oc",
	"afr",
	"me",
] as const;

export type LocationHint = (typeof LOCATION_HINTS)[number];
