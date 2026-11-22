/** Who receives an event, and when maintenance holds it back. Pure functions. */
import type { ComponentRef, NotificationEvent } from "../../shared/admin-api";
import type { MonitorEvent } from "./events";

/** What {@link targetReceives} needs from a target. */
export interface TargetSelection {
	readonly enabled: boolean;
	readonly admin: boolean;
	readonly events: readonly NotificationEvent[];
	readonly allMonitors: boolean;
	readonly monitors: readonly string[];
	readonly components: readonly ComponentRef[];
}

/**
 * Whether a target receives `event`: it is enabled, it chose the event (`unknown` only
 * for administrators' targets), and it covers the monitor: all monitors, the monitor by ID,
 * or a component that shows it (`refs`: the components that show the monitor).
 */
export function targetReceives(target: TargetSelection, event: Pick<MonitorEvent, "event" | "monitorId">, refs: readonly ComponentRef[]): boolean {
	if (event.event === "stopped") return false;
	if (!target.enabled || !target.events.includes(event.event)) return false;
	if (event.event === "unknown" && !target.admin) return false;
	if (target.allMonitors || target.monitors.includes(event.monitorId)) return true;
	return target.components.some((selected) =>
		refs.some((ref) => ref.pageId === selected.pageId && ref.componentId === selected.componentId),
	);
}

/** A maintenance window, as suppression needs it. */
export interface MaintenanceWindow {
	readonly pageId: string;
	readonly components: readonly string[];
	readonly startsAt: number;
	readonly endsAt: number;
}

/**
 * Whether maintenance suppresses a monitor's notifications at `at`: some component that
 * shows the monitor (`refs`) is under maintenance then, from `startsAt` (inclusive) to
 * `endsAt` (exclusive), as the status page shows it.
 */
export function suppressedByMaintenance(refs: readonly ComponentRef[], windows: readonly MaintenanceWindow[], at: number): boolean {
	return windows.some(
		(window) =>
			window.startsAt <= at &&
			at < window.endsAt &&
			refs.some((ref) => ref.pageId === window.pageId && window.components.includes(ref.componentId)),
	);
}

/**
 * Whether maintenance applies to `event` at all: to the start of a problem (`down`,
 * `degraded`). A recovery goes to the targets that heard of the problem, whatever the
 * maintenance (see `pairedEventIds`), and `unknown` is about monitoring itself (results stopped
 * arriving at the hub), not about the service under maintenance, so administrators hear about
 * it even then.
 */
export function maintenanceApplies(event: Pick<MonitorEvent, "event">): boolean {
	return event.event === "down" || event.event === "degraded";
}
