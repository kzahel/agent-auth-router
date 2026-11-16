import { useEffect, useState } from "react";

/** The current time, advanced every minute while `active`, so countdowns stay current. */
export function useNow(active = true, everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
  return now;
}
