# Request body compression

Agent clients resend the whole conversation with every request; the APIs are
stateless and prompt caching saves computation, not upload. On the
maintainer's router on 2026-10-15, 4,634 Claude requests in 24 hours uploaded
7.2 GB (1.6 MB on average, 11 MB at most) against 123 MB downloaded.

## What the upstreams accept

**Anthropic** (`api.anthropic.com`) accepts gzip request bodies. Probed
2026-10-15 with one subscription account's OAuth token on
`/v1/messages/count_tokens`, which is not inference:

| Body | Result |
| --- | --- |
| JSON | 200, 2,008 input tokens |
| gzip, `Content-Encoding: gzip` | 200, 2,008 input tokens |
| zstd, br or deflate with that `Content-Encoding` | 400 "Unsupported Content-Encoding … send the request body gzip-compressed or uncompressed" |
| gzip bytes without `Content-Encoding` | 400 "The request body is not valid JSON" |

Unauthenticated probes cannot tell: authentication is checked before the body
is read. `/v1/messages` was not probed with a compressed body, to avoid
inference; it is expected to share the request handling. Anthropic's API
reference does not mention request compression, the official TypeScript SDK
(0.134.0) never compresses, and CLIProxyAPI only decompresses Anthropic
responses ([reference](../reference/README.md)).

**Codex backend** (`chatgpt.com/backend-api/codex`) accepts zstd. Codex CLI
compresses streaming request bodies with zstd when signed in with ChatGPT
against its built-in OpenAI provider (`Feature::EnableRequestCompression`,
default on, `codex-rs/core/src/client.rs` `responses_request_compression`,
rust-v0.162.1), and pi does the same
(`packages/ai/src/api/openai-codex-responses.ts`). Not probed here. Codex
configured for the router as a custom provider (`aar`, as `aar client add`
prints) sends uncompressed bodies, so its traffic is compressed only when the
router setting says zstd.

## Compression ratio

A 1.6 MB slice of a Claude Code session transcript compressed 1.7× with gzip
in 17 ms: text compressed 3.7× and lines carrying base64 screenshots 1.4×,
and images were 78% of that session's bytes. Text-heavy sessions should
shrink 3–4×.

## Behavior

- **Passthrough (default).** Request bodies go upstream exactly as received.
  `Content-Encoding` is forwarded for both providers, so a client that
  compresses its own body (Codex CLI signed in with ChatGPT) works through
  the router. Before 2026-10-15 the router dropped that header, which would
  have sent compressed bytes as if they were JSON.
- **Metadata from compressed bodies.** The router reads the model and the
  client's session id from the body. For a compressed body it decodes a copy
  (gzip, deflate, br, zstd) no larger than the request body limit
  (`limits.maxBodyBytes`), so a small body cannot expand without bound; an
  unreadable body is still forwarded, without that metadata.
- **Router compression (opt-in).** Settings → "Requests to providers":
  Claude gzip or Codex zstd instead of "Pass through", stored in
  `settings.json` in the state directory and applied from the next request. The router compresses bodies of
  at least 1 KB that the client did not compress itself, off the event loop,
  and keeps the plain body when compression would not make it smaller.
- **Metering.** Uploaded counts request bytes received from clients; Sent
  upstream (Bytes mode) counts bytes sent on, after compression and including
  a retry after credential recovery.

Owner operation: `settings/request-compression` returns the setting and the
accepted values; with `{ provider, value }` it sets one.
