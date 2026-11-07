// Ariadne-сервер (зона /srv/ariadne на сервере A, порт 3010, только Tailscale).
// Фаза B: раздача обновлений (latest.json + asar). Фаза C добавит auth/sync.
// Без зависимостей: только модули Node. Запуск: node ariadne-server.js
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createHash } from "node:crypto";

const HOST = "100.68.27.113"; // только tailnet
const PORT = 3010;
const ROOT = new URL(".", import.meta.url).pathname; // /srv/ariadne/server/
const UPDATES = join(ROOT, "..", "updates");
const MIME = { ".json": "application/json", ".asar": "application/octet-stream", ".md": "text/markdown" };

const send = (res, code, body, type = "text/plain; charset=utf-8") => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = url.pathname;

    if (route === "/health") return send(res, 200, "ok");

    if (route === "/latest.json") {
      const file = join(UPDATES, "latest.json");
      const st = await stat(file).catch(() => null);
      if (!st) return send(res, 404, "нет опубликованных версий");
      res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
      return createReadStream(file).pipe(res);
    }

    // /asar/<имя файла> — защита от выхода за пределы папки updates/asar
    const m = route.match(/^\/asar\/([A-Za-z0-9._-]+)$/);
    if (m) {
      const file = normalize(join(UPDATES, "asar", m[1]));
      if (!file.startsWith(join(UPDATES, "asar"))) return send(res, 403, "запрещено");
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) return send(res, 404, "нет такого файла");
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "content-length": st.size,
        "cache-control": "no-store"
      });
      return createReadStream(file).pipe(res);
    }

    // /sha256/<имя файла> — контрольная сумма для проверки скачанного
    const m2 = route.match(/^\/sha256\/([A-Za-z0-9._-]+)$/);
    if (m2) {
      const file = normalize(join(UPDATES, "asar", m2[1]));
      if (!file.startsWith(join(UPDATES, "asar"))) return send(res, 403, "запрещено");
      const buf = await import("node:fs/promises").then((f) => f.readFile(file));
      return send(res, 200, createHash("sha256").update(buf).digest("hex"));
    }

    return send(res, 404, "не найдено");
  } catch (e) {
    return send(res, 500, `ошибка: ${e.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ariadne-server: http://${HOST}:${PORT} (updates)`);
});
