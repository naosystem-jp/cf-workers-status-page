import * as z from "zod";
import { LIMITS } from "../../shared/admin-api";
import { decodeCursor } from "../db/common";

/**
 * Query parameters of list endpoints: `?page=<page ID>&limit=<1-100>&cursor=<nextCursor>`.
 * `page` is required (lists are per page, and walk a per-page index); it may be a page no
 * longer in status.config.ts. Other parameters are ignored.
 */
export const listQuerySchema = z.object({
	page: z.string({ error: "Required: the ID of the page" }).min(1).max(64),
	limit: z.coerce.number().int().min(1).max(LIMITS.pageSize).default(50),
	cursor: z
		.string()
		.transform((value, ctx) => {
			const cursor = decodeCursor(value);
			if (cursor === undefined) {
				ctx.addIssue({ code: "custom", message: "Not a cursor from a previous page" });
				return z.NEVER;
			}
			return cursor;
		})
		.optional(),
});
