// Заменяет регион src/shared/geometry.ts в собранных файлах на patches/geometry.js.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const geo = readFileSync(join(root, "patches/geometry.js"), "utf8").trimEnd();
const START = "//#region src/shared/geometry.ts";
for (const rel of process.argv.slice(2)) {
	const file = join(root, rel);
	const src = readFileSync(file, "utf8");
	const i = src.indexOf(START);
	const j = src.indexOf("//#endregion", i);
	if (i < 0 || j < 0) throw new Error(`geometry region not found in ${rel}`);
	writeFileSync(file, src.slice(0, i) + geo + src.slice(j + "//#endregion".length));
	console.log(`patched ${rel}`);
}
