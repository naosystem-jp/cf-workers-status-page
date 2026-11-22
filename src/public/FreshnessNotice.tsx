import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/I18nProvider";
import type { Freshness } from "../lib/freshness";
import { HttpError } from "../lib/http";

export interface FreshnessNoticeProps {
	readonly freshness: Freshness;
	/** When the shown data was computed by the server. */
	readonly generatedAt: number;
	/** When the next attempt is due; `null` while one is in flight. */
	readonly dueAt: number | null;
	readonly loading: boolean;
	readonly now: number;
	readonly onRetry: () => void;
}

/** "Last updated" and, when refreshing fails, why and when it is tried again. */
export function FreshnessNotice({ freshness, generatedAt, dueAt, loading, now, onRetry }: FreshnessNoticeProps) {
	const { t, f } = useI18n();
	const error = freshness.kind === "fresh" || freshness.kind === "stale" ? freshness.error : null;
	return (
		<div className={`freshness${freshness.kind === "stale" ? " freshness--stale" : ""}`}>
			<p className="freshness__updated">
				{t("public.freshness.updated", { time: f.time(generatedAt) })}
				{freshness.kind === "stale" && <> · {t("public.freshness.age", { age: f.relative(now - freshness.ageMs, now) })}</>}
			</p>
			<div className="freshness__status">
				{error !== null && (
					<p className="freshness__error">
						<Icon name="warning" />
						{/* Announced once per failure; the countdown next to it is not (it changes every few seconds). */}
						<span role="status">{t("public.freshness.failed", { reason: describeError(error, t) })}</span>
						<span>
							{loading
								? t("public.freshness.retrying")
								: dueAt !== null && t("public.freshness.retryAt", { time: f.relative(Math.max(dueAt, now + 1000), now) })}
						</span>
						<button type="button" className="button button--small" onClick={onRetry} disabled={loading}>
							<Icon name="refresh" />
							{t("public.freshness.retryNow")}
						</button>
					</p>
				)}
			</div>
		</div>
	);
}

/** Why a request failed, in a few words. */
export function describeError(error: unknown, t: ReturnType<typeof useI18n>["t"]): string {
	if (error instanceof HttpError) {
		if (error.status === 0) return t("public.error.network");
		return t("public.error.http", { status: error.status });
	}
	return t("public.error.unknown");
}

/**
 * Shown when the server could not read incidents, maintenance and appearance (its database
 * was unavailable) and sent them as last read: the states are current, the rest may not be.
 */
export function OutdatedIncidentsNotice() {
	const { t } = useI18n();
	return (
		<div className="freshness">
			<p className="freshness__error" role="status">
				<Icon name="warning" />
				<span>{t("public.freshness.incidentsOutdated")}</span>
			</p>
		</div>
	);
}
