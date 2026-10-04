import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("timestamp retries preserve signing arguments, remain bounded and refuse other failures", () => {
  const root = mkdtempSync(join(tmpdir(), "aar-signing-retry-"));
  try {
    const count = join(root, "count"), args = join(root, "args");
    writeFileSync(join(root, "codesign"), `#!/bin/bash
n=0; [[ ! -f "$TEST_COUNT" ]] || n=$(cat "$TEST_COUNT")
n=$((n+1)); echo "$n" > "$TEST_COUNT"
printf '%s\\n' "$@" >> "$TEST_ARGS"
if [[ "$TEST_FAILURE" == fatal ]]; then echo 'identity not found' >&2; exit 2; fi
if (( n <= TEST_FAILURES )); then echo 'A timestamp was expected but was not found.' >&2; exit 1; fi
`, { mode: 0o700 });
    // Exercise retry behavior without waiting for a real timestamp service.
    writeFileSync(join(root, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const expected = ["--force", "--timestamp", "--sign", "Synthetic Publisher", "/tmp/App with spaces.app"];
    for (const [failures, failure, status, attempts] of [[0, "timestamp", 0, 1], [2, "timestamp", 0, 3], [3, "timestamp", 1, 3], [0, "fatal", 2, 1]]) {
      rmSync(count, { force: true }); rmSync(args, { force: true });
      const result = spawnSync("bash", [resolve(import.meta.dirname, "../scripts/codesign-with-retry.sh"), ...expected], {
        env: { ...process.env, PATH: `${root}:/usr/bin:/bin`, TEST_COUNT: count, TEST_ARGS: args, TEST_FAILURES: String(failures), TEST_FAILURE: failure },
        encoding: "utf8",
      });
      assert.equal(result.status, status, result.stderr);
      assert.equal(Number(readFileSync(count, "utf8").trim()), attempts);
      assert.deepEqual(readFileSync(args, "utf8").trim().split("\n"), Array.from({ length: attempts }, () => expected).flat());
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
