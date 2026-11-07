// Ariadne-сервер (зона /srv/ariadne на сервере A, порт 3010, только Tailscale).
// Фаза B: раздача обновлений (latest.json + asar).
// Фаза C: аккаунт (логин+пароль, один) и избирательная синхронизация общих
// досок/заметок. Хранилище: data/state.json (атомарная запись) + data/blobs/<sha256>.
// Без зависимостей: только модули Node. Запуск: node ariadane-server.js
// Дизайн: src/DESIGN-sync.md в репозитории Ariadne.
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const HOST = "100.68.27.113"; // только tailnet
const PORT = 3010;
const ROOT = new URL(".", import.meta.url).pathname; // /srv/ariadne/server/
const UPDATES = join(ROOT, "..", "updates");
const DATA = join(ROOT, "..", "data");
const STATE = join(DATA, "state.json");
const BLOBS = join(DATA, "blobs");
const MIME = { ".json": "application/json", ".asar": "application/octet-stream", ".md": "text/markdown" };
const MAX_BODY = 128 * 1024 * 1024; // 128 МБ на блоб/запрос

// ---------- состояние ----------
let S = { account: null, tokens: [], rev: 0, boards: {}, files: {} };

async function loadState() {
  try {
    S = JSON.parse(await readFile(STATE, "utf8"));
  } catch {
    S = { account: null, tokens: [], rev: 0, boards: {}, files: {} };
  }
  await mkdir(BLOBS, { recursive: true });
}

let saveTimer = null;
function saveState() {
  // Дебаунс: частые push не должны молотить диск.
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = `${STATE}.tmp`;
      await writeFile(tmp, JSON.stringify(S), "utf8");
      const { rename } = await import("node:fs/promises");
      await rename(tmp, STATE);
    } catch (e) {
      console.error("saveState:", e.message);
    }
  }, 150);
}

// ---------- помощники ----------
const send = (res, code, body, type = "text/plain; charset=utf-8", extra = {}) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...extra });
  res.end(body);
};
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj), "application/json");

async function readBody(req, limit = MAX_BODY) {
  const chunks = [];
  let got = 0;
  for await (const c of req) {
    got += c.length;
    if (got > limit) throw new Error("тело слишком большое");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 64).toString("hex");
}
function checkPassword(password) {
  const a = S.account;
  const given = Buffer.from(hashPassword(password, a.salt), "hex");
  const stored = Buffer.from(a.pwhash, "hex");
  return given.length === stored.length && timingSafeEqual(given, stored);
}
function authorized(req) {
  const h = req.headers["authorization"] ?? "";
  return h.startsWith("Bearer ") && S.tokens.includes(h.slice(7));
}

/** LWW-строка: входящее побеждает при version > или равной с другим содержимым. */
function applyRow(store, kind, id, incoming) {
  const byKind = store.rows[kind] ?? (store.rows[kind] = {});
  const cur = byKind[id];
  if (cur && incoming.version < cur.version) return false;
  if (cur && incoming.version === cur.version && JSON.stringify(cur.json) === JSON.stringify(incoming.json)) return false;
  byKind[id] = { json: incoming.json, version: incoming.version, deleted: incoming.deleted ? 1 : 0 };
  return true;
}

// ---------- сервер ----------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = url.pathname;

    if (route === "/health") return send(res, 200, "ok");

    // ----- обновления (фаза B) -----
    if (route === "/latest.json") {
      const file = join(UPDATES, "latest.json");
      const st = await stat(file).catch(() => null);
      if (!st) return send(res, 404, "нет опубликованных версий");
      res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
      return createReadStream(file).pipe(res);
    }
    const asar = route.match(/^\/asar\/([A-Za-z0-9._-]+)$/);
    if (asar) {
      const file = normalize(join(UPDATES, "asar", asar[1]));
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
    const sha = route.match(/^\/sha256\/([A-Za-z0-9._-]+)$/);
    if (sha) {
      const file = normalize(join(UPDATES, "asar", sha[1]));
      if (!file.startsWith(join(UPDATES, "asar"))) return send(res, 403, "запрещено");
      const buf = await readFile(file);
      return send(res, 200, createHash("sha256").update(buf).digest("hex"));
    }

    // ----- аккаунт -----
    if (route === "/register" && req.method === "POST") {
      if (S.account) return send(res, 409, "аккаунт уже создан");
      const { login, password } = JSON.parse((await readBody(req, 65536)).toString("utf8"));
      if (!login || String(login).length < 2 || !password || String(password).length < 4)
        return send(res, 400, "логин от 2 символов, пароль от 4");
      const salt = randomBytes(16).toString("hex");
      S.account = { login: String(login), salt, pwhash: hashPassword(password, salt) };
      saveState();
      return send(res, 200, "ok");
    }
    if (route === "/auth" && req.method === "POST") {
      if (!S.account) return send(res, 404, "аккаунта нет — создайте в приложении");
      const { login, password } = JSON.parse((await readBody(req, 65536)).toString("utf8"));
      if (String(login) !== S.account.login || !checkPassword(password))
        return send(res, 403, "неверный логин или пароль");
      const token = randomBytes(32).toString("hex");
      S.tokens.push(token);
      if (S.tokens.length > 20) S.tokens.splice(0, S.tokens.length - 20);
      saveState();
      return sendJson(res, 200, { token, login: S.account.login });
    }

    if (!authorized(req)) return send(res, 401, "нужен токен");

    // ----- синхронизация -----
    if (route === "/sync/state" && req.method === "GET") {
      return sendJson(res, 200, { rev: S.rev, boards: S.boards, files: S.files });
    }

    if (route === "/sync/boards" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      let changed = 0;
      for (const b of body.boards ?? []) {
        const id = b?.board?.id;
        if (!id) continue;
        const store = S.boards[id] ?? { board: null, rows: {} };
        // строка самой доски — LWW по version (updated_at)
        if (!store.board || (b.board.version ?? 0) >= (store.board.version ?? 0)) {
          if (JSON.stringify(store.board?.json ?? null) !== JSON.stringify(b.board.json ?? null) || !store.board) {
            store.board = { json: b.board.json, version: b.board.version ?? 0, deleted: b.board.deleted ? 1 : 0 };
            changed++;
          }
        }
        for (const [kind, rows] of Object.entries(b.rows ?? {}))
          for (const [rowId, row] of Object.entries(rows))
            if (applyRow(store, kind, rowId, row)) changed++;
        S.boards[id] = store;
      }
      if (changed) {
        S.rev += changed;
        saveState();
      }
      return sendJson(res, 200, { rev: S.rev, changed });
    }

    if (route === "/sync/files" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      let changed = 0;
      for (const f of body.files ?? []) {
        if (!f?.path) continue;
        const cur = S.files[f.path];
        if (!cur || cur.sha256 !== f.sha256 || !!cur.deleted !== !!f.deleted) changed++;
        S.files[f.path] = { sha256: f.sha256, size: f.size ?? 0, deleted: f.deleted ? 1 : 0 };
      }
      if (changed) {
        S.rev += changed;
        saveState();
      }
      return sendJson(res, 200, { rev: S.rev, changed });
    }

    const blob = route.match(/^\/blob\/([a-f0-9]{64})$/);
    if (blob && req.method === "PUT") {
      const body = await readBody(req);
      const hash = createHash("sha256").update(body).digest("hex");
      if (hash !== blob[1]) return send(res, 400, "sha256 не совпал");
      const { writeFile: wf } = await import("node:fs/promises");
      await mkdir(BLOBS, { recursive: true });
      await wf(join(BLOBS, hash), body);
      return send(res, 200, "ok");
    }
    if (blob && req.method === "GET") {
      const file = join(BLOBS, blob[1]);
      const st = await stat(file).catch(() => null);
      if (!st?.isFile()) return send(res, 404, "блоба нет");
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": st.size, "cache-control": "no-store" });
      return createReadStream(file).pipe(res);
    }

    return send(res, 404, "не найдено");
  } catch (e) {
    return send(res, 500, `ошибка: ${e.message}`);
  }
});

await loadState();
server.listen(PORT, HOST, () => {
  console.log(`ariadne-server: http://${HOST}:${PORT} (updates + sync)`);
});
