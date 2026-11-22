/**
 * Just enough JSON Web Token handling for Cloudflare Access application tokens: RS256
 * signatures (RSASSA-PKCS1-v1_5 with SHA-256) over WebCrypto, keys from a JWKS document.
 * Standard web APIs only, so the package runs on any runtime.
 */

/** The only algorithm Access signs application tokens with. Pinned: the token's `alg` must match. */
export const ALGORITHM = "RS256";
const IMPORT_PARAMS = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export class TokenError extends Error {
	override readonly name = "TokenError";
}

export interface DecodedToken {
	readonly header: Readonly<Record<string, unknown>>;
	readonly payload: Readonly<Record<string, unknown>>;
	/** `base64url(header) "." base64url(payload)`: the bytes the signature covers. */
	readonly signingInput: string;
	readonly signature: Uint8Array<ArrayBuffer>;
}

function base64UrlDecode(part: string): Uint8Array<ArrayBuffer> {
	if (!BASE64URL.test(part) || part.length % 4 === 1) throw new TokenError("malformed base64url");
	const base64 = part.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (part.length % 4)) % 4);
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function decodeJsonObject(part: string, what: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(base64UrlDecode(part)));
	} catch {
		throw new TokenError(`malformed ${what}`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TokenError(`malformed ${what}`);
	}
	return value as Record<string, unknown>;
}

/** Splits and decodes a compact JWS. Checks the format only, not the signature or claims. */
export function decodeToken(token: string): DecodedToken {
	const parts = token.split(".");
	if (parts.length !== 3) throw new TokenError("not a compact JWT");
	const [header, payload, signature] = parts as [string, string, string];
	if (header === "" || payload === "" || signature === "") throw new TokenError("not a compact JWT");
	return {
		header: decodeJsonObject(header, "header"),
		payload: decodeJsonObject(payload, "payload"),
		signingInput: `${header}.${payload}`,
		signature: base64UrlDecode(signature),
	};
}

/** Verifies the token's RS256 signature with `key`. */
export function verifySignature(token: DecodedToken, key: CryptoKey): Promise<boolean> {
	return crypto.subtle.verify(
		IMPORT_PARAMS.name,
		key,
		token.signature,
		new TextEncoder().encode(token.signingInput),
	);
}

/** Signing keys by key ID. */
export type KeyMap = ReadonlyMap<string, CryptoKey>;

/**
 * Imports the RSA signing keys of a JWKS document (`{ keys: [...] }`). Keys that are not
 * RSA, declare another algorithm or use, or fail to import are skipped.
 * @throws TokenError when the document has no usable key.
 */
export async function importKeySet(document: unknown): Promise<KeyMap> {
	const entries =
		typeof document === "object" && document !== null && Array.isArray((document as { keys?: unknown }).keys)
			? ((document as { keys: unknown[] }).keys)
			: [];
	const keys = new Map<string, CryptoKey>();
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const jwk = entry as Record<string, unknown>;
		const { kid, kty, alg, use, n, e } = jwk;
		if (typeof kid !== "string" || kid === "" || kty !== "RSA") continue;
		if (alg !== undefined && alg !== ALGORITHM) continue;
		if (use !== undefined && use !== "sig") continue;
		if (typeof n !== "string" || typeof e !== "string") continue;
		try {
			const key = await crypto.subtle.importKey(
				"jwk",
				{ kty: "RSA", n, e, alg: ALGORITHM, ext: true },
				IMPORT_PARAMS,
				false,
				["verify"],
			);
			keys.set(kid, key);
		} catch {
			// Not a valid RSA public key: skip it.
		}
	}
	if (keys.size === 0) throw new TokenError("the key set has no usable RS256 key");
	return keys;
}
