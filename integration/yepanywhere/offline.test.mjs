import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { assertLoopback } from "./offline.mjs";

test("network tripwire handles positional, object and normalized socket arguments", () => {
  for (const args of [
    [443, "example.invalid"],
    [{ host: "192.0.2.1", port: 443 }],
    [[{ host: "192.0.2.1", port: 443 }, () => {}]],
  ]) {
    assert.throws(() => assertLoopback(args), /blocked a non-loopback/);
  }
  for (const args of [
    [80],
    [80, () => {}],
    [80, "127.0.0.1"],
    [{ port: 80, host: "::1" }],
    ["/tmp/fixture.sock"],
    [[{ path: "/tmp/fixture.sock" }]],
  ]) {
    assert.doesNotThrow(() => assertLoopback(args));
  }
  // These must throw synchronously, before any network operation occurs.
  assert.throws(
    () => net.createConnection({ host: "192.0.2.1", port: 443 }),
    /blocked a non-loopback/,
  );
  const socket = new net.Socket();
  try {
    assert.throws(
      () => socket.connect(443, "192.0.2.1"),
      /blocked a non-loopback/,
    );
  } finally {
    socket.destroy();
  }
});

test("network tripwire permits the real loopback fetch transport", async (t) => {
  const server = http.createServer((_request, response) =>
    response.end("fixture"),
  );
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await response.text(), "fixture");
});
