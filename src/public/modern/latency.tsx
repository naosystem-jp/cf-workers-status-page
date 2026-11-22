/**
 * A component's response times (`components[].latency` in status.config.ts): the latest, the
 * average and the 95th percentile over the last 24 hours, 7 days or 30 days, and a line of the
 * average of each bucket. Gaps in the line are buckets without any response.
 */
import { useState } from "react";
import type { ComponentLatency, LatencySeries, PageLatencyResponse } from "../../../shared/public-api";
import { useI18n } from "../../i18n/I18nProvider";
import { describeError } from "../FreshnessNotice";

export interface LatencyState {
	readonly data: PageLatencyResponse | undefined;
	readonly error: unknown;
}

export type LatencyRange = "day" | "week" | "month";

const RANGES: readonly LatencyRange[] = ["day", "week", "month"];

/** Where the time axis is labelled: how long ago, and in which unit. Phones show only the `major` ones. */
const TICKS: Readonly<Record<LatencyRange, { readonly unit: "hour" | "day"; readonly ago: readonly number[]; readonly major: readonly number[] }>> = {
	day: { unit: "hour", ago: [24, 18, 12, 6, 0], major: [24, 12, 0] },
	week: { unit: "day", ago: [6, 4, 2, 0], major: [6, 0] },
	month: { unit: "day", ago: [30, 20, 10, 0], major: [30, 0] },
};

const WIDTH = 1000;
const HEIGHT = 200;

/** A round top for the axis, above the highest value: 1, 2, 2.5 or 5 times a power of ten. */
export function niceMax(value: number): number {
	const target = Math.max(1, value * 1.15);
	const step = 10 ** Math.floor(Math.log10(target));
	for (const multiple of [1, 2, 2.5, 5]) if (multiple * step >= target) return multiple * step;
	return 10 * step;
}

/** The line (and the area under it) of the buckets with a value, split where there is none. */
export function chartPaths(values: readonly (number | null)[], top: number): { readonly line: string; readonly area: string } {
	const x = (index: number) => (values.length <= 1 ? WIDTH : (index / (values.length - 1)) * WIDTH);
	const y = (value: number) => HEIGHT - (Math.min(value, top) / top) * HEIGHT;
	const runs: [number, number][][] = [];
	let run: [number, number][] = [];
	values.forEach((value, index) => {
		if (value === null) {
			if (run.length > 0) runs.push(run);
			run = [];
		} else {
			run.push([x(index), y(value)]);
		}
	});
	if (run.length > 0) runs.push(run);
	const point = ([px, py]: [number, number]) => `${px.toFixed(1)},${py.toFixed(1)}`;
	// A lone value is a dot: a line of no length with round ends.
	const line = runs.map((points) => `M${points.map(point).join(" L")}${points.length === 1 ? " h0.01" : ""}`).join(" ");
	const area = runs
		.filter((points) => points.length > 1)
		.map((points) => {
			const first = points[0] as [number, number];
			const last = points.at(-1) as [number, number];
			return `M${points.map(point).join(" L")} L${last[0].toFixed(1)},${HEIGHT} L${first[0].toFixed(1)},${HEIGHT} Z`;
		})
		.join(" ");
	return { line, area };
}

export function LatencyPanel({
	id,
	name,
	latency,
	state,
}: {
	readonly id: string;
	readonly name: string;
	/** `undefined` until loaded (or when the component has none). */
	readonly latency: ComponentLatency | undefined;
	readonly state: LatencyState;
}) {
	const { t, f } = useI18n();
	const [range, setRange] = useState<LatencyRange>("day");
	if (latency === undefined) {
		return (
			<div id={id} className="m-latency">
				<p className="m-muted m-small">
					{state.error !== null && state.data === undefined
						? t("public.modern.latency.failed", { reason: describeError(state.error, t) })
						: t("public.modern.latency.loading")}
				</p>
			</div>
		);
	}
	const series: LatencySeries = latency[range];
	const ms = (value: number | null) => (value === null ? "—" : value.toLocaleString(f.locale));
	const present = series.values.filter((value): value is number => value !== null);
	const top = niceMax(Math.max(0, ...present));
	const { line, area } = chartPaths(series.values, top);
	const span = Math.max(1, (series.values.length - 1) * series.bucketMs);
	const relative = new Intl.RelativeTimeFormat(f.locale, { numeric: "always" });
	const unitMs = TICKS[range].unit === "hour" ? 3_600_000 : 86_400_000;
	const ticks = TICKS[range].ago.map((ago) => {
		const at = Math.max(0, Math.min(1, 1 - (ago * unitMs) / span));
		return {
			text: ago === 0 ? t("public.modern.latency.now") : relative.format(-ago, TICKS[range].unit),
			left: `${(at * 100).toFixed(3)}%`,
			shift: at <= 0 ? "start" : at >= 1 ? "end" : "middle",
			minor: !TICKS[range].major.includes(ago),
		};
	});
	return (
		<div id={id} className="m-latency">
			<div className="m-latency__head">
				<dl className="m-latency__stats">
					{(
						[
							["latest", latency.latest?.ms ?? null],
							["average", series.averageMs],
							["p95", series.p95Ms],
						] as const
					).map(([key, value]) => (
						<div key={key}>
							<dt>{t(`public.modern.latency.${key}`)}</dt>
							<dd className="m-num">
								{ms(value)}
								<span className="m-latency__unit">ms</span>
							</dd>
						</div>
					))}
				</dl>
				<div className="m-segmented" role="group" aria-label={t("public.modern.latency.period")}>
					{RANGES.map((option) => (
						<button key={option} type="button" className="m-segmented__option" aria-pressed={range === option} onClick={() => setRange(option)}>
							{t(`public.modern.latency.${option}`)}
						</button>
					))}
				</div>
			</div>
			{present.length === 0 ? (
				<p className="m-muted m-small">{t("public.modern.latency.none")}</p>
			) : (
				<div className="m-chart">
					<div className="m-chart__y m-num" aria-hidden="true">
						<span style={{ top: "0%" }}>{t("public.modern.latency.value", { ms: ms(top) })}</span>
						<span style={{ top: "50%" }}>{t("public.modern.latency.value", { ms: ms(top / 2) })}</span>
						<span style={{ top: "100%" }}>{t("public.modern.latency.value", { ms: "0" })}</span>
					</div>
					<svg
						className="m-chart__plot"
						viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
						preserveAspectRatio="none"
						role="img"
						aria-label={t("public.modern.latency.chart", {
							component: name,
							period: t(`public.modern.latency.${range}`),
							average: t("public.modern.latency.value", { ms: ms(series.averageMs) }),
							p95: t("public.modern.latency.value", { ms: ms(series.p95Ms) }),
						})}
					>
						<line x1="0" y1="0" x2={WIDTH} y2="0" className="m-chart__grid" />
						<line x1="0" y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} className="m-chart__grid" />
						<line x1="0" y1={HEIGHT} x2={WIDTH} y2={HEIGHT} className="m-chart__base" />
						<path d={area} className="m-chart__area" />
						<path d={line} className="m-chart__line" />
					</svg>
					<div className="m-chart__x" aria-hidden="true">
						{ticks.map((tick) => (
							<span
								key={tick.text}
								className={`m-chart__tick m-chart__tick--${tick.shift}${tick.minor ? " m-chart__tick--minor" : ""}`}
								style={{ left: tick.left }}
							>
								{tick.text}
							</span>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
