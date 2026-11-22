import { type ReactNode, useEffect, useRef, useState } from "react";
import { useAdminI18n } from "./messages";

export interface ConfirmActionProps {
	/** The button that asks first. */
	readonly label: ReactNode;
	/** What will happen, asked before doing it. */
	readonly question: ReactNode;
	readonly confirmLabel: ReactNode;
	readonly onConfirm: () => Promise<void> | void;
	readonly danger?: boolean;
	readonly disabled?: boolean;
}

/**
 * A destructive action behind an inline confirmation: the button opens a question with
 * "confirm" and "cancel". Focus moves to the confirm button; Escape or "cancel" closes the
 * question and returns focus to the button.
 */
export function ConfirmAction({ label, question, confirmLabel, onConfirm, danger = true, disabled = false }: ConfirmActionProps) {
	const { t } = useAdminI18n();
	const [asking, setAsking] = useState(false);
	const [busy, setBusy] = useState(false);
	const confirmRef = useRef<HTMLButtonElement>(null);
	const openerRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (asking) confirmRef.current?.focus();
	}, [asking]);

	if (!asking) {
		return (
			<button
				ref={openerRef}
				type="button"
				className={danger ? "button button--danger" : "button"}
				disabled={disabled}
				onClick={() => setAsking(true)}
			>
				{label}
			</button>
		);
	}
	const cancel = () => {
		setAsking(false);
		requestAnimationFrame(() => openerRef.current?.focus());
	};
	return (
		<div
			className="confirm"
			role="group"
			onKeyDown={(event) => {
				if (event.key === "Escape") cancel();
			}}
		>
			<p className="confirm__question">{question}</p>
			<div className="actions">
				<button
					ref={confirmRef}
					type="button"
					className={danger ? "button button--danger-solid" : "button button--primary"}
					disabled={busy}
					onClick={async () => {
						setBusy(true);
						try {
							await onConfirm();
						} finally {
							setBusy(false);
							setAsking(false);
						}
					}}
				>
					{confirmLabel}
				</button>
				<button type="button" className="button" onClick={cancel} disabled={busy}>
					{t("admin.action.cancel")}
				</button>
			</div>
		</div>
	);
}
