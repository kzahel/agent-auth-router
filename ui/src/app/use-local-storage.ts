import { useState } from "react";

/** A string preference kept in this browser; `parse` maps stored values to valid ones. */
export function useLocalStorage<T extends string>(key: string, parse: (stored: string | null) => T): [T, (value: T) => void] {
  const [value, setValue] = useState(() => parse(localStorage.getItem(key)));
  return [value, (next) => { localStorage.setItem(key, next); setValue(next); }];
}
