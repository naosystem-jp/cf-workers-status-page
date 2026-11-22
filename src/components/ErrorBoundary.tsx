import { Component, type ErrorInfo, type ReactNode } from "react";

export interface ErrorBoundaryProps {
	/**
	 * What to show instead of the app after it failed to render. `crashes` counts the failures
	 * since the page loaded; `retry` renders the app again.
	 */
	readonly fallback: (error: unknown, crashes: number, retry: () => void) => ReactNode;
	readonly children: ReactNode;
}

interface State {
	readonly error: unknown;
	readonly failed: boolean;
	readonly crashes: number;
}

/**
 * Catches errors while rendering, so that a page that meets something it cannot show (data
 * from a newer version of the API, say) shows a way out instead of a blank screen.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
	override state: State = { error: null, failed: false, crashes: 0 };

	static getDerivedStateFromError(error: unknown): Partial<State> {
		return { error, failed: true };
	}

	override componentDidCatch(error: unknown, info: ErrorInfo): void {
		this.setState((previous) => ({ crashes: previous.crashes + 1 }));
		console.error("The page failed to render", error, info.componentStack);
	}

	retry = (): void => {
		this.setState({ error: null, failed: false });
	};

	override render(): ReactNode {
		return this.state.failed ? this.props.fallback(this.state.error, Math.max(1, this.state.crashes), this.retry) : this.props.children;
	}
}
