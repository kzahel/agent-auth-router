// Metadata-only structured logging. Callers pass explicit fields; request
// bodies, headers and credential values are never passed here. Free-form
// error text is still sanitized because helper and upstream messages can
// echo secrets back.

export type LogFields = Record<string, string | number | boolean | null | undefined>;
export type LogSink = (line: string) => void;

let sink: LogSink = (line) => process.stderr.write(line + "\n");

export function setLogSink(next: LogSink): LogSink {
  const previous = sink;
  sink = next;
  return previous;
}

export function log(event: string, fields: LogFields = {}): void {
  const record: Record<string, unknown> = { ts: new Date().toISOString(), event };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    record[key] = typeof value === "string" ? sanitize(value) : value;
  }
  sink(JSON.stringify(record));
}

const MAX_TEXT = 300;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // JWTs (Codex access/id tokens).
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted]"],
  // Anthropic, OpenAI and this router's token families.
  [/\b(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{16,}|aar_[A-Za-z0-9_-]{16,})/g, "[redacted]"],
  // Bearer values and common key=value / "key": "value" spellings.
  [/(bearer\s+)[^\s"',]+/gi, "$1[redacted]"],
  [
    /((?:access|refresh|id)_?token|api_?key|authorization|password|secret)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
    "$1$2[redacted]",
  ],
];

export function sanitize(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/[\r\n\t]+/g, " ");
  return out.length > MAX_TEXT ? out.slice(0, MAX_TEXT) + "…" : out;
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return sanitize(error.message);
  return sanitize(String(error));
}
