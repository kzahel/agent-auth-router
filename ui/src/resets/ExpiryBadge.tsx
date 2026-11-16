import { expiresIn, resetUrgency, URGENCY_LABEL } from "../lib/resets.ts";
import styles from "./resets.module.css";

/** A reset's time to expiry, colored by how soon: under two weeks, a week, a day. */
export function ExpiryBadge({ expiresAt, now }: { expiresAt: string | null; now: number }) {
  const urgency = resetUrgency(expiresAt, now);
  return (
    <span className={styles.expiry} data-urgency={urgency}
      title={expiresAt ? `${URGENCY_LABEL[urgency]} · ${new Date(expiresAt).toLocaleString()}` : URGENCY_LABEL[urgency]}>
      {expiresIn(expiresAt, now)}
    </span>
  );
}
