import { statusPage } from "@naosystem/cf-workers-status-page/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [statusPage()],
});
