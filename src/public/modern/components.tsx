/**
 * The modern template's components: one row per component, groups folded under their name,
 * each with its state, its uptime over the days shown, a bar per day and, when the page
 * publishes them, its response times.
 *
 * A day's bar is green where there was data, with the share of the day spent down (red),
 * degraded (amber) and in maintenance (blue) drawn from its bottom, at least a few pixels when
 * there was any; grey without data. As in the default template, the bars are one tab stop
 * (arrow keys, Home and End move between days), each has a full description as its accessible
 * name, and a tooltip shows the day on hover, focus or tap: its figures, and the incidents,
 * maintenance and outages detected by monitoring, at their times in the page's time zone.
 */
import { type CSSProperties, type KeyboardEvent, useRef, useState } from "react";
import type {
	ComponentGroup,
	ComponentHistory,
	ComponentStatus,
	PageHistoryResponse,
	State,
	Stoppage,
} from "../../../shared/public-api";
import type { Translate } from "../../../shared/i18n/core";
import type { Formatters } from "../../i18n/format";
import { useI18n } from "../../i18n/I18nProvider";
import {
	type DayKind,
	dayKind,
	dayLabel,
	describeDay,
	type Markers,
	MIN_OBSERVED_MS,
	NARROW_DAYS,
	NARROW_QUERY,
	summarizeWindow,
	useMediaQuery,
	WIDE_DAYS,
} from "../UptimeBars";
import { LatencyPanel, type LatencyState } from "./latency";
import { Glyph, StrokeIcon } from "./shell";

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

export type EventKind = "incident" | "maintenance" | "stoppage";

export interface DayEvent {
	readonly kind: EventKind;
	/** Within the day. */
	readonly from: number;
	readonly to: number;
	readonly title: string;
	/** For a group: the components concerned. */
	readonly who: string | null;
}

export type HeadlineTone = "up" | "degraded" | "down" | "maintenance" | "none";

/** What a bar shows and says. */
export interface DayView {
	readonly date: string;
	readonly from: number;
	readonly to: number;
	readonly kind: DayKind;
	/** Shares of the day, from 0 to 1. */
	readonly fractions: { readonly maintenance: number; readonly degraded: number; readonly down: number };
	readonly headline: { readonly text: string; readonly tone: HeadlineTone };
	readonly lines: readonly string[];
	readonly events: readonly DayEvent[];
	/** The accessible name. */
	readonly label: string;
}

const MEASURED: ReadonlySet<DayKind> = new Set(["up", "degraded", "down"]);

function clip(from: number, to: number | null, day: { readonly from: number; readonly to: number }, now: number): [number, number] | null {
	const start = Math.max(from, day.from);
	const end = Math.min(to ?? now, day.to);
	return end > start ? [start, end] : null;
}

function unionLength(ranges: readonly (readonly [number, number])[]): number {
	let total = 0;
	let end = Number.NEGATIVE_INFINITY;
	for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
		if (to <= end) continue;
		total += to - Math.max(from, end);
		end = to;
	}
	return total;
}

/** A component's days, the last `count` of them. */
export function componentDays(
	component: ComponentHistory,
	markers: Markers,
	stoppages: readonly Stoppage[],
	count: number,
	now: number,
	t: Translate,
	f: Formatters,
): DayView[] {
	const own = stoppages.filter((stoppage) => stoppage.componentId === component.id);
	return summarizeWindow(component, count).days.map((day) => {
		const described = describeDay(day, component, markers, t, f);
		const kind = dayKind(day, component);
		const length = day.to - day.from;
		const events: DayEvent[] = [];
		for (const [ids, kindOf, byId] of [
			[day.incidents, "incident", markers.incidents],
			[day.maintenance, "maintenance", markers.maintenance],
		] as const) {
			for (const id of ids) {
				const marker = byId.get(id);
				const within = marker === undefined ? null : clip(marker.from, marker.to, day, now);
				if (marker !== undefined && within !== null) {
					events.push({ kind: kindOf, from: within[0], to: within[1], title: marker.title, who: null });
				}
			}
		}
		for (const stoppage of own) {
			const within = clip(stoppage.from, stoppage.to, day, now);
			if (within !== null) events.push({ kind: "stoppage", from: within[0], to: within[1], title: t("public.modern.event.stoppage"), who: null });
		}
		events.sort((a, b) => a.from - b.from);

		const measured = MEASURED.has(kind);
		const maintenanceMs = unionLength(events.filter((event) => event.kind === "maintenance").map((event) => [event.from, event.to] as const));
		const downMs = measured ? (day.downtimeMs ?? 0) : 0;
		const degradedMs = measured ? (day.degradedMs ?? 0) : 0;
		const parts: { text: string; tone: HeadlineTone }[] = [];
		if (downMs > 0) parts.push({ text: t("public.day.downtime", { duration: f.duration(downMs) }), tone: "down" });
		if (degradedMs > 0) parts.push({ text: t("public.modern.day.degraded", { duration: f.duration(degradedMs) }), tone: "degraded" });
		if (maintenanceMs > 0) parts.push({ text: t("public.modern.day.maintenance", { duration: f.duration(maintenanceMs) }), tone: "maintenance" });
		// An incident without an outage monitoring saw is still not "no issues".
		if (parts.length === 0 && described.incidents.length > 0) {
			parts.push({ text: t("public.day.incidents", { titles: described.incidents.join(", ") }), tone: "degraded" });
		}

		const lines: string[] = [];
		if (!measured) lines.push(...described.summary);
		if (measured && day.uptime !== null) lines.push(t("public.day.uptime", { uptime: f.percent(day.uptime) }));
		if (measured && day.coverage !== null) lines.push(t("public.day.coverage", { coverage: f.percent(day.coverage) }));
		const headline =
			parts.length > 0
				? { text: parts.map((part) => part.text).join(" · "), tone: (parts[0] as { tone: HeadlineTone }).tone }
				: measured
					? { text: t("public.modern.day.noIssues"), tone: "up" as const }
					: { text: lines.shift() ?? "", tone: "none" as const };
		return {
			date: described.date,
			from: day.from,
			to: day.to,
			kind,
			fractions: { maintenance: maintenanceMs / length, degraded: degradedMs / length, down: downMs / length },
			headline,
			lines,
			events,
			label: dayLabel(described, t),
		};
	});
}

/** Which kind a group's bar takes: the worst of its components' (pending only when nothing worse is known). */
const KIND_RANK: Readonly<Record<DayKind, number>> = { down: 6, degraded: 5, pending: 4, up: 3, nodata: 2, notyet: 1, unmonitored: 0 };
const TONE_RANK: Readonly<Record<HeadlineTone, number>> = { down: 4, degraded: 3, maintenance: 2, up: 1, none: 0 };

/** A group's days, from its components' days (the same days, in the same order). */
export function groupDays(members: readonly { readonly name: string; readonly days: readonly DayView[] }[], t: Translate): DayView[] {
	const first = members[0];
	if (first === undefined) return [];
	return first.days.map((base, index) => {
		const views = members.flatMap((member) => {
			const day = member.days[index];
			return day === undefined ? [] : [{ name: member.name, day }];
		});
		const kind = views.reduce<DayKind>((worst, { day }) => (KIND_RANK[day.kind] > KIND_RANK[worst] ? day.kind : worst), "unmonitored");
		const max = (key: keyof DayView["fractions"]) => Math.max(0, ...views.map(({ day }) => day.fractions[key]));
		const issues = views
			.filter(({ day }) => day.headline.tone !== "up" && day.headline.tone !== "none")
			.sort((a, b) => TONE_RANK[b.day.headline.tone] - TONE_RANK[a.day.headline.tone]);
		const measured = views.some(({ day }) => MEASURED.has(day.kind));
		const [worst, ...others] = issues;
		const headline =
			worst !== undefined
				? { text: `${worst.name}: ${worst.day.headline.text}`, tone: worst.day.headline.tone }
				: measured
					? { text: t("public.modern.day.noIssues"), tone: "up" as const }
					: { text: base.headline.text, tone: "none" as const };
		// The same incident or maintenance once, with every component it concerns.
		const events = new Map<string, DayEvent>();
		for (const { name, day } of views) {
			for (const event of day.events) {
				const key = event.kind === "stoppage" ? `${event.kind}:${name}:${event.from}` : `${event.kind}:${event.title}:${event.from}:${event.to}`;
				const known = events.get(key);
				events.set(key, known === undefined ? { ...event, who: name } : { ...known, who: `${known.who}, ${name}` });
			}
		}
		return {
			date: base.date,
			from: base.from,
			to: base.to,
			kind,
			fractions: { maintenance: max("maintenance"), degraded: max("degraded"), down: max("down") },
			headline,
			lines: others.map(({ name, day }) => `${name}: ${day.headline.text}`),
			events: [...events.values()].sort((a, b) => a.from - b.from),
			label: views.map(({ name, day }) => `${name}: ${day.label}`).join(". "),
		};
	});
}

/** Uptime over the days shown, or why there is none. */
interface Figures {
	readonly monitored: boolean;
	readonly observedFrom: number | null;
	readonly observedMs: number;
	readonly downMs: number;
}

function figuresOf(component: ComponentHistory, count: number): Figures {
	const summary = summarizeWindow(component, count);
	return {
		monitored: component.monitored,
		observedFrom: component.observedFrom,
		observedMs: summary.observedMs,
		downMs: summary.uptime === null ? 0 : summary.observedMs * (1 - summary.uptime),
	};
}

function combineFigures(all: readonly Figures[]): Figures {
	const monitored = all.filter((figures) => figures.monitored);
	const starts = monitored.flatMap((figures) => (figures.observedFrom === null ? [] : [figures.observedFrom]));
	return {
		monitored: monitored.length > 0,
		observedFrom: starts.length === 0 ? null : Math.min(...starts),
		observedMs: monitored.reduce((sum, figures) => sum + figures.observedMs, 0),
		downMs: monitored.reduce((sum, figures) => sum + figures.downMs, 0),
	};
}

function uptimeText(figures: Figures, t: Translate, f: Formatters): string | null {
	if (!figures.monitored) return null;
	if (figures.observedMs < MIN_OBSERVED_MS) return null;
	return t("public.modern.uptime", { uptime: f.percent(Math.max(0, 1 - figures.downMs / figures.observedMs)) });
}

/** The uptime over the days shown, or why there is none (in a quieter colour). */
function Uptime({ figures }: { readonly figures: Figures }) {
	const { t, f } = useI18n();
	const text = uptimeText(figures, t, f);
	if (text !== null) return <span className="m-uptime m-num">{text}</span>;
	const why = !figures.monitored
		? t("public.modern.uptime.notMonitored")
		: figures.observedFrom === null
			? t("public.modern.uptime.notYet")
			: figures.observedMs === 0
				? t("public.modern.uptime.noData")
				: t("public.modern.uptime.notEnough");
	return <span className="m-uptime m-uptime--none">{why}</span>;
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

const clocks = new Map<string, Intl.DateTimeFormat>();

/** "14:02" in the page's time zone; the end of the day is "24:00". */
function clockIn(timezone: string, locale: string, at: number, day: { readonly to: number }): string {
	if (at >= day.to) return "24:00";
	const key = `${locale} ${timezone}`;
	let clock = clocks.get(key);
	if (clock === undefined) {
		clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone });
		clocks.set(key, clock);
	}
	return clock.format(at);
}

const EVENT_TONE: Readonly<Record<EventKind, string>> = { incident: "degraded", maintenance: "maintenance", stoppage: "down" };

function DayBars({ days, label, timezone }: { readonly days: readonly DayView[]; readonly label: string; readonly timezone: string }) {
	const { t, f } = useI18n();
	const [active, setActive] = useState(days.length - 1);
	const [shown, setShown] = useState<number | null>(null);
	const group = useRef<HTMLDivElement>(null);

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

	const day = shown === null ? undefined : days[shown];
	const at = shown === null ? 0 : (shown + 0.5) / days.length;
	const side = at < 0.15 ? "start" : at > 0.85 ? "end" : "center";
	return (
		<div className="m-bars-wrap">
			<div ref={group} className="m-bars" role="group" aria-label={label} onKeyDown={onKeyDown} onMouseLeave={() => setShown(null)}>
				{days.map((entry, index) => (
					<button
						key={entry.date}
						type="button"
						className={`m-bar m-bar--${entry.kind}${shown !== null && shown !== index ? " is-dimmed" : ""}`}
						tabIndex={index === active ? 0 : -1}
						aria-label={entry.label}
						onFocus={() => {
							setActive(index);
							setShown(index);
						}}
						onBlur={() => setShown(null)}
						onMouseEnter={() => setShown(index)}
						onClick={() => setShown(index)}
					>
						{(["maintenance", "degraded", "down"] as const).map((key) =>
							entry.fractions[key] > 0 ? (
								<span key={key} className={`m-bar__seg m-bar__seg--${key}`} style={{ height: `max(3px, ${Math.min(100, entry.fractions[key] * 100).toFixed(2)}%)` }} />
							) : null,
						)}
					</button>
				))}
			</div>
			{day !== undefined && (
				<div className={`m-tip m-tip--${side}`} style={{ "--at": `${(at * 100).toFixed(2)}%` } as CSSProperties} aria-hidden="true">
					<p className="m-tip__date">{day.date}</p>
					<p className={`m-tip__headline m-text--${day.headline.tone}`}>{day.headline.text}</p>
					{day.lines.map((line) => (
						<p key={line} className="m-tip__line">
							{line}
						</p>
					))}
					{day.events.length > 0 && (
						<>
							<div className={`m-tip__day${MEASURED.has(day.kind) ? "" : " is-empty"}`}>
								{day.events.map((event) => (
									<span
										key={`${event.kind}:${event.from}:${event.who ?? ""}`}
										className={`m-tip__span m-bg--${EVENT_TONE[event.kind]}`}
										style={{
											left: `${(((event.from - day.from) / (day.to - day.from)) * 100).toFixed(2)}%`,
											width: `max(2px, ${(((event.to - event.from) / (day.to - day.from)) * 100).toFixed(2)}%)`,
										}}
									/>
								))}
							</div>
							<div className="m-tip__scale">
								<span>0:00</span>
								<span>12:00</span>
								<span>24:00</span>
							</div>
							<p className="m-tip__zone">{t("public.modern.day.timeline", { timezone })}</p>
							<ul className="m-tip__events">
								{day.events.map((event) => (
									<li key={`${event.kind}:${event.from}:${event.who ?? ""}`}>
										<span className="m-tip__event-head">
											<span className="m-num">
												{clockIn(timezone, f.locale, event.from, day)}–{clockIn(timezone, f.locale, event.to, day)}
											</span>
											<span className={`m-text--${EVENT_TONE[event.kind]}`}>{t(`public.modern.event.${event.kind}`)}</span>
										</span>
										<span className="m-tip__event-title">
											{event.who !== null && `${event.who}: `}
											{event.kind === "stoppage" ? "" : event.title}
										</span>
									</li>
								))}
							</ul>
						</>
					)}
				</div>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const STATE_RANK: Readonly<Record<State, number>> = { up: 0, unknown: 1, degraded: 2, down: 3 };

function worstState(states: readonly State[]): State {
	return states.reduce<State>((worst, state) => (STATE_RANK[state] > STATE_RANK[worst] ? state : worst), "up");
}

/** The state in words: shown unless it is `up`, which screen readers still hear. */
function StateWords({ state }: { readonly state: State }) {
	const { t } = useI18n();
	return (
		<span className={`m-state m-text--${state}${state === "up" ? " m-visually-hidden" : ""}`}>{t(`public.state.${state}`)}</span>
	);
}

function MaintenancePill() {
	const { t } = useI18n();
	return <span className="m-pill m-pill--maintenance m-pill--small">{t("public.component.maintenance")}</span>;
}

interface HistoryInput {
	readonly history: PageHistoryResponse | undefined;
	readonly failed: boolean;
}

/** The bars, a placeholder while the history loads, or why there are none. */
function HistoryArea({ days, label, input }: { readonly days: readonly DayView[] | null; readonly label: string; readonly input: HistoryInput }) {
	const { t } = useI18n();
	if (days !== null && input.history !== undefined) return <DayBars days={days} label={label} timezone={input.history.timezone} />;
	if (input.history === undefined && !input.failed) return <div className="m-bars m-bars--placeholder" aria-hidden="true" />;
	if (input.history === undefined) return <p className="m-muted m-small">{t("public.components.historyFailed")}</p>;
	return null;
}

interface RowProps {
	readonly component: ComponentStatus;
	readonly days: readonly DayView[] | null;
	readonly figures: Figures | null;
	readonly input: HistoryInput;
	readonly count: number;
	readonly latency: LatencyState;
	readonly latencyOpen: boolean;
	readonly onLatency: () => void;
	readonly nested?: boolean;
}

function ComponentRow({ component, days, figures, input, count, latency, latencyOpen, onLatency, nested }: RowProps) {
	const { t, f } = useI18n();
	const panel = `m-latency-${component.id}`;
	const latest = latency.data?.components.find((entry) => entry.id === component.id);
	return (
		<li className={`m-row${nested ? " m-row--nested" : ""}`}>
			<div className="m-row__head">
				<div className="m-row__title">
					<Glyph tone={component.state} />
					<h3 className="m-row__name">{component.name}</h3>
					<StateWords state={component.state} />
					{component.maintenance && <MaintenancePill />}
				</div>
				<div className="m-row__figures">
					{component.latency && (
						<button
							type="button"
							className="m-latency-toggle m-num"
							aria-expanded={latencyOpen}
							aria-controls={panel}
							aria-label={t("public.modern.latency.toggle", { component: component.name })}
							onClick={onLatency}
						>
							{latest?.latest ? t("public.modern.latency.value", { ms: latest.latest.ms.toLocaleString(f.locale) }) : "— ms"}
							<span className={`m-chevron${latencyOpen ? " is-open" : ""}`}>
								<StrokeIcon name="chevron-down" size={16} />
							</span>
						</button>
					)}
					{figures !== null && <Uptime figures={figures} />}
				</div>
			</div>
			<HistoryArea days={days} label={t("public.bars.label", { component: component.name, period: f.days(count) })} input={input} />
			{component.latency && latencyOpen && <LatencyPanel id={panel} name={component.name} latency={latest} state={latency} />}
		</li>
	);
}

export interface ComponentListProps {
	readonly components: readonly ComponentStatus[];
	readonly groups: readonly ComponentGroup[];
	readonly history: PageHistoryResponse | undefined;
	readonly historyFailed: boolean;
	readonly historyError?: string;
	readonly stoppages: readonly Stoppage[];
	readonly latency: LatencyState;
	/** Whether the states shown are the last known ones (see Overall). */
	readonly stale: boolean;
	readonly now: number;
}

type Entry = { readonly kind: "component"; readonly component: ComponentStatus } | { readonly kind: "group"; readonly group: ComponentGroup; readonly members: readonly ComponentStatus[] };

/** Components in the page's order, a group where its first component is. */
export function entriesOf(components: readonly ComponentStatus[], groups: readonly ComponentGroup[]): Entry[] {
	const groupOf = new Map(groups.flatMap((group) => group.components.map((id) => [id, group] as const)));
	const byId = new Map(components.map((component) => [component.id, component]));
	const placed = new Set<string>();
	const entries: Entry[] = [];
	for (const component of components) {
		const group = groupOf.get(component.id);
		if (group === undefined) {
			entries.push({ kind: "component", component });
		} else if (!placed.has(group.id)) {
			placed.add(group.id);
			const members = group.components.flatMap((id) => {
				const member = byId.get(id);
				return member === undefined ? [] : [member];
			});
			entries.push({ kind: "group", group, members });
		}
	}
	return entries;
}

export function ComponentList({ components, groups, history, historyFailed, historyError, stoppages, latency, stale, now }: ComponentListProps) {
	const { t, f } = useI18n();
	const narrow = useMediaQuery(NARROW_QUERY);
	const count = narrow ? NARROW_DAYS : WIDE_DAYS;
	const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
	// The first component with response times shows them at first; the others on request.
	const [openLatency, setOpenLatency] = useState<ReadonlySet<string>>(() => {
		const first = components.find((component) => component.latency);
		return new Set(first === undefined ? [] : [first.id]);
	});
	if (components.length === 0) return null;

	const toggle = (set: ReadonlySet<string>, id: string) => {
		const next = new Set(set);
		if (!next.delete(id)) next.add(id);
		return next;
	};
	const byId = new Map(history?.components.map((component) => [component.id, component]));
	const markers: Markers = {
		incidents: new Map(history?.incidents.map((marker) => [marker.id, marker])),
		maintenance: new Map(history?.maintenance.map((marker) => [marker.id, marker])),
	};
	const input: HistoryInput = { history, failed: historyFailed };
	const daysOf = (component: ComponentStatus): DayView[] | null => {
		const entry = byId.get(component.id);
		return entry === undefined ? null : componentDays(entry, markers, stoppages, count, now, t, f);
	};
	const figuresOfComponent = (component: ComponentStatus): Figures | null => {
		const entry = byId.get(component.id);
		return entry === undefined ? null : figuresOf(entry, count);
	};
	const row = (component: ComponentStatus, nested = false) => (
		<ComponentRow
			key={component.id}
			component={component}
			days={daysOf(component)}
			figures={figuresOfComponent(component)}
			input={input}
			count={count}
			latency={latency}
			latencyOpen={openLatency.has(component.id)}
			onLatency={() => setOpenLatency(toggle(openLatency, component.id))}
			nested={nested}
		/>
	);

	return (
		<section className="m-components" aria-label={t("public.modern.components.label")}>
			{stale && <p className="m-muted m-small">{t("public.components.stale")}</p>}
			{historyFailed && history !== undefined && (
				<p className="m-muted m-small">{t("public.components.historyStale", { reason: historyError ?? "", time: f.time(history.generatedAt) })}</p>
			)}
			<ul className={`m-rows${stale ? " is-stale" : ""}`}>
				{entriesOf(components, groups).map((entry) => {
					if (entry.kind === "component") return row(entry.component);
					const { group, members } = entry;
					const open = openGroups.has(group.id);
					const state = worstState(members.map((member) => member.state));
					const memberDays = members.flatMap((member) => {
						const days = daysOf(member);
						return days === null ? [] : [{ name: member.name, days }];
					});
					const days = memberDays.length === members.length ? groupDays(memberDays, t) : null;
					const allFigures = members.map(figuresOfComponent);
					const figures = allFigures.every((figure) => figure !== null) ? combineFigures(allFigures as Figures[]) : null;
					const list = `m-group-${group.id}`;
					return (
						<li key={`group:${group.id}`} className="m-row m-row--group">
							<div className="m-row__head">
								<div className="m-row__title">
									<button type="button" className="m-group-toggle" aria-expanded={open} aria-controls={list} onClick={() => setOpenGroups(toggle(openGroups, group.id))}>
										<span className={`m-group-toggle__mark${open ? " is-open" : ""}`}>
											<StrokeIcon name="chevron-right" size={14} />
										</span>
										<h3 className="m-row__name m-row__name--group">{group.name}</h3>
										<span className="m-muted">
											· {members.length === 1 ? t("public.modern.group.one") : t("public.modern.group.count", { count: members.length })}
										</span>
									</button>
									<StateWords state={state} />
									{members.some((member) => member.maintenance) && <MaintenancePill />}
								</div>
								<div className="m-row__figures">{figures !== null && <Uptime figures={figures} />}</div>
							</div>
							<HistoryArea days={days} label={t("public.bars.label", { component: group.name, period: f.days(count) })} input={input} />
							{open && (
								<ul id={list} className="m-rows m-rows--nested">
									{members.map((member) => row(member, true))}
								</ul>
							)}
						</li>
					);
				})}
			</ul>
			<div className="m-axis" aria-hidden="true">
				<span>{f.daysAgo(count)}</span>
				<span>{t("public.bars.today")}</span>
			</div>
			{history !== undefined && <Legend />}
		</section>
	);
}

function Legend() {
	const { t } = useI18n();
	const swatches = [
		["up", t("public.legend.up")],
		["degraded", t("public.legend.degraded")],
		["down", t("public.legend.down")],
		["maintenance", t("public.modern.legend.maintenance")],
		["none", t("public.legend.noData")],
	] as const;
	return (
		<div className="m-legend">
			<ul className="m-legend__items">
				{swatches.map(([kind, label]) => (
					<li key={kind}>
						<span className={`m-legend__swatch m-bg--${kind}`} aria-hidden="true" />
						{label}
					</li>
				))}
			</ul>
		</div>
	);
}
