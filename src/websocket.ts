// Minimal RFC 6455 server for the dashboard: text messages only, masked
// client frames, bounded messages and buffers, ping keepalive. Callers do
// all Host/Origin/session checks before accepting the upgrade.

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const PING_INTERVAL_MS = 30_000;
const IDLE_TIMEOUT_MS = 75_000;

export interface WebSocketConnection {
  send(text: string): void;
  close(code?: number): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: () => void): void;
}

/** Writes the 101 response and returns the connection, or answers 400 and returns undefined. */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, maxMessageBytes: number): WebSocketConnection | undefined {
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  const connection = String(req.headers.connection ?? "").toLowerCase();
  if (req.method !== "GET" || upgrade !== "websocket" || !connection.split(/,\s*/).includes("upgrade") || req.headers["sec-websocket-version"] !== "13"
    || typeof key !== "string" || Buffer.from(key, "base64").length !== 16) {
    socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    return undefined;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`);
  return new Connection(socket, head, maxMessageBytes);
}

class Connection implements WebSocketConnection {
  private readonly socket: Duplex;
  private readonly maxMessageBytes: number;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private messageHandler: (text: string) => void = () => {};
  private closeHandlers: (() => void)[] = [];
  private closed = false;
  private lastSeen = Date.now();
  private readonly pinger: NodeJS.Timeout;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(socket: Duplex, head: Buffer, maxMessageBytes: number) {
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    socket.on("data", (chunk: Buffer) => this.read(chunk));
    socket.on("error", () => this.destroy());
    socket.on("close", () => this.destroy());
    this.pinger = setInterval(() => {
      if (Date.now() - this.lastSeen > IDLE_TIMEOUT_MS) { this.destroy(); return; }
      this.frame(0x9, Buffer.alloc(0));
    }, PING_INTERVAL_MS);
    this.pinger.unref();
    if (head.length) this.read(head);
  }
  onMessage(handler: (text: string) => void): void { this.messageHandler = handler; }
  onClose(handler: () => void): void { if (this.closed) handler(); else this.closeHandlers.push(handler); }
  send(text: string): void { this.frame(0x1, Buffer.from(text, "utf8")); }
  close(code = 1000): void {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    this.frame(0x8, payload);
    this.socket.end();
    this.destroy();
  }
  private frame(opcode: number, payload: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    if ((this.socket as Duplex & { writableLength: number }).writableLength > MAX_BUFFERED_BYTES) { this.destroy(); return; }
    const length = payload.length;
    const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    if (length < 126) header[1] = length;
    else if (length < 65536) { header[1] = 126; header.writeUInt16BE(length, 2); }
    else { header[1] = 127; header.writeBigUInt64BE(BigInt(length), 2); }
    this.socket.write(Buffer.concat([header, payload]));
  }
  private destroy(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    if (!this.socket.destroyed) this.socket.destroy();
    for (const handler of this.closeHandlers.splice(0)) handler();
  }
  private fail(code: number): void { this.close(code); }
  private read(chunk: Buffer): void {
    if (this.closed) return;
    this.lastSeen = Date.now();
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (!this.closed) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0]!, second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0, opcode = first & 0x0f, masked = (second & 0x80) !== 0;
      if (first & 0x70) { this.fail(1002); return; }
      if (!masked) { this.fail(1002); return; }
      let length = second & 0x7f, offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessageBytes)) { this.fail(1009); return; }
        length = Number(big);
        offset = 10;
      }
      if (length > this.maxMessageBytes) { this.fail(1009); return; }
      if (this.buffer.length < offset + 4 + length) {
        if (this.buffer.length > this.maxMessageBytes + 14) this.fail(1009);
        return;
      }
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      this.buffer = this.buffer.subarray(offset + 4 + length);
      if (opcode >= 0x8) {
        if (!fin || length > 125) { this.fail(1002); return; }
        if (opcode === 0x8) { this.close(1000); return; }
        if (opcode === 0x9) this.frame(0xa, payload);
        else if (opcode !== 0xa) { this.fail(1002); return; }
        continue;
      }
      if (opcode === 0x2) { this.fail(1003); return; }
      if (opcode === 0x1) { if (this.fragments.length) { this.fail(1002); return; } }
      else if (opcode !== 0x0 || !this.fragments.length) { this.fail(1002); return; }
      this.fragments.push(payload);
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxMessageBytes) { this.fail(1009); return; }
      if (!fin) continue;
      const message = Buffer.concat(this.fragments);
      this.fragments = [];
      this.fragmentBytes = 0;
      let text: string;
      try { text = this.decoder.decode(message); } catch { this.fail(1007); return; }
      this.messageHandler(text);
    }
  }
}
