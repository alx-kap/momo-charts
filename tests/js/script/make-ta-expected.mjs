// Regenerates tests/script_cases/ta/expected.json: node tests/js/script/make-ta-expected.mjs
import { mkdirSync, writeFileSync } from "node:fs";

import { FILE, build } from "./ta-cases.mjs";

mkdirSync(new URL("./", FILE), { recursive: true });
writeFileSync(FILE, JSON.stringify(build()) + "\n");
console.log("wrote", FILE.pathname);
