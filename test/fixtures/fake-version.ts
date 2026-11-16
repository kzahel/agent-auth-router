// Prints a CLI --version line; argv: <output> [count file]. The count file records each run.
import { appendFileSync } from "node:fs";
const [output = "", countFile] = process.argv.slice(2);
if (countFile) appendFileSync(countFile, "run\n");
if (output === "fail") process.exit(1);
process.stdout.write(output + "\n");
