import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppClient, type Hello, type Inbound, type Outbound, type Port } from "./client.ts";

/** A port the test drives: it records what the client sends and delivers what the core would. */
function fakePort() {
  let deliver: (message: Inbound) => void = () => {}, close = () => {};
  const sent: Outbound[] = [];
  const connects: boolean[] = [];
  let refuse = false;
  const port: Port = {
    kind: "desktop",
    connect: async (start) => {
      connects.push(start);
      if (refuse) throw new Error("Router unavailable");
      return { protocol: 1, routerId: "fixture", kind: "desktop" } satisfies Hello;
    },
    send: (message) => { sent.push(message); },
    onMessage: (handler) => { deliver = handler; },
    onClose: (handler) => { close = handler; },
    shell: { native: false, logout: async () => ({}) },
  };
  return {
    port, sent, connects,
    deliver: (message: Inbound) => deliver(message),
    close: () => close(),
    refuse: (value: boolean) => { refuse = value; },
  };
}

describe("AppClient", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("matches replies to calls by id and rejects errors with their status", async () => {
    const fake = fakePort(), client = new AppClient(fake.port);
    await client.start();
    const overview = client.call("overview");
    const failing = client.call("accounts/remove", { id: "work" });
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    const [first, second] = fake.sent as { id: number; call: string; body: unknown }[];
    expect(first).toMatchObject({ call: "overview", body: {} });
    expect(second).toMatchObject({ call: "accounts/remove", body: { id: "work" } });
    fake.deliver({ id: second!.id, error: { status: 409, message: "Router busy" } });
    fake.deliver({ id: first!.id, result: { accounts: [] } });
    await expect(overview).resolves.toEqual({ accounts: [] });
    await expect(failing).rejects.toMatchObject({ message: "Router busy", status: 409 });
  });

  it("refuses calls while disconnected", async () => {
    const client = new AppClient(fakePort().port);
    await expect(client.call("overview")).rejects.toThrow("Router unavailable");
  });

  it("delivers a subscription's snapshot and events, and unsubscribes", async () => {
    const fake = fakePort(), client = new AppClient(fake.port);
    await client.start();
    const messages: { type: string; data: unknown }[] = [];
    const stop = client.subscribe("requests", {}, (message) => messages.push(message));
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    const { id } = fake.sent[0] as { id: number; subscribe: string };
    expect(fake.sent[0]).toMatchObject({ subscribe: "requests", body: {} });
    fake.deliver({ id, result: { requests: [] } });
    fake.deliver({ sub: id, event: "request", data: { id: 7 } });
    fake.deliver({ sub: id + 100, event: "request", data: { id: 8 } });
    expect(messages).toEqual([{ type: "snapshot", data: { requests: [] } }, { type: "request", data: { id: 7 } }]);
    stop();
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    expect(fake.sent[1]).toMatchObject({ unsubscribe: id });
    fake.deliver({ sub: id, event: "request", data: { id: 9 } });
    expect(messages).toHaveLength(2);
  });

  it("reports subscription errors to the handler", async () => {
    const fake = fakePort(), client = new AppClient(fake.port);
    await client.start();
    const messages: { type: string; data: unknown }[] = [];
    client.subscribe("history", { range: "1y" }, (message) => messages.push(message));
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    fake.deliver({ id: (fake.sent[0] as { id: number }).id, error: { status: 400, message: "invalid history subscription" } });
    expect(messages).toEqual([{ type: "error", data: { status: 400, message: "invalid history subscription" } }]);
  });

  it("passes broadcast change events to change listeners", async () => {
    const fake = fakePort(), client = new AppClient(fake.port);
    await client.start();
    const changes: unknown[] = [];
    const off = client.onChange((data) => changes.push(data));
    fake.deliver({ event: "change", data: { revision: 3 } });
    off();
    fake.deliver({ event: "change", data: { revision: 4 } });
    expect(changes).toEqual([{ revision: 3 }]);
  });

  it("rejects pending calls on close, reconnects without starting the core and resubscribes", async () => {
    const fake = fakePort(), client = new AppClient(fake.port);
    const states: string[] = [];
    client.onStatus((state) => states.push(state));
    await client.start(true);
    client.subscribe("live", {}, () => {});
    const pending = client.call("overview");
    await vi.waitFor(() => expect(fake.sent).toHaveLength(2));
    fake.close();
    await expect(pending).rejects.toThrow("Router connection closed");
    expect(client.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.connects).toEqual([true, false]);
    expect(client.connected).toBe(true);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(3));
    const resubscribed = fake.sent.slice(2);
    expect(resubscribed).toHaveLength(1);
    expect(resubscribed[0]).toMatchObject({ subscribe: "live" });
    expect((resubscribed[0] as { id: number }).id).not.toBe((fake.sent[0] as { id: number }).id);
    expect(states).toEqual(["connected", "disconnected", "connected"]);
  });

  it("backs off between failed reconnects, up to ten seconds", async () => {
    const fake = fakePort(), client = new AppClient(fake.port);
    await client.start();
    fake.refuse(true);
    fake.close();
    const attempts = async (ms: number) => { const before = fake.connects.length; await vi.advanceTimersByTimeAsync(ms); return fake.connects.length - before; };
    expect(await attempts(1000)).toBe(1);
    expect(await attempts(1999)).toBe(0);
    expect(await attempts(1)).toBe(1);
    expect(await attempts(4000)).toBe(1);
    expect(await attempts(8000)).toBe(1);
    expect(await attempts(10_000)).toBe(1);
    expect(await attempts(10_000)).toBe(1);
    expect(fake.connects.every((start, i) => i === 0 || start === false)).toBe(true);
  });

  it("stops reconnecting when paused", async () => {
    const fake = fakePort(), client = new AppClient(fake.port);
    await client.start();
    fake.close();
    client.pause();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.connects).toHaveLength(1);
  });
});
