/**
 * Concurrent edits: every edit sends the `version` it started
 * from; when someone else saved in between, the API answers 409 `edit_conflict` with what is
 * there now, and nothing is saved. The form then shows who saved what, and lets the admin
 * either take the current version (discarding their edits) or re-apply their edits on top of
 * it: the fields they changed keep their values, the others take the new ones, and they save
 * again after reviewing.
 */
import { useState } from "react";
import { Icon } from "../components/Icon";
import { useAdminI18n } from "./messages";
import { isEditConflict } from "./api";

export function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** The keys whose values differ between `a` and `b`. */
export function changedKeys<D extends object>(a: D, b: D): (keyof D & string)[] {
	return (Object.keys(b) as (keyof D & string)[]).filter((key) => !sameValue(a[key], b[key]));
}

/**
 * The admin's edits (`draft` against `started`, the version they began from) applied to
 * `current` (what someone else saved): changed fields keep the admin's values.
 */
export function rebase<D extends object>(started: D, draft: D, current: D): D {
	const result = { ...current };
	for (const key of changedKeys(started, draft)) result[key] = draft[key];
	return result;
}

export interface Versioned {
	readonly version: number;
	readonly updatedAt: number | null;
	readonly updatedBy: string | null;
}

export interface Conflict<T> {
	/** `save`: a save was refused (409). `refresh`: a newer version arrived while editing. */
	readonly source: "save" | "refresh";
	readonly current: T;
	/** Fields someone else changed. */
	readonly theirs: readonly string[];
	/** Fields both changed: the admin's value replaces theirs if they re-apply. */
	readonly both: readonly string[];
}

export interface VersionedDraft<T extends Versioned, D extends object> {
	/** The version edits start from. */
	readonly base: T;
	readonly draft: D;
	setDraft(update: (draft: D) => D): void;
	/** Fields the admin changed. */
	readonly changed: readonly (keyof D & string)[];
	readonly conflict: Conflict<T> | null;
	/** After a successful save: start over from what was saved. */
	saved(entity: T): void;
	/**
	 * A newer version arrived another way (a reload, the admin's own timeline update). Edits to
	 * fields it did not change are kept on top of it; when it changed a field the admin also
	 * changed, nothing is merged and the conflict is shown instead, as for a refused save:
	 * silently re-applying the admin's value would overwrite the other change unseen.
	 */
	refresh(entity: T): void;
	/** Handles an error of a save: `true` when it was an edit conflict (shown with {@link ConflictNotice}). */
	handleError(error: unknown): boolean;
	/** Discards the admin's edits and takes the current version. */
	takeCurrent(): void;
	/** Keeps the admin's edits on top of the current version. */
	reapply(): void;
}

/** A form's draft of a versioned entity, with conflict handling (see the module documentation). */
export function useVersionedDraft<T extends Versioned, D extends object>(initial: T, toDraft: (entity: T) => D): VersionedDraft<T, D> {
	const [state, setState] = useState(() => ({ base: initial, draft: toDraft(initial), conflict: null as Conflict<T> | null }));
	const started = toDraft(state.base);
	return {
		base: state.base,
		draft: state.draft,
		setDraft: (update) => setState((previous) => ({ ...previous, draft: update(previous.draft) })),
		changed: changedKeys(started, state.draft),
		conflict: state.conflict,
		saved: (entity) => setState({ base: entity, draft: toDraft(entity), conflict: null }),
		refresh: (entity) =>
			setState((previous) => {
				if (entity.version <= previous.base.version || previous.conflict !== null) return previous;
				const from = toDraft(previous.base);
				const now = toDraft(entity);
				const theirs = changedKeys(from, now);
				const mine = new Set(changedKeys(from, previous.draft));
				const both = theirs.filter((key) => mine.has(key));
				if (both.length > 0) return { ...previous, conflict: { source: "refresh", current: entity, theirs, both } };
				return { base: entity, draft: rebase(from, previous.draft, now), conflict: null };
			}),
		handleError: (error) => {
			if (!isEditConflict<T>(error)) return false;
			const current = error.body.current;
			setState((previous) => {
				const from = toDraft(previous.base);
				const now = toDraft(current);
				const theirs = changedKeys(from, now);
				const mine = new Set(changedKeys(from, previous.draft));
				return { ...previous, conflict: { source: "save", current, theirs, both: theirs.filter((key) => mine.has(key)) } };
			});
			return true;
		},
		takeCurrent: () =>
			setState((previous) =>
				previous.conflict === null ? previous : { base: previous.conflict.current, draft: toDraft(previous.conflict.current), conflict: null },
			),
		reapply: () =>
			setState((previous) => {
				if (previous.conflict === null) return previous;
				const current = previous.conflict.current;
				return { base: current, draft: rebase(toDraft(previous.base), previous.draft, toDraft(current)), conflict: null };
			}),
	};
}

export interface ConflictNoticeProps {
	readonly conflict: Conflict<Versioned>;
	/** A field's name for people. */
	readonly label: (field: string) => string;
	/** Someone else's value of a field, as text. */
	readonly value: (field: string) => string;
	readonly onTakeCurrent: () => void;
	readonly onReapply: () => void;
}

export function ConflictNotice({ conflict, label, value, onTakeCurrent, onReapply }: ConflictNoticeProps) {
	const { t, f } = useAdminI18n();
	const { current } = conflict;
	return (
		<div className="alert alert--conflict" role="alert">
			<Icon name="warning" />
			<div className="conflict">
				<p className="conflict__title">{conflict.source === "save" ? t("admin.conflict.title") : t("admin.conflict.titleRefresh")}</p>
				<p>
					{t("admin.conflict.savedBy", {
						who: current.updatedBy ?? t("admin.common.automation"),
						time: current.updatedAt === null ? "—" : f.dateTimeWithZone(current.updatedAt),
					})}
				</p>
				{conflict.theirs.length === 0 ? (
					<p>{t("admin.conflict.noFieldChanges")}</p>
				) : (
					<>
						<p>{t("admin.conflict.theyChanged")}</p>
						<dl className="conflict__fields">
							{conflict.theirs.map((field) => (
								<div key={field}>
									<dt>
										{label(field)}
										{conflict.both.includes(field) && <span className="badge badge--degraded">{t("admin.conflict.alsoYours")}</span>}
									</dt>
									<dd>{value(field)}</dd>
								</div>
							))}
						</dl>
					</>
				)}
				<div className="actions">
					<button type="button" className="button" onClick={onTakeCurrent}>
						{t("admin.conflict.takeCurrent")}
					</button>
					<button type="button" className="button button--primary" onClick={onReapply}>
						{t("admin.conflict.reapply")}
					</button>
				</div>
				<p className="field__hint">{t("admin.conflict.reapplyHint")}</p>
			</div>
		</div>
	);
}
