/**
 * A component's daily history as bars: one bar per day of the page's time zone, by
 * the worst confirmed state of the day, with markers for incidents and maintenance (which
 * never change a bar or the uptime). States differ in shape as well as colour: `up` is a
 * short solid bar, `degraded` a tall striped one, `down` a tall solid one, a day without data a
 * short hollow one, and a day not monitored (yet) a flat line.
 *
 * Phones show the last 30 days, wider screens 90; the uptime, coverage, labels and tooltip are
 * all about the days shown. Each bar has a full description (uptime, coverage, downtime,
 * incidents, maintenance) as its accessible name and as a tooltip on hover, focus or tap. The
 * bars are one tab stop; arrow keys, Home and End move between days.
 */
import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ComponentHistory, HistoryDay, HistoryMarker } from "../../shared/public-api";
import type { Translate } from "../../shared/i18n/core";
import { Icon } from "../components/Icon";
import type { Formatters } from "../i18n/format";
import { useI18n } from "../i18n/I18nProvider";

/** Days shown on narrow screens (phones), and on others. */
export const NARROW_DAYS = 30;
export const WIDE_DAYS = 90;
export const NARROW_QUERY = "(max-width: 600px)";
/** Less observed time than this is not enough for an uptime figure. */
export const MIN_OBSERVED_MS = 24 * 3_600_000;

/** Whether `query` matches, following changes (rotating a phone). `false` without `matchMedia`. */
export function useMediaQuery(query: string): boolean {
	const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
	const [matches, setMatches] = useState(get);
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const list = window.matchMedia(query);
		const onChange = () => setMatches(list.matches);
		onChange();
		list.addEventListener("change", onChange);
		return () => list.removeEventListener("change", onChange);
	}, [query]);
	return matches;
}

export type DayKind = "up" | "degraded" | "down" | "nodata" | "unmonitored" | "notyet" | "pending";

export function dayKind(day: HistoryDay, component: Pick<ComponentHistory, "monitored" | "observedFrom">): DayKind {
	if (!component.monitored) return "unmonitored";
	if (component.observedFrom === null || day.to <= component.observedFrom) return "notyet";
	if (day.pending) return "pending";
	return day.worst ?? "nodata";
}

/** The uptime and coverage of the days shown, from the days' own figures. */
export interface WindowSummary {
	readonly days: readonly HistoryDay[];
	/** Time with a confirmed state in these days. */
	readonly observedMs: number;
	readonly uptime: number | null;
	readonly coverage: number | null;
	/** When monitoring began, if within these days: the figures are "since" then. */
	readonly since: number | null;
}

export function summarizeWindow(component: ComponentHistory, count: number): WindowSummary {
	const days = component.days.slice(-count);
	let observedMs = 0;
	let downMs = 0;
	let expected = 0;
	let obtained = 0;
	for (const day of days) {
		if (day.pending) continue;
		observedMs += day.observedMs ?? 0;
		downMs += day.downtimeMs ?? 0;
		expected += day.checks?.expected ?? 0;
		obtained += day.checks?.obtained ?? 0;
	}
	const from = days[0]?.from ?? 0;
	return {
		days,
		observedMs,
		uptime: observedMs > 0 ? Math.max(0, 1 - downMs / observedMs) : null,
		coverage: expected > 0 ? Math.min(1, obtained / expected) : null,
		since: component.observedFrom !== null && component.observedFrom > from ? component.observedFrom : null,
	};
}

export interface Markers {
	readonly incidents: ReadonlyMap<string, HistoryMarker>;
	readonly maintenance: ReadonlyMap<string, HistoryMarker>;
}

function titles(ids: readonly string[], markers: ReadonlyMap<string, HistoryMarker>): string[] {
	return ids.map((id) => markers.get(id)?.title).filter((title): title is string => title !== undefined);
}

export interface DayLines {
	readonly date: string;
	/** The day's numbers, or why there are none. */
	readonly summary: readonly string[];
	readonly incidents: readonly string[];
	readonly maintenance: readonly string[];
}

/** What a day's tooltip and accessible name say. */
export function describeDay(day: HistoryDay, component: Pick<ComponentHistory, "monitored" | "observedFrom">, markers: Markers, t: Translate, f: Formatters): DayLines {
	const summary: string[] = [];
	const kind = dayKind(day, component);
	if (kind === "unmonitored") summary.push(t("public.day.unmonitored"));
	else if (kind === "notyet") summary.push(t("public.day.notYet"));
	else if (kind === "pending") summary.push(t("public.day.pending"));
	else if (day.uptime === null) summary.push(t("public.day.noData"));
	else {
		summary.push(t("public.day.uptime", { uptime: f.percent(day.uptime) }));
		if (day.downtimeMs !== null && day.downtimeMs > 0) summary.push(t("public.day.downtime", { duration: f.duration(day.downtimeMs) }));
		if (day.worst === "degraded") summary.push(t("public.day.degraded"));
	}
	if (kind !== "unmonitored" && kind !== "notyet" && kind !== "pending" && day.coverage !== null) {
		summary.push(t("public.day.coverage", { coverage: f.percent(day.coverage) }));
	}
	return {
		date: f.day(day.date),
		summary,
		incidents: titles(day.incidents, markers.incidents),
		maintenance: titles(day.maintenance, markers.maintenance),
	};
}

/** The day as one sentence, for screen readers. */
export function dayLabel(lines: DayLines, t: Translate): string {
	const parts = [lines.date, ...lines.summary];
	if (lines.incidents.length > 0) parts.push(t("public.day.incidents", { titles: lines.incidents.join(", ") }));
	if (lines.maintenance.length > 0) parts.push(t("public.day.maintenance", { titles: lines.maintenance.join(", ") }));
	return parts.join(". ");
}

/** The figures under the bars: uptime and coverage of the days shown, or why there are none. */
export function windowText(component: ComponentHistory, summary: WindowSummary, t: Translate, f: Formatters): { main: string; detail: string | null } {
	if (!component.monitored) return { main: t("public.component.notMonitored"), detail: null };
	if (component.observedFrom === null) return { main: t("public.component.notMonitoredYet"), detail: null };
	if (summary.observedMs === 0) return { main: t("public.component.noUptime"), detail: null };
	if (summary.uptime === null || summary.observedMs < MIN_OBSERVED_MS) {
		return { main: t("public.component.notEnoughData", { duration: f.duration(summary.observedMs) }), detail: null };
	}
	const uptime = f.percent(summary.uptime);
	const main =
		summary.since === null
			? t("public.component.uptime", { uptime, period: f.days(summary.days.length) })
			: t("public.component.uptimeSince", { uptime, date: f.date(summary.since) });
	return { main, detail: summary.coverage === null ? null : t("public.component.coverage", { coverage: f.percent(summary.coverage) }) };
}

export interface UptimeBarsProps {
	readonly component: ComponentHistory;
	readonly markers: Markers;
}

export function UptimeBars({ component, markers }: UptimeBarsProps) {
	const narrow = useMediaQuery(NARROW_QUERY);
	// A new window (a phone rotated) starts over at today.
	return <Bars key={narrow ? "narrow" : "wide"} component={component} markers={markers} count={narrow ? NARROW_DAYS : WIDE_DAYS} />;
}

function Bars({ component, markers, count }: UptimeBarsProps & { readonly count: number }) {
	const { t, f } = useI18n();
	const summary = summarizeWindow(component, count);
	const days = summary.days;
	const [active, setActive] = useState(days.length - 1);
	const [shown, setShown] = useState<number | null>(null);
	const group = useRef<HTMLDivElement>(null);
	const descriptions = days.map((day) => describeDay(day, component, markers, t, f));
	const text = windowText(component, summary, t, f);

	function focusDay(index: number) {
		const target = Math.max(0, Math.min(days.length - 1, index));
		(group.current?.children[target] as HTMLElement | undefined)?.focus();
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const moves: Record<string, number> = { ArrowLeft: active - 1, ArrowRight: active + 1, Home: 0, End: days.length - 1 };
		const target = moves[event.key];
		if (target !== undefined) {
			event.preventDefault();
			focusDay(target);
		} else if (event.key === "Escape") {
			setShown(null);
		}
	}

	const tooltip = shown === null ? undefined : descriptions[shown];
	const side = shown === null ? "center" : shown < days.length / 3 ? "start" : shown > (days.length * 2) / 3 ? "end" : "center";

	return (
		<div className="history">
			<div
				ref={group}
				className="bars"
				role="group"
				aria-label={t("public.bars.label", { component: component.name, period: f.days(days.length) })}
				onKeyDown={onKeyDown}
				onMouseLeave={() => setShown(null)}
			>
				{days.map((day, index) => {
					const lines = descriptions[index] as DayLines;
					return (
						<button
							key={day.date}
							type="button"
							className={`bar bar--${dayKind(day, component)}`}
							tabIndex={index === active ? 0 : -1}
							aria-label={dayLabel(lines, t)}
							data-incident={day.incidents.length > 0 || undefined}
							data-maintenance={day.maintenance.length > 0 || undefined}
							onFocus={() => {
								setActive(index);
								setShown(index);
							}}
							onBlur={() => setShown(null)}
							onMouseEnter={() => setShown(index)}
							onClick={() => setShown(index)}
						>
							<span className="bar__fill" />
						</button>
					);
				})}
			</div>
			{tooltip !== undefined && shown !== null && (
				<div
					className={`tooltip tooltip--${side}`}
					style={{ "--at": `${((shown + 0.5) / days.length) * 100}%` } as CSSProperties}
					aria-hidden="true"
				>
					<p className="tooltip__date">{tooltip.date}</p>
					{tooltip.summary.map((line) => (
						<p key={line}>{line}</p>
					))}
					{tooltip.incidents.map((title) => (
						<p key={`i:${title}`} className="tooltip__marker">
							<Icon name="incident" /> {title}
						</p>
					))}
					{tooltip.maintenance.map((title) => (
						<p key={`m:${title}`} className="tooltip__marker">
							<Icon name="maintenance" /> {title}
						</p>
					))}
				</div>
			)}
			<div className="bars__axis">
				<span aria-hidden="true">{f.daysAgo(days.length)}</span>
				<span className="bars__uptime">
					{text.main}
					{text.detail !== null && <span className="muted"> · {text.detail}</span>}
				</span>
				<span aria-hidden="true">{t("public.bars.today")}</span>
			</div>
		</div>
	);
}
