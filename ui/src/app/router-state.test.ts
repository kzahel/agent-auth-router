import { describe, expect, it, vi } from "vitest";
import { AppClient, type Inbound, type Port } from "../protocol/client.ts";
import { RouterState } from "./router-state.ts";

/** A port whose overview replies the test releases one at a time. */
function harness(desktop = true) {
  let deliver: (message: Inbound) => void = () => {}, close = () => {};
  const pending: number[] = [];
  const connects: boolean[] = [];
  const port: Port = {
    kind: desktop ? "desktop" : "web",
    connect: async (start) => { connects.push(start); return { protocol: 1, routerId: "r", kind: port.kind }; },
    send: (message) => { if ("call" in message) pending.push(message.id); },
    onMessage: (handler) => { deliver = handler; },
    onClose: (handler) => { close = handler; },
    shell: { native: false, logout: async () => ({}) },
  };
  const client = new AppClient(port);
  const router = new RouterState(client, desktop);
  let revision = 0;
  return {
    client, router, connects, pending, close: () => close(),
    /** Answers the oldest outstanding overview request. */
    answer: () => deliver({ id: pending.shift()!, result: { routerId: "r", revision: ++revision, accounts: [], pools: [], integrations: [], logins: [], activeRequests: 0 } }),
  };
}

describe("RouterState", () => {
  it("coalesces bursts of change events into one more overview request", async () => {
    const h = harness();
    // Connecting fetches the overview.
    await h.client.start();
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    h.answer();
    await vi.waitFor(() => expect(h.router.view.overview).toBeDefined());
    for (let i = 0; i < 8; i++) h.router.changed();
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    h.answer();
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    h.answer();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.pending).toHaveLength(0);
  });

  it("starts the core only when asked, and reports a router it cannot reach", async () => {
    const h = harness();
    await expect(h.router.reload()).rejects.toThrow("Router unavailable");
    expect(h.connects).toEqual([]);
    expect(h.router.view.status).toEqual({ message: "Router unavailable", startable: true });
    const loading = h.router.reload(true);
    await vi.waitFor(() => expect(h.pending.length).toBeGreaterThan(0));
    while (h.pending.length) h.answer();
    await loading;
    expect(h.connects).toEqual([true]);
    expect(h.router.view.status.message).toBe("");
  });

  it("keeps only the newest overview when replies arrive out of order", async () => {
    const h = harness();
    await h.client.start();
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    const second = h.router.reload();
    await vi.waitFor(() => expect(h.pending).toHaveLength(2));
    h.answer();
    h.answer();
    await second;
    expect((h.router.view.overview as unknown as { revision: number }).revision).toBe(2);
  });

  it("shows reconnecting after a lost connection, unless the owner stopped the router", async () => {
    const h = harness(false);
    await h.client.start();
    h.close();
    expect(h.router.view.status).toEqual({ message: "Router unavailable · reconnecting. Restart it with aar serve if it stopped.", startable: false });
    const stopped = harness();
    await stopped.client.start();
    stopped.router.stoppedByOwner = true;
    const pause = vi.spyOn(stopped.client, "pause");
    stopped.close();
    expect(pause).toHaveBeenCalled();
  });

  it("reports action failures on the error line and clears it on the next action", async () => {
    const h = harness();
    const listener = vi.fn();
    h.router.subscribe(listener);
    expect(await h.router.run(async () => { throw new Error("Router busy"); })).toBeUndefined();
    expect(h.router.view.error).toBe("Router busy");
    expect(await h.router.run(async () => 7)).toBe(7);
    expect(h.router.view.error).toBe("");
    expect(listener).toHaveBeenCalled();
  });
});
