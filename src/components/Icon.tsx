/**
 * Small inline icons (no icon font, no external files). States have different shapes as well
 * as colours, so that they never rely on colour alone. Decorative: the text next to each one
 * says what it means.
 */
import type { State } from "../../shared/public-api";

export type IconName = State | "maintenance" | "incident" | "external" | "refresh" | "warning";

const PATHS: Readonly<Record<IconName, string>> = {
	// A check mark in a circle.
	up: "M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm3.2 4.6-4 4.6a.75.75 0 0 1-1.1 0L4.8 8.9a.75.75 0 1 1 1.1-1l.75.8 3.45-4a.75.75 0 1 1 1.1 1Z",
	// An exclamation mark in a triangle.
	degraded:
		"M8.9 1.6a1 1 0 0 0-1.8 0L.6 13.5A1 1 0 0 0 1.5 15h13a1 1 0 0 0 .9-1.5L8.9 1.6ZM8 5c.4 0 .75.35.75.75v3.5a.75.75 0 0 1-1.5 0v-3.5C7.25 5.35 7.6 5 8 5Zm0 6a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z",
	// A cross in an octagon.
	down: "M5.1 1h5.8L15 5.1v5.8L10.9 15H5.1L1 10.9V5.1L5.1 1Zm.6 3.6a.75.75 0 0 0-1.1 1.1L6.9 8l-2.3 2.3a.75.75 0 1 0 1.1 1.1L8 9.1l2.3 2.3a.75.75 0 1 0 1.1-1.1L9.1 8l2.3-2.3a.75.75 0 1 0-1.1-1.1L8 6.9 5.7 4.6Z",
	// A question mark in a circle.
	unknown:
		"M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 10.2a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8ZM8 3.5c1.5 0 2.7 1 2.7 2.4 0 1.1-.7 1.7-1.3 2.1-.5.3-.65.5-.65.8v.2a.75.75 0 0 1-1.5 0V8.8c0-1.1.7-1.6 1.2-2 .5-.3.75-.5.75-.9 0-.5-.5-.9-1.2-.9s-1.2.4-1.3.9a.75.75 0 1 1-1.5-.2C5.4 4.4 6.6 3.5 8 3.5Z",
	// A wrench.
	maintenance:
		"M10.6 1.1a4 4 0 0 0-4.3 5.2L1.6 11a1.9 1.9 0 0 0 2.7 2.7L9 9a4 4 0 0 0 5.2-4.3.5.5 0 0 0-.85-.3l-1.9 1.9-1.6-.4-.4-1.6 1.9-1.9a.5.5 0 0 0-.3-.85l-.45-.45Z",
	// A flag.
	incident: "M3 1.75a.75.75 0 0 1 1.5 0V2h8.1a.5.5 0 0 1 .4.8L11.3 5.5 13 8.2a.5.5 0 0 1-.4.8H4.5v5.25a.75.75 0 0 1-1.5 0V1.75Z",
	// An arrow out of a box.
	external:
		"M9 2.75A.75.75 0 0 1 9.75 2h3.5c.4 0 .75.35.75.75v3.5a.75.75 0 0 1-1.5 0V4.56L8.53 8.53a.75.75 0 0 1-1.06-1.06L11.44 3.5H9.75A.75.75 0 0 1 9 2.75ZM3.5 5A.5.5 0 0 0 3 5.5v7c0 .28.22.5.5.5h7a.5.5 0 0 0 .5-.5v-3a.75.75 0 0 1 1.5 0v3a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3a.75.75 0 0 1 0 1.5h-3Z",
	// A circular arrow.
	refresh:
		"M8 2.5a5.5 5.5 0 0 0-5.2 3.7.75.75 0 1 1-1.4-.5A7 7 0 0 1 13 3.6V2.25a.75.75 0 0 1 1.5 0v3.5c0 .4-.35.75-.75.75h-3.5a.75.75 0 0 1 0-1.5h1.7A5.5 5.5 0 0 0 8 2.5Zm5.7 6.8a.75.75 0 0 1 .5.9A7 7 0 0 1 3 12.4v1.35a.75.75 0 0 1-1.5 0v-3.5c0-.4.35-.75.75-.75h3.5a.75.75 0 0 1 0 1.5H4a5.5 5.5 0 0 0 9.3-1.2.75.75 0 0 1 .9-.5Z",
	// An exclamation mark in a circle.
	warning:
		"M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 3c.4 0 .75.35.75.75v4a.75.75 0 0 1-1.5 0v-4C7.25 4.35 7.6 4 8 4Zm0 6.6a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8Z",
};

export function Icon({ name, className }: { readonly name: IconName; readonly className?: string }) {
	return (
		<svg
			className={className === undefined ? "icon" : `icon ${className}`}
			viewBox="0 0 16 16"
			width="16"
			height="16"
			aria-hidden="true"
			focusable="false"
		>
			<path fill="currentColor" fillRule="evenodd" d={PATHS[name]} />
		</svg>
	);
}
