import type { PublicMaintenance } from "../../shared/public-api";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/I18nProvider";

function MaintenanceItem({ maintenance, active }: { readonly maintenance: PublicMaintenance; readonly active: boolean }) {
	const { t, f } = useI18n();
	const window = { from: f.dateTimeWithZone(maintenance.startsAt), to: f.dateTimeWithZone(maintenance.endsAt) };
	return (
		<article className="maintenance" aria-labelledby={`maintenance-${maintenance.id}`}>
			<h3 id={`maintenance-${maintenance.id}`} className="maintenance__title">
				<Icon name="maintenance" />
				{maintenance.title}
			</h3>
			<p className="maintenance__window">
				{active ? t("public.maintenance.until", { to: window.to }) : t("public.maintenance.window", window)}
			</p>
			{maintenance.components.length > 0 && (
				<p className="muted">
					{t("public.maintenance.components", { components: f.list(maintenance.components.map((component) => component.name)) })}
				</p>
			)}
			{maintenance.body !== "" && <p className="maintenance__body">{maintenance.body}</p>}
		</article>
	);
}

export function MaintenanceSection({ items, active }: { readonly items: readonly PublicMaintenance[]; readonly active: boolean }) {
	const { t } = useI18n();
	if (items.length === 0) return null;
	const id = active ? "maintenance-active" : "maintenance-upcoming";
	return (
		<section className="section" aria-labelledby={id}>
			<h2 id={id} className="section__title">
				{active ? t("public.maintenance.activeHeading") : t("public.maintenance.upcomingHeading")}
			</h2>
			{items.map((maintenance) => (
				<MaintenanceItem key={maintenance.id} maintenance={maintenance} active={active} />
			))}
		</section>
	);
}
