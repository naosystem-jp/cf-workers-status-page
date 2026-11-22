/** `/api/admin/me`, `/api/admin/pages`, page appearance and its images. */
import {
	type AdminMe,
	type AdminPagesResponse,
	type ApiIssue,
	FRAME_LIMITS,
	IMAGE_TYPES,
	LIMITS,
	type PageAppearance,
	pageAppearanceSchema,
} from "../../shared/admin-api";
import { config } from "../config";
import { getAppearance, putAppearance } from "../db/appearance";
import { checkImage, extensionOf, imageExists, removeUnusedImages, storeImage, uploadsBucket } from "../uploads";
import { type AdminContext, findPage, publicPageChanged, publicPageChanging } from "./context";
import { apiError, editConflict, json, notFound, readBody, readCapped, validationFailed } from "./http";

/** The signed-in administrator, as the admin UI shows it. */
export async function me(admin: AdminContext): Promise<Response> {
	return json({ identity: admin.identity, author: admin.actor.kind === "admin" ? admin.actor.name : null } satisfies AdminMe);
}

/** The pages and components of status.config.ts, for the admin UI's forms. */
export async function pages(admin: AdminContext): Promise<Response> {
	return json({
		pages: config.pages.map((page) => ({
			id: page.id,
			template: page.template,
			incidents: page.incidents,
			components: page.components.map((component) => ({
				id: component.id,
				name: component.name,
				monitors: component.monitors,
			})),
			frame: page.frame,
		})),
		uploads: uploadsBucket(admin.env) !== undefined,
	} satisfies AdminPagesResponse);
}

export async function getPageAppearance(admin: AdminContext): Promise<Response> {
	const page = findPage(admin.params["pageId"] ?? "");
	if (page === undefined) return notFound("page");
	return json(await getAppearance(admin.env.DB, page.id));
}

function uploadsUnavailable(): Response {
	return apiError(501, "uploads_unavailable", "Images cannot be uploaded: the Worker has no R2 bucket (UPLOADS binding)");
}

/**
 * Problems with the images an edit names. An image the appearance names now (in either field)
 * is accepted as it is, even without the bucket, so that the other fields can still be saved
 * after the binding was removed. Any other must be in the bucket.
 */
async function imageIssues(
	env: Env,
	current: PageAppearance,
	images: Readonly<Record<"logoImage" | "faviconImage", string | null | undefined>>,
): Promise<ApiIssue[]> {
	const saved = new Set([current.logoImage, current.faviconImage]);
	const named = Object.entries(images).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string" && !saved.has(entry[1]),
	);
	if (named.length === 0) return [];
	const bucket = uploadsBucket(env);
	const found = await Promise.all(named.map(([, id]) => (bucket === undefined ? false : imageExists(bucket, current.pageId, id))));
	return named.flatMap(([field, id], index) =>
		found[index]
			? []
			: [
					bucket === undefined
						? { path: [field], message: "Images cannot be used: the Worker has no R2 bucket", code: "uploads_unavailable" }
						: { path: [field], message: `No uploaded image "${id}"; upload it again`, code: "unknown_image" },
				],
	);
}

export async function putPageAppearance(admin: AdminContext): Promise<Response> {
	const page = findPage(admin.params["pageId"] ?? "");
	if (page === undefined) return notFound("page");
	// Its header and footer may be larger than other requests.
	const body = await readBody(admin.request, pageAppearanceSchema, FRAME_LIMITS.appearanceRequestBytes);
	if (!body.ok) return body.response;
	const { version, ...fields } = body.value;
	// Images are checked against the version the edit replaces; the write below is conditional on it.
	const current = await getAppearance(admin.env.DB, page.id);
	if (current.version !== version) return editConflict(current);
	const issues = await imageIssues(admin.env, current, { logoImage: fields.logoImage, faviconImage: fields.faviconImage });
	if (issues.length > 0) return validationFailed(issues);
	await publicPageChanging(admin, page.id);
	const result = await putAppearance(admin.env.DB, page.id, version, fields, admin.actor);
	if (result.status !== "updated") {
		return result.status === "conflict" ? editConflict(result.current) : notFound("page");
	}
	await publicPageChanged(admin, page.id);
	const bucket = uploadsBucket(admin.env);
	if (bucket !== undefined) admin.ctx.waitUntil(removeUnused(admin.env.DB, bucket, page.id));
	return json(result.value);
}

/**
 * Deletes the page's images that its appearance no longer names (see `removeUnusedImages`).
 * The appearance is read again first, which keeps the images of a save made before then; one
 * made during the deletion is the case worker/uploads.ts describes. Never fails.
 */
async function removeUnused(db: D1Database, bucket: R2Bucket, pageId: string): Promise<void> {
	try {
		const current = await getAppearance(db, pageId);
		const keep = new Set([current.logoImage, current.faviconImage].filter((id) => id !== null));
		await removeUnusedImages(bucket, pageId, keep);
	} catch (error) {
		console.warn(`Could not delete the unused images of page "${pageId}"`, error);
	}
}

/**
 * `POST /api/admin/pages/:pageId/images`: stores the request body, an image of the type its
 * `Content-Type` names, and answers with its ID ({@link UploadedImage}), which the appearance
 * then names. Only image types are accepted, which an HTML form cannot send and a cross-site
 * script cannot send without a CORS preflight, as for JSON bodies (see csrf.ts).
 */
export async function uploadImage(admin: AdminContext): Promise<Response> {
	const page = findPage(admin.params["pageId"] ?? "");
	if (page === undefined) return notFound("page");
	const bucket = uploadsBucket(admin.env);
	if (bucket === undefined) return uploadsUnavailable();
	const declared = extensionOf(admin.request.headers.get("Content-Type"));
	if (declared === null) {
		return apiError(415, "unsupported_media_type", `Send the image as its own Content-Type: one of ${Object.keys(IMAGE_TYPES).join(", ")}`);
	}
	const bytes = await readCapped(admin.request, LIMITS.imageBytes);
	if (bytes === null) {
		return apiError(413, "payload_too_large", `The image must be at most ${LIMITS.imageBytes} bytes`);
	}
	const check = checkImage(bytes, declared);
	if (!check.ok) {
		return apiError(400, "invalid_image", `The file is not a valid image of the declared type (${check.reason})`, { reason: check.reason });
	}
	return json(await storeImage(bucket, page.id, bytes, check.extension), 201);
}
