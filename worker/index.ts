import { handleAdminApi, isAdminApiPath, isAdminUiPath, serveAdminUi } from "./admin";
import { handleNotificationBatch } from "./notifications/consumer";
import { runCron } from "./notifications/cron";
import { handlePublicApi, isPublicApiPath } from "./public";
import { RequestReconciler } from "./reconciler";

export { CloudflareRunner } from "./cloudflare-runner";
export { Monitor } from "./monitor";
export { PublicApi } from "./public";
export { Reconciler } from "./reconciler";
export { StatusPage } from "./status-page";

const requestReconciler = new RequestReconciler();

/** For the health check and errors: browsers and proxies must not keep them. (Workers Cache is off for this entrypoint.) */
const NO_STORE = { "Cache-Control": "no-store" } as const;

export default {
	async fetch(request, env, ctx): Promise<Response> {
		// Starts new Monitor DOs after a deploy, in the background.
		requestReconciler.trigger(env, ctx);

		const url = new URL(request.url);

		// Admin API and admin UI: administrators only.
		if (isAdminApiPath(url.pathname)) return handleAdminApi(request, env, ctx);
		if (isAdminUiPath(url.pathname)) return serveAdminUi(request, env, ctx);

		// Public API: through the cached `PublicApi` entrypoint.
		if (isPublicApiPath(url.pathname)) return handlePublicApi(request, env, ctx);

		if (request.method === "GET" && url.pathname === "/api/health") {
			return Response.json({ ok: true }, { headers: NO_STORE });
		}

		if (url.pathname.startsWith("/api/")) {
			return Response.json({ error: "not_found", message: "No such resource" }, { status: 404, headers: NO_STORE });
		}

		// Only paths in `run_worker_first` reach the Worker (see `assets` in wrangler.jsonc).
		return new Response("Not Found", { status: 404, headers: NO_STORE });
	},

	// Runs every minute (`triggers.crons` in wrangler.jsonc): starts and stops Monitor DOs after
	// a deploy, and periodically re-checks that every monitor is running; notifies
	// `unknown` monitors and the `down` that maintenance held back.
	async scheduled(controller, env) {
		const { report } = await runCron(env, controller.scheduledTime);
		if (report.reconcile.status === "incomplete") {
			console.warn(`Reconciliation incomplete: ${report.reconcile.failures.length} of ${report.reconcile.synced} monitors`);
		}
	},

	// Consumer of the notification queue and of its dead letter queue.
	async queue(batch, env, ctx) {
		await handleNotificationBatch(batch, env, ctx);
	},
} satisfies ExportedHandler<Env>;
