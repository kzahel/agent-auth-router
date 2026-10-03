// Validate the publisher's existing PKCS#12, then upload the matched pair.
// No private paths or credential values belong in this source file.
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const run = (command, args, input) => execFileSync(command, args, {
  input, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
  stdio: ["pipe", "pipe", "pipe"],
});

export function validateCertificate(path, password, team, execute = run) {
  if (!password || /[\r\n]/.test(password)) throw new Error("A nonempty, single-line export password is required");
  if (!/^[A-Z0-9]{10}$/.test(team)) throw new Error("Invalid expected Apple team ID");
  let pem;
  try {
    pem = execute("/usr/bin/openssl", ["pkcs12", "-in", path, "-nokeys", "-passin", "stdin"], `${password}\n`);
  } catch {
    throw new Error("Certificate validation failed: check the PKCS#12 file and its export password");
  }
  const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  const identity = certs.map((text) => new X509Certificate(text)).find((cert) => {
    const subject = cert.subject.split("\n");
    return subject.includes(`OU=${team}`) && subject.some((line) => line.startsWith("CN=Developer ID Application:"));
  });
  if (!identity) throw new Error("Certificate does not contain the expected team's Developer ID Application identity");
  if (Date.now() < Date.parse(identity.validFrom) || Date.now() >= Date.parse(identity.validTo))
    throw new Error("Developer ID Application certificate is not currently valid");
}

export function uploadCertificate(repo, bytes, password, execute = run) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid GitHub repository");
  // GitHub cannot expose existing secret values. Upload both from the same
  // validated container; do not guess which password matches a remote blob.
  const values = [
    ["MACOS_CERTIFICATE_P12_BASE64", bytes.toString("base64")],
    ["MACOS_CERTIFICATE_PASSWORD", password],
  ];
  for (const [name, value] of values) {
    try { execute("gh", ["secret", "set", name, "--repo", repo], value); }
    catch { throw new Error(`Upload failed for ${name}; rerun to finish the matched pair before starting CI`); }
  }
  let names;
  try { names = JSON.parse(execute("gh", ["secret", "list", "--repo", repo, "--json", "name"])); }
  catch { throw new Error("Could not verify uploaded secret names"); }
  for (const [name] of values)
    if (!names.some((secret) => secret.name === name)) throw new Error(`GitHub did not report ${name}`);
}

async function main() {
  const { values } = parseArgs({ options: {
    p12: { type: "string" }, repo: { type: "string", default: "kzahel/agent-auth-router" },
    set: { type: "boolean", default: false },
  } });
  if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw new Error("Invalid GitHub repository");
  if (!values.p12) throw new Error("Usage: node desktop/scripts/upload-macos-certificate.mjs --p12 FILE [--set] [--repo OWNER/REPO]");
  const bytes = readFileSync(values.p12);
  if (bytes.length > 36 * 1024) throw new Error("Certificate exceeds GitHub's encoded secret size limit");
  const team = run("gh", ["variable", "get", "APPLE_TEAM_ID", "--repo", values.repo]).trim();
  // The prompt result stays in process memory. It is never printed or passed
  // in command arguments; OpenSSL and gh receive it on their private stdin.
  let password;
  try {
    password = execFileSync("/usr/bin/osascript", ["-e", `text returned of (display dialog "Enter the Developer ID .p12 export password for ${values.repo}. It will be validated locally${values.set ? " and uploaded to GitHub Actions" : " only (no upload)"}." default answer "" with hidden answer buttons {"Cancel", "Continue"} default button "Continue" with title "Agent Auth Router signing setup")`], {
      encoding: "utf8", timeout: 10 * 60_000, stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\r?\n$/, "");
  } catch { throw new Error("Password entry cancelled or unavailable; nothing uploaded"); }
  validateCertificate(values.p12, password, team);
  if (!bytes.equals(readFileSync(values.p12))) throw new Error("Certificate file changed during validation; retry before uploading");
  console.log("Validated Developer ID Application certificate, team and expiry.");
  if (values.set) {
    uploadCertificate(values.repo, bytes, password);
    console.log(`Certificate and password uploaded and secret names verified on ${values.repo}.`);
  } else console.log("Validation only. Use --set to upload the matched certificate/password pair.");
}
if (import.meta.main) void main().catch((error) => {
  // Do not print child-process error objects: they can retain sensitive input.
  console.error(error instanceof Error ? error.message : "Signing setup failed");
  process.exitCode = 1;
});
