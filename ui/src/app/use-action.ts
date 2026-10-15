import { useCallback, useState } from "react";
import { useApp } from "./context.tsx";

/**
 * Runs user actions one at a time, reporting failures on the error line.
 * `pending` disables the control that started it.
 */
export function useAction(): [pending: boolean, run: (action: () => unknown) => Promise<void>] {
  const { router } = useApp();
  const [pending, setPending] = useState(false);
  const run = useCallback(async (action: () => unknown) => {
    setPending(true);
    try { await router.run(async () => action()); } finally { setPending(false); }
  }, [router]);
  return [pending, run];
}
