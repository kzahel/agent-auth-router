// The router as the UI observes it: the latest overview, the status banner
// and the error line. Registry changes (pairing, CLI edits, sign-in
// progress) arrive as change events; bursts are coalesced into at most one
// overview request at a time plus one more. Observation never starts a
// stopped core; only Start router and the first load may.

import { errorText } from "../lib/format.ts";
import type { AppClient } from "../protocol/client.ts";
import type { Overview } from "../protocol/types.ts";

export interface RouterView {
  overview: Overview | undefined;
  /** Shown only when something is wrong; `startable` offers Start router in the desktop app. */
  status: { message: string; startable: boolean };
  error: string;
}

export class RouterState {
  #client: AppClient;
  #desktop: boolean;
  #view: RouterView = { overview: undefined, status: { message: "Connecting to the router…", startable: false }, error: "" };
  #listeners = new Set<() => void>();
  #generation = 0;
  #dirty = false;
  #job: Promise<void> | undefined;
  /** Set while the owner stops the router, so the disconnect does not read as a failure. */
  stoppedByOwner = false;

  constructor(client: AppClient, desktop: boolean) {
    this.#client = client;
    this.#desktop = desktop;
    client.onChange(() => this.changed());
    client.onStatus((state) => {
      if (state === "connected") { this.changed(); return; }
      if (this.stoppedByOwner) { client.pause(); return; }
      this.setStatus(desktop ? "Router unavailable · reconnecting" : "Router unavailable · reconnecting. Restart it with aar serve if it stopped.", true);
    });
  }

  get view(): RouterView { return this.#view; }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  #set(change: Partial<RouterView>) {
    this.#view = { ...this.#view, ...change };
    for (const listener of this.#listeners) listener();
  }

  setStatus(message: string, startable = false) { this.#set({ status: { message, startable: startable && this.#desktop } }); }
  setError(value: unknown) { this.#set({ error: value ? errorText(value) : "" }); }

  /** Runs a user action, reporting its failure on the error line. */
  async run<T>(action: () => Promise<T>): Promise<T | undefined> {
    this.setError("");
    try { return await action(); }
    catch (failure) { this.setError(failure); return undefined; }
  }

  /** `start` (Start router and first load) may start a stopped desktop core; change events never do. */
  async reload(start = false): Promise<void> {
    const generation = ++this.#generation;
    let next: Overview;
    try {
      if (!this.#client.connected) {
        if (!start) throw new Error("Router unavailable");
        this.stoppedByOwner = false;
        await this.#client.start(this.#desktop);
      }
      next = await this.#client.call<Overview>("overview");
    } catch (failure) {
      if (generation === this.#generation) this.setStatus("Router unavailable", true);
      throw failure;
    }
    if (generation !== this.#generation) return;
    this.#set({ overview: next, status: { message: "", startable: false } });
  }

  /** Something changed in the router: fetch the overview again, coalescing bursts. */
  changed() {
    this.#dirty = true;
    if (this.#job) return;
    this.#job = (async () => {
      while (this.#dirty) {
        this.#dirty = false;
        try { await this.reload(); } catch { /* The status conveys unavailability. */ }
      }
    })().finally(() => { this.#job = undefined; });
  }
}
