import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateCertificate, uploadCertificate } from "../scripts/upload-macos-certificate.mjs";

test("PKCS#12 validation rejects wrong passwords and publisher teams before upload", { skip: process.platform !== "darwin" }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aar-signing-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem"), p12 = join(dir, "fixture.p12");
  const openssl = (args, input) => execFileSync("/usr/bin/openssl", args, { input, stdio: ["pipe", "pipe", "pipe"] });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=Developer ID Application: Fixture/OU=AAAAAAAAAA"]);
  const password = "synthetic-only-export-password";
  openssl(["pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12, "-passout", "stdin"], `${password}\n`);
  validateCertificate(p12, password, "AAAAAAAAAA");
  assert.throws(() => validateCertificate(p12, "wrong-secret-do-not-print", "AAAAAAAAAA"), (error) => {
    assert.match(error.message, /validation failed/);
    assert.doesNotMatch(error.message, /wrong-secret/);
    return true;
  });
  assert.throws(() => validateCertificate(p12, password, "BBBBBBBBBB"), /expected team's/);
});

test("matched certificate/password upload uses stdin and confirms both names", () => {
  const calls = [];
  uploadCertificate("owner/product", Buffer.from("synthetic-container"), "synthetic-password", (cmd, args, input) => {
    calls.push({ cmd, args, input });
    return JSON.stringify([{ name: "MACOS_CERTIFICATE_P12_BASE64" }, { name: "MACOS_CERTIFICATE_PASSWORD" }]);
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].input, Buffer.from("synthetic-container").toString("base64"));
  assert.equal(calls[1].input, "synthetic-password");
  assert.ok(calls.every((c) => !JSON.stringify(c.args).includes("synthetic")));
  assert.throws(() => uploadCertificate("owner/product", Buffer.from("x"), "password", () => {
    throw new Error("private-child-output");
  }), (error) => {
    assert.match(error.message, /rerun/);
    assert.doesNotMatch(error.message, /private-child-output/);
    return true;
  });
  assert.throws(() => uploadCertificate("owner/product", Buffer.from("x"), "password", () => "[]"), /did not report/);
});
