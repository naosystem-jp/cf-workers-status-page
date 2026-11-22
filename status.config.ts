// Monitors and status pages for this deployment.
// This file is deployed with the Worker and may be in a public repository:
// never put secrets here. Edit the example below to monitor your own services.
// import { cloudflareAccess } from "@naosystem/cf-workers-status-page-auth-cloudflare-access";
import { component, defineConfig } from "@naosystem/cf-workers-status-page-core";
import { discord } from "@naosystem/cf-workers-status-page-notifier-discord";
import { slack } from "@naosystem/cf-workers-status-page-notifier-slack";
import { webhook } from "@naosystem/cf-workers-status-page-notifier-webhook";
import { http } from "@naosystem/cf-workers-status-page-provider-http";

export default defineConfig({
	// Where each day starts for daily uptime. IANA name; default "UTC".
	timezone: "UTC",
	// Default location of monitors, e.g. "apac-ne". Omit to let Cloudflare choose.
	// A monitor cannot move after it is created: changing this needs a new monitor ID.
	// location: "apac-ne",
	// How long to keep check results, e.g. "180d". Omit to keep them forever.
	// retention: "180d",
	// Admin authentication. Without `auth`, the admin UI and admin API reject every request.
	// With Cloudflare Access protecting /admin and /api/admin (see README), uncomment the
	// import above and give your team domain, the application's AUD tag and, recommended, who
	// may administer (none of this is secret):
	// auth: cloudflareAccess({
	// 	teamDomain: "myteam.cloudflareaccess.com",
	// 	aud: "<AUD tag>",
	// 	allowedDomains: ["example.com"],
	// }),
	// Recommended with `auth`: answer admin requests on these host names only (see README).
	// adminHosts: ["status.example.com"], // or "baseUrl"
	// Kinds of notification targets offered in the admin UI. The targets themselves (which
	// channel, which monitors and events) and their secrets are set up there, not here.
	notifiers: [slack(), discord(), webhook()],
	// Language of notifications and automatic incidents: "en" (default) or "ja", or any
	// language with a file in shared/i18n/locales.
	// locale: "ja",
	// This deployment's URL, for links in notifications (the admin UI's incident form).
	// baseUrl: "https://status.example.com",
	// How often to look for monitors whose results stopped arriving, to notify
	// administrators (whole minutes, default "1m"; longer saves Durable Object requests).
	// notifications: { unknownCheckInterval: "1m" },
	// The public API that status pages read (see README, "Caching and cross-origin access").
	// publicApi: {
	// 	cache: "durable-object", // or "workers-cache"
	// 	allowedOrigins: ["https://www.example.com"], // other sites allowed to read it (CORS); or "*"
	// },
	monitors: [
		http({
			id: "example",
			name: "Example",
			url: "https://example.com/",
			interval: "1m",
			// For an endpoint that needs credentials, reference a Worker secret by name
			// (`npx wrangler secret put API_TOKEN`) instead of writing the value here, with
			// `import { secret } from "@naosystem/cf-workers-status-page-core"` at the top:
			// headers: { Authorization: secret("API_TOKEN") },
		}),
	],
	pages: [
		{
			id: "default",
			// How the page looks: "default", or "modern" (a dark header over one card, with groups,
			// response times and a light/dark switch). See README, "Templates".
			// template: "modern",
			// Linked as "Report a problem" in the modern template's header (https, http or mailto).
			// reportUrl: "mailto:support@example.com",
			// `auto: true` publishes an incident when a monitor is confirmed down, and resolves it on
			// recovery unless an administrator edited it. Its texts can be replaced with
			// `templates: { title, investigating, update, partial, resolved, stopped, reopened }`,
			// using {components}, {monitor} and {time}. A component that goes down again within
			// `reopenWithin` (default "30m") of an automatic resolution reopens that incident.
			incidents: { auto: false },
			// component("monitor-id") is a component with one monitor and the same ID;
			// component("monitor-id", { latency: true }) also publishes its response times.
			// Other components need an explicit `id`, e.g.
			// { id: "api", name: "API", monitors: ["example"] }
			// A group folds components under one name (the modern template), e.g.
			// { id: "backend", name: "Backend", components: [component("api"), component("db")] }
			components: [component("example")],
		},
	],
});
