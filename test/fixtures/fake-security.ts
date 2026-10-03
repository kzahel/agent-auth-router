import { readFileSync, writeFileSync } from "node:fs";

const [mode, payloadPath, argvPath, ...args] = process.argv.slice(2);
if (argvPath) writeFileSync(argvPath, JSON.stringify(args));
switch (mode) {
  case "read": process.stdout.write(readFileSync(payloadPath!, "utf8")); break;
  case "missing": process.exitCode = 44; break;
  case "denied": process.stderr.write("SECRET-KEYCHAIN-STDERR sk-ant-SYNTHETIC"); process.exitCode = 36; break;
  case "oversized": process.stdout.write("x".repeat(128 * 1024)); break;
  case "hang": setInterval(() => {}, 1000); break;
  default: process.exitCode = 1;
}
