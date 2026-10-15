// Request body encodings. A client's compressed body is forwarded unchanged
// with its Content-Encoding; the router decodes a bounded copy only to read
// metadata (model, session). Optionally the router compresses what it sends
// upstream, per provider. See docs/compression.md.

import { promisify } from "node:util";
import zlib from "node:zlib";
import type { Provider } from "./types.ts";

export type RequestCompression = "off" | "gzip" | "zstd";
/** Encodings each upstream accepts on request bodies, verified 2026-10-15 (docs/compression.md). */
export const COMPRESSION_CHOICES: Readonly<Record<Provider, readonly RequestCompression[]>> = { claude: ["off", "gzip"], codex: ["off", "zstd"] };
/** Smaller bodies gain nothing worth the work. */
const MIN_COMPRESS_BYTES = 1024;

const gunzip = promisify(zlib.gunzip), inflate = promisify(zlib.inflate), brotli = promisify(zlib.brotliDecompress), unzstd = promisify(zlib.zstdDecompress);
const gzip = promisify(zlib.gzip), zstd = promisify(zlib.zstdCompress);

/** The request's single content coding, lowercased; undefined for none or identity. */
export function contentEncoding(headers: Record<string, string | string[] | undefined>): string | undefined {
  const value = headers["content-encoding"];
  const text = (Array.isArray(value) ? value.join(",") : value ?? "").trim().toLowerCase();
  return text && text !== "identity" ? text : undefined;
}

/**
 * Decodes a copy of a client-compressed body for metadata only, never more
 * than `max` bytes. Undefined when the coding is unknown, stacked or corrupt;
 * the body is still forwarded and the upstream decides.
 */
export async function decodeForInspection(body: Buffer, encoding: string, max: number): Promise<Buffer | undefined> {
  const options = { maxOutputLength: max };
  try {
    if (encoding === "gzip" || encoding === "x-gzip") return await gunzip(body, options);
    if (encoding === "deflate") return await inflate(body, options);
    if (encoding === "br") return await brotli(body, options);
    if (encoding === "zstd") return await unzstd(body, options);
  } catch { /* Unreadable: no metadata, still forwarded. */ }
  return undefined;
}

/** The body to send upstream and its coding, or the original when compression is off, unhelpful or already applied. */
export async function compressForUpstream(body: Buffer, mode: RequestCompression, clientEncoding: string | undefined): Promise<{ body: Buffer; encoding?: string }> {
  if (mode === "off" || clientEncoding || body.length < MIN_COMPRESS_BYTES) return { body };
  const compressed = mode === "gzip" ? await gzip(body) : await zstd(body, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
  return compressed.length < body.length ? { body: compressed, encoding: mode } : { body };
}
