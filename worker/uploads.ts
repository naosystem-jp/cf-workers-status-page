/**
 * Images administrators upload for a page: its logo and favicon, in R2
 * (the `UPLOADS` binding).
 *
 * - **Optional.** Without the binding (R2 not enabled on the account, or a deployment from the
 *   package that does not name a bucket) nothing else changes: uploads are refused, and the
 *   page shows its logo URL or its title, never a broken image.
 * - **Never-reused IDs.** An image's ID is random, new for every upload, under its page
 *   (`pages/<pageId>/images/<id>`), so a served image never changes and browsers keep it for a
 *   year (`immutable`): visitors fetch it once, and it costs no D1 read at all. Uploading the
 *   same file again gives another ID rather than the old one: an image whose deletion has been
 *   decided can never be uploaded again under its ID and named by a save meanwhile.
 * - **Upload first, then save.** The admin UI uploads a file as soon as it is chosen and names
 *   it in the appearance when the form is saved, with the appearance's `version` like every
 *   other field. Images that no saved appearance names are deleted a
 *   day after their upload, when the page's appearance is next saved
 *   ({@link removeUnusedImages}), so that an edit left unsaved for a while can still be saved.
 *   What remains: a save that names, through the API, an older image the appearance has just
 *   stopped naming can still lose it, if it lands during that deletion. The admin UI never
 *   does that (it names only images it has just uploaded, or the ones already saved), and
 *   uploading the file again repairs it.
 * - **Raster images only**, checked by their first bytes, and served with `nosniff` and a
 *   sandboxing Content-Security-Policy: an image opened on its own runs nothing.
 */
import {
	IMAGE_CONTENT_TYPES,
	IMAGE_ID,
	IMAGE_TYPES,
	type ImageExtension,
	imagePath,
	LIMITS,
	type UploadedImage,
} from "../shared/admin-api";

export { imagePath };

/** The bucket, or `undefined` when the Worker has none (see the module documentation). */
export function uploadsBucket(env: Env): R2Bucket | undefined {
	return (env as Partial<Pick<Env, "UPLOADS">>).UPLOADS;
}

/** Where a page's images are in the bucket. */
export function imagePrefix(pageId: string): string {
	return `pages/${pageId}/images/`;
}

export function imageKey(pageId: string, imageId: string): string {
	return `${imagePrefix(pageId)}${imageId}`;
}

export function isImageId(value: string): boolean {
	return IMAGE_ID.test(value);
}

/** The extension of an accepted media type (`Content-Type`, parameters ignored), or `null`. */
export function extensionOf(contentType: string | null): ImageExtension | null {
	const type = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
	return Object.hasOwn(IMAGE_TYPES, type) ? IMAGE_TYPES[type as keyof typeof IMAGE_TYPES] : null;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
	return bytes.length >= offset + prefix.length && prefix.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** The format of an image by its first bytes, or `null` when it is none of the accepted ones. */
export function sniffImage(bytes: Uint8Array): ImageExtension | null {
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpg";
	if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "gif";
	if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "webp";
	// An icon (type 1, not a cursor) with at least one image.
	if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00]) && bytes.length >= 6 && (bytes[4] ?? 0) + (bytes[5] ?? 0) > 0) return "ico";
	return null;
}

function hex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A new image ID: 128 random bits. */
export function newImageId(extension: ImageExtension): string {
	return `${hex(crypto.getRandomValues(new Uint8Array(16)))}.${extension}`;
}

export type ImageCheck =
	| { readonly ok: true; readonly extension: ImageExtension }
	| { readonly ok: false; readonly reason: "empty" | "too_large" | "not_an_image" | "type_mismatch" };

/** Whether `bytes` are an image of the declared extension, within the size limit. */
export function checkImage(bytes: Uint8Array, declared: ImageExtension): ImageCheck {
	if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
	if (bytes.byteLength > LIMITS.imageBytes) return { ok: false, reason: "too_large" };
	const actual = sniffImage(bytes);
	if (actual === null) return { ok: false, reason: "not_an_image" };
	if (actual !== declared) return { ok: false, reason: "type_mismatch" };
	return { ok: true, extension: actual };
}

/** Stores an image (checked with {@link checkImage}) for the page, under a new ID. */
export async function storeImage(bucket: R2Bucket, pageId: string, bytes: Uint8Array, extension: ImageExtension): Promise<UploadedImage> {
	const id = newImageId(extension);
	const contentType = IMAGE_CONTENT_TYPES[extension];
	// R2 checks the bytes it stores against their SHA-256.
	const sha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
	await bucket.put(imageKey(pageId, id), bytes, { httpMetadata: { contentType }, sha256 });
	return { id, url: imagePath(pageId, id), contentType, size: bytes.byteLength };
}

export async function imageExists(bucket: R2Bucket, pageId: string, imageId: string): Promise<boolean> {
	return (await bucket.head(imageKey(pageId, imageId))) !== null;
}

/** How long an image no appearance names is kept after its upload: an editor may still be about to save it. */
export const UNUSED_IMAGE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes the page's images that are not in `keep` (what its appearance names now) and were
 * uploaded more than {@link UNUSED_IMAGE_GRACE_MS} ago. Returns the IDs deleted.
 */
export async function removeUnusedImages(bucket: R2Bucket, pageId: string, keep: ReadonlySet<string>, now = Date.now()): Promise<string[]> {
	const prefix = imagePrefix(pageId);
	const unused: string[] = [];
	let cursor: string | undefined;
	do {
		const listed = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
		for (const object of listed.objects) {
			const id = object.key.slice(prefix.length);
			if (!keep.has(id) && object.uploaded.getTime() <= now - UNUSED_IMAGE_GRACE_MS) unused.push(id);
		}
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (cursor !== undefined);
	// At most 1,000 keys per call.
	for (let start = 0; start < unused.length; start += 1000) {
		await bucket.delete(unused.slice(start, start + 1000).map((id) => imageKey(pageId, id)));
	}
	return unused;
}

/** A year: an image's URL names its bytes, so it never changes. */
const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * Headers of every image response: never sniffed, and run as nothing when opened on its own
 * (a raster image runs nothing anyway; this holds should a stored file ever be something else).
 */
const IMAGE_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Content-Security-Policy": "default-src 'none'; sandbox",
	"Cross-Origin-Resource-Policy": "cross-origin",
} as const;

function notFound(): Response {
	return Response.json(
		{ error: "not_found", message: "No such image" },
		{ status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
	);
}

/**
 * `GET /api/pages/:pageId/images/:imageId`: the image from R2, cached for a year, with
 * `ETag` and conditional requests (304). 404 without the bucket or the image.
 */
export async function serveImage(env: Env, pageId: string, imageId: string, request: Request): Promise<Response> {
	const bucket = uploadsBucket(env);
	if (bucket === undefined || !isImageId(imageId)) return notFound();
	const object = await bucket.get(imageKey(pageId, imageId), { onlyIf: request.headers });
	if (object === null) return notFound();
	const extension = imageId.slice(imageId.lastIndexOf(".") + 1) as ImageExtension;
	const headers = new Headers({
		...IMAGE_HEADERS,
		"Content-Type": IMAGE_CONTENT_TYPES[extension],
		"Cache-Control": IMMUTABLE,
		ETag: object.httpEtag,
	});
	// The condition held (If-None-Match matched): R2 returns the object without its body.
	if (!("body" in object)) return new Response(null, { status: 304, headers });
	headers.set("Content-Length", String(object.size));
	if (request.method !== "HEAD") return new Response(object.body, { headers });
	await object.body.cancel();
	return new Response(null, { headers });
}
