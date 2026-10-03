// Catch accidental non-loopback TCP connections in the Node fixture processes.
// This is a test tripwire, not an OS network sandbox.
// Dependency checkout/install is a separate, explicitly networked phase.
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const connect = net.Socket.prototype.connect;
export function assertLoopback(args) {
  // net.createConnection passes Node's normalized [options, callback] array.
  while (Array.isArray(args[0])) args = args[0];
  const first = args[0];
  const options =
    typeof first === "object" && first !== null
      ? first
      : typeof first === "string" && !/^\d+$/.test(first)
        ? { path: first }
        : {
            port: first,
            host: typeof args[1] === "string" ? args[1] : undefined,
          };
  if (
    !options.path &&
    ![undefined, "localhost", "127.0.0.1", "::1"].includes(options.host)
  ) {
    throw new Error("Integration fixture blocked a non-loopback connection");
  }
}
net.Socket.prototype.connect = function (...args) {
  assertLoopback(args);
  return connect.apply(this, args);
};
syncBuiltinESMExports();
