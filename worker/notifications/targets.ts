/**
 * A target's options: split into plain and secret ones, the secret ones encrypted for storage
 * and decrypted for sending. Secret values never leave the Worker: the admin API returns
 * only whether each one is set ({@link publicTarget}).
 */
import { destinationOptionOf, isPublicHostname, type NotifierKind } from "@naosystem/cf-workers-status-page-core";
import type { NotificationTarget } from "../../shared/admin-api";
import type { TargetRecord } from "../db/notifications";
import { DecryptionError, decryptSecret, encryptSecret, isBoundToDestination, type KeyRing, keyRing, storedKeyId } from "./crypto";

/** The secret options of a kind; for a kind no longer registered, those the target has. */
function secretKeys(target: Pick<TargetRecord, "secrets">, kind: NotifierKind | undefined): string[] {
	return kind === undefined ? Object.keys(target.secrets) : [...kind.secretOptions];
}

/** The target as the admin API shows it: secret values replaced by whether they are set. */
export function publicTarget(target: TargetRecord, kind: NotifierKind | undefined): NotificationTarget {
	const { secrets, ...rest } = target;
	return {
		...rest,
		secrets: Object.fromEntries(secretKeys(target, kind).map((key) => [key, Object.hasOwn(secrets, key)])),
	};
}

/**
 * The option that says where `target` sends (`destinationOption` in @naosystem/cf-workers-status-page-core): its
 * kind's, or `url` for a kind no longer registered that has one.
 */
export function destinationOption(
	target: Pick<TargetRecord, "options" | "secrets">,
	kind: NotifierKind | undefined,
): string | undefined {
	if (kind !== undefined) return destinationOptionOf(kind);
	return Object.hasOwn(target.secrets, "url") || Object.hasOwn(target.options, "url") ? "url" : undefined;
}

/** The origin of a destination URL, or `undefined` when `value` is not one. */
export function destinationOrigin(value: unknown): string | undefined {
	if (typeof value !== "string" || !URL.canParse(value)) return undefined;
	const { origin } = new URL(value);
	return origin === "null" ? undefined : origin;
}

/**
 * Why `options[destination]` may not be sent to, or `null`: it must name a public host, not an
 * IP address or an internal name, whatever the kind's own schema says.
 */
export function destinationProblem(kind: NotifierKind, options: Readonly<Record<string, unknown>>): string | null {
	const option = destinationOptionOf(kind);
	const value = option === undefined ? undefined : options[option];
	if (typeof value !== "string" || !URL.canParse(value)) return null;
	return isPublicHostname(new URL(value).hostname)
		? null
		: "must name a public host: IP addresses and internal names such as localhost or *.internal are not allowed";
}

/**
 * Splits validated `options` into plain ones and encrypted secret ones, for target `targetId`.
 * Secret options other than the destination are bound to the destination's origin.
 */
export async function splitOptions(
	env: Env,
	targetId: string,
	kind: NotifierKind,
	options: Readonly<Record<string, unknown>>,
): Promise<{ options: Record<string, unknown>; secrets: Record<string, string> }> {
	const plain: Record<string, unknown> = {};
	const secret: [string, unknown][] = [];
	for (const [key, value] of Object.entries(options)) {
		if (value === undefined) continue;
		if (kind.secretOptions.includes(key)) secret.push([key, value]);
		else plain[key] = value;
	}
	if (secret.length === 0) return { options: plain, secrets: {} };
	// Throws EncryptionKeyError without the key: secrets are never stored in plain text.
	const ring = await keyRing(env);
	const destination = destinationOptionOf(kind);
	const origin = destination === undefined ? undefined : destinationOrigin(options[destination]);
	const secrets: Record<string, string> = {};
	for (const [key, value] of secret) {
		secrets[key] = await encryptSecret(ring, targetId, key, JSON.stringify(value), key === destination ? undefined : origin);
	}
	return { options: plain, secrets };
}

export interface ReadSecrets {
	/** The target's options, with every secret that could be decrypted. */
	readonly options: Record<string, unknown>;
	/** Secrets that could not be decrypted (their key is gone, or they belong to another destination), by option. */
	readonly errors: ReadonlyMap<string, DecryptionError>;
}

/**
 * Decrypts the target's secrets with `ring`: the destination first, then the others for its
 * origin. Never throws a {@link DecryptionError}; see `errors`.
 */
export async function readSecrets(
	ring: KeyRing,
	target: Pick<TargetRecord, "id" | "options" | "secrets">,
	kind: NotifierKind | undefined,
): Promise<ReadSecrets> {
	const options: Record<string, unknown> = { ...target.options };
	const errors = new Map<string, DecryptionError>();
	const destination = destinationOption(target, kind);
	const keys = Object.keys(target.secrets).sort((a, b) => Number(b === destination) - Number(a === destination));
	let origin = destination === undefined ? undefined : destinationOrigin(options[destination]);
	for (const key of keys) {
		try {
			options[key] = await decryptOption(ring, target.id, key, target.secrets[key] as string, key === destination ? undefined : origin);
			if (key === destination) origin = destinationOrigin(options[key]);
		} catch (error) {
			if (!(error instanceof DecryptionError)) throw error;
			errors.set(key, error);
		}
	}
	return { options, errors };
}

/**
 * The target's options with its secrets decrypted, as entered. Needs the key only when the
 * target has secrets. @throws EncryptionKeyError, DecryptionError
 */
export async function decryptOptions(
	env: Env,
	target: Pick<TargetRecord, "id" | "options" | "secrets">,
	kind: NotifierKind | undefined,
): Promise<Record<string, unknown>> {
	if (Object.keys(target.secrets).length === 0) return { ...target.options };
	const { options, errors } = await readSecrets(await keyRing(env), target, kind);
	const [first] = errors.values();
	if (first !== undefined) throw first;
	return options;
}

/**
 * Whether the target's secrets are all encrypted with the current key and, but for the
 * destination itself, bound to the destination (what `re-encrypt` brings them to).
 */
export function secretsUpToDate(ring: KeyRing, target: Pick<TargetRecord, "options" | "secrets">, kind: NotifierKind | undefined): boolean {
	const destination = destinationOption(target, kind);
	return Object.entries(target.secrets).every(
		([key, stored]) =>
			storedKeyId(stored) === ring.currentId && (destination === undefined || key === destination || isBoundToDestination(stored)),
	);
}

/** One secret option's value. @throws DecryptionError, whose message never contains the value. */
export async function decryptOption(
	ring: KeyRing,
	targetId: string,
	option: string,
	stored: string,
	destination?: string,
): Promise<unknown> {
	const plaintext = await decryptSecret(ring, targetId, option, stored, destination);
	try {
		return JSON.parse(plaintext) as unknown;
	} catch {
		// A JSON error would quote the value.
		throw new DecryptionError(`The stored value of "${option}" is damaged`);
	}
}

/** Shortest fragment of a secret URL redacted on its own (a token in a path or query). */
const MIN_FRAGMENT = 8;

/**
 * The strings to redact from errors: every string in the secret options and, for URLs, their
 * path segments and query values, which a service's error message might echo.
 */
export function secretValues(target: Pick<TargetRecord, "secrets">, options: Readonly<Record<string, unknown>>): string[] {
	const values: string[] = [];
	const visit = (value: unknown): void => {
		if (typeof value === "string") {
			values.push(value);
			if (URL.canParse(value)) {
				const url = new URL(value);
				for (const part of [...url.pathname.split("/"), ...url.searchParams.values()]) {
					if (part.length >= MIN_FRAGMENT) values.push(part);
				}
			}
		} else if (Array.isArray(value)) value.forEach(visit);
		else if (typeof value === "object" && value !== null) Object.values(value).forEach(visit);
	};
	for (const key of Object.keys(target.secrets)) visit(options[key]);
	return values;
}
