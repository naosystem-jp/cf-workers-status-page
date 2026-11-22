import * as z from "zod";

/**
 * A reference to a secret by name, written in `status.config.ts` in place of the secret
 * itself. The runner looks the value up when a check runs; on Cloudflare that is
 * a Worker secret (`wrangler secret put API_TOKEN`).
 *
 * It is plain data so that it survives structured cloning (RPC) and JSON.
 */
export interface SecretRef {
	readonly $secret: string;
}

/** Secret names: letters, digits and `_`, not starting with a digit (like environment variables). */
const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** References a secret by name, e.g. `headers: { Authorization: secret("API_TOKEN") }`. */
export function secret(name: string): SecretRef {
	return Object.freeze({ $secret: name });
}

export function isSecretRef(value: unknown): value is SecretRef {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === 1 &&
		typeof (value as { $secret?: unknown }).$secret === "string"
	);
}

/** Zod schema for a {@link SecretRef}. Providers use it, usually through {@link secretOr}, where a value may be secret. */
export function secretRefSchema(): z.ZodType<SecretRef, SecretRef> {
	return z.strictObject({
		$secret: z
			.string()
			.regex(
				SECRET_NAME_PATTERN,
				'secret name must be letters, digits or "_", not starting with a digit',
			),
	});
}

/** Accepts either a value matching `schema` or a `secret("NAME")` reference. */
export function secretOr<Output, Input>(
	schema: z.ZodType<Output, Input>,
): z.ZodType<Output | SecretRef, Input | SecretRef> {
	return z.union([secretRefSchema(), schema]);
}

/** `T` with every {@link SecretRef} replaced by the secret's value, as providers receive it. */
export type SecretsResolved<T> = T extends SecretRef
	? string
	: T extends readonly (infer Item)[]
		? SecretsResolved<Item>[]
		: T extends object
			? { [K in keyof T]: SecretsResolved<T[K]> }
			: T;

/** Looks a secret up by name. `undefined` (or an empty string) means it is not set. */
export type SecretLookup = (name: string) => string | undefined | Promise<string | undefined>;

/** A referenced secret is not set. The message names the secrets, never their values. */
export class MissingSecretError extends Error {
	override readonly name = "MissingSecretError";
	readonly secrets: readonly string[];

	constructor(secrets: readonly string[]) {
		const list = secrets.map((name) => `"${name}"`).join(", ");
		super(
			secrets.length === 1
				? `Secret ${list} is not set or is empty`
				: `Secrets ${list} are not set or are empty`,
		);
		this.secrets = secrets;
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value) as unknown;
	return prototype === Object.prototype || prototype === null;
}

/** Names of all secrets referenced in `value`, without duplicates. */
export function secretNames(value: unknown): string[] {
	const names = new Set<string>();
	const visit = (node: unknown): void => {
		if (isSecretRef(node)) names.add(node.$secret);
		else if (Array.isArray(node)) node.forEach(visit);
		else if (isPlainObject(node)) Object.values(node).forEach(visit);
	};
	visit(value);
	return [...names];
}

/**
 * Replaces every {@link SecretRef} in `value` with the secret's value.
 * Returns the values too, so that they can be redacted from anything the check produces.
 * @throws MissingSecretError if any referenced secret is not set or is empty.
 */
export async function resolveSecrets<T>(
	value: T,
	lookup: SecretLookup,
): Promise<{ value: SecretsResolved<T>; secrets: string[] }> {
	const found = new Map<string, string>();
	const missing: string[] = [];
	for (const name of secretNames(value)) {
		const secretValue = await lookup(name);
		if (secretValue === undefined || secretValue === "") missing.push(name);
		else found.set(name, secretValue);
	}
	if (missing.length > 0) throw new MissingSecretError(missing);

	const replace = (node: unknown): unknown => {
		if (isSecretRef(node)) return found.get(node.$secret);
		if (Array.isArray(node)) return node.map(replace);
		if (isPlainObject(node)) {
			return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, replace(item)]));
		}
		return node;
	};
	return { value: replace(value) as SecretsResolved<T>, secrets: [...found.values()] };
}

const REDACTED = "[redacted]";

/** Replaces every occurrence of the given secret values in strings within `value`. */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
	// Longest first, so that a secret containing another is redacted whole.
	const values = [...new Set(secrets)].filter((s) => s !== "").sort((a, b) => b.length - a.length);
	if (values.length === 0) return value;
	const redactString = (text: string) =>
		values.reduce((result, secretValue) => result.split(secretValue).join(REDACTED), text);
	const visit = (node: unknown): unknown => {
		if (typeof node === "string") return redactString(node);
		if (Array.isArray(node)) return node.map(visit);
		if (isPlainObject(node)) {
			return Object.fromEntries(Object.entries(node).map(([key, item]) => [key, visit(item)]));
		}
		return node;
	};
	return visit(value) as T;
}
