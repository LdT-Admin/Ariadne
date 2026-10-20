// Заменяет LINK_STYLE (толщина, цвета, пунктир) и прозрачность связей в собранных файлах.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const style = readFileSync(join(root, "patches/link-style.js"), "utf8").trimEnd();
for (const rel of process.argv.slice(2)) {
	const file = join(root, rel);
	let src = readFileSync(file, "utf8");
	const i = src.indexOf("var LINK_STYLE = {");
	const j = src.indexOf("\n};", i);
	if (i < 0 || j < 0) throw new Error(`LINK_STYLE not found in ${rel}`);
	src = src.slice(0, i) + style + src.slice(j + 3);
	src = src.replace(/(var LINK_OPACITY = \{\s*normal: )\.55,(\s*highlighted: 1,\s*dimmed: )\.15/, "$1.75,$2.2");
	writeFileSync(file, src);
	console.log(`patched ${rel}`);
}
