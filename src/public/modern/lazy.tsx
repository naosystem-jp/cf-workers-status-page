/**
 * The modern template's frame and views, loaded on first use: its code, styles and fonts are a
 * chunk of their own, which visitors of default-template pages never download. A page whose
 * HTML says it uses this template loads the chunk before its first render (src/main.tsx), so
 * that its loading screen is in this template too.
 *
 * Not `React.lazy`: a lazy component suspends on its first render even when its chunk has
 * loaded, and React then shows the <Suspense> fallback (the default template's) for a moment.
 * These render at once when the chunk is there, and suspend only while it is not.
 */
import { use } from "react";
import type * as Views from "./views";

type ViewsModule = typeof Views;

let loaded: ViewsModule | null = null;
let loading: Promise<ViewsModule> | null = null;

/** The chunk, loaded once (and again after a failure). */
export function loadModern(): Promise<ViewsModule> {
	loading ??= import("./views").then(
		(module) => {
			loaded = module;
			return module;
		},
		(error: unknown) => {
			loading = null;
			throw error;
		},
	);
	return loading;
}

/** Starts loading the chunk. Never fails: a page that needs it shows the failure. */
export function preloadModern(): Promise<void> {
	return loadModern().then(
		() => undefined,
		() => undefined,
	);
}

/** The chunk, or suspends until it has loaded (so: inside a <Suspense>). */
function useModern(): ViewsModule {
	return loaded ?? use(loadModern());
}

export function ModernFrame(props: Views.ModernFrameProps) {
	const { ModernFrame: View } = useModern();
	return <View {...props} />;
}

export function ModernStatusContent(props: Views.ModernStatusProps) {
	const { ModernStatusContent: View } = useModern();
	return <View {...props} />;
}

export function ModernIncidentContent(props: Views.ModernIncidentProps) {
	const { ModernIncidentContent: View } = useModern();
	return <View {...props} />;
}

export function ModernHistoryContent(props: Views.ModernHistoryProps) {
	const { ModernHistoryContent: View } = useModern();
	return <View {...props} />;
}

export function ModernViewLoading() {
	const { ModernViewLoading: View } = useModern();
	return <View />;
}

export function ModernViewUnavailable(props: Views.ModernUnavailableProps) {
	const { ModernViewUnavailable: View } = useModern();
	return <View {...props} />;
}

export function ModernViewNotFound(props: Views.ModernNotFoundProps) {
	const { ModernViewNotFound: View } = useModern();
	return <View {...props} />;
}

export function ModernLoadingView() {
	const { ModernLoadingView: View } = useModern();
	return <View />;
}

export function ModernUnavailableView(props: Views.ModernUnavailableProps) {
	const { ModernUnavailableView: View } = useModern();
	return <View {...props} />;
}
