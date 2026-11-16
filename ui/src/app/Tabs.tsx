import styles from "./tabs.module.css";

export const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "accounts", label: "Accounts" },
  { id: "resets", label: "Resets" },
  { id: "pools", label: "Pools" },
  { id: "integrations", label: "Connections" },
  { id: "settings", label: "Settings" },
] as const;
export type TabId = (typeof TABS)[number]["id"];

/**
 * The tab list: arrow keys, Home and End move between tabs and select them.
 * A badge adds a short count to a tab, with its own description.
 */
export function Tabs({ selected, onSelect, badges = {} }: { selected: TabId; onSelect(tab: TabId): void; badges?: Partial<Record<TabId, { text: string; label: string }>> }) {
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % TABS.length
      : event.key === "ArrowLeft" ? (index + TABS.length - 1) % TABS.length
      : event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    onSelect(TABS[next]!.id);
    document.getElementById(`tab-${TABS[next]!.id}`)?.focus();
  };
  return (
    <nav role="tablist" aria-label="Router management" className={styles.tabs}>
      {TABS.map((tab, index) => (
        <button key={tab.id} type="button" role="tab" id={`tab-${tab.id}`} aria-controls={`panel-${tab.id}`}
          aria-selected={tab.id === selected} tabIndex={tab.id === selected ? 0 : -1}
          onClick={() => onSelect(tab.id)} onKeyDown={(event) => move(event, index)}>
          {tab.label}
          {badges[tab.id] && " "}
          {badges[tab.id] && <span className={styles.badge} aria-label={badges[tab.id]!.label} title={badges[tab.id]!.label}>{badges[tab.id]!.text}</span>}
        </button>
      ))}
    </nav>
  );
}
