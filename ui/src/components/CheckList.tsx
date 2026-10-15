import type { ReactNode } from "react";
import ui from "../styles/ui.module.css";

/** Checkboxes choosing a subset of `items`. */
export function CheckList({ id, items, selected, onChange, empty }: {
  id: string;
  items: { value: string; label: string }[];
  selected: ReadonlySet<string>;
  onChange(next: Set<string>): void;
  /** Shown when there is nothing to choose. */
  empty?: ReactNode;
}) {
  return (
    <div id={id}>
      {items.map(item => (
        <label key={item.value} className={ui.check}>
          <input type="checkbox" value={item.value} checked={selected.has(item.value)} onChange={(event) => {
            const next = new Set(selected);
            if (event.target.checked) next.add(item.value); else next.delete(item.value);
            onChange(next);
          }} />
          {item.label}
        </label>
      ))}
      {!items.length && empty}
    </div>
  );
}
