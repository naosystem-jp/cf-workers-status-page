import type { State } from "../../shared/public-api";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/I18nProvider";
import type { Freshness } from "../lib/freshness";

export interface OverallBannerProps {
	readonly overall: State;
	readonly hasComponents: boolean;
	readonly maintenance: boolean;
	readonly freshness: Freshness;
	/** When the shown status was computed. */
	readonly generatedAt: number;
	readonly now: number;
}

/**
 * The page's overall state. When the status could not be refreshed for a while, it says that
 * the state is the last known one and how old it is, in a neutral colour: an old "all
 * systems operational" must never look current.
 */
export function OverallBanner({ overall, hasComponents, maintenance, freshness, generatedAt, now }: OverallBannerProps) {
	const { t, f } = useI18n();
	const stale = freshness.kind === "stale";
	const headline = hasComponents ? t(`public.overall.${overall}`) : t("public.overall.empty");
	return (
		<section className={`banner banner--${stale ? "stale" : overall}`} aria-labelledby="overall-heading">
			<Icon name={stale ? "warning" : overall} className="banner__icon" />
			<div>
				<h2 id="overall-heading" className="banner__title">
					{stale ? t("public.overall.stale") : headline}
				</h2>
				{stale ? (
					<p className="banner__detail">
						{t("public.overall.staleDetail", { state: headline, time: f.relative(generatedAt, now) })}
					</p>
				) : overall === "unknown" && hasComponents ? (
					<p className="banner__detail">{t("public.overall.unknownDetail")}</p>
				) : null}
				{maintenance && !stale && <p className="banner__detail">{t("public.overall.maintenance")}</p>}
			</div>
		</section>
	);
}
