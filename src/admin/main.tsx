import { boot } from "../i18n/boot";
import "../index.css";
import { AdminApp } from "./AdminApp";
import { CrashPanel } from "./layout";
import { ADMIN_CATALOG } from "./messages";
import "./admin.css";

void boot("admin-root", <AdminApp />, {
	catalog: ADMIN_CATALOG,
	fallback: (error, _crashes, retry) => <CrashPanel error={error} retry={retry} />,
});
