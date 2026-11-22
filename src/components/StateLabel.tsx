import type { Impact, IncidentStage, State } from "../../shared/public-api";
import { Icon } from "./Icon";
import { useI18n } from "../i18n/I18nProvider";

/** A component's state as an icon and a word, coloured (never colour alone). */
export function StateLabel({ state }: { readonly state: State }) {
	const { t } = useI18n();
	return (
		<span className={`state state--${state}`}>
			<Icon name={state} />
			<span>{t(`public.state.${state}`)}</span>
		</span>
	);
}

const IMPACT_STATE: Readonly<Record<Impact, State>> = { none: "up", degraded: "degraded", down: "down" };

/** An incident's impact as a badge. */
export function ImpactBadge({ impact }: { readonly impact: Impact }) {
	const { t } = useI18n();
	return <span className={`badge badge--${IMPACT_STATE[impact]}`}>{t(`impact.${impact}`)}</span>;
}

/** An incident's stage as a badge. */
export function StageBadge({ stage }: { readonly stage: IncidentStage }) {
	const { t } = useI18n();
	return <span className={`badge badge--stage badge--${stage}`}>{t(`stage.${stage}`)}</span>;
}

export function MaintenanceBadge() {
	const { t } = useI18n();
	return (
		<span className="badge badge--maintenance">
			<Icon name="maintenance" />
			{t("public.component.maintenance")}
		</span>
	);
}
