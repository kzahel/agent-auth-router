import type { ButtonHTMLAttributes } from "react";
import { useAction } from "../app/use-action.ts";
import ui from "../styles/ui.module.css";

type Props = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  /** Runs on click; the button is disabled until it settles, and a failure shows on the error line. */
  action: () => unknown;
  danger?: boolean;
};

export function ActionButton({ action, danger, className, disabled, ...rest }: Props) {
  const [pending, run] = useAction();
  const classes = [danger ? ui.danger : "", className ?? ""].join(" ").trim() || undefined;
  return <button type="button" {...rest} className={classes} disabled={disabled || pending} onClick={() => void run(action)} />;
}
