import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { adminUi } from "./vite.admin.ts";
import { pageTemplates } from "./vite.pages.ts";

export default defineConfig({
	plugins: [react(), cloudflare(), adminUi(), pageTemplates()],
});
