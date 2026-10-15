import { useEffect, useRef, useState } from "react";
import { TrafficGraph } from "../chart/traffic-graph.ts";

/** Re-renders when the system switches between light and dark. */
export function useColorScheme(): "light" | "dark" {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const list = matchMedia(query), changed = () => setDark(list.matches);
    list.addEventListener("change", changed);
    return () => list.removeEventListener("change", changed);
  }, []);
  return dark ? "dark" : "light";
}

/** A theme variable's current value, for drawing on canvas. */
export const cssVariable = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Re-renders every `ms` while `enabled`, for ages and running durations. */
export function useTicker(ms: number, enabled: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setTick(t => t + 1), ms);
    return () => clearInterval(timer);
  }, [ms, enabled]);
  return tick;
}

/** A canvas graph bound to the refs' elements for the component's lifetime. */
export function useTrafficGraph() {
  const canvas = useRef<HTMLCanvasElement>(null), tooltip = useRef<HTMLDivElement>(null);
  const [graph, setGraph] = useState<TrafficGraph>();
  useEffect(() => {
    const created = new TrafficGraph(canvas.current!, tooltip.current!);
    setGraph(created);
    return () => created.dispose();
  }, []);
  return { graph, canvas, tooltip };
}
