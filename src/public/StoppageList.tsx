import { useState } from "react";
import type { StoppagesResponse } from "../../shared/public-api";
import { useI18n } from "../i18n/I18nProvider";

/** Stoppages listed before "show all". */
const SHOWN = 10;

export interface StoppageListProps {
	readonly stoppages: StoppagesResponse | undefined;
	/** Component names by ID. */
	readonly names: ReadonlyMap<string, string>;
	readonly failed: boolean;
	readonly now: number;
}

/**
 * Confirmed `down` periods detected by monitoring, listed apart from incidents:
 * what monitoring saw, whether or not anyone wrote an incident about it.
 */
export function StoppageList({ stoppages, names, failed, now }: StoppageListProps) {
	const { t, f } = useI18n();
	const [all, setAll] = useState(false);
	const list = stoppages?.stoppages ?? [];
	const shown = all ? list : list.slice(0, SHOWN);
	return (
		<section className="section" aria-labelledby="stoppages-heading">
			<h2 id="stoppages-heading" className="section__title">
				{t("public.stoppages.heading")}
			</h2>
			<p className="muted">{t("public.stoppages.intro")}</p>
			{stoppages === undefined ? (
				<p className="muted">{failed ? t("public.stoppages.failed") : t("ui.loading")}</p>
			) : list.length === 0 ? (
				<p>{t("public.stoppages.none", { period: f.days(Math.max(1, Math.ceil((now - stoppages.from) / 86_400_000))) })}</p>
			) : (
				<ul className="stoppages">
					{shown.map((stoppage) => (
						<li key={`${stoppage.componentId}:${stoppage.from}`} className={stoppage.to === null ? "stoppage stoppage--ongoing" : "stoppage"}>
							<span className="stoppage__component">{names.get(stoppage.componentId) ?? stoppage.componentId}</span>
							<span className="stoppage__time">
								{stoppage.to === null
									? t("public.stoppages.ongoing", { from: f.dateTimeWithZone(stoppage.from), duration: f.duration(now - stoppage.from) })
									: t("public.stoppages.period", {
											from: f.dateTimeWithZone(stoppage.from),
											duration: f.duration(stoppage.to - stoppage.from),
										})}
							</span>
						</li>
					))}
				</ul>
			)}
			{list.length > SHOWN && (
				<p>
					<button type="button" className="button" aria-expanded={all} onClick={() => setAll(!all)}>
						{all ? t("public.stoppages.fewer") : t("public.stoppages.all", { count: list.length })}
					</button>
				</p>
			)}
			{stoppages?.truncated === true && (all || list.length <= SHOWN) && <p className="muted">{t("public.stoppages.truncated")}</p>}
		</section>
	);
}
