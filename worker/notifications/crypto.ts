/**
 * Encryption of notification targets' secret options in D1, with AES-256-GCM
 * (WebCrypto) and keys held in a Worker secret.
 *
 * ## The key secret
 *
 * `NOTIFICATION_KEYS` holds one or more keys, separated by commas, each `<id>:<key>`: the ID is
 * 1-32 letters, digits, `-` or `_`, and the key is 32 random bytes in base64. The first key is
 * the current one: it encrypts every value written. The others only decrypt. Create one with
 *
 * ```sh
 * echo "k1:$(openssl rand -base64 32)" | npx wrangler secret put NOTIFICATION_KEYS
 * ```
 *
 * Without the secret (or with a malformed one) secret options can be neither stored nor
 * read: the admin API refuses to save them (503 `encryption_key_missing`), and deliveries to
 * targets with secrets fail until it is set.
 *
 * ## Rotating the key
 *
 * 1. Generate a new key and put it first, keeping the old one after it:
 *    `NOTIFICATION_KEYS=k2:<new>,k1:<old>` (`wrangler secret put` deploys it at once).
 * 2. `POST /api/admin/notifications/re-encrypt`: every target's secrets are decrypted and
 *    encrypted again with `k2` (also done for a target whenever it is saved).
 * 3. Once that reports no `failed` targets, remove the old key: `NOTIFICATION_KEYS=k2:<new>`.
 *
 * Losing every key means entering the targets' secrets again.
 *
 * ## Format
 *
 * A value is stored as `<format>.<key id>.<iv>.<ciphertext>`, with a random 96-bit IV and
 * base64url parts. The key ID says which key decrypts it. The target's ID and the option's name
 * are authenticated as additional data, so a value copied to another target or option does not
 * decrypt. Format `v2` also authenticates the origin of the target's destination (its `url`,
 * see `destinationOption` in @naosystem/cf-workers-status-page-core): a secret header or signing secret then decrypts
 * only while the target still sends to that origin, so no edit can redirect it elsewhere.
 * `v1` values, written before, are bound to no destination; saving the target or
 * `POST /api/admin/notifications/re-encrypt` binds them.
 */

/** The Worker secret with the keys. */
export const KEYS_SECRET = "NOTIFICATION_KEYS";

/** Bound to the target and option only (the destination itself, kinds without one, and values written before v2). */
const FORMAT = "v1";
/** Also bound to the origin of the target's destination. */
const BOUND_FORMAT = "v2";
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** The key secret is not set, or is malformed. The message never contains key material. */
export class EncryptionKeyError extends Error {
	override readonly name = "EncryptionKeyError";
}

/** A stored value cannot be decrypted (unknown key, damaged, or moved to another target or option). */
export class DecryptionError extends Error {
	override readonly name = "DecryptionError";
}

export interface KeyRing {
	readonly currentId: string;
	readonly keys: ReadonlyMap<string, CryptoKey>;
}

function decodeBase64(value: string): Uint8Array {
	const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
	const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Parses the secret's value. @throws EncryptionKeyError naming what is wrong, never the key. */
export async function parseKeyRing(value: unknown): Promise<KeyRing> {
	if (typeof value !== "string" || value.trim() === "") {
		throw new EncryptionKeyError(
			`The ${KEYS_SECRET} secret is not set: set it to encrypt notification targets' secrets (see the README)`,
		);
	}
	const keys = new Map<string, CryptoKey>();
	let currentId: string | undefined;
	for (const [index, entry] of value.split(",").entries()) {
		const separator = entry.indexOf(":");
		const id = entry.slice(0, separator).trim();
		const material = entry.slice(separator + 1).trim();
		if (separator === -1 || !KEY_ID.test(id)) {
			throw new EncryptionKeyError(`${KEYS_SECRET}: entry ${index + 1} must be "<id>:<base64 key>", with an ID of letters, digits, "-" or "_"`);
		}
		if (keys.has(id)) throw new EncryptionKeyError(`${KEYS_SECRET}: key ID "${id}" is listed twice`);
		let bytes: Uint8Array;
		try {
			bytes = decodeBase64(material);
		} catch {
			throw new EncryptionKeyError(`${KEYS_SECRET}: key "${id}" is not base64`);
		}
		if (bytes.length !== KEY_BYTES) {
			throw new EncryptionKeyError(`${KEYS_SECRET}: key "${id}" must be ${KEY_BYTES} bytes (openssl rand -base64 32)`);
		}
		keys.set(id, await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]));
		currentId ??= id;
	}
	if (currentId === undefined) throw new EncryptionKeyError(`${KEYS_SECRET} has no key`);
	return { currentId, keys };
}

let cached: { readonly value: string; readonly ring: Promise<KeyRing> } | undefined;

/** The key ring from `env`, parsed once per value of the secret in this isolate. */
export function keyRing(env: Env): Promise<KeyRing> {
	const value = (env as unknown as Record<string, unknown>)[KEYS_SECRET];
	if (typeof value !== "string") return parseKeyRing(value);
	if (cached?.value !== value) cached = { value, ring: parseKeyRing(value) };
	return cached.ring;
}

/**
 * Additional authenticated data: binds a value to its target and option and, with a
 * `destination` (an origin), to that too.
 *
 * Changing it makes every saved value impossible to decrypt: the targets' secrets would have to
 * be entered again.
 */
function additionalData(targetId: string, option: string, destination: string | undefined): Uint8Array {
	return new TextEncoder().encode(
		destination === undefined
			? `cf-workers-status-page/notification-target/${targetId}/${option}`
			: `cf-workers-status-page/notification-target/v2/${JSON.stringify([targetId, option, destination])}`,
	);
}

/**
 * Encrypts `plaintext` with the current key, bound to `destination` (the origin the target
 * sends to) when one is given.
 */
export async function encryptSecret(
	ring: KeyRing,
	targetId: string,
	option: string,
	plaintext: string,
	destination?: string,
): Promise<string> {
	const key = ring.keys.get(ring.currentId) as CryptoKey;
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: additionalData(targetId, option, destination) },
		key,
		new TextEncoder().encode(plaintext),
	);
	const format = destination === undefined ? FORMAT : BOUND_FORMAT;
	return [format, ring.currentId, encodeBase64Url(iv), encodeBase64Url(new Uint8Array(ciphertext))].join(".");
}

/** The ID of the key that encrypted `stored`, if it is in a known format. */
export function storedKeyId(stored: string): string | undefined {
	const [format, id] = stored.split(".");
	return format === FORMAT || format === BOUND_FORMAT ? id : undefined;
}

/** Whether `stored` is bound to a destination origin (format v2). */
export function isBoundToDestination(stored: string): boolean {
	return stored.startsWith(`${BOUND_FORMAT}.`);
}

/**
 * Decrypts a value made by {@link encryptSecret}. A value bound to a destination decrypts only
 * with that same `destination`. @throws DecryptionError
 */
export async function decryptSecret(
	ring: KeyRing,
	targetId: string,
	option: string,
	stored: string,
	destination?: string,
): Promise<string> {
	const parts = stored.split(".");
	if (parts.length !== 4 || (parts[0] !== FORMAT && parts[0] !== BOUND_FORMAT)) {
		throw new DecryptionError(`The stored value of "${option}" is damaged`);
	}
	const bound = parts[0] === BOUND_FORMAT;
	if (bound && destination === undefined) {
		throw new DecryptionError(`"${option}" is bound to the target's destination, which could not be read`);
	}
	const [, id, iv, ciphertext] = parts as [string, string, string, string];
	const key = ring.keys.get(id);
	if (key === undefined) {
		throw new DecryptionError(`"${option}" was encrypted with key "${id}", which is not in ${KEYS_SECRET}; enter it again`);
	}
	try {
		const plaintext = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: decodeBase64(iv), additionalData: additionalData(targetId, option, bound ? destination : undefined) },
			key,
			decodeBase64(ciphertext),
		);
		return new TextDecoder().decode(plaintext);
	} catch {
		throw new DecryptionError(
			bound
				? `The stored value of "${option}" does not decrypt with key "${id}" for the target's destination; enter it again`
				: `The stored value of "${option}" does not decrypt with key "${id}"`,
		);
	}
}
