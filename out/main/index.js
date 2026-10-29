import { BrowserWindow, app, clipboard, dialog, ipcMain, net, protocol, shell } from "electron";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nanoid } from "nanoid";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Marked } from "marked";
import { argon2id } from "hash-wasm";
import { homedir } from "node:os";
import { Resvg, initWasm } from "@resvg/resvg-wasm";
//#region src/shared/paths.ts
/**
* Папка данных. Порядок: ARIADNE_DATA → рядом с Ariadne.exe (портативная сборка) → <devRoot>/data.
* И приложение, и MCP-сервер (запущенный тем же exe) приходят к одной и той же папке.
*/
function resolveDataDir(devRoot) {
	const dir = process.env.ARIADNE_DATA || (basename(process.execPath).toLowerCase() === "ariadne.exe" ? join(dirname(process.execPath), "data") : join(devRoot, "data"));
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
}
//#endregion
//#region src/shared/db/schema.ts
var MIGRATIONS = [`
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  INSERT INTO meta (key, value) VALUES ('revision', '0');

  CREATE TABLE boards (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    sort_order  REAL NOT NULL DEFAULT 0,
    project_dir TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER
  );

  CREATE TABLE blocks (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL REFERENCES boards(id),
    type        TEXT NOT NULL,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    x           INTEGER NOT NULL,
    y           INTEGER NOT NULL,
    color       TEXT,
    status      TEXT,
    priority    TEXT,
    due_date    TEXT,
    secret_enc  BLOB,            -- только main-процесс приложения; MCP не читает
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deleted_at  INTEGER
  );
  CREATE INDEX blocks_board ON blocks(board_id) WHERE deleted_at IS NULL;

  CREATE TABLE links (
    id          TEXT PRIMARY KEY,
    board_id    TEXT NOT NULL REFERENCES boards(id),
    from_id     TEXT NOT NULL REFERENCES blocks(id),
    to_id       TEXT NOT NULL REFERENCES blocks(id),
    type        TEXT NOT NULL,
    label       TEXT,
    created_at  INTEGER NOT NULL,
    deleted_at  INTEGER
  );
  CREATE INDEX links_board ON links(board_id) WHERE deleted_at IS NULL;
  CREATE INDEX links_from ON links(from_id);
  CREATE INDEX links_to ON links(to_id);

  CREATE TABLE tags (
    id       TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id),
    name     TEXT NOT NULL,
    color    TEXT NOT NULL,
    UNIQUE (board_id, name)
  );
  CREATE TABLE block_tags (
    block_id TEXT NOT NULL REFERENCES blocks(id),
    tag_id   TEXT NOT NULL REFERENCES tags(id),
    PRIMARY KEY (block_id, tag_id)
  );

  CREATE TABLE comments (
    id         TEXT PRIMARY KEY,
    block_id   TEXT NOT NULL REFERENCES blocks(id),
    author     TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE checklist_items (
    id         TEXT PRIMARY KEY,
    block_id   TEXT NOT NULL REFERENCES blocks(id),
    text       TEXT NOT NULL,
    done       INTEGER NOT NULL DEFAULT 0,
    sort_order REAL NOT NULL DEFAULT 0
  );

  -- kind: image | link | file | code
  CREATE TABLE attachments (
    id         TEXT PRIMARY KEY,
    block_id   TEXT NOT NULL REFERENCES blocks(id),
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    url        TEXT,              -- для link
    path       TEXT,              -- относительно data/attachments/<board>/
    language   TEXT,              -- для code
    content    TEXT,              -- для code
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE search_index USING fts5(
    block_id UNINDEXED, board_id UNINDEXED, title, body,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `, `
  ALTER TABLE blocks ADD COLUMN w INTEGER;
  ALTER TABLE blocks ADD COLUMN h INTEGER;
  `];
//#endregion
//#region src/shared/db/open.ts
function openDb(dataDir) {
	const db = new DatabaseSync(join(dataDir, "boards.db"));
	db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
  `);
	db.function("ulower", { deterministic: true }, (s) => typeof s === "string" ? s.toLowerCase() : s);
	migrate(db);
	return db;
}
function migrate(db) {
	const current = db.prepare("PRAGMA user_version").get().user_version;
	for (let v = current; v < MIGRATIONS.length; v++) tx(db, () => {
		db.exec(MIGRATIONS[v]);
		db.exec(`PRAGMA user_version = ${v + 1}`);
	});
}
/** Короткая пишущая транзакция; увеличивает meta.revision. */
function write(db, fn) {
	return tx(db, () => {
		const result = fn();
		db.exec(`UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'`);
		return result;
	});
}
function tx(db, fn) {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = fn();
		db.exec("COMMIT");
		return result;
	} catch (e) {
		db.exec("ROLLBACK");
		throw e;
	}
}
/** Меняется, когда другое соединение (MCP) закоммитило изменения. */
function dataVersion(db) {
	return db.prepare("PRAGMA data_version").get().data_version;
}
//#endregion
//#region src/shared/constants.ts
/** Наибольший размер карточки, который можно растянуть. */
var CARD_MAX_W = 1200;
var CARD_MAX_H = 1200;
var THEME = {
	canvas: "#121212",
	panel: "#181818",
	selected: "#262626",
	border: "#2A2A2A",
	text: "#ECECEC",
	textMuted: "#9B9B9B",
	accent: "#D97757"
};
var BLOCK_TYPES = [
	"component",
	"server",
	"file",
	"task",
	"idea",
	"decision",
	"note"
];
var BLOCK_STYLE = {
	component: {
		color: "#7AA2F7",
		icon: "boxes"
	},
	server: {
		color: "#56B6A6",
		icon: "server"
	},
	file: {
		color: "#A0A8B8",
		icon: "file-code-2"
	},
	task: {
		color: "#E5B567",
		icon: "square-check"
	},
	idea: {
		color: "#B392F0",
		icon: "lightbulb"
	},
	decision: {
		color: "#8CC084",
		icon: "scale"
	},
	note: {
		color: "#A8A29E",
		icon: "notebook-text"
	}
};
var LINK_TYPES = [
	"depends_on",
	"data_flow",
	"hosted_on",
	"blocks",
	"relates_to",
	"implemented_in",
	"spawned_by"
];
/** dash: [штрих, пробел] в экранных px; пустой массив — сплошная */
var LINK_STYLE = {
	depends_on: {
		color: "#A8A8A8",
		width: 2.2,
		dash: []
	},
	data_flow: {
		color: "#7AA2F7",
		width: 1.8,
		dash: [7, 4]
	},
	hosted_on: {
		color: "#56B6A6",
		width: 2,
		dash: [2, 4]
	},
	blocks: {
		color: "#E06C75",
		width: 2.2,
		dash: []
	},
	relates_to: {
		color: "#8A8A8A",
		width: 1.8,
		dash: [2, 4]
	},
	implemented_in: {
		color: "#A0A8B8",
		width: 1.8,
		dash: [
			7,
			3,
			2,
			3
		]
	},
	spawned_by: {
		color: "#8CC084",
		width: 1.8,
		dash: [4, 3]
	}
};
var TASK_STATUSES = [
	"idea",
	"planned",
	"in_progress",
	"done"
];
var STATUS_COLOR = {
	idea: "#9B9B9B",
	planned: "#7AA2F7",
	in_progress: "#D97757",
	done: "#8CC084"
};
var PRIORITIES = [
	"low",
	"medium",
	"high",
	"critical"
];
var PRIORITY_COLOR = {
	low: "#6B6B6B",
	medium: "#A0A8B8",
	high: "#E5B567",
	critical: "#E06C75"
};
/** Палитра тегов и пользовательских цветов блока: приглушённые цвета, читаемые на тёмном фоне. */
var PALETTE = [
	"#7AA2F7",
	"#56B6A6",
	"#E5B567",
	"#B392F0",
	"#8CC084",
	"#E06C75",
	"#D19A66",
	"#61AFEF"
];
var OWNER_AUTHOR = "owner";
//#endregion
//#region src/shared/placement.ts
var snap = (v) => Math.round(v / 20) * 20;
var GAP_X = 40;
var GAP_Y = 40;
var wOf = (r) => r.w ?? 240;
var hOf = (r) => r.h ?? 100;
function overlaps(x, y, w, h, occupied) {
	return occupied.some((o) => x < o.x + wOf(o) + GAP_X && o.x < x + w + GAP_X && y < o.y + hOf(o) + GAP_Y && o.y < y + h + GAP_Y);
}
/**
* Ближайшая свободная позиция вокруг якоря: спиральный обход слотов,
* результат кратен шагу сетки и не пересекает занятые карточки (с зазором) с учётом их размеров.
*/
function findFreeSpot(anchor, occupied, size = {
	w: 240,
	h: 100
}, maxRings = 60) {
	const ax = snap(anchor.x);
	const ay = snap(anchor.y);
	const stepX = Math.max(wOf(anchor), size.w) + GAP_X;
	const stepY = Math.max(hOf(anchor), size.h) + GAP_Y;
	for (let ring = 1; ring <= maxRings; ring++) {
		const candidates = [];
		for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
			if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
			candidates.push({
				x: ax + dx * stepX,
				y: ay + dy * stepY
			});
		}
		candidates.sort((a, b) => dist(a, ax, ay) - dist(b, ax, ay));
		const free = candidates.find((c) => !overlaps(c.x, c.y, size.w, size.h, occupied));
		if (free) return {
			x: snap(free.x),
			y: snap(free.y)
		};
	}
	return {
		x: ax,
		y: snap(ay + (maxRings + 1) * stepY)
	};
}
var dist = (p, x, y) => Math.hypot(p.x - x, (p.y - y) * 1.2);
/** Якорь для нового блока: первый указанный связанный блок (ТЗ 5.2), иначе запасная точка (центр вида / последний блок). */
function pickAnchor(linked, fallback) {
	return linked[0] ?? fallback;
}
//#endregion
//#region src/shared/db/blocks.ts
var BLOCK_COLS = `
  b.id, b.board_id AS boardId, b.type, b.title, b.description, b.x, b.y,
  COALESCE(b.w, 240) AS w, COALESCE(b.h, 100) AS h, b.color,
  b.status, b.priority, b.due_date AS dueDate, (b.secret_enc IS NOT NULL) AS hasSecret,
  (SELECT group_concat(tag_id) FROM block_tags WHERE block_id = b.id) AS tagIds,
  b.created_by AS createdBy, b.created_at AS createdAt, b.updated_at AS updatedAt`;
var toBlock = (r) => ({
	...r,
	hasSecret: r.hasSecret === 1,
	tagIds: r.tagIds ? r.tagIds.split(",") : []
});
function listBlocks(db, boardId) {
	return db.prepare(`SELECT ${BLOCK_COLS} FROM blocks b WHERE b.board_id = ? AND b.deleted_at IS NULL`).all(boardId).map(toBlock);
}
function getBlock(db, id, opts = {}) {
	const row = db.prepare(`SELECT ${BLOCK_COLS} FROM blocks b WHERE b.id = ?` + (opts.withDeleted ? "" : " AND b.deleted_at IS NULL")).get(id);
	return row ? toBlock(row) : null;
}
function createBlock(db, input, author) {
	assertEnum(input.type, BLOCK_TYPES, "тип блока");
	const isTask = input.type === "task";
	const status = isTask ? input.status ?? "planned" : null;
	const priority = isTask ? input.priority ?? "medium" : null;
	if (status) assertEnum(status, TASK_STATUSES, "статус");
	if (priority) assertEnum(priority, PRIORITIES, "приоритет");
	return write(db, () => {
		assertBoard(db, input.boardId);
		const size = clampSize(input.w, input.h);
		const pos = input.x !== void 0 && input.y !== void 0 ? {
			x: snap(input.x),
			y: snap(input.y)
		} : autoPosition(db, input.boardId, input.nearIds ?? [], input.fallback, size);
		const now = Date.now();
		const id = nanoid(10);
		db.prepare(`INSERT INTO blocks (id, board_id, type, title, description, x, y, w, h, color, status, priority, due_date,
                           created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.boardId, input.type, input.title.trim(), input.description ?? "", pos.x, pos.y, size.w === 240 ? null : size.w, size.h === 100 ? null : size.h, input.color ?? null, status, priority, isTask ? input.dueDate ?? null : null, author, now, now);
		reindexBlock(db, id);
		touchBoard(db, input.boardId, now);
		return getBlock(db, id);
	});
}
var RECT_COLS = `x, y, COALESCE(w, 240) AS w, COALESCE(h, 100) AS h`;
/** Размер карточки: по сетке, не меньше стандартного и не больше CARD_MAX_*. */
function clampSize(w, h) {
	return {
		w: Math.min(CARD_MAX_W, Math.max(240, snap(w ?? 240))),
		h: Math.min(CARD_MAX_H, Math.max(100, snap(h ?? 100)))
	};
}
function autoPosition(db, boardId, nearIds, fallback, size) {
	const occupied = db.prepare(`SELECT ${RECT_COLS} FROM blocks WHERE board_id = ? AND deleted_at IS NULL`).all(boardId);
	const linked = nearIds.map((id) => db.prepare(`SELECT ${RECT_COLS} FROM blocks WHERE id = ? AND deleted_at IS NULL`).get(id)).filter(Boolean);
	const last = db.prepare(`SELECT ${RECT_COLS} FROM blocks WHERE board_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`).get(boardId);
	const anchor = pickAnchor(linked, fallback ?? last ?? {
		x: 0,
		y: 0
	});
	if (occupied.length === 0) return {
		x: snap(anchor.x),
		y: snap(anchor.y)
	};
	return findFreeSpot(anchor, occupied, size);
}
var PATCH_COLUMNS = {
	type: "type",
	title: "title",
	description: "description",
	color: "color",
	status: "status",
	priority: "priority",
	dueDate: "due_date"
};
function updateBlock(db, id, patch) {
	if (patch.type) assertEnum(patch.type, BLOCK_TYPES, "тип блока");
	if (patch.status) assertEnum(patch.status, TASK_STATUSES, "статус");
	if (patch.priority) assertEnum(patch.priority, PRIORITIES, "приоритет");
	return write(db, () => {
		const current = requireBlock(db, id);
		const fields = /* @__PURE__ */ new Map();
		for (const [key, col] of Object.entries(PATCH_COLUMNS)) {
			if (patch[key] === void 0) continue;
			fields.set(col, key === "title" ? String(patch[key]).trim() : patch[key]);
		}
		if ((patch.type ?? current.type) === "task") {
			if (current.type !== "task") {
				if (!fields.get("status")) fields.set("status", "planned");
				if (!fields.get("priority")) fields.set("priority", "medium");
			}
		} else {
			fields.delete("status");
			fields.delete("priority");
			fields.delete("due_date");
			if (current.type === "task") for (const col of [
				"status",
				"priority",
				"due_date"
			]) fields.set(col, null);
		}
		if (fields.size === 0) return current;
		const sets = [...fields.keys()].map((col) => `${col} = ?`);
		const values = [...fields.values()];
		const now = Date.now();
		db.prepare(`UPDATE blocks SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, now, id);
		reindexBlock(db, id);
		touchBoard(db, current.boardId, now);
		return getBlock(db, id);
	});
}
/** Размер карточки (владелец тянет за угол или агент задаёт). Стандартный размер хранится как NULL. */
function resizeBlock(db, id, w, h, x, y) {
	return write(db, () => {
		requireBlock(db, id);
		const s = clampSize(w, h);
		db.prepare(`UPDATE blocks SET w = ?, h = ?, updated_at = ? WHERE id = ?`).run(s.w === 240 ? null : s.w, s.h === 100 ? null : s.h, Date.now(), id);
		if (x !== void 0 && y !== void 0) db.prepare(`UPDATE blocks SET x = ?, y = ? WHERE id = ?`).run(snap(x), snap(y), id);
		return getBlock(db, id);
	});
}
/** Перемещение многих блоков одной транзакцией (авто-раскладка, групповой drag). */
function moveBlocks(db, moves) {
	write(db, () => {
		const st = db.prepare(`UPDATE blocks SET x = ?, y = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`);
		const now = Date.now();
		for (const m of moves) st.run(snap(m.x), snap(m.y), now, m.id);
	});
}
/** Мягкое удаление: блок и его связи уходят в корзину с одной меткой времени. */
function deleteBlock(db, id) {
	write(db, () => {
		const b = requireBlock(db, id);
		const now = Date.now();
		db.prepare(`UPDATE blocks SET deleted_at = ? WHERE id = ?`).run(now, id);
		db.prepare(`UPDATE links SET deleted_at = ? WHERE (from_id = ? OR to_id = ?) AND deleted_at IS NULL`).run(now, id, id);
		touchBoard(db, b.boardId, now);
	});
}
/** Восстановление из корзины вместе со связями, удалёнными в тот же момент (если второй конец жив). */
function restoreBlock(db, id) {
	return write(db, () => {
		const row = db.prepare(`SELECT deleted_at AS deletedAt, board_id AS boardId FROM blocks WHERE id = ?`).get(id);
		if (!row) throw new Error(`Блок ${id} не найден`);
		if (row.deletedAt === null) return getBlock(db, id);
		assertBoard(db, row.boardId);
		db.prepare(`UPDATE blocks SET deleted_at = NULL WHERE id = ?`).run(id);
		db.prepare(`UPDATE links SET deleted_at = NULL
       WHERE deleted_at = ? AND (from_id = ? OR to_id = ?)
         AND NOT EXISTS (SELECT 1 FROM blocks o
                         WHERE o.id IN (links.from_id, links.to_id) AND o.deleted_at IS NOT NULL)`).run(row.deletedAt, id, id);
		touchBoard(db, row.boardId, Date.now());
		return getBlock(db, id);
	});
}
/** Перестроить запись полнотекстового индекса: название + описание + теги + комментарии. */
function reindexBlock(db, id) {
	db.prepare(`DELETE FROM search_index WHERE block_id = ?`).run(id);
	const b = db.prepare(`SELECT board_id AS boardId, title, description FROM blocks WHERE id = ?`).get(id);
	if (!b) return;
	const extra = db.prepare(`SELECT group_concat(t, ' ') AS text FROM (
         SELECT tg.name AS t FROM block_tags bt JOIN tags tg ON tg.id = bt.tag_id WHERE bt.block_id = ?
         UNION ALL SELECT body FROM comments WHERE block_id = ?)`).get(id, id);
	db.prepare(`INSERT INTO search_index (block_id, board_id, title, body) VALUES (?, ?, ?, ?)`).run(id, b.boardId, b.title, `${b.description} ${extra.text ?? ""}`);
}
function requireBlock(db, id) {
	const b = getBlock(db, id);
	if (!b) throw new Error(`Блок ${id} не найден (или лежит в корзине)`);
	return b;
}
function assertBoard(db, boardId) {
	if (!db.prepare(`SELECT 1 FROM boards WHERE id = ? AND deleted_at IS NULL`).get(boardId)) throw new Error(`Доска ${boardId} не найдена (или лежит в корзине)`);
}
function touchBoard(db, boardId, now) {
	db.prepare(`UPDATE boards SET updated_at = ? WHERE id = ?`).run(now, boardId);
}
function assertEnum(value, allowed, what) {
	if (!allowed.includes(value)) throw new Error(`Недопустимый ${what}: «${value}». Допустимо: ${allowed.join(", ")}`);
}
//#endregion
//#region src/shared/db/links.ts
var COLS$2 = `id, board_id AS boardId, from_id AS fromId, to_id AS toId, type, label`;
function listLinks(db, boardId) {
	return db.prepare(`SELECT ${COLS$2} FROM links WHERE board_id = ? AND deleted_at IS NULL`).all(boardId);
}
function linksOfBlock(db, blockId) {
	return db.prepare(`SELECT ${COLS$2} FROM links WHERE (from_id = ? OR to_id = ?) AND deleted_at IS NULL`).all(blockId, blockId);
}
function createLink(db, fromId, toId, type, label = null) {
	assertLinkType(type);
	if (fromId === toId) throw new Error("Нельзя связать блок с самим собой");
	return write(db, () => {
		const from = requireBlock(db, fromId);
		const to = requireBlock(db, toId);
		if (from.boardId !== to.boardId) throw new Error("Блоки находятся на разных досках");
		const existing = db.prepare(`SELECT ${COLS$2} FROM links WHERE from_id = ? AND to_id = ? AND type = ? AND deleted_at IS NULL`).get(fromId, toId, type);
		if (existing) return existing;
		const id = nanoid(10);
		const now = Date.now();
		db.prepare(`INSERT INTO links (id, board_id, from_id, to_id, type, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, from.boardId, fromId, toId, type, label, now);
		touchBoard(db, from.boardId, now);
		return {
			id,
			boardId: from.boardId,
			fromId,
			toId,
			type,
			label
		};
	});
}
function updateLink(db, id, patch) {
	if (patch.type) assertLinkType(patch.type);
	return write(db, () => {
		const next = {
			...requireLink(db, id),
			...patch
		};
		db.prepare(`UPDATE links SET type = ?, label = ? WHERE id = ?`).run(next.type, next.label, id);
		return next;
	});
}
function deleteLink(db, id) {
	write(db, () => {
		requireLink(db, id);
		db.prepare(`UPDATE links SET deleted_at = ? WHERE id = ?`).run(Date.now(), id);
	});
}
function restoreLink(db, id) {
	return write(db, () => {
		if (db.prepare(`SELECT 1 FROM links l JOIN blocks f ON f.id = l.from_id JOIN blocks t ON t.id = l.to_id
         WHERE l.id = ? AND (f.deleted_at IS NOT NULL OR t.deleted_at IS NOT NULL)`).get(id)) throw new Error("Сначала восстановите связанные блоки");
		db.prepare(`UPDATE links SET deleted_at = NULL WHERE id = ?`).run(id);
		return requireLink(db, id);
	});
}
function requireLink(db, id) {
	const l = db.prepare(`SELECT ${COLS$2} FROM links WHERE id = ? AND deleted_at IS NULL`).get(id);
	if (!l) throw new Error(`Связь ${id} не найдена (или лежит в корзине)`);
	return l;
}
function assertLinkType(type) {
	if (!LINK_TYPES.includes(type)) throw new Error(`Недопустимый тип связи: «${type}». Допустимо: ${LINK_TYPES.join(", ")}`);
}
//#endregion
//#region src/shared/db/tags.ts
var COLS$1 = `id, board_id AS boardId, name, color`;
function listTags(db, boardId) {
	return db.prepare(`SELECT ${COLS$1} FROM tags WHERE board_id = ? ORDER BY name`).all(boardId);
}
/** Найти тег по имени или создать (цвет — заданный или следующий из палитры). Без транзакции — вызывать внутри write. */
function ensureTag(db, boardId, name, color) {
	const clean = name.trim();
	const found = db.prepare(`SELECT ${COLS$1} FROM tags WHERE board_id = ? AND ulower(name) = ulower(?)`).get(boardId, clean);
	if (found) return found;
	const { n } = db.prepare(`SELECT count(*) AS n FROM tags WHERE board_id = ?`).get(boardId);
	const tag = {
		id: nanoid(10),
		boardId,
		name: clean,
		color: color ?? PALETTE[n % PALETTE.length]
	};
	db.prepare(`INSERT INTO tags (id, board_id, name, color) VALUES (?, ?, ?, ?)`).run(tag.id, boardId, clean, tag.color);
	return tag;
}
/** Заменить набор тегов блока. Отсутствующие теги создаются на лету. */
function setBlockTags(db, blockId, names) {
	return write(db, () => {
		const b = requireBlock(db, blockId);
		const unique = /* @__PURE__ */ new Map();
		for (const n of names.map((s) => s.trim()).filter(Boolean)) if (!unique.has(n.toLowerCase())) unique.set(n.toLowerCase(), n);
		const tags = [...unique.values()].map((n) => ensureTag(db, b.boardId, n));
		db.prepare(`DELETE FROM block_tags WHERE block_id = ?`).run(blockId);
		const ins = db.prepare(`INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)`);
		for (const t of tags) ins.run(blockId, t.id);
		reindexBlock(db, blockId);
		return tags;
	});
}
function updateTag(db, id, patch) {
	write(db, () => {
		if (patch.name !== void 0) db.prepare(`UPDATE tags SET name = ? WHERE id = ?`).run(patch.name.trim(), id);
		if (patch.color !== void 0) db.prepare(`UPDATE tags SET color = ? WHERE id = ?`).run(patch.color, id);
	});
}
//#endregion
//#region src/shared/db/boards.ts
var COLS = `id, name, sort_order AS sortOrder, project_dir AS projectDir, created_at AS createdAt, updated_at AS updatedAt`;
function listBoards(db) {
	return db.prepare(`SELECT ${COLS} FROM boards WHERE deleted_at IS NULL ORDER BY sort_order, created_at`).all();
}
function getBoard(db, id) {
	return db.prepare(`SELECT ${COLS} FROM boards WHERE id = ? AND deleted_at IS NULL`).get(id) ?? null;
}
function createBoard(db, name) {
	return write(db, () => {
		const now = Date.now();
		const id = nanoid(10);
		const { next } = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM boards`).get();
		db.prepare(`INSERT INTO boards (id, name, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(id, name.trim(), next, now, now);
		return getBoard(db, id);
	});
}
function renameBoard(db, id, name) {
	write(db, () => db.prepare(`UPDATE boards SET name = ?, updated_at = ? WHERE id = ?`).run(name.trim(), Date.now(), id));
}
function setBoardProjectDir(db, id, dir) {
	write(db, () => db.prepare(`UPDATE boards SET project_dir = ? WHERE id = ?`).run(dir, id));
}
/** Новый порядок досок: массив id сверху вниз. */
function reorderBoards(db, ids) {
	write(db, () => {
		const st = db.prepare(`UPDATE boards SET sort_order = ? WHERE id = ?`);
		ids.forEach((id, i) => st.run(i + 1, id));
	});
}
function deleteBoard(db, id) {
	write(db, () => db.prepare(`UPDATE boards SET deleted_at = ? WHERE id = ?`).run(Date.now(), id));
}
function restoreBoard(db, id) {
	write(db, () => db.prepare(`UPDATE boards SET deleted_at = NULL WHERE id = ?`).run(id));
}
function getGraph(db, boardId) {
	const attachments = db.prepare(`SELECT a.id, a.block_id AS blockId, a.kind, a.name, a.url, a.language,
              CASE WHEN a.kind = 'code' THEN substr(a.content, 1, 600) END AS snippet
       FROM attachments a JOIN blocks b ON b.id = a.block_id
       WHERE b.board_id = ? AND b.deleted_at IS NULL ORDER BY a.created_at`).all(boardId);
	return {
		boardId,
		blocks: listBlocks(db, boardId),
		links: listLinks(db, boardId),
		tags: listTags(db, boardId),
		attachments
	};
}
//#endregion
//#region src/shared/i18n/ru.ts
var ru = {
	app: {
		title: "Ariadne",
		/** Заголовок окна при открытой доске (docs/NAME.md §2) */
		windowTitle: (board) => `${board} — Ariadne`
	},
	sidebar: {
		newBoard: "Новая доска",
		trash: "Корзина",
		rename: "Переименовать",
		delete: "В корзину",
		untitled: "Без названия",
		boardMenu: "Действия с доской",
		exportAll: "Экспорт PNG — вся доска",
		exportView: "Экспорт PNG — видимая область",
		exported: (path) => `PNG сохранён: ${path}`
	},
	trash: {
		title: "Корзина",
		hint: "Всё удалённое — и вами, и агентами — лежит здесь, пока вы не очистите корзину.",
		empty: "Корзина пуста",
		boards: "Доски",
		blocks: "Блоки",
		links: "Связи",
		restore: "Восстановить",
		purge: "Очистить корзину",
		purgeConfirm: "Удалить всё безвозвратно?",
		close: "Закрыть корзину",
		deletedAt: (date) => `удалено ${date}`
	},
	sections: {
		notes: "Заметки (Ctrl+1)",
		boards: "Доски (Ctrl+2)"
	},
	notes: {
		newNote: "Новая заметка",
		untitled: "Новая заметка",
		empty: "Заметок пока нет. Создайте первую или положите .md файл в папку заметок.",
		noneSelected: "Выберите заметку слева или создайте новую.",
		trash: "Корзина",
		created: (d) => `Создано ${d}`,
		modified: (d) => `Изменено ${d}`,
		tools: {
			find: "Найти в заметке (Ctrl+F)",
			findPlaceholder: "Найти в заметке…",
			findCount: (i, n) => n ? `${i} из ${n}` : "нет",
			prev: "Предыдущее (Shift+Enter)",
			next: "Следующее (Enter)",
			close: "Закрыть (Esc)",
			toc: "Оглавление",
			tocEmpty: "В заметке нет заголовков",
			history: "История версий",
			pdf: "Экспорт в PDF",
			pdfDone: (path) => `PDF сохранён: ${path}`
		},
		history: {
			title: (name) => `История версий — ${name}`,
			hint: "Хранятся 20 последних версий: перед записью агента, перед изменением снаружи и при вашей правке не чаще раза в 5 минут.",
			empty: "Версий пока нет — они появятся после правок.",
			current: "Сейчас",
			reasons: {
				owner: "Ваша правка",
				agent: "Запись агента",
				external: "Изменено снаружи",
				restore: "Перед возвратом версии"
			},
			compare: "Отличия: «−» — только в этой версии, «+» — только в текущем тексте",
			same: "Совпадает с текущим текстом",
			restore: "Вернуть эту версию",
			restored: "Версия возвращена (текущий текст сохранён в истории)",
			close: "Закрыть"
		},
		agents: {
			access: "Доступ агентов",
			accessHint: "Агенты работают с заметками только через MCP Ariadne. Новая заметка закрыта для всех; права меняет только владелец.",
			levels: {
				none: "Нет доступа",
				read: "Только чтение",
				write: "Чтение и запись"
			},
			fsWarning: "Не держите папку заметок в рабочей папке агента: оттуда Claude Code может прочитать файл напрямую.",
			send: "Отправить агенту",
			sendHint: "Готовый промпт с заметкой копируется в буфер — вставьте его в Claude Code или Z Code.",
			includeHidden: "Включить скрытые значения (только в этот раз)",
			copyPrompt: "Скопировать промпт",
			copied: (hidden) => hidden ? "Промпт скопирован, скрытые значения — [скрыто]" : "Промпт скопирован"
		},
		boardNotes: {
			title: "Заметки доски",
			toggle: "Привязка к заметкам",
			hint: "По умолчанию доски и заметки не связаны. Включите, чтобы привязать к доске нужные .md: они видны значком на доске, а агенту с доступом — в обзоре доски.",
			none: "Заметок пока нет",
			add: "Привязать заметку…",
			create: "Новая заметка для доски",
			unlink: "Отвязать (файл останется)",
			open: "Открыть в «Заметках»",
			openWindow: "Открыть в отдельном окне",
			button: (n) => `Заметки доски (${n})`
		},
		compact: {
			openInMain: "Открыть в Ariadne",
			addToNotes: "Добавить в заметки",
			external: (dir) => `Внешний файл: ${dir}`,
			missing: "Файл не найден — возможно, его переместили или удалили.",
			confirmTitle: "Переместить файл в заметки?",
			confirmText: (from, to) => `Файл «${from}» будет перемещён в папку заметок (${to}) вместе с его вложениями. Ссылки на старое расположение перестанут работать.`,
			confirmMove: "Переместить",
			cancel: "Отмена",
			added: (name) => `Добавлено в заметки: ${name}`
		},
		addFile: "Добавить файл (.md) — переместить в папку заметок",
		dropMd: "Отпустите, чтобы добавить .md в заметки",
		pinned: "Закреплённые",
		ungrouped: "Без группы",
		search: "Поиск по заметкам (Ctrl+Shift+F)",
		searchPlaceholder: "Название или текст…",
		searchNothing: "Ничего не найдено",
		menu: {
			openWindow: "Открыть в новом окне",
			pin: "Закрепить",
			unpin: "Открепить",
			rename: "Переименовать",
			moveToGroup: "Переместить в группу",
			newGroup: "Новая группа…",
			newGroupPlaceholder: "Название группы",
			removeFromGroup: "Убрать из группы",
			delete: "Удалить",
			renameGroup: "Переименовать группу",
			deleteGroup: "Удалить группу (заметки останутся)"
		},
		groupDrop: "Отпустите, чтобы переместить в группу",
		titlePlaceholder: "Название заметки",
		titleHint: "Название — это имя .md файла. Enter — сохранить, Esc — отменить",
		saving: "Сохраняю…",
		saved: "Сохранено",
		placeholder: "Начните писать… (визуальный редактор появится на этапе З2, файл — обычный .md)",
		changedOutside: "Файл изменён снаружи, пока вы печатали.",
		reload: "Обновить",
		keepMine: "Оставить моё",
		deletedOutside: "Заметка удалена или переименована снаружи.",
		trashTitle: "Корзина заметок",
		trashHint: "Удалённые заметки лежат здесь, пока вы не очистите корзину.",
		trashEmpty: "Корзина пуста",
		restore: "Восстановить",
		purge: "Очистить корзину",
		purgeConfirm: "Удалить безвозвратно?",
		restoredAs: (name) => `Восстановлено: «${name}»`
	},
	editor: {
		bold: "Жирный (Ctrl+B)",
		italic: "Курсив (Ctrl+I)",
		strike: "Зачёркнутый (Ctrl+Shift+S)",
		underline: "Подчёркнутый (Ctrl+U)",
		heading: (n) => `Заголовок ${n} (Ctrl+Alt+${n})`,
		bullet: "Маркированный список (Ctrl+Shift+8)",
		ordered: "Нумерованный список (Ctrl+Shift+7)",
		task: "Чек-лист (Ctrl+Shift+9)",
		quote: "Цитата (Ctrl+Shift+B)",
		code: "Код в строке (Ctrl+E)",
		codeBlock: "Блок кода (Ctrl+Alt+C)",
		rule: "Разделитель",
		link: "Ссылка (Ctrl+K)",
		unlink: "Убрать ссылку",
		table: "Таблица",
		fontSize: "Размер текста",
		fontSizeHint: "Размер текста, 10–150 px: введите число (Enter), стрелки ↑↓, или потяните мышью влево/вправо",
		fontSizeList: "Стандартные размеры",
		fontSizeNormal: "обычный",
		color: "Цвет текста",
		resetColor: "Без цвета",
		linkPlaceholder: "https://… или mailto:…",
		linkHint: (href) => `${href}\nКлик — открыть · Ctrl+клик — поставить курсор (править текст ссылки)`,
		more: "Ещё",
		image: "Картинка (или вставьте скриншот: Ctrl+V)",
		file: "Прикрепить файл",
		hide: "Скрыть значение (Ctrl+Shift+H)",
		img: {
			left: "Слева, текст обтекает справа",
			none: "Без обтекания",
			right: "Справа, текст обтекает слева",
			resize: "Потяните, чтобы изменить размер",
			broken: "Картинка не найдена",
			remove: "Удалить картинку"
		},
		fileCard: {
			open: "Открыть",
			show: "Показать в папке",
			missing: "Файл не найден",
			linked: "ссылка на оригинал",
			copied: "копия в папке заметки",
			remove: "Убрать из заметки"
		},
		attach: {
			title: (n) => n === 1 ? "Как прикрепить файл?" : `Как прикрепить файлы (${n})?`,
			copy: "Скопировать в папку заметки",
			copyHint: "Файл копируется рядом с заметкой, ссылка относительная — при переносе на флешку всё остаётся.",
			link: "Ссылка на оригинал",
			linkHint: "Ссылка по полному пути на диске — на другом компьютере перестанет работать.",
			cancel: "Отмена"
		},
		hidden: {
			show: "Показать",
			hide: "Скрыть",
			copy: "Копировать значение",
			copied: "Значение скопировано",
			hint: "Скрыто только на экране: в .md файле значение лежит открытым текстом (это не шифрование)"
		},
		tableLabel: "Таблица:",
		apply: "Применить",
		copy: "Копировать",
		copied: "Скопировано",
		plainText: "текст",
		menu: {
			cut: "Вырезать",
			copy: "Копировать",
			copyMd: "Копировать как Markdown",
			paste: "Вставить",
			pasteRich: "Вставить с форматированием",
			selectAll: "Выделить всё"
		},
		tableBar: {
			rowAbove: "Строка выше",
			rowBelow: "Строка ниже",
			colLeft: "Столбец слева",
			colRight: "Столбец справа",
			delRow: "Удалить строку",
			delCol: "Удалить столбец",
			shade: "Закрасить выбранные ячейки серым (повторно — снять)",
			header: "Строка-заголовок: закрасить выбранную строку (станет первой); повторно — обычная строка",
			rowUp: "Переместить строку вверх",
			rowDown: "Переместить строку вниз",
			delTable: "Удалить таблицу",
			dragRow: "Перетащите, чтобы переставить строку"
		}
	},
	notesSettings: {
		title: "Папка заметок",
		hint: "Заметки — обычные .md файлы в этой папке. При смене папки всё переносится: заметки, корзина, вложения; старая папка удаляется только после проверки копий.",
		warning: "Держите папку заметок вне рабочих папок агентов: доступ через MCP ограничивается, но Claude Code может прочитать любой файл в своей рабочей папке напрямую.",
		change: "Сменить папку…",
		byDefault: "по умолчанию — Sessions рядом с программой",
		moved: (n, path) => `Перенесено файлов: ${n} → ${path}`,
		assocTitle: "Открывать .md в Ariadne",
		assocHint: "Двойной клик по любому .md откроет его в компактном окне Ariadne. По умолчанию реестр не трогается; включение пишет ассоциацию только для текущего пользователя, «Убрать» возвращает всё как было. Без этого всегда работают: перетаскивание файла в окно и «Открыть с помощью».",
		assocOn: "Включено",
		assocOff: "Выключено",
		assocEnable: "Включить",
		assocDisable: "Убрать",
		assocUpdate: "Обновить путь",
		assocStale: "Ассоциация указывает на старое расположение программы (флешку переподключили под другой буквой?).",
		assocChoice: (prog) => `Сейчас Windows открывает .md через «${prog}» (выбор пользователя). Один раз: правый клик по .md → «Открыть с помощью» → Ariadne → «Всегда».`,
		assocStaleBanner: "Ассоциация .md указывает на старое расположение Ariadne.",
		assocLater: "Не сейчас",
		assocDone: "Ассоциация .md обновлена"
	},
	settings: {
		title: "Настройки",
		close: "Закрыть",
		agentsTitle: "Подключить агента",
		agentsHint: "Прописывает MCP-сервер ariadne-board в конфиг агента. После подключения перезапустите сессию агента. Если папку Ariadne перенесли — нажмите «Обновить путь».",
		status: {
			connected: "Подключено",
			outdated: "Путь устарел",
			missing: "Не подключено"
		},
		connect: "Подключить",
		reconnect: "Обновить путь",
		copyJson: "Скопировать JSON",
		copyCli: "Скопировать команду",
		copied: "Скопировано в буфер обмена",
		connected: (name) => `${name}: сервер ariadne-board прописан. Перезапустите сессию агента.`,
		manualHint: "Не получилось записать автоматически? Вставьте JSON в настройки агента вручную.",
		serverMissing: "MCP-сервер не собран — выполните npm run build:mcp",
		projectTitle: (board) => `Папка проекта доски «${board}»`,
		projectHint: "В эту папку Ariadne пишет PROJECT_BOARD.md — свежий обзор доски для агента — и, по кнопке, инструкции в CLAUDE.md / AGENTS.md.",
		noProject: "Папка не выбрана",
		chooseDir: "Выбрать папку…",
		unlink: "Отвязать",
		writeInstructions: "Записать инструкции",
		instructionsResult: {
			created: "создан",
			updated: "обновлён",
			appended: "дополнен",
			unchanged: "без изменений"
		},
		noBoard: "Выберите доску в левой панели"
	},
	hotkeys: {
		title: "Горячие клавиши",
		list: [
			["N", "Новый блок (меню типов)"],
			["L", "Режим «Добавить связь»"],
			["Alt + перетаскивание", "Протянуть связь от блока"],
			["R", "Размер выделенной карточки"],
			["Delete", "Выделенный блок — в корзину"],
			["Ctrl+F / Ctrl+K", "Поиск по всем доскам"],
			["Shift+F", "Фильтры"],
			["M", "Мини-карта"],
			["+ / −", "Приблизить / отдалить"],
			["Shift+A", "Авто-раскладка доски"],
			["Ctrl+E", "Экспорт доски в PNG"],
			["Shift+1", "Показать всю доску"],
			["Ctrl+Z / Ctrl+Y", "Отменить / повторить"],
			["F1 или ?", "Эта справка"],
			["Esc", "Закрыть панель, выйти из режима"]
		]
	},
	vault: {
		setupTitle: "Задайте мастер-пароль",
		setupText: "Им шифруются защищённые поля блоков — пароли, ключи, адреса. Агенты эти поля не видят. Пароль спрашивается при каждом запуске.",
		setupWarning: "Восстановить мастер-пароль невозможно: забыли — защищённые поля потеряны.",
		unlockTitle: "Введите мастер-пароль",
		unlockText: "Без него защищённые поля останутся заблокированными, остальная доска работает.",
		password: "Мастер-пароль",
		repeat: "Повторите пароль",
		create: "Создать",
		open: "Открыть",
		later: "Позже",
		skip: "Пропустить",
		wrong: "Неверный пароль",
		mismatch: "Пароли не совпадают",
		checking: "Проверяю…",
		field: "Защищённое поле",
		fieldHint: "Пароли, ключи, IP. Видно только вам: не попадает ни к агентам, ни в обзор, ни в снимки и PNG.",
		placeholder: "Например: root / пароль, API-ключ, адрес сервера…",
		show: "Показать",
		hide: "Скрыть",
		locked: "Заблокировано — введите мастер-пароль",
		notSet: "Сначала задайте мастер-пароль",
		unlockButton: "Ввести пароль",
		setupButton: "Задать пароль",
		settingsTitle: "Мастер-пароль",
		statusNone: "Не задан — защищённые поля недоступны",
		statusLocked: "Задан, хранилище заблокировано",
		statusUnlocked: "Задан, хранилище открыто",
		lockNow: "Заблокировать",
		change: "Сменить пароль",
		current: "Текущий пароль",
		newPassword: "Новый пароль",
		changed: "Мастер-пароль изменён"
	},
	filters: {
		types: "Тип блока",
		statuses: "Статус задачи",
		tags: "Теги",
		links: "Типы связей",
		dim: "Приглушать",
		hide: "Скрывать",
		reset: "Сбросить",
		active: "Фильтр включён"
	},
	search: {
		placeholder: "Поиск по всем доскам: названия, описания, теги, комментарии…",
		empty: "Ничего не найдено",
		hint: "↑↓ — выбор, Enter — перейти, Esc — закрыть",
		board: "Доска"
	},
	sendToAgent: {
		button: "Отправить агенту",
		hint: "Скопировать готовый промпт с контекстом задачи",
		copied: "Промпт скопирован — вставьте его в Claude Code или Z Code"
	},
	undo: {
		undone: (what) => `Отменено: ${what}`,
		redone: (what) => `Повторено: ${what}`,
		nothingToUndo: "Нечего отменять",
		nothingToRedo: "Нечего повторять",
		failed: (what) => `Не удалось отменить «${what}» — возможно, это уже изменил агент или очищена корзина`,
		move: "перемещение",
		resize: "размер карточки",
		autoLayout: "авто-раскладка",
		createBlock: "создание блока",
		deleteBlock: "удаление блока",
		editBlock: "изменение блока",
		tags: "изменение тегов",
		tagColor: "цвет тега",
		createLink: "создание связи",
		deleteLink: "удаление связи",
		linkType: "смена типа связи",
		renameBoard: "переименование доски",
		deleteBoard: "удаление доски",
		reorderBoards: "порядок досок",
		createBoard: "создание доски",
		checklist: "изменение чек-листа",
		restore: "восстановление из корзины"
	},
	toolbar: {
		addBlock: "Добавить блок",
		addLink: "Добавить связь",
		resize: "Размер карточки",
		resizeHint: "Размер карточки — сначала выделите карточку",
		resizeModeHint: "Тяните за углы карточки: больше места — больше текста и вложений. Esc — выход.",
		linkModeHint: "Протяните нить от одного блока к другому. Alt + перетаскивание — то же без режима. Esc — выход.",
		chooseLinkType: "Тип связи",
		autoLayout: "Авто-раскладка",
		layingOut: "Раскладываю доску…",
		laidOut: (n) => `Разложено блоков: ${n}. Отменить — Ctrl+Z`,
		zoomIn: "Приблизить",
		zoomOut: "Отдалить",
		fit: "Показать всё"
	},
	topbar: {
		search: "Поиск",
		minimap: "Мини-карта",
		filters: "Фильтры",
		hotkeys: "Горячие клавиши",
		settings: "Настройки"
	},
	empty: {
		noBoards: "Создайте первую доску в Ariadne",
		emptyBoard: "Доска пуста. Добавьте блок или попросите агента заполнить её."
	},
	blockType: {
		component: "Компонент",
		server: "Сервер / инфраструктура",
		file: "Файл / модуль кода",
		task: "Задача",
		idea: "Идея",
		decision: "Решение",
		note: "Заметка / документация"
	},
	linkType: {
		depends_on: "Зависит от",
		data_flow: "Передаёт данные",
		hosted_on: "Размещено на",
		blocks: "Блокирует",
		relates_to: "Относится к",
		implemented_in: "Реализовано в",
		spawned_by: "Порождено решением"
	},
	status: {
		idea: "Идея",
		planned: "В планах",
		in_progress: "В работе",
		done: "Готово"
	},
	priority: {
		low: "Низкий",
		medium: "Средний",
		high: "Высокий",
		critical: "Критичный"
	},
	author: { owner: "Я" },
	block: { newTitle: "Новый блок" },
	panel: {
		close: "Закрыть",
		toTrash: "В корзину",
		titlePlaceholder: "Без названия",
		type: "Тип",
		color: "Цвет",
		colorByType: "По типу",
		status: "Статус",
		priority: "Приоритет",
		due: "Срок",
		tags: "Теги",
		tagPlaceholder: "Добавить тег…",
		tagColor: "Цвет тега",
		description: "Описание",
		descriptionPlaceholder: "Добавьте описание… (поддерживается Markdown)",
		edit: "Изменить",
		save: "Сохранить",
		cancel: "Отмена",
		editHint: "Ctrl+Enter — сохранить, Esc — отмена",
		checklist: "Чек-лист",
		checklistPlaceholder: "Добавить пункт…",
		attachments: "Вложения",
		addFile: "Файл",
		addLink: "Ссылка",
		addCode: "Код",
		linkUrl: "https://…",
		linkName: "Название (необязательно)",
		codeName: "Название фрагмента",
		codePlaceholder: "Вставьте код…",
		pasteHint: "Скриншот можно вставить через Ctrl+V",
		showMore: "Показать целиком",
		showLess: "Свернуть",
		tooBig: "Файл слишком большой для превью — откройте его",
		links: "Связи",
		noLinks: "Связей нет",
		outgoing: "исходящая",
		incoming: "входящая",
		deleteLink: "Удалить связь",
		comments: "Комментарии",
		commentPlaceholder: "Комментарий… (Ctrl+Enter — отправить)",
		send: "Отправить",
		deleteConfirm: "Удалить безвозвратно?",
		delete: "Удалить",
		created: (author, date) => `Создал ${author} · ${date}`,
		pastedName: "скриншот"
	},
	dev: {
		loadBoard: "Стенд 3000 / 6000",
		stats: (fps, cards, tiles) => `${fps} FPS · карточек ${cards} · тайлов связей ${tiles}`
	}
};
//#endregion
//#region src/shared/markdown.ts
/** Markdown → простой текст для карточки, обзора агенту и т.п.: без разметки, в одну строку. */
function markdownToPlain(src) {
	return src.replace(/```[\s\S]*?```/g, " ").replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "").replace(/^\s*[-*_]{3,}\s*$/gm, " ").replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, "$2").replace(/\s+/g, " ").trim();
}
//#endregion
//#region src/shared/db/details.ts
function listComments(db, blockId) {
	return db.prepare(`SELECT id, block_id AS blockId, author, body, created_at AS createdAt
       FROM comments WHERE block_id = ? ORDER BY created_at`).all(blockId);
}
function addComment(db, blockId, author, body) {
	if (!body.trim()) throw new Error("Пустой комментарий");
	return write(db, () => {
		requireBlock(db, blockId);
		const c = {
			id: nanoid(10),
			blockId,
			author,
			body: body.trim(),
			createdAt: Date.now()
		};
		db.prepare(`INSERT INTO comments (id, block_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`).run(c.id, blockId, author, c.body, c.createdAt);
		reindexBlock(db, blockId);
		return c;
	});
}
function deleteComment(db, id) {
	write(db, () => {
		const row = db.prepare(`SELECT block_id AS blockId FROM comments WHERE id = ?`).get(id);
		db.prepare(`DELETE FROM comments WHERE id = ?`).run(id);
		if (row) reindexBlock(db, row.blockId);
	});
}
function listChecklist(db, blockId) {
	return db.prepare(`SELECT id, block_id AS blockId, text, done, sort_order AS sortOrder
       FROM checklist_items WHERE block_id = ? ORDER BY sort_order`).all(blockId).map((r) => ({
		...r,
		done: r.done === 1
	}));
}
function addChecklistItems(db, blockId, texts) {
	return write(db, () => {
		requireBlock(db, blockId);
		const { max } = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS max FROM checklist_items WHERE block_id = ?`).get(blockId);
		const ins = db.prepare(`INSERT INTO checklist_items (id, block_id, text, done, sort_order) VALUES (?, ?, ?, 0, ?)`);
		return texts.map((t) => t.trim()).filter(Boolean).map((text, i) => {
			const item = {
				id: nanoid(10),
				blockId,
				text,
				done: false,
				sortOrder: max + i + 1
			};
			ins.run(item.id, blockId, text, item.sortOrder);
			return item;
		});
	});
}
function updateChecklistItem(db, id, patch) {
	write(db, () => {
		if (patch.text !== void 0) db.prepare(`UPDATE checklist_items SET text = ? WHERE id = ?`).run(patch.text, id);
		if (patch.done !== void 0) db.prepare(`UPDATE checklist_items SET done = ? WHERE id = ?`).run(patch.done ? 1 : 0, id);
	});
}
function deleteChecklistItem(db, id) {
	write(db, () => db.prepare(`DELETE FROM checklist_items WHERE id = ?`).run(id));
}
var ATT_COLS = `id, block_id AS blockId, kind, name, url, path, language, content,
  created_by AS createdBy, created_at AS createdAt`;
function listAttachments(db, blockId) {
	return db.prepare(`SELECT ${ATT_COLS} FROM attachments WHERE block_id = ? ORDER BY created_at`).all(blockId);
}
function addAttachment(db, blockId, input, author) {
	if (input.kind === "link" && !input.url) throw new Error("Для ссылки нужен url");
	if (input.kind === "code" && !input.content) throw new Error("Для фрагмента кода нужен content");
	if ((input.kind === "file" || input.kind === "image") && !input.path) throw new Error("Для файла нужен path");
	return write(db, () => {
		requireBlock(db, blockId);
		const a = {
			id: nanoid(10),
			blockId,
			kind: input.kind,
			name: input.name,
			url: input.url ?? null,
			path: input.path ?? null,
			language: input.language ?? null,
			content: input.content ?? null,
			createdBy: author,
			createdAt: Date.now()
		};
		db.prepare(`INSERT INTO attachments (id, block_id, kind, name, url, path, language, content, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(a.id, blockId, a.kind, a.name, a.url, a.path, a.language, a.content, author, a.createdAt);
		return a;
	});
}
/** Удаляет запись; возвращает относительный путь файла (если был), чтобы вызывающий удалил файл. */
function deleteAttachment(db, id) {
	return write(db, () => {
		const row = db.prepare(`SELECT path FROM attachments WHERE id = ?`).get(id);
		db.prepare(`DELETE FROM attachments WHERE id = ?`).run(id);
		return row?.path ?? null;
	});
}
function getBlockDetails(db, id) {
	const block = getBlock(db, id);
	if (!block) return null;
	return {
		block,
		comments: listComments(db, id),
		checklist: listChecklist(db, id),
		attachments: listAttachments(db, id),
		links: linksOfBlock(db, id)
	};
}
//#endregion
//#region src/shared/agent/queries.ts
var PRIORITY_RANK = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3
};
var STATUS_RANK = {
	in_progress: 0,
	planned: 1,
	idea: 2,
	done: 3
};
var short = (s, n) => {
	const p = markdownToPlain(s);
	return p.length > n ? p.slice(0, n - 1).trimEnd() + "…" : p;
};
var tagNames = (b, tags) => b.tagIds.map((id) => tags.get(id)?.name).filter(Boolean);
/** Полная карточка блока: описание, теги, чек-лист, комментарии с авторами, вложения, связи с названиями. */
function blockFull(db, id) {
	const d = getBlockDetails(db, id);
	if (!d) return null;
	const tags = new Map(listTags(db, d.block.boardId).map((t) => [t.id, t]));
	const { hasSecret: _h, tagIds: _t, ...block } = d.block;
	return {
		...block,
		tags: tagNames(d.block, tags),
		checklist: d.checklist.map((i) => ({
			id: i.id,
			text: i.text,
			done: i.done
		})),
		comments: d.comments.map((c) => ({
			author: c.author === "owner" ? "владелец" : c.author,
			text: c.body,
			at: new Date(c.createdAt).toISOString()
		})),
		attachments: d.attachments.map((a) => ({
			id: a.id,
			kind: a.kind,
			name: a.name,
			...a.url && { url: a.url },
			...a.kind === "code" && {
				language: a.language,
				content: a.content
			}
		})),
		links: d.links.map((l) => {
			const out = l.fromId === id;
			const other = getBlock(db, out ? l.toId : l.fromId);
			return {
				id: l.id,
				direction: out ? "out" : "in",
				type: l.type,
				label: ru.linkType[l.type],
				other: other && {
					id: other.id,
					type: other.type,
					title: other.title
				}
			};
		})
	};
}
var taskOrder = (a, b) => STATUS_RANK[a.status ?? "planned"] - STATUS_RANK[b.status ?? "planned"] || PRIORITY_RANK[a.priority ?? "medium"] - PRIORITY_RANK[b.priority ?? "medium"] || a.createdAt - b.createdAt;
/** Контекст задачи: связанные блоки с описаниями и решения/файлы связанных компонентов (второй шаг). */
function taskContext(db, taskId) {
	const seen = /* @__PURE__ */ new Set([taskId]);
	const direct = linksOfBlock(db, taskId).map((l) => ({
		l,
		b: getBlock(db, l.fromId === taskId ? l.toId : l.fromId)
	})).filter((x) => !!x.b && !seen.has(x.b.id) && (seen.add(x.b.id), true));
	const related = direct.map(({ l, b }) => ({
		id: b.id,
		type: b.type,
		title: b.title,
		relation: `${ru.linkType[l.type]} (${l.fromId === taskId ? "задача →" : "→ задача"})`,
		description: short(b.description, 1500),
		...b.status && { status: b.status }
	}));
	const second = [];
	for (const { b } of direct) {
		if (b.type !== "component" && b.type !== "server") continue;
		for (const l of linksOfBlock(db, b.id)) {
			const o = getBlock(db, l.fromId === b.id ? l.toId : l.fromId);
			if (!o || seen.has(o.id) || o.type !== "decision" && o.type !== "file") continue;
			seen.add(o.id);
			second.push({
				id: o.id,
				type: o.type,
				title: o.title,
				via: b.title,
				description: short(o.description, 600)
			});
			if (second.length >= 12) break;
		}
	}
	return {
		related,
		alsoRelevant: second
	};
}
/** Полнотекстовый поиск по названию, описанию, тегам и комментариям; все доски или одна. */
function search(db, query, boardId, limit = 20) {
	const terms = query.split(/\s+/).map((w) => w.replace(/["*]/g, "")).filter(Boolean);
	if (!terms.length) throw new Error("Пустой запрос");
	const fts = terms.map((w) => `"${w}"*`).join(" ");
	const hits = db.prepare(`SELECT s.block_id AS id, b.type, b.title, d.id AS boardId, d.name AS board,
              snippet(search_index, 3, '«', '»', '…', 12) AS snippet
       FROM search_index s JOIN blocks b ON b.id = s.block_id JOIN boards d ON d.id = b.board_id
       WHERE search_index MATCH ? AND b.deleted_at IS NULL AND d.deleted_at IS NULL ${boardId ? "AND b.board_id = ?" : ""}
       ORDER BY rank LIMIT ?`).all(...boardId ? [
		fts,
		boardId,
		limit
	] : [fts, limit]);
	const boards = db.prepare(`SELECT id, name FROM boards WHERE deleted_at IS NULL AND ulower(name) LIKE '%' || ulower(?) || '%'`).all(query.trim());
	return {
		blocks: hits,
		...boards.length && { boards }
	};
}
//#endregion
//#region src/shared/agent/overview.ts
/** Связи, описывающие устройство системы (в отличие от «относится к» у задач и заметок). */
var STRUCTURAL = [
	"depends_on",
	"data_flow",
	"hosted_on",
	"implemented_in",
	"spawned_by",
	"blocks"
];
var LIMITS = {
	components: 40,
	files: 25,
	tasks: 30,
	decisions: 10,
	ideas: 12,
	notes: 12,
	edges: 90,
	perZone: 6,
	comments: 6
};
var date = (ms) => new Date(ms).toLocaleDateString("ru-RU", {
	day: "numeric",
	month: "short",
	year: "numeric"
});
var more = (n, hint) => n > 0 ? `\n- … и ещё ${n} (${hint})` : "";
/**
* Компактный обзор доски для начала сессии агента (ТЗ 8.2–8.3): что это за проект, из чего состоит,
* как разложено на доске, открытые задачи, последние решения, сжатая карта связей.
* Markdown, рассчитан на несколько тысяч токенов; подробности — get_block / get_graph.
*/
function buildOverview(db, boardId) {
	const board = getBoard(db, boardId);
	if (!board) throw new Error(`Доска ${boardId} не найдена`);
	const blocks = listBlocks(db, boardId);
	const links = listLinks(db, boardId);
	const tags = new Map(listTags(db, boardId).map((t) => [t.id, t]));
	const byId = new Map(blocks.map((b) => [b.id, b]));
	const of = (type) => blocks.filter((b) => b.type === type);
	const ref = (b) => `«${b.title}» (${b.id})`;
	const out = [];
	const counts = Object.keys(ru.blockType).map((t) => [t, of(t).length]).filter(([, n]) => n > 0).map(([t, n]) => `${ru.blockType[t].toLowerCase()}: ${n}`);
	out.push(`# Доска «${board.name}» (${board.id})`);
	out.push(blocks.length ? `Блоков ${blocks.length} (${counts.join(", ")}), связей ${links.length}. Обновлено ${date(board.updatedAt).replace(/\.$/, "")}.` : "Доска пуста. Заполните её: изучите проект и создайте блоки (create_block) и связи (create_link).");
	if (!blocks.length) return out.join("\n");
	out.push("Подробности блока — get_block, все блоки с фильтрами — get_graph, поиск — search.");
	const outgoing = /* @__PURE__ */ new Map();
	const degree = /* @__PURE__ */ new Map();
	for (const l of links) {
		if (!outgoing.has(l.fromId)) outgoing.set(l.fromId, []);
		outgoing.get(l.fromId).push(l);
		for (const id of [l.fromId, l.toId]) degree.set(id, (degree.get(id) ?? 0) + 1);
	}
	const relations = (b, types) => types.map((t) => {
		const targets = (outgoing.get(b.id) ?? []).filter((l) => l.type === t).map((l) => byId.get(l.toId)?.title).filter(Boolean);
		return targets.length ? `${ru.linkType[t].toLowerCase()}: ${targets.slice(0, 5).join(", ")}${targets.length > 5 ? "…" : ""}` : "";
	}).filter(Boolean);
	const tagsOf = (b) => b.tagIds.map((id) => tags.get(id)?.name).filter(Boolean);
	const x0 = Math.min(...blocks.map((b) => b.x)), x1 = Math.max(...blocks.map((b) => b.x + b.w));
	const y0 = Math.min(...blocks.map((b) => b.y)), y1 = Math.max(...blocks.map((b) => b.y + b.h));
	const spread = x1 - x0 > 840 || y1 - y0 > 840;
	const zone = (b) => {
		if (!spread) return "";
		const cx = (b.x + b.w / 2 - x0) / (x1 - x0), cy = (b.y + b.h / 2 - y0) / (y1 - y0);
		return [cx < 1 / 3 ? "слева" : cx < 2 / 3 ? "" : "справа", cy < 1 / 3 ? "сверху" : cy < 2 / 3 ? "" : "снизу"].filter(Boolean).join(" ") || "в центре";
	};
	const core = [...of("component"), ...of("server")].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0));
	if (core.length) {
		out.push("", "## Компоненты и инфраструктура");
		for (const b of core.slice(0, LIMITS.components)) {
			const parts = [
				b.description && short(b.description, 140),
				tagsOf(b).length && `теги: ${tagsOf(b).join(", ")}`,
				...relations(b, [
					"hosted_on",
					"depends_on",
					"data_flow",
					"implemented_in"
				]),
				zone(b) && `на доске: ${zone(b)}`
			].filter(Boolean);
			out.push(`- **${b.title}** (${b.type === "server" ? "сервер" : "компонент"}, ${b.id})${parts.length ? " — " + parts.join(" · ") : ""}`);
		}
		out.push(more(core.length - LIMITS.components, "get_graph types=[component,server]"));
	}
	const files = of("file");
	if (files.length) {
		out.push("", "## Файлы и модули кода");
		for (const b of files.slice(0, LIMITS.files)) {
			const impl = links.filter((l) => l.type === "implemented_in" && l.toId === b.id).map((l) => byId.get(l.fromId)?.title).filter(Boolean);
			out.push(`- ${ref(b)}${b.description ? " — " + short(b.description, 90) : ""}${impl.length ? ` · реализует: ${impl.join(", ")}` : ""}`);
		}
		out.push(more(files.length - LIMITS.files, "get_graph types=[file]"));
	}
	if (tags.size) {
		const groups = [...tags.values()].map((t) => ({
			t,
			list: blocks.filter((b) => b.tagIds.includes(t.id))
		})).filter((g) => g.list.length).sort((a, b) => b.list.length - a.list.length);
		if (groups.length) {
			out.push("", "## Группы по тегам");
			for (const g of groups.slice(0, 15)) {
				const sample = g.list.slice(0, 6).map((b) => b.title).join(", ");
				out.push(`- **${g.t.name}** (${g.list.length}): ${sample}${g.list.length > 6 ? "…" : ""}`);
			}
		}
	}
	if (spread) {
		const zones = /* @__PURE__ */ new Map();
		for (const b of [
			...core,
			...of("decision"),
			...of("note")
		]) {
			const z = zone(b);
			if (!zones.has(z)) zones.set(z, []);
			zones.get(z).push(b);
		}
		if (zones.size > 1) {
			out.push("", "## Как разложено на доске");
			for (const z of [
				"слева сверху",
				"сверху",
				"справа сверху",
				"слева",
				"в центре",
				"справа",
				"слева снизу",
				"снизу",
				"справа снизу"
			]) {
				const list = zones.get(z);
				if (list?.length) out.push(`- ${z}: ${list.slice(0, LIMITS.perZone).map((b) => b.title).join(", ")}${list.length > LIMITS.perZone ? "…" : ""}`);
			}
		}
	}
	const open = of("task").filter((b) => b.status !== "done").sort(taskOrder);
	const done = of("task").length - open.length;
	if (of("task").length) {
		out.push("", `## Открытые задачи (${open.length}; готово: ${done})`);
		if (!open.length) out.push("- открытых задач нет");
		for (const b of open.slice(0, LIMITS.tasks)) {
			const rel = (outgoing.get(b.id) ?? []).filter((l) => l.type === "relates_to").map((l) => byId.get(l.toId)?.title).filter(Boolean);
			const waits = links.filter((l) => l.type === "blocks" && l.toId === b.id).map((l) => byId.get(l.fromId)).filter((x) => x && x.status !== "done").map((x) => x.title);
			const parts = [
				b.description && short(b.description, 100),
				rel.length && `относится к: ${rel.join(", ")}`,
				waits.length && `ждёт: ${waits.join(", ")}`,
				b.dueDate && `срок ${b.dueDate}`
			].filter(Boolean);
			out.push(`- [${ru.priority[b.priority ?? "medium"].toLowerCase()} · ${ru.status[b.status ?? "planned"]}] ${ref(b)}${parts.length ? " — " + parts.join(" · ") : ""}`);
		}
		out.push(more(open.length - LIMITS.tasks, "list_tasks"));
	}
	const decisions = of("decision").sort((a, b) => b.updatedAt - a.updatedAt);
	if (decisions.length) {
		out.push("", "## Последние решения");
		for (const b of decisions.slice(0, LIMITS.decisions)) {
			const about = links.filter((l) => (l.fromId === b.id || l.toId === b.id) && l.type !== "spawned_by").map((l) => byId.get(l.fromId === b.id ? l.toId : l.fromId)?.title).filter(Boolean);
			out.push(`- **${b.title}** (${date(b.updatedAt)}, ${b.id})${b.description ? " — " + short(b.description, 220) : ""}${about.length ? ` · касается: ${about.slice(0, 4).join(", ")}` : ""}`);
		}
		out.push(more(decisions.length - LIMITS.decisions, "get_graph types=[decision]"));
	}
	for (const [type, title, limit] of [[
		"idea",
		"Идеи",
		LIMITS.ideas
	], [
		"note",
		"Заметки и документация",
		LIMITS.notes
	]]) {
		const list = of(type).sort((a, b) => b.updatedAt - a.updatedAt);
		if (!list.length) continue;
		out.push("", `## ${title}`);
		for (const b of list.slice(0, limit)) out.push(`- ${ref(b)}${b.description ? " — " + short(b.description, 80) : ""}`);
		out.push(more(list.length - limit, `get_graph types=[${type}]`));
	}
	const edges = links.filter((l) => STRUCTURAL.includes(l.type));
	if (edges.length) {
		out.push("", "## Карта связей");
		for (const l of edges.slice(0, LIMITS.edges)) {
			const a = byId.get(l.fromId), b = byId.get(l.toId);
			if (a && b) out.push(`- ${a.title} —${ru.linkType[l.type].toLowerCase()}→ ${b.title}`);
		}
		out.push(more(edges.length - LIMITS.edges, "get_graph"));
	}
	const comments = db.prepare(`SELECT c.author, c.body, c.created_at AS at, b.title FROM comments c JOIN blocks b ON b.id = c.block_id
       WHERE b.board_id = ? AND b.deleted_at IS NULL ORDER BY c.created_at DESC LIMIT ?`).all(boardId, LIMITS.comments);
	if (comments.length) {
		out.push("", "## Последние комментарии");
		for (const c of comments) out.push(`- ${date(c.at)}, ${c.author === "owner" ? "владелец" : c.author} → «${c.title}»: ${short(c.body, 160)}`);
	}
	return out.filter((line) => line !== "").join("\n").replace(/\n## /g, "\n\n## ");
}
//#endregion
//#region src/shared/agent/overviewFile.ts
var OVERVIEW_FILE = "PROJECT_BOARD.md";
var DEBOUNCE_MS$1 = 2e3;
var header = (boardName) => `<!-- Сгенерировано Ariadne по доске «${boardName}». Не редактируйте: файл перезаписывается при изменениях доски.\n     Агенту: актуальные данные и запись на доску — через MCP-сервер ariadne-board (get_overview, get_block). -->\n\n`;
/** Записать обзор доски в её папку проекта, если содержимое изменилось. Возвращает путь или null. */
function writeOverviewFile(db, board) {
	if (!board.projectDir || !existsSync(board.projectDir)) return null;
	const file = join(board.projectDir, OVERVIEW_FILE);
	const content = header(board.name) + buildOverview(db, board.id) + "\n";
	if (existsSync(file) && readFileSync(file, "utf8") === content) return file;
	writeFileSync(file + ".tmp", content, "utf8");
	renameSync(file + ".tmp", file);
	return file;
}
/**
* Авто-обзор (ТЗ 8.1 п.5): после изменений (с паузой 2 с) переписывает PROJECT_BOARD.md у всех досок
* с заданной папкой проекта. Работает и в приложении, и в MCP-сервере — кто изменил, тот и обновил.
* Срабатывает только если сменилась meta.revision, поэтому poke() можно звать часто.
*/
var OverviewWriter = class {
	db;
	onError;
	timer = null;
	lastRevision = -1;
	constructor(db, onError = () => {}) {
		this.db = db;
		this.onError = onError;
	}
	poke() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush(), DEBOUNCE_MS$1);
	}
	flush() {
		this.timer = null;
		try {
			const rev = Number(this.db.prepare(`SELECT value FROM meta WHERE key = 'revision'`).get().value);
			if (rev === this.lastRevision) return;
			this.lastRevision = rev;
			for (const b of listBoards(this.db)) if (b.projectDir) writeOverviewFile(this.db, b);
		} catch (e) {
			this.onError(e);
		}
	}
};
//#endregion
//#region src/shared/notes/assets.ts
/**
* Картинки и файлы заметок (ТЗ заметок §3, §5.6, §5.7): копии лежат в `<папка заметок>/_assets/<заметка>/`,
* в `.md` — относительная ссылка `_assets/<заметка>/<файл>`; «ссылка на оригинал» — полный путь `file:///…`.
* Здесь только строки (без fs) — нужно и редактору, и main, и тестам.
*/
var ASSETS_PREFIX = "_assets/";
/** Схема, по которой окно показывает картинки из папки заметок (обслуживает main, см. main/notesAssets.ts). */
var ASSET_SCHEME = "ariadne-asset";
var IMAGE_EXT$1 = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
var isImagePath = (p) => IMAGE_EXT$1.test(p);
/** Ссылка на вложение (а не на сайт): копия в `_assets/` или файл на диске. */
var isAttachmentHref = (href) => href.startsWith("_assets/") || /^file:/i.test(href);
/** Для `.md`: пробелы, скобки и угловые скобки кодируем (иначе ломают ссылку), кириллицу оставляем читаемой. */
var encodeHref = (href) => href.replace(/[ ()<>]/g, (c) => encodeURIComponent(c));
/** Из `.md`/HTML в редактор: `%20` и `%D0%…` → обычные символы. */
function decodeHref(href) {
	try {
		return decodeURI(href);
	} catch {
		return href;
	}
}
/** Адрес картинки для окна: вложение — через свою схему, остальное (http, data) — как есть. */
function assetUrl(src, host = "notes") {
	if (!src.startsWith("_assets/")) return src;
	return `${ASSET_SCHEME}://${host}/${src.split("/").map(encodeURIComponent).join("/")}`;
}
/** Имя файла из ссылки (для подписи карточки). */
function fileNameOf(href) {
	const clean = decodeHref(href).replace(/[?#].*$/, "");
	return clean.split(/[\\/]/).pop() || clean;
}
/**
* Переименовали заметку — относительные ссылки на её папку вложений тоже (в обоих написаниях).
* Только в начале ссылки (`](…`, `src="…`, `<…`): полный путь `file:///…/_assets/…` — «ссылка на оригинал», его не трогаем.
*/
function retargetAssets(md, from, to) {
	const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	let out = md;
	for (const [a, b] of [[`${ASSETS_PREFIX}${from}/`, `${ASSETS_PREFIX}${to}/`], [encodeHref(`${ASSETS_PREFIX}${from}/`), encodeHref(`${ASSETS_PREFIX}${to}/`)]]) out = out.replace(new RegExp(`(\\]\\(|src="|<)${reEsc(a)}`, "g"), (_m, lead) => lead + b);
	return out;
}
/** Открывать двойным кликом опасно (запустит программу) — для таких только «Показать в папке». */
var RUNNABLE_EXT = /\.(exe|msi|bat|cmd|com|ps1|vbs|vbe|js|jse|wsf|wsh|scr|lnk|hta|cpl|reg|jar)$/i;
//#endregion
//#region src/shared/notes/store.ts
/**
* Заметки (ТЗ заметок §3): источник правды — сами `.md` файлы, плоско в одной папке.
* Служебное — в `<папка>/.ariadne/` (корзина, позже группы, доступ, история), вложения — в `<папка>/_assets/<заметка>/`.
* В базе приложения заметки не хранятся.
*/
var META_DIR = ".ariadne";
var ASSETS_DIR = "_assets";
var TRASH_DIR = join(META_DIR, "trash");
var FORBIDDEN = /[\\/:*?"<>|\x00-\x1f]/g;
var RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
/** Название → допустимое имя файла Windows (без расширения). */
function safeName$1(title) {
	let n = title.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
	if (!n || RESERVED.test(n)) n = n ? `${n}_` : "Без названия";
	return n.slice(0, 150);
}
/**
* Атомарная запись: во временный файл рядом, сброс на диск, переименование поверх.
* При сбое или выдёргивании флешки остаётся либо старая, либо новая версия — не обрезанная.
*/
function atomicWrite(file, content) {
	const tmp = join(file, "..", `.${basename(file)}.${randomBytes(4).toString("hex")}.tmp`);
	const fd = openSync(tmp, "w");
	try {
		writeSync(fd, typeof content === "string" ? Buffer.from(content, "utf8") : content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmp, file);
	} catch (e) {
		rmSync(tmp, { force: true });
		throw e;
	}
}
var sha = (buf) => createHash("sha256").update(buf).digest("hex");
var NotesStore = class {
	dir;
	/** Что мы сами записали последним — чтобы наблюдатель не принимал своё за внешнее изменение. */
	written = /* @__PURE__ */ new Map();
	/** ensureMeta: false — чужая папка (внешний .md в компактном окне): служебную `.ariadne/` там не создаём. */
	constructor(dir, ensureMeta = true) {
		this.dir = dir;
		if (ensureMeta) mkdirSync(join(dir, TRASH_DIR), { recursive: true });
	}
	file(name) {
		const f = join(this.dir, `${name}.md`);
		if (relative(this.dir, f).includes("..") || basename(f) !== `${name}.md`) throw new Error(`Недопустимое имя заметки: «${name}»`);
		return f;
	}
	list() {
		return readdirSync(this.dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md") && !e.name.startsWith(".")).map((e) => {
			const st = statSync(join(this.dir, e.name));
			return {
				name: e.name.slice(0, -3),
				modifiedAt: st.mtimeMs,
				createdAt: st.birthtimeMs || st.ctimeMs,
				size: st.size
			};
		});
	}
	exists(name) {
		return existsSync(this.file(name));
	}
	read(name) {
		return readFileSync(this.file(name), "utf8");
	}
	write(name, content) {
		const f = this.file(name);
		this.written.set(name, sha(content));
		atomicWrite(f, content);
		const st = statSync(f);
		return {
			name,
			modifiedAt: st.mtimeMs,
			createdAt: st.birthtimeMs || st.ctimeMs,
			size: st.size
		};
	}
	/** Свободное имя: «Новая заметка», «Новая заметка 2», … */
	freeName(title) {
		const base = safeName$1(title);
		let n = base;
		for (let i = 2; existsSync(this.file(n)); i++) n = `${base} ${i}`;
		return n;
	}
	create(title, content = "") {
		return this.write(this.freeName(title), content);
	}
	/**
	* Переименовать (название заметки = имя файла): вложения `_assets/<имя>/` — следом.
	* Имя занято другой заметкой — ошибка, ничего не трогаем; смена только регистра — разрешена.
	*/
	rename(from, title) {
		const to = safeName$1(title);
		if (to === from) return from;
		const src = this.file(from);
		if (!existsSync(src)) throw new Error(`Заметки «${from}» нет`);
		if (to.toLowerCase() !== from.toLowerCase() && existsSync(this.file(to))) throw new Error(`Заметка «${to}» уже есть`);
		renameSync(src, this.file(to));
		this.written.delete(from);
		const assets = join(this.dir, ASSETS_DIR, from);
		if (existsSync(assets)) {
			renameSync(assets, join(this.dir, ASSETS_DIR, to));
			const md = this.read(to);
			const next = retargetAssets(md, from, to);
			if (next !== md) this.write(to, next);
			else this.written.set(to, sha(md));
		} else this.written.set(to, sha(readFileSync(this.file(to))));
		return to;
	}
	/**
	* «Добавить файл» (ТЗ заметок §6): внешний .md переезжает в папку заметок (имя занято — «имя 2»);
	* его вложения `_assets/<имя>/` рядом с ним — следом. На другой диск — копия, сверка, потом удаление.
	*/
	addFile(srcPath) {
		if (!/\.md$/i.test(srcPath)) throw new Error("Добавить можно только .md файл");
		const base = basename(srcPath).slice(0, -3);
		const name = this.freeName(base);
		moveFile(srcPath, this.file(name));
		const assets = join(srcPath, "..", ASSETS_DIR, base);
		if (existsSync(assets)) {
			for (const f of walk(assets)) moveFile(join(assets, f), join(this.dir, ASSETS_DIR, name, f));
			rmSync(assets, {
				recursive: true,
				force: true
			});
			if (name !== base) {
				const md = this.read(name);
				const next = retargetAssets(md, base, name);
				if (next !== md) this.write(name, next);
			}
		}
		return name;
	}
	/** Папка вложений заметки; имя файла — без перезаписи: «shot.png», «shot 2.png», … (создание с флагом wx). */
	reserveAsset(note, fileName) {
		this.file(note);
		const dir = join(this.dir, ASSETS_DIR, note);
		mkdirSync(dir, { recursive: true });
		const clean = safeName$1(fileName.replace(/\.[^.]*$/, "")) || "file";
		const ext = /\.[^.\\/]+$/.exec(fileName)?.[0]?.toLowerCase() ?? "";
		for (let i = 1;; i++) {
			const name = `${clean}${i > 1 ? ` ${i}` : ""}${ext}`;
			const abs = join(dir, name);
			try {
				closeSync(openSync(abs, "wx"));
				return {
					abs,
					rel: `${ASSETS_DIR}/${note}/${name}`
				};
			} catch (e) {
				if (e.code !== "EEXIST") throw e;
			}
		}
	}
	/** Скриншот из буфера и т.п.: байты → файл в папке вложений; возвращает относительную ссылку. */
	saveAsset(note, fileName, bytes) {
		const { abs, rel } = this.reserveAsset(note, fileName);
		atomicWrite(abs, bytes);
		return rel;
	}
	/** «Скопировать в папку заметки»: копия файла с диска; возвращает относительную ссылку. */
	importFile(note, srcPath) {
		const { abs, rel } = this.reserveAsset(note, basename(srcPath));
		copyFileSync(srcPath, abs);
		return rel;
	}
	/** Ссылка из заметки → путь на диске (копия в `_assets/` — только внутри папки заметок; `file:` — как есть). */
	resolveHref(href) {
		const h = decodeHref(href);
		if (/^file:/i.test(h)) return fileURLToPath(encodeURI(h).replace(/%25/g, "%"));
		if (!h.startsWith("_assets/")) throw new Error("Это не вложение заметки");
		const abs = resolve(this.dir, h);
		if (relative(join(this.dir, "_assets"), abs).startsWith("..")) throw new Error("Ссылка ведёт за папку заметок");
		return abs;
	}
	/** Для карточки файла: есть ли файл и его размер. */
	fileInfo(href) {
		try {
			const path = this.resolveHref(href);
			const st = statSync(path);
			return {
				exists: st.isFile(),
				size: st.size,
				path
			};
		} catch {
			return {
				exists: false,
				size: 0,
				path: ""
			};
		}
	}
	/** Своя ли это запись (тот же текст, что мы писали) — тогда событие наблюдателя игнорируем. */
	isOwnWrite(name) {
		const mine = this.written.get(name);
		if (!mine) return false;
		try {
			return sha(readFileSync(this.file(name))) === mine;
		} catch {
			return false;
		}
	}
	/** В корзину: файл переносится в `.ariadne/trash/<время>__<имя>.md` — восстанавливается, очищается только вручную. */
	trash(name) {
		const ts = Date.now();
		mkdirSync(join(this.dir, TRASH_DIR), { recursive: true });
		renameSync(this.file(name), join(this.dir, TRASH_DIR, `${ts}__${name}.md`));
		this.written.delete(name);
	}
	listTrash() {
		return readdirSync(join(this.dir, TRASH_DIR)).filter((f) => /^\d+__.+\.md$/.test(f)).map((f) => {
			const [ts, ...rest] = f.slice(0, -3).split("__");
			return {
				id: f,
				name: rest.join("__"),
				deletedAt: Number(ts)
			};
		}).sort((a, b) => b.deletedAt - a.deletedAt);
	}
	/** Вернуть из корзины; если имя занято — «имя (восстановлено)», без перезаписи. */
	restore(id) {
		const src = join(this.dir, TRASH_DIR, basename(id));
		if (!existsSync(src)) throw new Error("Заметки нет в корзине");
		const item = this.listTrash().find((t) => t.id === basename(id));
		const name = existsSync(this.file(item.name)) ? this.freeName(`${item.name} (восстановлено)`) : item.name;
		renameSync(src, this.file(name));
		return name;
	}
	purgeTrash() {
		const items = this.listTrash();
		for (const t of items) rmSync(join(this.dir, TRASH_DIR, t.id), { force: true });
		return items.length;
	}
};
/** Переместить файл; между дисками — копия со сверкой SHA-256, затем удаление оригинала. */
function moveFile(src, dst) {
	mkdirSync(join(dst, ".."), { recursive: true });
	if (existsSync(dst)) throw new Error(`Файл уже есть: ${dst}`);
	try {
		renameSync(src, dst);
		return;
	} catch (e) {
		if (e.code !== "EXDEV") throw e;
	}
	copyFileSync(src, dst);
	if (sha(readFileSync(src)) !== sha(readFileSync(dst))) {
		rmSync(dst, { force: true });
		throw new Error(`Копия не совпала с оригиналом: ${src}`);
	}
	rmSync(src, { force: true });
}
/** Все файлы папки заметок (кроме временных), относительными путями. */
function walk(dir, base = dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p, base));
		else if (e.isFile() && !e.name.endsWith(".tmp")) out.push(relative(base, p));
	}
	return out;
}
/**
* Перенести всё содержимое папки заметок в новую (ТЗ заметок §3): заметки, служебные файлы, вложения.
* Безопасно: 1) конфликты имён — отказ, ничего не трогаем; 2) копирование; 3) сверка размера и SHA-256
* каждого файла; 4) только потом удаление старых. Ошибка на шаге 2–3 — скопированное удаляется (откат).
*/
function moveNotesDir(from, to) {
	const a = resolve(from), b = resolve(to);
	if (a.toLowerCase() === b.toLowerCase()) throw new Error("Это та же папка");
	if ((b + sep).toLowerCase().startsWith((a + sep).toLowerCase())) throw new Error("Новая папка не может лежать внутри текущей");
	if ((a + sep).toLowerCase().startsWith((b + sep).toLowerCase())) throw new Error("Новая папка не может содержать текущую");
	const files = walk(a);
	const conflicts = files.filter((f) => existsSync(join(b, f)));
	if (conflicts.length) throw new Error(`В новой папке уже есть файлы с такими именами: ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? "…" : ""}. Ничего не перенесено.`);
	const copied = [];
	try {
		for (const f of files) {
			const src = join(a, f), dst = join(b, f);
			mkdirSync(join(dst, ".."), { recursive: true });
			copyFileSync(src, dst);
			copied.push(dst);
			const s1 = readFileSync(src), s2 = readFileSync(dst);
			if (s1.length !== s2.length || sha(s1) !== sha(s2)) throw new Error(`Копия не совпала с оригиналом: ${f}`);
		}
	} catch (e) {
		for (const c of copied) rmSync(c, { force: true });
		throw new Error(`Переезд отменён, старая папка не тронута: ${e.message}`);
	}
	for (const f of files) rmSync(join(a, f), { force: true });
	for (const d of [join(a, ASSETS_DIR), join(a, META_DIR)]) rmSync(d, {
		recursive: true,
		force: true
	});
	try {
		if (readdirSync(a).length === 0) rmSync(a, {
			recursive: true,
			force: true
		});
	} catch {}
	return { moved: files.length };
}
//#endregion
//#region src/shared/notes/organize.ts
var PINS = "pins.json";
var GROUPS = "groups.json";
function readJson$1(file, fallback) {
	try {
		return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
	} catch {
		return fallback;
	}
}
function readOrg(dir) {
	const pins = readJson$1(join(dir, META_DIR, PINS), {});
	const groups = readJson$1(join(dir, META_DIR, GROUPS), {});
	return {
		pinned: Array.isArray(pins.pinned) ? pins.pinned.filter((x) => typeof x === "string") : [],
		folders: Array.isArray(groups.folders) ? groups.folders.filter((f) => f && typeof f.id === "string" && typeof f.name === "string").map((f) => ({
			id: f.id,
			name: f.name,
			collapsed: !!f.collapsed,
			notes: Array.isArray(f.notes) ? f.notes.filter((x) => typeof x === "string") : []
		})) : [],
		pinnedFolders: Array.isArray(groups.pinnedFolders) ? groups.pinnedFolders.filter((x) => typeof x === "string") : [],
		groups: Array.isArray(groups.groups) ? groups.groups.filter((g) => g && typeof g.id === "string" && typeof g.name === "string").map((g) => ({
			id: g.id,
			name: g.name,
			collapsed: !!g.collapsed,
			notes: Array.isArray(g.notes) ? g.notes.filter((x) => typeof x === "string") : []
		})) : [],
		free: Array.isArray(groups.free) ? groups.free.filter((x) => typeof x === "string") : []
	};
}
function writeOrg(dir, org) {
	atomicWrite(join(dir, META_DIR, PINS), JSON.stringify({ pinned: org.pinned }, null, 2) + "\n");
	atomicWrite(join(dir, META_DIR, GROUPS), JSON.stringify({
		folders: org.folders,
		pinnedFolders: org.pinnedFolders,
		groups: org.groups,
		free: org.free
	}, null, 2) + "\n");
}
/** Изменить и записать: чтение → правка → атомарная запись. */
function update$1(dir, fn) {
	const org = readOrg(dir);
	fn(org);
	writeOrg(dir, org);
	return org;
}
var groupOf = (org, id) => {
	const g = org.groups.find((x) => x.id === id);
	if (!g) throw new Error("Группы нет");
	return g;
};
var folderOf = (org, id) => {
	const f = org.folders.find((x) => x.id === id);
	if (!f) throw new Error("Папки нет");
	return f;
};
var togglePin = (dir, note) => update$1(dir, (o) => {
	o.pinned = o.pinned.includes(note) ? o.pinned.filter((n) => n !== note) : [note, ...o.pinned];
});
function createGroup(dir, name, notes = []) {
	const id = `g_${randomBytes(4).toString("hex")}`;
	const clean = name.replace(/\s+/g, " ").trim() || "Группа";
	return {
		org: update$1(dir, (o) => {
			for (const g of o.groups) g.notes = g.notes.filter((n) => !notes.includes(n));
			o.groups.push({
				id,
				name: clean,
				collapsed: false,
				notes: [...notes]
			});
		}),
		id
	};
}
var renameGroup = (dir, id, name) => update$1(dir, (o) => {
	groupOf(o, id).name = name.replace(/\s+/g, " ").trim() || groupOf(o, id).name;
});
/** Удалить группу: заметки остаются (уходят в «без группы»). */
var deleteGroup = (dir, id) => update$1(dir, (o) => {
	o.groups = o.groups.filter((g) => g.id !== id);
});
var setGroupCollapsed = (dir, id, collapsed) => update$1(dir, (o) => {
	groupOf(o, id).collapsed = collapsed;
});
/** Заметка живёт либо в группе, либо в папке — взаимно исключаем, чтобы список не превращался в хаос. */
var removeFromContainers = (o, note) => {
	for (const g of o.groups) g.notes = g.notes.filter((n) => n !== note);
	for (const f of o.folders) f.notes = f.notes.filter((n) => n !== note);
};
function createFolder(dir, name, notes = []) {
	const id = `f_${randomBytes(4).toString("hex")}`;
	const clean = name.replace(/\s+/g, " ").trim() || "Папка";
	return {
		org: update$1(dir, (o) => {
			for (const n of notes) removeFromContainers(o, n);
			o.folders.push({
				id,
				name: clean,
				collapsed: false,
				notes: [...notes]
			});
		}),
		id
	};
}
var renameFolder = (dir, id, name) => update$1(dir, (o) => {
	folderOf(o, id).name = name.replace(/\s+/g, " ").trim() || folderOf(o, id).name;
});
/** Удалить папку: заметки остаются (возвращаются в корень списка). */
var deleteFolder = (dir, id) => update$1(dir, (o) => {
	o.folders = o.folders.filter((f) => f.id !== id);
	o.pinnedFolders = o.pinnedFolders.filter((x) => x !== id);
});
var setFolderCollapsed = (dir, id, collapsed) => update$1(dir, (o) => {
	folderOf(o, id).collapsed = collapsed;
});
/** В папку (null — убрать из папки). */
var moveToFolder = (dir, note, id) => update$1(dir, (o) => {
	if (id) folderOf(o, id);
	removeFromContainers(o, note);
	if (id) folderOf(o, id).notes.push(note);
});
var toggleFolderPin = (dir, id) => update$1(dir, (o) => {
	folderOf(o, id);
	o.pinnedFolders = o.pinnedFolders.includes(id) ? o.pinnedFolders.filter((x) => x !== id) : [id, ...o.pinnedFolders];
});
/** В группу (null — убрать из группы). Заметка бывает только в одной группе. */
var moveToGroup = (dir, note, id) => update$1(dir, (o) => {
	if (id) groupOf(o, id);
	removeFromContainers(o, note);
	if (id) groupOf(o, id).notes.push(note);
});
/** Заметку переименовали — закрепление, папка и группа следуют за ней. */
function renameInOrg(dir, from, to) {
	const org = readOrg(dir);
	if (!(org.pinned.includes(from) || org.free.includes(from) || org.groups.some((g) => g.notes.includes(from)) || org.folders.some((f) => f.notes.includes(from)))) return;
	update$1(dir, (o) => {
		o.pinned = o.pinned.map((n) => n === from ? to : n);
		o.free = o.free.map((n) => n === from ? to : n);
		for (const g of o.groups) g.notes = g.notes.map((n) => n === from ? to : n);
		for (const f of o.folders) f.notes = f.notes.map((n) => n === from ? to : n);
	});
}
/** Заметку удалили в корзину — из закреплённых, папок и групп убираем. */
function forgetInOrg(dir, note) {
	const org = readOrg(dir);
	if (!(org.pinned.includes(note) || org.free.includes(note) || org.groups.some((g) => g.notes.includes(note)) || org.folders.some((f) => f.notes.includes(note)))) return;
	update$1(dir, (o) => {
		o.pinned = o.pinned.filter((n) => n !== note);
		o.free = o.free.filter((n) => n !== note);
		for (const g of o.groups) g.notes = g.notes.filter((n) => n !== note);
		for (const f of o.folders) f.notes = f.notes.filter((n) => n !== note);
	});
}
/**
* Ручной порядок (правка владельца 19.10.2026): перетащить заметку к другой — встать перед before
* (null — в конец). target: 'pinned' — среди закреплённых; id группы — в группу; null — без группы.
* Порядок без группы — список free в groups.json; заметки, которых там нет (новые), идут сверху.
* visible — порядок раздела «без группы» на экране (с новыми заметками), чтобы ручной порядок начался с него.
*/
var placeNote = (dir, note, target, before, visible) => update$1(dir, (o) => {
	const insert = (list) => {
		const rest = list.filter((n) => n !== note);
		const i = before ? rest.indexOf(before) : -1;
		rest.splice(i < 0 ? rest.length : i, 0, note);
		return rest;
	};
	if (target === "pinned") {
		o.pinned = insert(o.pinned);
		return;
	}
	o.pinned = o.pinned.filter((n) => n !== note);
	removeFromContainers(o, note);
	if (target) {
		const f = o.folders.find((x) => x.id === target);
		if (f) {
			f.notes = insert(f.notes);
			return;
		}
		const g = groupOf(o, target);
		g.notes = insert(g.notes);
		o.free = o.free.filter((n) => n !== note);
	} else {
		if (visible) o.free = [...visible, ...o.free.filter((n) => !visible.includes(n))];
		o.free = insert(o.free);
	}
});
//#endregion
//#region src/shared/notes/metaFile.ts
/**
* Служебные JSON-файлы папки заметок (`.ariadne/*.json`): права агентов, привязки к доскам.
* Пишут и приложение, и MCP-сервер — запись атомарная; испорченный файл читается как пустой (список не ломается).
*/
function readMeta(dir, file, fallback) {
	const p = join(dir, META_DIR, file);
	try {
		return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback;
	} catch {
		return fallback;
	}
}
function writeMeta(dir, file, data) {
	const p = join(dir, META_DIR, file);
	mkdirSync(dirname(p), { recursive: true });
	atomicWrite(p, JSON.stringify(data, null, 2) + "\n");
}
//#endregion
//#region src/shared/notes/access.ts
var FILE$1 = "access.json";
function read$1(dir) {
	const a = readMeta(dir, FILE$1, {});
	return { notes: a.notes && typeof a.notes === "object" ? a.notes : {} };
}
/** Уровень агента для заметки (без учёта регистра в имени агента). */
function levelOf(dir, note, agent) {
	const rights = read$1(dir).notes[note];
	if (!rights) return "none";
	const key = Object.keys(rights).find((k) => k.toLowerCase() === agent.toLowerCase());
	return key ? rights[key] : "none";
}
/** Агенты, у которых где-либо есть доступ (для списка в интерфейсе, кроме стандартных). */
function knownAgents(dir) {
	const set = /* @__PURE__ */ new Set();
	for (const r of Object.values(read$1(dir).notes)) for (const a of Object.keys(r)) set.add(a);
	return [...set];
}
function setLevel(dir, note, agent, level) {
	const a = read$1(dir);
	const r = { ...a.notes[note] ?? {} };
	for (const k of Object.keys(r)) if (k.toLowerCase() === agent.toLowerCase()) delete r[k];
	if (level !== "none") r[agent] = level;
	if (Object.keys(r).length) a.notes[note] = r;
	else delete a.notes[note];
	writeMeta(dir, FILE$1, a);
}
/** Переименование заметки — права следом; удаление в корзину — права снимаются. */
function renameInAccess(dir, from, to) {
	const a = read$1(dir);
	if (!a.notes[from]) return;
	a.notes[to] = a.notes[from];
	delete a.notes[from];
	writeMeta(dir, FILE$1, a);
}
function forgetInAccess(dir, note) {
	const a = read$1(dir);
	if (!a.notes[note]) return;
	delete a.notes[note];
	writeMeta(dir, FILE$1, a);
}
//#endregion
//#region src/shared/notes/boardLinks.ts
var FILE = "links.json";
function read(dir) {
	const f = readMeta(dir, FILE, {});
	return { boards: f.boards && typeof f.boards === "object" ? f.boards : {} };
}
function boardNotes(dir, boardId) {
	const b = read(dir).boards[boardId];
	return {
		enabled: !!b?.enabled,
		notes: Array.isArray(b?.notes) ? b.notes.filter((n) => typeof n === "string") : []
	};
}
function update(dir, boardId, fn) {
	const f = read(dir);
	const b = boardNotes(dir, boardId);
	fn(b);
	f.boards[boardId] = b;
	writeMeta(dir, FILE, f);
	return b;
}
var setBoardNotesEnabled = (dir, boardId, enabled) => update(dir, boardId, (b) => b.enabled = enabled);
var linkNote = (dir, boardId, note) => update(dir, boardId, (b) => {
	if (!b.notes.includes(note)) b.notes.push(note);
});
var unlinkNote = (dir, boardId, note) => update(dir, boardId, (b) => b.notes = b.notes.filter((n) => n !== note));
/** К каким доскам привязана заметка (только где привязка включена). */
function boardsOfNote(dir, note) {
	return Object.entries(read(dir).boards).filter(([, b]) => b.enabled && b.notes?.includes(note)).map(([id]) => id);
}
/** Переименование заметки — привязки следом; корзина — привязки снимаются. */
function renameInLinks(dir, from, to) {
	const f = read(dir);
	let changed = false;
	for (const b of Object.values(f.boards)) if (b.notes?.includes(from)) {
		b.notes = b.notes.map((n) => n === from ? to : n);
		changed = true;
	}
	if (changed) writeMeta(dir, FILE, f);
}
function forgetInLinks(dir, note) {
	const f = read(dir);
	let changed = false;
	for (const b of Object.values(f.boards)) if (b.notes?.includes(note)) {
		b.notes = b.notes.filter((n) => n !== note);
		changed = true;
	}
	if (changed) writeMeta(dir, FILE, f);
}
//#endregion
//#region src/shared/notes/hidden.ts
/**
* Скрытые значения для агентов, PDF и промпта (решение владельца 19.10.2026): вместо значения — `[скрыто]`.
* Обратно (агент присылает текст целиком): метки `[скрыто]` по порядку заменяются исходными значениями —
* так агент может переписать заметку, не стерев пароли, которых не видел.
*/
var HIDDEN_LABEL = "[скрыто]";
var SPAN = /<span data-ariadne="hidden">([\s\S]*?)<\/span>/g;
function maskHidden(md) {
	const secrets = [];
	return {
		text: md.replace(SPAN, (_m, v) => (secrets.push(v), HIDDEN_LABEL)),
		secrets
	};
}
var hasHidden = (md) => /<span data-ariadne="hidden">/.test(md);
var dirOf = (dir, note) => join(dir, META_DIR, "history", note);
function listSnapshots(dir, note) {
	const d = dirOf(dir, note);
	if (!existsSync(d)) return [];
	return readdirSync(d).map((f) => /^(\d+)__(owner|agent|external|restore)(?:__(.+))?\.md$/.exec(f)).filter((m) => !!m).map((m) => ({
		id: m[0],
		at: Number(m[1]),
		reason: m[2],
		by: m[3] ?? null
	})).sort((a, b) => b.at - a.at);
}
function readSnapshot(dir, note, id) {
	if (!/^\d+__\w+(__.+)?\.md$/.test(id) || id.includes("..") || /[\\/]/.test(id)) throw new Error("Нет такой версии");
	return readFileSync(join(dirOf(dir, note), id), "utf8");
}
/** Сохранить снимок (тот же текст, что последний снимок, не дублируем) и оставить 20 последних. */
function saveSnapshot(dir, note, content, reason, by) {
	const d = dirOf(dir, note);
	mkdirSync(d, { recursive: true });
	const list = listSnapshots(dir, note);
	if (list[0] && readFileSync(join(d, list[0].id), "utf8") === content) return;
	const at = Math.max(Date.now(), (list[0]?.at ?? 0) + 1);
	const who = by ? `__${by.replace(/[\\/:*?"<>|_]/g, " ").trim().slice(0, 40)}` : "";
	atomicWrite(join(d, `${at}__${reason}${who}.md`), content);
	for (const old of listSnapshots(dir, note).slice(20)) rmSync(join(d, old.id), { force: true });
}
/** Переименование заметки — история следом; корзина — история остаётся (вернётся при восстановлении). */
function renameHistory(dir, from, to) {
	const a = dirOf(dir, from);
	const b = dirOf(dir, to);
	if (existsSync(a) && !existsSync(b)) renameSync(a, b);
}
//#endregion
//#region src/shared/notes/markdown.ts
/**
* Markdown ↔ документ редактора (ТЗ заметок §5.1). На диске — обычный .md; то, чего Markdown не умеет,
* хранится маленькими HTML-вставками: `<u>`, `<span style="color: …; font-size: …">`, ширины столбцов —
* комментарием `<!-- ariadne:colwidths … -->` сразу после таблицы (в чужих просмотрщиках невидим).
*
* md → HTML (marked, GFM) → документ (TipTap разбирает HTML по схеме); документ → md — свой сериализатор,
* чтобы формат был предсказуемым и «круг» md → редактор → md не менял файл.
*/
var COLWIDTHS = /^<!--\s*ariadne:colwidths\s+([\d,\s]+)\s*-->\s*$/;
var SHADED = /^<!--\s*ariadne:shaded\s+([\d:,\s]+)\s*-->\s*$/;
var isTableMeta = (text) => text.trim().split("\n").every((l) => COLWIDTHS.test(l.trim()) || SHADED.test(l.trim()));
var esc$2 = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var md = new Marked({
	gfm: true,
	breaks: true
});
md.use({
	tokenizer: { url() {} },
	renderer: {
		list(token) {
			const allTasks = token.items.length > 0 && token.items.every((i) => i.task);
			const items = token.items.map((item) => {
				const body = this.parser.parse(item.tokens.filter((x) => x.type !== "checkbox"));
				if (allTasks) return `<li data-type="taskItem" data-checked="${item.checked ? "true" : "false"}">${body}</li>`;
				return `<li>${item.task ? `[${item.checked ? "x" : " "}] ` : ""}${body}</li>`;
			}).join("");
			if (allTasks) return `<ul data-type="taskList">${items}</ul>`;
			const tag = token.ordered ? "ol" : "ul";
			return `<${tag}${token.ordered && token.start !== 1 && token.start !== "" ? ` start="${token.start}"` : ""}>${items}</${tag}>`;
		},
		table(token) {
			const w = (i) => token.colwidths?.[i] ? ` colwidth="${token.colwidths[i]}"` : "";
			const shade = (r, i) => token.shaded?.has(`${r}:${i}`) ? " data-shaded=\"true\"" : "";
			const cell = (c, i, tag, r = 0) => `<${tag}${w(i)}${tag === "td" ? shade(r, i) : ""}>${this.parser.parseInline(c.tokens)}</${tag}>`;
			return `<table><tbody>${`<tr>${token.header.map((c, i) => cell(c, i, "th")).join("")}</tr>`}${token.rows.map((r, ri) => `<tr>${r.map((c, i) => cell(c, i, "td", ri + 1)).join("")}</tr>`).join("")}</tbody></table>`;
		},
		html(token) {
			return isTableMeta(token.text) ? "" : token.text;
		},
		paragraph(token) {
			const parts = token.tokens.filter((x) => !(x.type === "text" && !x.raw.trim()) && x.type !== "br");
			if (parts.length && parts.every((x) => x.type === "image")) return this.parser.parseInline(parts);
			const only = parts.length === 1 ? parts[0] : null;
			if (only?.type === "link" && isAttachmentHref(decodeHref(only.href))) {
				const l = only;
				const name = l.tokens.map((x) => "text" in x ? x.text : "").join("") || fileNameOf(l.href);
				return `<div data-file-card="" data-href="${esc$2(l.href)}" data-name="${esc$2(name)}"></div>`;
			}
			return `<p>${this.parser.parseInline(token.tokens)}</p>\n`;
		},
		code(token) {
			const lang = (token.lang ?? "").trim().split(/\s+/)[0];
			return `<pre><code${lang ? ` class="language-${esc$2(lang)}"` : ""}>${esc$2(token.text)}</code></pre>`;
		}
	}
});
function markdownToHtml(src) {
	const tokens = md.lexer(src.replace(/\r\n?/g, "\n"));
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.type !== "table") continue;
		const meta = [];
		for (let j = i + 1; j < tokens.length; j++) {
			const x = tokens[j];
			if (x.type === "space") continue;
			if (x.type !== "html" || !isTableMeta(x.text)) break;
			meta.push(...x.text.trim().split("\n"));
		}
		const tt = t;
		for (const line of meta) {
			const w = COLWIDTHS.exec(line.trim());
			if (w) tt.colwidths = w[1].split(",").map((x) => Number(x.trim()) || 0);
			const s = SHADED.exec(line.trim());
			if (s) tt.shaded = new Set(s[1].split(",").map((x) => x.trim()).filter(Boolean));
		}
	}
	return md.parser(tokens);
}
//#endregion
//#region src/shared/notes/printHtml.ts
var esc$1 = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Светлая печатная вёрстка: то же форматирование, что в редакторе, но для бумаги. */
var CSS = `
@page { size: A4; margin: 18mm 16mm; }
body { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 11pt; line-height: 1.55; color: #1a1a1a; }
h1.title { font-size: 20pt; margin: 0 0 4mm; }
.meta { color: #777; font-size: 9pt; margin-bottom: 6mm; }
h1 { font-size: 16pt; } h2 { font-size: 14pt; } h3 { font-size: 12pt; } h4 { font-size: 11pt; color: #555; }
h1, h2, h3, h4 { margin: 5mm 0 2mm; page-break-after: avoid; }
p { margin: 0 0 2.5mm; }
a { color: #b4532f; }
code { font-family: 'Cascadia Code', Consolas, monospace; font-size: 9.5pt; background: #f2f2f2; padding: 0 3px; border-radius: 3px; }
pre { background: #f6f6f6; border: 1px solid #e3e3e3; border-radius: 4px; padding: 3mm; white-space: pre-wrap; page-break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { margin: 2mm 0; padding-left: 4mm; border-left: 2px solid #ccc; color: #555; }
table { border-collapse: collapse; margin: 3mm 0; page-break-inside: avoid; }
th, td { border: 1px solid #ccc; padding: 1.5mm 2.5mm; vertical-align: top; text-align: left; }
th, td[data-shaded="true"] { background: #f2f2f2; }
ul[data-type="taskList"] { list-style: none; padding-left: 2mm; }
li[data-type="taskItem"]::before { content: '☐ '; }
li[data-type="taskItem"][data-checked="true"]::before { content: '☑ '; }
li[data-type="taskItem"][data-checked="true"] { color: #888; text-decoration: line-through; }
img { max-width: 100%; border-radius: 3px; }
img[data-align="left"] { float: left; margin: 1mm 5mm 2mm 0; }
img[data-align="right"] { float: right; margin: 1mm 0 2mm 5mm; }
h1, h2, h3, table, pre, hr, .file { clear: both; }
.file { margin: 2mm 0; padding: 2mm 3mm; border: 1px solid #ddd; border-radius: 4px; font-size: 10pt; }
.hidden { color: #888; }
hr { border: 0; border-top: 1px solid #ddd; }
`;
/** HTML заметки для печати (PDF, ТЗ заметок §5.9): скрытые значения — [скрыто], картинки — из папки вложений, карточки файлов — подписью. */
function noteHtml(name, md, host, modified) {
	let body = markdownToHtml(maskHidden(md).text.replace(/\[скрыто\]/g, "<span class=\"hidden\">[скрыто]</span>"));
	body = body.replace(/<img([^>]*?)src="([^"]*)"/g, (_m, pre, src) => `<img${pre}src="${esc$1(assetUrl(decodeHref(src.replace(/&amp;/g, "&")), host))}"`).replace(/<div data-file-card="" data-href="([^"]*)" data-name="([^"]*)"><\/div>/g, (_m, href, n) => `<div class="file">📎 ${n || esc$1(fileNameOf(href))}</div>`);
	const date = new Date(modified).toLocaleString("ru-RU", {
		day: "numeric",
		month: "long",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit"
	});
	return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc$1(name)}</title><style>${CSS}</style></head>
<body><h1 class="title">${esc$1(name)}</h1><div class="meta">${esc$1(date)}</div>${body}</body></html>`;
}
//#endregion
//#region src/main/notesPdf.ts
/**
* Экспорт заметки в PDF (ТЗ заметок §5.9): скрытое окно с HTML заметки → printToPDF → файл по выбору владельца.
* fixedPath — без диалога (сценарий проверки). Возвращает путь или null (отменено).
*/
async function exportNotePdf(store, name, host, fixedPath) {
	const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
	let path = fixedPath;
	if (!path) {
		const r = await dialog.showSaveDialog(owner, {
			title: "Экспорт в PDF",
			defaultPath: `${name}.pdf`,
			filters: [{
				name: "PDF",
				extensions: ["pdf"]
			}]
		});
		if (r.canceled || !r.filePath) return null;
		path = r.filePath;
	}
	const info = store.list().find((n) => n.name === name);
	const html = noteHtml(name, store.read(name), host, info?.modifiedAt ?? Date.now());
	const win = new BrowserWindow({
		show: false,
		webPreferences: {
			sandbox: true,
			javascript: false
		}
	});
	try {
		await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
		const pdf = await win.webContents.printToPDF({
			printBackground: true,
			preferCSSPageSize: true
		});
		writeFileSync(path, pdf);
		return path;
	} finally {
		win.destroy();
	}
}
//#endregion
//#region src/shared/agent/prompt.ts
/**
* «Отправить агенту» (ТЗ 8.7): полный готовый промпт по задаче — описание, чек-лист, связанные компоненты,
* решения, файлы, комментарии и как отчитаться на доске. Владелец вставляет его в Claude Code / Z Code.
*/
function buildTaskPrompt(db, taskId) {
	const task = blockFull(db, taskId);
	if (!task) throw new Error("Задача не найдена");
	const board = getBoard(db, task.boardId);
	const ctx = taskContext(db, taskId);
	const out = [];
	out.push(`Возьми в работу задачу с доски проекта Ariadne «${board?.name}».`, "");
	out.push(`## Задача: ${task.title}`);
	const meta = [
		task.priority && `приоритет: ${ru.priority[task.priority].toLowerCase()}`,
		task.status && `статус: ${ru.status[task.status].toLowerCase()}`,
		task.dueDate && `срок: ${task.dueDate}`,
		task.tags.length && `теги: ${task.tags.join(", ")}`,
		`id: ${task.id}`
	].filter(Boolean);
	out.push(meta.join(" · "));
	if (task.description.trim()) out.push("", task.description.trim());
	if (task.checklist.length) {
		out.push("", "### Чек-лист");
		for (const i of task.checklist) out.push(`- [${i.done ? "x" : " "}] ${i.text}`);
	}
	if (ctx.related.length) {
		out.push("", "## Контекст: связанные блоки");
		for (const r of ctx.related) {
			out.push("", `### ${r.title} — ${ru.blockType[r.type].toLowerCase()} · ${r.relation.toLowerCase()} · id ${r.id}`);
			if (r.description) out.push(r.description);
		}
	}
	if (ctx.alsoRelevant.length) {
		out.push("", "## Также важно (решения и файлы связанных компонентов)");
		for (const r of ctx.alsoRelevant) out.push(`- **${r.title}** (${ru.blockType[r.type].toLowerCase()}, через «${r.via}», id ${r.id})${r.description ? " — " + r.description : ""}`);
	}
	const code = task.attachments.filter((a) => a.kind === "code");
	const links = task.attachments.filter((a) => a.kind === "link");
	if (links.length) {
		out.push("", "## Ссылки");
		for (const a of links) out.push(`- ${a.name}: ${a.url}`);
	}
	for (const a of code) out.push("", `### ${a.name}`, "```" + (a.language ?? ""), a.content ?? "", "```");
	if (task.comments.length) {
		out.push("", "## Комментарии");
		for (const c of task.comments) out.push(`- ${c.author} (${c.at.slice(0, 10)}): ${c.text}`);
	}
	out.push("", "## Как работать с доской", `Доска доступна через MCP-сервер \`ariadne-board\`. Подробности любого блока — \`get_block\` по id.`, `- Начиная работу: \`set_task_status\` task="${task.id}" status="in_progress".`, "- Принятые решения записывай блоками «Решение» (что и почему) со связями к затронутым блокам; новые задачи — блоками «Задача».", `- Закончив: \`set_task_status\` task="${task.id}" status="done" с комментарием, что сделано.`);
	return out.join("\n");
}
/**
* «Отправить заметку агенту» (ТЗ заметок §5.9): название, содержимое и (если есть) привязанные доски.
* body уже с `[скрыто]` вместо скрытых значений — если владелец разово не включил их.
*/
function noteAgentPrompt(name, body, boards) {
	const out = [
		`Заметка владельца из Ariadne — «${name}».`,
		"",
		"---",
		body.trim(),
		"---"
	];
	if (/\[скрыто\]/.test(body)) out.push("", "Значения, помеченные [скрыто], владелец не передаёт.");
	if (boards.length) {
		out.push("", `Заметка связана с доск${boards.length > 1 ? "ами" : "ой"} проекта: ${boards.map((b) => `«${b}»`).join(", ")}.`);
		out.push("Обзор доски — MCP-сервер `ariadne-board`, инструмент `get_overview`.");
	}
	return out.join("\n");
}
//#endregion
//#region src/shared/agent/connect.ts
/** Ключ сервера в конфигах агентов (docs/NAME.md §4). */
var SERVER_NAME = "ariadne-board";
var AGENT_NAMES = {
	claude: "Claude Code",
	zcode: "Z Code"
};
/** Команда запуска MCP: тот же exe в режиме Node — на чужом ПК Node не нужен. */
function launchSpec(exe, serverJs, kind, extraEnv = {}) {
	return {
		command: exe,
		args: [
			serverJs,
			"--agent",
			AGENT_NAMES[kind]
		],
		env: {
			ELECTRON_RUN_AS_NODE: "1",
			...extraEnv
		}
	};
}
/**
* Где агент хранит пользовательские MCP-серверы:
* - Claude Code: ~/.claude.json → mcpServers (уровень пользователя, для всех проектов);
* - Z Code: ~/.zcode/cli/config.json → mcp.servers (https://zcode.z.ai/en/docs/mcp-services).
*/
var configPath = (kind, home) => kind === "claude" ? join(home, ".claude.json") : join(home, ".zcode", "cli", "config.json");
function configEntry(kind, spec) {
	return kind === "claude" ? {
		type: "stdio",
		...spec
	} : {
		...spec,
		enable: true
	};
}
/** Готовый фрагмент для ручной вставки (если автоматическая запись невозможна). */
function manualSnippet(kind, spec) {
	const entry = { [SERVER_NAME]: configEntry(kind, spec) };
	return JSON.stringify(kind === "claude" ? { mcpServers: entry } : { mcp: { servers: entry } }, null, 2);
}
/** Команда для терминала: `claude mcp add-json` (кавычки — для PowerShell). */
function claudeCliCommand(spec) {
	return `claude mcp add-json ${SERVER_NAME} '${JSON.stringify(configEntry("claude", spec)).replace(/'/g, "''")}' --scope user`;
}
function readJson(file) {
	if (!existsSync(file)) return {};
	const text = readFileSync(file, "utf8");
	if (!text.trim()) return {};
	try {
		const v = JSON.parse(text);
		if (v && typeof v === "object" && !Array.isArray(v)) return v;
	} catch {}
	throw new Error(`Файл ${file} не похож на JSON — исправьте его или добавьте настройки вручную`);
}
function entriesOf(kind, cfg) {
	if (kind === "claude") return cfg.mcpServers;
	return cfg.mcp?.servers;
}
/** connected — прописан с этой командой; outdated — прописан, но путь другой (папку перенесли); missing — нет. */
function agentStatus(kind, home, spec) {
	const file = configPath(kind, home);
	let cfg;
	try {
		cfg = readJson(file);
	} catch {
		return {
			status: "missing",
			file
		};
	}
	const entry = entriesOf(kind, cfg)?.[SERVER_NAME];
	if (!entry) return {
		status: "missing",
		file
	};
	return {
		status: entry.command === spec.command && JSON.stringify(entry.args) === JSON.stringify(spec.args) ? "connected" : "outdated",
		file,
		current: entry
	};
}
/**
* Прописать сервер в конфиг агента, сохранив всё остальное. Перед записью — копия *.ariadne-backup,
* запись через временный файл (Claude Code держит ~/.claude.json открытым и сам его переписывает).
*/
function connectAgent(kind, home, spec) {
	const file = configPath(kind, home);
	const cfg = readJson(file);
	if (kind === "claude") cfg.mcpServers = {
		...cfg.mcpServers,
		[SERVER_NAME]: configEntry(kind, spec)
	};
	else {
		const mcp = cfg.mcp ?? {};
		cfg.mcp = {
			...mcp,
			servers: {
				...mcp.servers,
				[SERVER_NAME]: configEntry(kind, spec)
			}
		};
	}
	mkdirSync(dirname(file), { recursive: true });
	let backup = null;
	if (existsSync(file)) {
		backup = file + ".ariadne-backup";
		copyFileSync(file, backup);
	}
	writeFileSync(file + ".ariadne-tmp", JSON.stringify(cfg, null, 2), "utf8");
	renameSync(file + ".ariadne-tmp", file);
	return {
		file,
		backup
	};
}
var START = "<!-- ariadne:start -->";
var END = "<!-- ariadne:end -->";
var renderSnippet = (template, boardName) => template.replaceAll("{{BOARD_NAME}}", boardName).trim();
/**
* Вставить или обновить блок инструкций между маркерами ariadne:start/end в CLAUDE.md / AGENTS.md.
* Остальной текст файла не трогается; повторный вызов обновляет блок, а не дублирует его.
*/
function upsertInstructions(file, snippet) {
	if (!snippet.startsWith(START) || !snippet.endsWith(END)) throw new Error("Сниппет должен быть обёрнут маркерами ariadne:start/end");
	if (!existsSync(file)) {
		writeFileSync(file, snippet + "\n", "utf8");
		return "created";
	}
	const text = readFileSync(file, "utf8");
	const s = text.indexOf(START), e = text.indexOf(END);
	let next;
	let result;
	if (s >= 0 && e > s) {
		next = text.slice(0, s) + snippet + text.slice(e + 20);
		result = "updated";
	} else {
		next = text.replace(/\s*$/, "") + "\n\n" + snippet + "\n";
		result = "appended";
	}
	if (next === text) return "unchanged";
	writeFileSync(file, next, "utf8");
	return result;
}
//#endregion
//#region src/shared/db/trash.ts
/**
* Содержимое корзины. Блоки удалённой доски и связи удалённого блока отдельно не показываются —
* они вернутся вместе с доской / блоком.
*/
function listTrash(db) {
	return db.prepare(`SELECT 'board' AS kind, id, id AS boardId, name AS title, deleted_at AS deletedAt
         FROM boards WHERE deleted_at IS NOT NULL
       UNION ALL
       SELECT 'block', b.id, b.board_id, b.title, b.deleted_at
         FROM blocks b JOIN boards d ON d.id = b.board_id
        WHERE b.deleted_at IS NOT NULL AND d.deleted_at IS NULL
       UNION ALL
       SELECT 'link', l.id, l.board_id, f.title || ' → ' || t.title, l.deleted_at
         FROM links l JOIN blocks f ON f.id = l.from_id JOIN blocks t ON t.id = l.to_id
         JOIN boards d ON d.id = l.board_id
        WHERE l.deleted_at IS NOT NULL AND f.deleted_at IS NULL AND t.deleted_at IS NULL AND d.deleted_at IS NULL
       ORDER BY deletedAt DESC`).all();
}
/**
* Окончательная очистка корзины (только из UI владельцем).
* Возвращает пути вложений (относительно data/attachments/<boardId>/), чьи файлы надо удалить.
*/
function purgeTrash(db) {
	return write(db, () => {
		const deadBlocks = `SELECT b.id FROM blocks b JOIN boards d ON d.id = b.board_id
                        WHERE b.deleted_at IS NOT NULL OR d.deleted_at IS NOT NULL`;
		const files = db.prepare(`SELECT b.board_id AS boardId, a.path FROM attachments a JOIN blocks b ON b.id = a.block_id
         WHERE a.path IS NOT NULL AND a.block_id IN (${deadBlocks})`).all();
		db.exec(`
      CREATE TEMP TABLE dead AS ${deadBlocks};
      DELETE FROM links WHERE deleted_at IS NOT NULL OR from_id IN (SELECT id FROM dead) OR to_id IN (SELECT id FROM dead)
        OR board_id IN (SELECT id FROM boards WHERE deleted_at IS NOT NULL);
      DELETE FROM comments WHERE block_id IN (SELECT id FROM dead);
      DELETE FROM checklist_items WHERE block_id IN (SELECT id FROM dead);
      DELETE FROM attachments WHERE block_id IN (SELECT id FROM dead);
      DELETE FROM block_tags WHERE block_id IN (SELECT id FROM dead);
      DELETE FROM search_index WHERE block_id IN (SELECT id FROM dead);
      DELETE FROM blocks WHERE id IN (SELECT id FROM dead);
      DELETE FROM tags WHERE board_id IN (SELECT id FROM boards WHERE deleted_at IS NOT NULL);
      DELETE FROM boards WHERE deleted_at IS NOT NULL;
      DROP TABLE dead;
    `);
		return files;
	});
}
//#endregion
//#region src/shared/vault.ts
/** 64 МБ, 3 прохода — порядка секунды на обычном ноутбуке: перебор пароля дорог. */
var DEFAULT_KDF = {
	m: 65536,
	t: 3,
	p: 1
};
async function kek(password, salt, kdf) {
	const out = await argon2id({
		password: password.normalize("NFC"),
		salt,
		iterations: kdf.t,
		parallelism: kdf.p,
		memorySize: kdf.m,
		hashLength: 32,
		outputType: "binary"
	});
	return Buffer.from(out);
}
function seal(key, plain) {
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key, iv);
	const ct = Buffer.concat([c.update(plain), c.final()]);
	return Buffer.concat([
		iv,
		c.getAuthTag(),
		ct
	]);
}
function open(key, box) {
	const d = createDecipheriv("aes-256-gcm", key, box.subarray(0, 12));
	d.setAuthTag(box.subarray(12, 28));
	return Buffer.concat([d.update(box.subarray(28)), d.final()]);
}
var Vault = class {
	db;
	kdf;
	dek = null;
	constructor(db, kdf = DEFAULT_KDF) {
		this.db = db;
		this.kdf = kdf;
	}
	meta() {
		const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'vault'`).get();
		return row ? JSON.parse(row.value) : null;
	}
	status() {
		return this.dek ? "unlocked" : this.meta() ? "locked" : "none";
	}
	/** Первый запуск: задать мастер-пароль. Восстановить его нельзя — интерфейс предупреждает. */
	async setup(password) {
		if (this.meta()) throw new Error("Мастер-пароль уже задан");
		checkStrength(password);
		const salt = randomBytes(16);
		const dek = randomBytes(32);
		const box = seal(await kek(password, salt, this.kdf), dek);
		const meta = {
			v: 1,
			salt: salt.toString("base64"),
			kdf: this.kdf,
			dek: box.toString("base64")
		};
		write(this.db, () => this.db.prepare(`INSERT INTO meta (key, value) VALUES ('vault', ?)`).run(JSON.stringify(meta)));
		this.dek = dek;
	}
	/** Неверный пароль — false (GCM не сходится), без подробностей. */
	async unlock(password) {
		const m = this.meta();
		if (!m) throw new Error("Мастер-пароль ещё не задан");
		try {
			this.dek = open(await kek(password, Buffer.from(m.salt, "base64"), m.kdf), Buffer.from(m.dek, "base64"));
			return true;
		} catch {
			return false;
		}
	}
	lock() {
		this.dek?.fill(0);
		this.dek = null;
	}
	/** Смена пароля: проверяем старый, перешифровываем только DEK новой солью. */
	async changePassword(oldPassword, newPassword) {
		const m = this.meta();
		if (!m) throw new Error("Мастер-пароль ещё не задан");
		checkStrength(newPassword);
		let dek;
		try {
			dek = open(await kek(oldPassword, Buffer.from(m.salt, "base64"), m.kdf), Buffer.from(m.dek, "base64"));
		} catch {
			throw new Error("Текущий пароль неверен");
		}
		const salt = randomBytes(16);
		const box = seal(await kek(newPassword, salt, this.kdf), dek);
		const next = {
			v: 1,
			salt: salt.toString("base64"),
			kdf: this.kdf,
			dek: box.toString("base64")
		};
		write(this.db, () => this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'vault'`).run(JSON.stringify(next)));
		this.dek = dek;
	}
	requireDek() {
		if (!this.dek) throw new Error("Защищённые поля заблокированы — введите мастер-пароль");
		return this.dek;
	}
	getSecret(blockId) {
		const row = this.db.prepare(`SELECT secret_enc AS s FROM blocks WHERE id = ?`).get(blockId);
		if (!row?.s) return "";
		return open(this.requireDek(), Buffer.from(row.s)).toString("utf8");
	}
	/** Пустая строка — поле очищается (NULL). */
	setSecret(blockId, text) {
		const dek = this.requireDek();
		const value = text ? seal(dek, Buffer.from(text, "utf8")) : null;
		write(this.db, () => this.db.prepare(`UPDATE blocks SET secret_enc = ?, updated_at = ? WHERE id = ?`).run(value, Date.now(), blockId));
	}
};
function checkStrength(password) {
	if (password.length < 8) throw new Error("Пароль — не короче 8 символов");
}
//#endregion
//#region src/shared/dev/loadtest.ts
var WORDS = [
	"CRM",
	"Telegram",
	"аккаунт",
	"сервер",
	"Cloudflare",
	"Android",
	"оплата",
	"клиент",
	"бот",
	"очередь",
	"парсер",
	"webhook",
	"база",
	"кэш",
	"авторизация",
	"рассылка",
	"каталог",
	"заказ",
	"лог",
	"бэкап"
];
var TAGS = [
	["бэкенд", "#7AA2F7"],
	["telegram", "#56B6A6"],
	["баг", "#E06C75"],
	["android", "#8CC084"],
	["оплата", "#E5B567"],
	["инфра", "#B392F0"]
];
/** Детерминированный ГПСЧ, чтобы стенд был одинаковым между запусками. */
function rng(seed) {
	return () => (seed = seed * 1664525 + 1013904223 >>> 0) / 2 ** 32;
}
/**
* Нагрузочная доска: кластеры блоков по сетке слотов, большинство связей локальные, часть — дальние.
* Пишется напрямую одной транзакцией (тысячи блоков за доли секунды).
*/
function generateLoadBoard(db, blocks = 3e3, links = 6e3, seed = 42) {
	const rand = rng(seed);
	const pick = (arr) => arr[Math.floor(rand() * arr.length)];
	const board = createBoard(db, `Стенд ${blocks}/${links}`);
	write(db, () => {
		const now = Date.now();
		const cols = Math.ceil(Math.sqrt(blocks * 1.6));
		const ids = [];
		const insB = db.prepare(`INSERT INTO blocks (id, board_id, type, title, description, x, y, status, priority, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'loadtest', ?, ?)`);
		let slot = 0;
		for (let i = 0; i < blocks; i++) {
			slot += rand() < .15 ? 2 : 1;
			const type = pick(BLOCK_TYPES);
			const isTask = type === "task";
			const id = nanoid(10);
			const title = `${pick(WORDS)} ${pick(WORDS).toLowerCase()} #${i + 1}`;
			const desc = `Описание блока ${i + 1}: ${pick(WORDS)}, ${pick(WORDS)} и ${pick(WORDS)} — связка для проверки обрезки текста в две строки.`;
			insB.run(id, board.id, type, title, desc, slot % cols * 280, Math.floor(slot / cols) * 140, isTask ? pick(TASK_STATUSES) : null, isTask ? pick(PRIORITIES) : null, now, now);
			ids.push(id);
		}
		const insL = db.prepare(`INSERT INTO links (id, board_id, from_id, to_id, type, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
		for (let made = 0; made < links;) {
			const a = Math.floor(rand() * blocks);
			const local = rand() < .85;
			const off = local ? Math.floor(rand() * 5) - 2 + (rand() < .5 ? cols : 1) : Math.floor(rand() * blocks);
			const b = Math.min(blocks - 1, Math.max(0, local ? a + off : off));
			if (a === b) continue;
			insL.run(nanoid(10), board.id, ids[a], ids[b], pick(LINK_TYPES), now);
			made++;
		}
		const tagIds = TAGS.map(([name, color]) => {
			const id = nanoid(10);
			db.prepare(`INSERT INTO tags (id, board_id, name, color) VALUES (?, ?, ?, ?)`).run(id, board.id, name, color);
			return id;
		});
		const insT = db.prepare(`INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)`);
		for (const id of ids) {
			if (rand() < .4) insT.run(id, pick(tagIds));
			if (rand() < .15) insT.run(id, pick(tagIds));
		}
		const insC = db.prepare(`INSERT INTO comments (id, block_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)`);
		for (const id of ids) if (rand() < .1) insC.run(nanoid(10), id, "Claude Code", `Проверил ${pick(WORDS)}: работает, но нужен **${pick(WORDS)}**.`, now - 36e5);
		for (const id of ids) reindexBlock(db, id);
	});
	return board;
}
//#endregion
//#region src/main/attachments.ts
var IMAGE_EXT = /* @__PURE__ */ new Set([
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".bmp",
	".svg"
]);
var MIME = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".svg": "image/svg+xml"
};
/** Превью картинок отдаём data-URL'ом; больше этого размера — только «открыть». */
var PREVIEW_LIMIT = 8388608;
var safeName = (name) => basename(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120) || "file";
/** Вложения-файлы живут в data/attachments/<boardId>/<префикс>-<имя>; в БД — относительный путь. */
var Attachments = class {
	db;
	dataDir;
	constructor(db, dataDir) {
		this.db = db;
		this.dataDir = dataDir;
	}
	dir(boardId) {
		const d = join(this.dataDir, "attachments", boardId);
		mkdirSync(d, { recursive: true });
		return d;
	}
	boardOf(blockId) {
		const b = getBlock(this.db, blockId);
		if (!b) throw new Error(`Блок ${blockId} не найден`);
		return b.boardId;
	}
	absPath(a) {
		const b = getBlock(this.db, a.blockId, { withDeleted: true });
		if (!b || !a.path) throw new Error("У вложения нет файла");
		return join(this.dataDir, "attachments", b.boardId, a.path);
	}
	get(id) {
		const a = this.db.prepare(`SELECT id, block_id AS blockId, kind, name, url, path, language, content, created_by AS createdBy, created_at AS createdAt
         FROM attachments WHERE id = ?`).get(id);
		if (!a) throw new Error(`Вложение ${id} не найдено`);
		return a;
	}
	/** Диалог выбора файлов; каждый копируется в папку данных (оригинал не трогаем). */
	async pickFiles(blockId) {
		const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
		const res = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
		if (res.canceled) return [];
		const dir = this.dir(this.boardOf(blockId));
		return res.filePaths.map((src) => {
			const name = safeName(src);
			const rel = `${nanoid(8)}-${name}`;
			copyFileSync(src, join(dir, rel));
			const kind = IMAGE_EXT.has(extname(name).toLowerCase()) ? "image" : "file";
			return addAttachment(this.db, blockId, {
				kind,
				name,
				path: rel
			}, OWNER_AUTHOR);
		});
	}
	/** Вставка из буфера обмена (скриншот): байты пишутся файлом. */
	saveBytes(blockId, name, bytes) {
		const clean = safeName(name);
		const rel = `${nanoid(8)}-${clean}`;
		writeFileSync(join(this.dir(this.boardOf(blockId)), rel), bytes);
		const kind = IMAGE_EXT.has(extname(clean).toLowerCase()) ? "image" : "file";
		return addAttachment(this.db, blockId, {
			kind,
			name: clean,
			path: rel
		}, OWNER_AUTHOR);
	}
	remove(id) {
		const a = this.get(id);
		const abs = a.path ? this.absPath(a) : null;
		deleteAttachment(this.db, id);
		if (abs) rmSync(abs, { force: true });
	}
	/** Ссылки — во внешнем браузере (только http/https/mailto), файлы — программой по умолчанию. */
	async open(id) {
		const a = this.get(id);
		if (a.kind === "link" && a.url) return openExternalSafe(a.url);
		if (a.path) {
			const err = await shell.openPath(this.absPath(a));
			if (err) throw new Error(err);
		}
	}
	dataUrl(id) {
		const a = this.get(id);
		if (a.kind !== "image" || !a.path) return null;
		const abs = this.absPath(a);
		if (statSync(abs).size > PREVIEW_LIMIT) return null;
		return `data:${MIME[extname(abs).toLowerCase()] ?? "application/octet-stream"};base64,${readFileSync(abs).toString("base64")}`;
	}
};
async function openExternalSafe(url) {
	const u = new URL(url);
	if (![
		"http:",
		"https:",
		"mailto:"
	].includes(u.protocol)) throw new Error(`Ссылки «${u.protocol}» не открываются`);
	await shell.openExternal(u.toString());
}
//#endregion
//#region src/shared/render/png.ts
var ready = null;
var fonts = [];
/** Шрифты с кириллицей из системы (целевая ОС — Windows). */
var FONT_FILES = [
	"segoeui.ttf",
	"segoeuib.ttf",
	"seguisb.ttf",
	"arial.ttf"
];
function init(wasmPath) {
	ready ??= (async () => {
		await initWasm(readFileSync(wasmPath));
		const dir = join(process.env.WINDIR ?? "C:\\Windows", "Fonts");
		fonts = FONT_FILES.map((f) => join(dir, f)).filter(existsSync).map((f) => readFileSync(f));
	})();
	return ready;
}
async function svgToPng(svg, wasmPath) {
	await init(wasmPath);
	return new Resvg(svg, { font: {
		fontBuffers: fonts,
		defaultFontFamily: "Segoe UI",
		loadSystemFonts: false
	} }).render().asPng();
}
//#endregion
//#region src/shared/geometry.ts
/** Радиус скругления колен нитки и минимальный отрезок от карточки до колена (мировые единицы). */
var CORNER_R = 16;
var LINK_STUB = 24;
/**
* Ортогональная нитка между карточками. Правило одно для всех связей:
* блоки разнесены по горизонтали (и не сильно по вертикали) — выход из боковой стороны,
* иначе — из верхней/нижней. Колено — посередине промежутка, поэтому у связей одного блока
* с карточками одной колонки/ряда общий «ствол», и линии не расходятся веером.
* Почти соосные карточки соединяются прямой без ступеньки.
*/
function linkRoute(a, b) {
	const aw = a.w ?? 240, ah = a.h ?? 100, bw = b.w ?? 240, bh = b.h ?? 100;
	const acx = a.x + aw / 2, acy = a.y + ah / 2;
	const bcx = b.x + bw / 2, bcy = b.y + bh / 2;
	const dx = bcx - acx, dy = bcy - acy;
	const gapX = Math.abs(dx) - (aw + bw) / 2, gapY = Math.abs(dy) - (ah + bh) / 2;
	if (gapX > 0 && (gapY <= 0 || gapX * 3 >= gapY)) {
		const dir = Math.sign(dx) || 1;
		const sx = acx + dir * aw / 2, ex = bcx - dir * bw / 2;
		let sy = acy, ey = bcy;
		if (Math.abs(sy - ey) < 2 * CORNER_R) {
			if (acy >= b.y && acy <= b.y + bh) ey = acy;
			else if (bcy >= a.y && bcy <= a.y + ah) sy = bcy;
		}
		const mid = (sx + ex) / 2;
		const lo = sx + dir * LINK_STUB, hi = ex - dir * LINK_STUB;
		const roomy = (hi - lo) * dir > 0;
		return {
			horizontal: true,
			dir,
			sx,
			sy,
			ex,
			ey,
			mid,
			lo: roomy ? lo : mid,
			hi: roomy ? hi : mid
		};
	}
	const dir = Math.sign(dy) || 1;
	const sy = acy + dir * ah / 2, ey = bcy - dir * bh / 2;
	let sx = acx, ex = bcx;
	if (Math.abs(sx - ex) < 2 * CORNER_R) {
		if (acx >= b.x && acx <= b.x + bw) ex = acx;
		else if (bcx >= a.x && bcx <= a.x + aw) sx = bcx;
	}
	const mid = (sy + ey) / 2;
	const lo = sy + dir * LINK_STUB, hi = ey - dir * LINK_STUB;
	const roomy = (hi - lo) * dir > 0;
	return {
		horizontal: false,
		dir,
		sx,
		sy,
		ex,
		ey,
		mid,
		lo: roomy ? lo : mid,
		hi: roomy ? hi : mid
	};
}
/** Скругление углов ломаной (плоский массив x,y): каждое колено — короткая квадратичная дуга. */
function roundCorners(c) {
	const n = c.length / 2;
	if (n < 3) return c.slice();
	const out = [c[0], c[1]];
	for (let i = 1; i < n - 1; i++) {
		const px = c[2 * i], py = c[2 * i + 1];
		const ax = c[2 * i - 2], ay = c[2 * i - 1], bx = c[2 * i + 2], by = c[2 * i + 3];
		const la = Math.hypot(px - ax, py - ay), lb = Math.hypot(bx - px, by - py);
		const r = Math.min(CORNER_R, la / 2, lb / 2);
		if (!(r > .5)) {
			out.push(px, py);
			continue;
		}
		const x0 = px + (ax - px) / la * r, y0 = py + (ay - py) / la * r;
		const x1 = px + (bx - px) / lb * r, y1 = py + (by - py) / lb * r;
		for (let k = 0; k <= 4; k++) {
			const t = k / 4, u = 1 - t;
			out.push(u * u * x0 + 2 * u * t * px + t * t * x1, u * u * y0 + 2 * u * t * py + t * t * y1);
		}
	}
	out.push(c[2 * n - 2], c[2 * n - 1]);
	return out;
}
/**
* Нитка с коленом в trunk (x для горизонтальной, y для вертикальной):
* corners — опорные точки ломаной (для обхода карточек), pts — она же со скруглёнными углами (для рисования).
*/
function makeCurve(r, trunk = r.mid) {
	const { sx, sy, ex, ey } = r;
	let corners;
	if (r.horizontal) corners = Math.abs(sy - ey) < .5 ? [sx, sy, ex, ey] : [sx, sy, trunk, sy, trunk, ey, ex, ey];
	else corners = Math.abs(sx - ex) < .5 ? [sx, sy, ex, ey] : [sx, sy, sx, trunk, ex, trunk, ex, ey];
	return {
		sx,
		sy,
		ex,
		ey,
		adx: r.horizontal ? r.dir : 0,
		ady: r.horizontal ? 0 : r.dir,
		corners,
		pts: roundCorners(corners)
	};
}
function linkCurve(a, b) {
	return makeCurve(linkRoute(a, b));
}
/** Треугольник стрелки на конце нитки (вдоль последнего отрезка), size — длина в мировых единицах. */
function arrowHead(c, size) {
	const tx = c.adx, ty = c.ady;
	const bx = c.ex - tx * size, by = c.ey - ty * size;
	return [
		c.ex,
		c.ey,
		bx - ty * size * .45,
		by + tx * size * .45,
		bx + ty * size * .45,
		by - tx * size * .45
	];
}
/** Точка на середине длины нитки — для подписи типа связи. */
function curveMid(c) {
	const p = c.pts;
	let total = 0;
	for (let i = 2; i < p.length; i += 2) total += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
	let half = total / 2;
	for (let i = 2; i < p.length; i += 2) {
		const len = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
		if (len >= half && len > 0) {
			const f = half / len;
			return [p[i - 2] + (p[i] - p[i - 2]) * f, p[i - 1] + (p[i + 1] - p[i - 1]) * f];
		}
		half -= len;
	}
	return [c.sx, c.sy];
}
var GEO_CELL = 400;
var GEO_PAD = 6;
var GEO_CACHE = 3e4;
/** Задевает ли отрезок прямоугольник (Лианг–Барски). */
function segHitsBox(x0, y0, x1, y1, r) {
	let t0 = 0, t1 = 1;
	const dx = x1 - x0, dy = y1 - y0;
	const p = [
		-dx,
		dx,
		-dy,
		dy
	];
	const q = [
		x0 - r.x0,
		r.x1 - x0,
		y0 - r.y0,
		r.y1 - y0
	];
	for (let i = 0; i < 4; i++) {
		if (p[i] === 0) {
			if (q[i] < 0) return false;
			continue;
		}
		const t = q[i] / p[i];
		if (p[i] < 0) {
			if (t > t1) return false;
			if (t > t0) t0 = t;
		} else {
			if (t < t0) return false;
			if (t < t1) t1 = t;
		}
	}
	return t0 <= t1;
}
var LinkRouter = class {
	grid = /* @__PURE__ */ new Map();
	cache = /* @__PURE__ */ new Map();
	constructor(blocks) {
		for (const b of blocks) {
			const box = {
				id: b.id,
				x0: b.x - GEO_PAD,
				y0: b.y - GEO_PAD,
				x1: b.x + (b.w ?? 240) + GEO_PAD,
				y1: b.y + (b.h ?? 100) + GEO_PAD
			};
			for (let cx = Math.floor(box.x0 / GEO_CELL); cx <= Math.floor(box.x1 / GEO_CELL); cx++) for (let cy = Math.floor(box.y0 / GEO_CELL); cy <= Math.floor(box.y1 / GEO_CELL); cy++) {
				const k = `${cx},${cy}`;
				let arr = this.grid.get(k);
				if (!arr) this.grid.set(k, arr = []);
				arr.push(box);
			}
		}
	}
	/** Сколько чужих карточек задевает ломаная (свои карточки на концах не считаются). */
	hits(c, aId, bId) {
		const seen = /* @__PURE__ */ new Set();
		const p = c.corners;
		for (let i = 2; i < p.length; i += 2) {
			const x0 = p[i - 2], y0 = p[i - 1], x1 = p[i], y1 = p[i + 1];
			for (let cx = Math.floor(Math.min(x0, x1) / GEO_CELL); cx <= Math.floor(Math.max(x0, x1) / GEO_CELL); cx++) for (let cy = Math.floor(Math.min(y0, y1) / GEO_CELL); cy <= Math.floor(Math.max(y0, y1) / GEO_CELL); cy++) for (const box of this.grid.get(`${cx},${cy}`) ?? []) {
				if (box.id === aId || box.id === bId || seen.has(box.id)) continue;
				if (segHitsBox(x0, y0, x1, y1, box)) seen.add(box.id);
			}
		}
		return seen.size;
	}
	/** Нитка связи: колено посередине, а если там чужая карточка — ближайшее свободное место в промежутке (кэш по положению концов). */
	curve(aId, a, bId, b) {
		const key = `${aId}:${a.x},${a.y},${a.w},${a.h}|${bId}:${b.x},${b.y},${b.w},${b.h}`;
		const hit = this.cache.get(key);
		if (hit) return hit;
		const r = linkRoute(a, b);
		let best = makeCurve(r);
		let bestHits = this.hits(best, aId, bId);
		if (bestHits > 0 && r.lo !== r.hi) for (const f of [
			.35,
			.65,
			.2,
			.8,
			0,
			1
		]) {
			const c = makeCurve(r, r.lo + (r.hi - r.lo) * f);
			const h = this.hits(c, aId, bId);
			if (h < bestHits) {
				best = c;
				bestHits = h;
			}
			if (bestHits === 0) break;
		}
		if (this.cache.size > GEO_CACHE) this.cache.clear();
		this.cache.set(key, best);
		return best;
	}
};
/** Границы связи (колено всегда между концами) с запасом — для индексов тайлов и отсечения. */
function routedBounds(a, b) {
	const r = linkRoute(a, b);
	return {
		x0: Math.min(r.sx, r.ex) - 40,
		y0: Math.min(r.sy, r.ey) - 40,
		x1: Math.max(r.sx, r.ex) + 40,
		y1: Math.max(r.sy, r.ey) + 40
	};
}
//#endregion
//#region src/shared/render/snapshot.ts
var FONT = "Segoe UI, Arial, sans-serif";
var esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Обрезка строки по приблизительной ширине (средний символ ≈ 0.55 кегля) — для SVG без измерения текста. */
function fit(text, size, width, lines) {
	const perLine = Math.max(4, Math.floor(width / (size * .55)));
	const words = text.split(/\s+/).filter(Boolean);
	const out = [];
	let line = "";
	for (const w of words) if ((line + " " + w).trim().length <= perLine) line = (line + " " + w).trim();
	else {
		if (line) out.push(line);
		line = w.length > perLine ? w.slice(0, perLine - 1) + "…" : w;
		if (out.length === lines) break;
	}
	if (line && out.length < lines) out.push(line);
	if (out.join(" ").length < words.join(" ").length && out.length) out[out.length - 1] = out[out.length - 1].replace(/.{0,1}$/, "…");
	return out.slice(0, lines);
}
function boardSnapshot(db, boardId, opts = {}) {
	const all = listBlocks(db, boardId);
	const tags = new Map(listTags(db, boardId).map((t) => [t.id, t]));
	const pad = 60;
	const bbox = (list) => ({
		x0: Math.min(...list.map((b) => b.x)) - pad,
		y0: Math.min(...list.map((b) => b.y)) - pad,
		x1: Math.max(...list.map((b) => b.x + b.w)) + pad,
		y1: Math.max(...list.map((b) => b.y + b.h)) + pad
	});
	let region = all.length ? bbox(all) : {
		x0: 0,
		y0: 0,
		x1: 800,
		y1: 500
	};
	if (opts.region) {
		const r = opts.region;
		const inside = all.filter((b) => b.x < r.x1 && b.x + b.w > r.x0 && b.y < r.y1 && b.y + b.h > r.y0);
		const c = inside.length ? bbox(inside) : r;
		region = {
			x0: Math.max(r.x0, c.x0),
			y0: Math.max(r.y0, c.y0),
			x1: Math.min(r.x1, c.x1),
			y1: Math.min(r.y1, c.y1)
		};
	}
	const rw = region.x1 - region.x0, rh = region.y1 - region.y0;
	const maxPx = opts.maxPx ?? 2e3;
	const scale = Math.min(1.5, maxPx / rw, maxPx / rh);
	const width = Math.round(rw * scale), height = Math.round(rh * scale);
	const inRegion = (r) => !(r.x1 < region.x0 || r.x0 > region.x1 || r.y1 < region.y0 || r.y0 > region.y1);
	const blocks = all.filter((b) => inRegion({
		x0: b.x,
		y0: b.y,
		x1: b.x + b.w,
		y1: b.y + b.h
	}));
	const byId = new Map(all.map((b) => [b.id, b]));
	const lod = scale >= .45 ? "full" : scale >= .2 ? "plate" : "dots";
	const px = (v) => v / scale;
	const parts = [];
	parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${region.x0} ${region.y0} ${rw} ${rh}" font-family="${FONT}">`, `<rect x="${region.x0}" y="${region.y0}" width="${rw}" height="${rh}" fill="${THEME.canvas}"/>`);
	if (lod !== "dots") {
		const router = new LinkRouter(all);
		for (const l of listLinks(db, boardId)) {
			const a = byId.get(l.fromId), b = byId.get(l.toId);
			if (!a || !b || !inRegion(routedBounds(a, b))) continue;
			const c = router.curve(a.id, a, b.id, b);
			const st = LINK_STYLE[l.type];
			const dash = st.dash.length ? ` stroke-dasharray="${st.dash.map(px).join(" ")}"` : "";
			parts.push(`<path d="M${c.pts.slice(0, 2).join(" ")} L${c.pts.slice(2).join(" ")}" fill="none" stroke="${st.color}" stroke-opacity="0.8" stroke-width="${px(st.width * 1.2)}"${dash}/>`, `<polygon points="${arrowHead(c, px(9)).join(" ")}" fill="${st.color}" fill-opacity="0.8"/>`);
		}
	}
	for (const b of blocks) {
		const color = b.color ?? BLOCK_STYLE[b.type].color;
		if (lod === "dots") {
			parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="${color}" fill-opacity="0.85"/>`);
			continue;
		}
		if (lod === "plate") {
			parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-opacity="0.6" stroke-width="2"/>`);
			const lines = fit(b.title, 26, b.w - 24, Math.max(1, Math.min(6, Math.floor((b.h - 24) / 30))));
			lines.forEach((ln, i) => parts.push(`<text x="${b.x + 12}" y="${b.y + (b.h - lines.length * 30) / 2 + 24 + i * 30}" font-size="26" font-weight="600" fill="${THEME.text}">${esc(ln)}</text>`));
			continue;
		}
		parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="8" fill="#1C1C1C" stroke="#333"/>`);
		parts.push(`<rect x="${b.x}" y="${b.y + 8}" width="3" height="${b.h - 16}" rx="1.5" fill="${color}"/>`);
		parts.push(`<text x="${b.x + 12}" y="${b.y + 22}" font-size="10" fill="${color}">${esc(ru.blockType[b.type].toUpperCase())}</text>`);
		parts.push(`<text x="${b.x + 12}" y="${b.y + 40}" font-size="14" font-weight="600" fill="${THEME.text}">${esc(fit(b.title, 14, b.w - 24, 1)[0] ?? "")}</text>`);
		fit(markdownToPlain(b.description), 11.5, b.w - 24, Math.max(1, Math.floor((b.h - 64) / 15))).forEach((ln, i) => parts.push(`<text x="${b.x + 12}" y="${b.y + 58 + i * 15}" font-size="11.5" fill="${THEME.textMuted}">${esc(ln)}</text>`));
		let x = b.x + 12;
		const pill = (label, c) => {
			const w = label.length * 6 + 12;
			if (x + w > b.x + b.w - 10) return;
			parts.push(`<rect x="${x}" y="${b.y + b.h - 24}" width="${w}" height="15" rx="4" fill="${c}" fill-opacity="0.18"/>`);
			parts.push(`<text x="${x + 6}" y="${b.y + b.h - 13}" font-size="10" font-weight="600" fill="${c}">${esc(label)}</text>`);
			x += w + 4;
		};
		if (b.type === "task" && b.status) pill(ru.status[b.status], STATUS_COLOR[b.status]);
		if (b.type === "task" && b.priority) pill(ru.priority[b.priority], PRIORITY_COLOR[b.priority]);
		for (const id of b.tagIds) {
			const tg = tags.get(id);
			if (tg) pill(tg.name, tg.color);
		}
	}
	parts.push("</svg>");
	return {
		svg: parts.join("\n"),
		width,
		height,
		scale,
		region,
		blocks: blocks.length
	};
}
//#endregion
//#region src/main/agents.ts
var KINDS = ["claude", "zcode"];
var INSTRUCTION_FILES = {
	"CLAUDE.md": "CLAUDE.snippet.md",
	"AGENTS.md": "AGENTS.snippet.md"
};
/**
* Подключение агентов (ТЗ 8.1): команда запуска MCP, запись в конфиги Claude Code / Z Code,
* инструкции в проект, промпт «Отправить агенту».
* Портативная сборка: Ariadne.exe + mcp/server.js рядом; в разработке — electron.exe + out/mcp/server.js
* и явная папка данных (иначе MCP искал бы её от своего пути).
*/
var Agents = class {
	db;
	dataDir;
	constructor(db, dataDir) {
		this.db = db;
		this.dataDir = dataDir;
	}
	root() {
		return app.isPackaged ? dirname(process.execPath) : app.getAppPath();
	}
	spec(kind) {
		const server = app.isPackaged ? join(this.root(), "mcp", "server.js") : join(this.root(), "out", "mcp", "server.js");
		return launchSpec(process.execPath, server, kind, app.isPackaged ? {} : { ARIADNE_DATA: this.dataDir });
	}
	info() {
		const home = homedir();
		return {
			serverExists: existsSync(this.spec("claude").args[0]),
			claudeCli: claudeCliCommand(this.spec("claude")),
			agents: KINDS.map((kind) => {
				const st = agentStatus(kind, home, this.spec(kind));
				return {
					kind,
					name: AGENT_NAMES[kind],
					status: st.status,
					file: st.file,
					snippet: manualSnippet(kind, this.spec(kind))
				};
			})
		};
	}
	connect(kind) {
		return connectAgent(kind, homedir(), this.spec(kind));
	}
	async chooseProjectDir(boardId) {
		const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
		const r = await dialog.showOpenDialog(win, {
			properties: ["openDirectory"],
			title: "Папка проекта для этой доски"
		});
		if (r.canceled || !r.filePaths[0]) return null;
		setBoardProjectDir(this.db, boardId, r.filePaths[0]);
		this.writeOverview(boardId);
		return r.filePaths[0];
	}
	clearProjectDir(boardId) {
		setBoardProjectDir(this.db, boardId, null);
	}
	writeOverview(boardId) {
		const b = getBoard(this.db, boardId);
		return b ? writeOverviewFile(this.db, b) : null;
	}
	/** Вписать блок инструкций в CLAUDE.md / AGENTS.md папки проекта доски. */
	writeInstructions(boardId, files) {
		const b = getBoard(this.db, boardId);
		if (!b?.projectDir) throw new Error("Сначала выберите папку проекта");
		return files.map((name) => {
			const tpl = readFileSync(join(this.root(), "agent-instructions", INSTRUCTION_FILES[name]), "utf8");
			return {
				file: name,
				result: upsertInstructions(join(b.projectDir, name), renderSnippet(tpl, b.name))
			};
		});
	}
	/** «Отправить агенту»: промпт сразу в буфер обмена (прямой отправки в агент нет — ТЗ 8.7). */
	copyTaskPrompt(taskId) {
		const text = buildTaskPrompt(this.db, taskId);
		clipboard.writeText(text);
		return text;
	}
	/**
	* Экспорт PNG (ТЗ 10.1): вся доска или область — тот же рендер, что get_snapshot (без защищённых полей),
	* но крупнее. Файл выбирает владелец в диалоге сохранения.
	*/
	async exportPng(boardId, region, fixedPath) {
		const b = getBoard(this.db, boardId);
		if (!b) throw new Error("Доска не найдена");
		const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
		const r = fixedPath ? {
			canceled: false,
			filePath: fixedPath
		} : await dialog.showSaveDialog(win, {
			title: "Экспорт доски в PNG",
			defaultPath: join(app.getPath("pictures"), `Ariadne — ${b.name.replace(/[\\/:*?"<>|]/g, "_")}.png`),
			filters: [{
				name: "PNG",
				extensions: ["png"]
			}]
		});
		if (r.canceled || !r.filePath) return null;
		const snap = boardSnapshot(this.db, boardId, {
			region: region ?? void 0,
			maxPx: 4e3
		});
		const wasm = app.isPackaged ? join(this.root(), "mcp", "resvg.wasm") : join(this.root(), "out", "mcp", "resvg.wasm");
		writeFileSync(r.filePath, await svgToPng(snap.svg, wasm));
		return r.filePath;
	}
	copyText(text) {
		clipboard.writeText(text);
	}
};
//#endregion
//#region src/main/ipc.ts
/** Белый список методов, доступных renderer'у. Автор всех изменений из UI — владелец. */
function registerIpc(ctx) {
	const { db } = ctx;
	const files = new Attachments(db, ctx.dataDir);
	const agents = new Agents(db, ctx.dataDir);
	const vault = new Vault(db);
	const S = (dir) => ctx.notes.storeFor(dir);
	let sender = null;
	const test = () => {
		if (!ctx.flags.shots) throw new Error("Только в режиме проверки");
	};
	const handlers = {
		listBoards: () => listBoards(db),
		createBoard: (name) => createBoard(db, name),
		renameBoard: (id, name) => renameBoard(db, id, name),
		reorderBoards: (ids) => reorderBoards(db, ids),
		deleteBoard: (id) => deleteBoard(db, id),
		restoreBoard: (id) => restoreBoard(db, id),
		getGraph: (boardId) => getGraph(db, boardId),
		getBlockDetails: (id) => getBlockDetails(db, id),
		createBlock: (input) => createBlock(db, input, OWNER_AUTHOR),
		updateBlock: (id, patch) => updateBlock(db, id, patch),
		moveBlocks: (moves) => moveBlocks(db, moves),
		resizeBlock: (id, r) => resizeBlock(db, id, r.w, r.h, r.x, r.y),
		deleteBlock: (id) => deleteBlock(db, id),
		restoreBlock: (id) => restoreBlock(db, id),
		createLink: (from, to, type) => createLink(db, from, to, type),
		updateLink: (id, patch) => updateLink(db, id, patch),
		deleteLink: (id) => deleteLink(db, id),
		restoreLink: (id) => restoreLink(db, id),
		setBlockTags: (blockId, names) => setBlockTags(db, blockId, names),
		updateTag: (id, patch) => updateTag(db, id, patch),
		addComment: (blockId, body) => addComment(db, blockId, OWNER_AUTHOR, body),
		deleteComment: (id) => deleteComment(db, id),
		addChecklistItems: (blockId, texts) => addChecklistItems(db, blockId, texts),
		updateChecklistItem: (id, patch) => updateChecklistItem(db, id, patch),
		deleteChecklistItem: (id) => deleteChecklistItem(db, id),
		addLinkAttachment: (blockId, url, name) => {
			const u = new URL(url);
			return addAttachment(db, blockId, {
				kind: "link",
				url: u.toString(),
				name: name?.trim() || u.host
			}, OWNER_AUTHOR);
		},
		addCodeAttachment: (blockId, name, language, content) => addAttachment(db, blockId, {
			kind: "code",
			name: name.trim() || language || "код",
			language,
			content
		}, OWNER_AUTHOR),
		pickAttachmentFiles: (blockId) => files.pickFiles(blockId),
		saveAttachmentBytes: (blockId, name, bytes) => files.saveBytes(blockId, name, bytes),
		deleteAttachment: (id) => files.remove(id),
		openAttachment: (id) => files.open(id),
		attachmentDataUrl: (id) => files.dataUrl(id),
		openExternal: (url) => openExternalSafe(url),
		search: (query) => search(db, query, void 0, 30),
		notesDir: () => ctx.notes.dir(),
		clipboardRead: async () => {
			let text = "", html = "";
			for (const item of await clipboard.read()) {
				if (!html && item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
				if (!text && item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
			}
			return {
				text,
				html
			};
		},
		notesList: () => ctx.notes.store.list(),
		notesRead: (name, dir) => {
			const md = S(dir).read(name);
			if (!dir) ctx.notes.remember(name, md);
			return md;
		},
		notesInfo: (name, dir) => S(dir).list().find((n) => n.name.toLowerCase() === name.toLowerCase()) ?? null,
		notesWrite: (name, content, dir) => {
			if (!dir) ctx.notes.snapshotBeforeOwnWrite(name, content);
			const info = S(dir).write(name, content);
			if (!dir) ctx.notes.remember(name, content);
			ctx.notes.notifyOthers(sender, name, dir ?? null);
			return info;
		},
		notesCreate: (title) => {
			const n = ctx.notes.store.create(title);
			ctx.notes.afterOwnChange([{
				kind: "created",
				name: n.name
			}]);
			return n;
		},
		notesSaveAsset: (note, fileName, bytes, dir) => S(dir).saveAsset(note, fileName, bytes),
		notesImportFile: (note, path, dir) => S(dir).importFile(note, path),
		notesPickFiles: async (images) => {
			const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
			const r = await dialog.showOpenDialog(win, {
				properties: ["openFile", "multiSelections"],
				filters: images ? [{
					name: "Картинки",
					extensions: [
						"png",
						"jpg",
						"jpeg",
						"gif",
						"webp",
						"bmp",
						"svg"
					]
				}] : []
			});
			return r.canceled ? [] : r.filePaths;
		},
		notesLinkHref: (path) => decodeHref(pathToFileURL(path).href),
		notesFileInfo: (href, dir) => S(dir).fileInfo(href),
		notesOpenFile: async (href, dir) => {
			const path = S(dir).resolveHref(href);
			if (RUNNABLE_EXT.test(path)) throw new Error("Программы и скрипты из заметок не запускаются — только «Показать в папке»");
			const err = await shell.openPath(path);
			if (err) throw new Error(err);
		},
		notesShowFile: (href, dir) => shell.showItemInFolder(S(dir).resolveHref(href)),
		uiSet: (key, value) => {
			if (key !== "section" && key !== "lastNote") throw new Error(`Неизвестный ключ: ${key}`);
			ctx.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(`ui_${key}`, String(value));
		},
		notesRename: (from, title, dir) => {
			const name = S(dir).rename(from, title);
			if (!dir && name !== from) {
				const d = ctx.notes.store.dir;
				renameInOrg(d, from, name);
				renameInAccess(d, from, name);
				renameInLinks(d, from, name);
				renameHistory(d, from, name);
			}
			ctx.notes.afterOwnChange([], dir ?? null);
			return name;
		},
		/** Внешний .md → в папку заметок (вместе с его `_assets/<имя>/`); возвращает имя заметки. */
		notesAddFile: (path) => {
			if (ctx.notes.isInNotesDir(path)) return basename(path).replace(/\.md$/i, "");
			const name = ctx.notes.store.addFile(path);
			ctx.notes.afterOwnChange([{
				kind: "created",
				name
			}]);
			return name;
		},
		notesPickMarkdown: async () => {
			const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
			const r = await dialog.showOpenDialog(win, {
				properties: ["openFile", "multiSelections"],
				filters: [{
					name: "Markdown",
					extensions: ["md"]
				}]
			});
			return r.canceled ? [] : r.filePaths;
		},
		openNoteWindow: (name) => ctx.windows.openNote(name),
		openFileWindow: (path) => ctx.windows.openFile(path),
		openMainWindow: (note) => ctx.windows.openMain(note),
		assocStatus: () => ctx.assoc.status(),
		assocEnable: () => ctx.assoc.enable(),
		assocDisable: () => ctx.assoc.disable(),
		notesTrash: (name) => {
			ctx.notes.store.trash(name);
			forgetInOrg(ctx.notes.store.dir, name);
			forgetInAccess(ctx.notes.store.dir, name);
			forgetInLinks(ctx.notes.store.dir, name);
			ctx.notes.afterOwnChange([{
				kind: "deleted",
				name
			}]);
		},
		notesOrg: () => readOrg(ctx.notes.store.dir),
		notesPin: (name) => togglePin(ctx.notes.store.dir, name),
		notesGroupCreate: (name, notes) => createGroup(ctx.notes.store.dir, name, notes).org,
		notesGroupRename: (id, name) => renameGroup(ctx.notes.store.dir, id, name),
		notesGroupDelete: (id) => deleteGroup(ctx.notes.store.dir, id),
		notesGroupCollapse: (id, collapsed) => setGroupCollapsed(ctx.notes.store.dir, id, collapsed),
		notesMoveToGroup: (name, id) => moveToGroup(ctx.notes.store.dir, name, id),
		notesFolderCreate: (name, notes) => createFolder(ctx.notes.store.dir, name, notes).org,
		notesFolderRename: (id, name) => renameFolder(ctx.notes.store.dir, id, name),
		notesFolderDelete: (id) => deleteFolder(ctx.notes.store.dir, id),
		notesFolderCollapse: (id, collapsed) => setFolderCollapsed(ctx.notes.store.dir, id, collapsed),
		notesMoveToFolder: (name, id) => moveToFolder(ctx.notes.store.dir, name, id),
		notesPinFolder: (id) => toggleFolderPin(ctx.notes.store.dir, id),
		notesPlace: (name, target, before, visible) => placeNote(ctx.notes.store.dir, name, target, before, visible),
		notesSearch: (query) => ctx.notes.index.search(ctx.notes.store, query),
		notesHistory: (name) => listSnapshots(ctx.notes.store.dir, name),
		notesSnapshot: (name, id) => readSnapshot(ctx.notes.store.dir, name, id),
		/** Вернуть версию: текущий текст — в историю («перед возвратом»), версия — в файл. */
		notesRestoreVersion: (name, id) => {
			const d = ctx.notes.store.dir;
			const version = readSnapshot(d, name, id);
			saveSnapshot(d, name, ctx.notes.store.read(name), "restore");
			ctx.notes.store.write(name, version);
			ctx.notes.remember(name, version);
			ctx.notes.notifyOthers(sender, name, null);
			return version;
		},
		notesExportPdf: (name, dir) => exportNotePdf(S(dir), name, dir ? ctx.notes.hostOf(dir) : "notes", ctx.flags.shots ? join(ctx.flags.shots, `${name}.pdf`) : void 0),
		/** Доступ агентов к заметке: подключаемые агенты + все, у кого уже есть права. */
		notesAccess: (name) => {
			const d = ctx.notes.store.dir;
			return [.../* @__PURE__ */ new Set([...Object.values(AGENT_NAMES), ...knownAgents(d)])].map((agent) => ({
				agent,
				level: levelOf(d, name, agent)
			}));
		},
		notesSetAccess: (name, agent, level) => {
			if (![
				"none",
				"read",
				"write"
			].includes(level)) throw new Error("Уровень: none / read / write");
			setLevel(ctx.notes.store.dir, name, agent, level);
		},
		/** «Отправить заметку агенту»: промпт в буфер; скрытые значения — [скрыто], если не включены разово. */
		notesAgentPrompt: (name, includeHidden) => {
			const d = ctx.notes.store.dir;
			const md = ctx.notes.store.read(name);
			const prompt = noteAgentPrompt(name, includeHidden ? md.replace(/<span data-ariadne="hidden">([\s\S]*?)<\/span>/g, "$1") : maskHidden(md).text, boardsOfNote(d, name).map((id) => getBoard(db, id)?.name).filter(Boolean));
			if (!ctx.flags.shots) clipboard.writeText(prompt);
			return {
				chars: prompt.length,
				hidden: !includeHidden && hasHidden(md),
				...ctx.flags.shots ? { prompt } : {}
			};
		},
		boardNotes: (boardId) => boardNotes(ctx.notes.store.dir, boardId),
		boardNotesEnable: (boardId, enabled) => setBoardNotesEnabled(ctx.notes.store.dir, boardId, enabled),
		boardNotesLink: (boardId, name) => linkNote(ctx.notes.store.dir, boardId, name),
		boardNotesUnlink: (boardId, name) => unlinkNote(ctx.notes.store.dir, boardId, name),
		notesTrashList: () => ctx.notes.store.listTrash(),
		notesRestore: (id) => {
			const name = ctx.notes.store.restore(id);
			ctx.notes.afterOwnChange([{
				kind: "created",
				name
			}]);
			return name;
		},
		notesPurgeTrash: () => {
			const n = ctx.notes.store.purgeTrash();
			ctx.notes.afterOwnChange([]);
			return n;
		},
		notesChooseDir: () => ctx.notes.chooseDir(),
		notesWriteExternal: (name, content) => {
			if (!ctx.flags.shots) throw new Error("Только в режиме проверки");
			writeFileSync(join(ctx.notes.store.dir, `${name}.md`), content, "utf8");
		},
		testWindows: () => (test(), BrowserWindow.getAllWindows().map((w) => w.getTitle())),
		testEval: async (titlePart, code) => {
			test();
			const win = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes(titlePart));
			if (!win) throw new Error(`Нет окна «${titlePart}»`);
			return win.webContents.executeJavaScript(code, true);
		},
		testWriteFile: (path, content) => (test(), mkdirSync(dirname(path), { recursive: true }), writeFileSync(path, content, "utf8")),
		testReadFile: (path) => (test(), existsSync(path) ? readFileSync(path, "utf8") : null),
		testSecondInstance: (args) => {
			test();
			const env = { ...process.env };
			delete env.ELECTRON_RUN_AS_NODE;
			spawn(process.execPath, [...app.isPackaged ? [] : [app.getAppPath()], ...args], {
				env,
				detached: true,
				stdio: "ignore"
			}).unref();
		},
		notesMoveTo: (dir) => {
			if (!ctx.flags.shots) throw new Error("Только в режиме проверки");
			return ctx.notes.moveTo(dir);
		},
		vaultStatus: () => vault.status(),
		vaultSetup: (password) => vault.setup(password),
		vaultUnlock: (password) => vault.unlock(password),
		vaultLock: () => vault.lock(),
		vaultChangePassword: (oldPassword, newPassword) => vault.changePassword(oldPassword, newPassword),
		getSecret: (blockId) => vault.getSecret(blockId),
		setSecret: (blockId, text) => vault.setSecret(blockId, text),
		listTrash: () => listTrash(db),
		purgeTrash: () => {
			for (const f of purgeTrash(db)) rmSync(join(ctx.dataDir, "attachments", f.boardId, f.path), { force: true });
		},
		agentsInfo: () => agents.info(),
		connectAgent: (kind) => agents.connect(kind),
		chooseProjectDir: (boardId) => agents.chooseProjectDir(boardId),
		clearProjectDir: (boardId) => agents.clearProjectDir(boardId),
		writeInstructions: (boardId, list) => agents.writeInstructions(boardId, list),
		copyTaskPrompt: (taskId) => agents.copyTaskPrompt(taskId),
		copyText: (text) => agents.copyText(text),
		exportPng: (boardId, region) => agents.exportPng(boardId, region, ctx.flags.shots ? join(ctx.flags.shots, region ? "export-view.png" : "export-all.png") : void 0),
		generateLoadBoard: (n, m) => generateLoadBoard(db, n, m),
		launchFlags: () => ctx.flags,
		reportBench: (result) => ctx.onBench(result),
		capture: (name, titlePart) => ctx.capture(name, titlePart)
	};
	ipcMain.handle("db", (e, method, ...args) => {
		const fn = handlers[method];
		if (!fn) throw new Error(`Неизвестный метод: ${method}`);
		sender = e.sender;
		let result;
		try {
			result = fn(...args);
		} finally {
			sender = null;
		}
		ctx.overview.poke();
		return result;
	});
}
//#endregion
//#region src/main/assoc.ts
var PROGID = "Ariadne.md";
var META = "md_assoc";
var USER_CHOICE = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.md\\UserChoice";
/**
* «Открывать .md в Ariadne» (ТЗ заметок §6): по умолчанию реестр не трогаем. Только по кнопке владельца
* и только для текущего пользователя (HKCU\Software\Classes): ProgId Ariadne.md, «Открыть с помощью», .md → Ariadne.md.
* «Убрать» удаляет всё своё и возвращает прежнее значение .md. Прежнее значение хранится в базе (meta).
* root — другой раздел реестра для сценария проверки (настоящий не трогаем).
*/
var MdAssociation = class {
	db;
	tmpDir;
	root;
	constructor(db, tmpDir, root = "HKCU\\Software\\Classes") {
		this.db = db;
		this.tmpDir = tmpDir;
		this.root = root;
		mkdirSync(tmpDir, { recursive: true });
	}
	reg(args) {
		try {
			return execFileSync("reg", args, {
				encoding: "utf8",
				windowsHide: true,
				stdio: [
					"ignore",
					"pipe",
					"ignore"
				]
			});
		} catch {
			return null;
		}
	}
	/**
	* Значение по умолчанию ключа (или именованное); не задано или нет ключа — null.
	* Через `reg export` (файл в UTF-16): вывод `reg query` — в кодировке консоли, и кириллица в пути
	* (папка «Рабочий стол», «Проверка») читалась бы искажённой. Временный файл — в папке данных.
	*/
	query(key, name) {
		const file = join(this.tmpDir, `reg-${process.pid}-${Date.now()}.reg`);
		try {
			if (this.reg([
				"export",
				key,
				file,
				"/y"
			]) === null || !existsSync(file)) return null;
			const lines = readFileSync(file).toString("utf16le").replace(/^﻿/, "").split(/\r?\n/);
			const start = lines.findIndex((l) => l.startsWith("["));
			const want = name ? `"${name.replace(/[\\"]/g, "\\$&")}"=` : "@=";
			for (const l of lines.slice(start + 1)) {
				if (l.startsWith("[")) break;
				if (!l.startsWith(want)) continue;
				const m = /^"((?:[^"\\]|\\.)*)"$/.exec(l.slice(want.length));
				return m ? m[1].replace(/\\(.)/g, "$1") : null;
			}
			return null;
		} finally {
			rmSync(file, { force: true });
		}
	}
	add(key, value, name, type = "REG_SZ") {
		if (this.reg([
			"add",
			key,
			...name ? ["/v", name] : ["/ve"],
			"/t",
			type,
			...type === "REG_NONE" ? [] : ["/d", value],
			"/f"
		]) === null) throw new Error(`Не удалось записать в реестр: ${key}`);
	}
	get exe() {
		return process.execPath;
	}
	/** Команда открытия: собранный exe — сам файл; в разработке — electron.exe + папка приложения. */
	command() {
		return app.isPackaged ? `"${this.exe}" "%1"` : `"${this.exe}" "${app.getAppPath()}" "%1"`;
	}
	backup() {
		const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META);
		try {
			return row ? JSON.parse(row.value) : null;
		} catch {
			return null;
		}
	}
	status() {
		const b = this.backup();
		const current = this.query(`${this.root}\\${PROGID}\\shell\\open\\command`);
		const enabled = !!b && !!current;
		const choice = this.root.startsWith("HKCU\\Software\\Classes") ? this.query(USER_CHOICE, "ProgId") : null;
		return {
			enabled,
			stale: enabled && current !== this.command(),
			command: current,
			userChoice: choice && choice !== PROGID ? choice : null
		};
	}
	enable() {
		const prev = this.backup();
		const was = this.query(`${this.root}\\.md`);
		const prevDefault = prev ? prev.prevDefault : was === PROGID ? null : was;
		const cmd = this.command();
		const icon = `"${this.exe}",0`;
		this.add(`${this.root}\\${PROGID}`, "Markdown — Ariadne");
		this.add(`${this.root}\\${PROGID}\\DefaultIcon`, icon);
		this.add(`${this.root}\\${PROGID}\\shell\\open\\command`, cmd);
		this.add(`${this.root}\\.md\\OpenWithProgids`, "", PROGID, "REG_NONE");
		this.add(`${this.root}\\.md`, PROGID);
		this.add(`${this.root}\\Applications\\${basename(this.exe)}\\shell\\open\\command`, cmd);
		this.add(`${this.root}\\Applications\\${basename(this.exe)}\\SupportedTypes`, "", ".md");
		const b = {
			command: cmd,
			prevDefault
		};
		this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(META, JSON.stringify(b));
		return this.status();
	}
	disable() {
		const b = this.backup();
		this.reg([
			"delete",
			`${this.root}\\${PROGID}`,
			"/f"
		]);
		this.reg([
			"delete",
			`${this.root}\\.md\\OpenWithProgids`,
			"/v",
			PROGID,
			"/f"
		]);
		this.reg([
			"delete",
			`${this.root}\\Applications\\${basename(this.exe)}`,
			"/f"
		]);
		if (this.query(`${this.root}\\.md`) === PROGID) {
			if (b?.prevDefault) this.add(`${this.root}\\.md`, b.prevDefault);
			else this.reg([
				"delete",
				`${this.root}\\.md`,
				"/ve",
				"/f"
			]);
		}
		this.db.prepare(`DELETE FROM meta WHERE key = ?`).run(META);
		return this.status();
	}
};
//#endregion
//#region src/shared/notes/location.ts
/**
* Где лежат заметки: по умолчанию `Sessions` в корне программы (рядом с `data/`); владелец может выбрать другую папку.
* Путь в базе — относительно корня программы, если папка внутри него (переживает смену буквы флешки).
* Одна функция и для приложения, и для MCP-сервера.
*/
var SETTING = "notes_dir";
var appRootOf$1 = (dataDir) => dirname(dataDir);
function notesDirOf(db, dataDir) {
	const root = appRootOf$1(dataDir);
	const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(SETTING);
	if (!row) return join(root, "Sessions");
	return isAbsolute(row.value) ? row.value : resolve(root, row.value);
}
function saveNotesDir(db, dataDir, dir) {
	const rel = relative(appRootOf$1(dataDir), dir);
	const value = !rel.startsWith("..") && !isAbsolute(rel) ? rel : dir;
	db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SETTING, value);
}
//#endregion
//#region src/shared/notes/search.ts
var HIDDEN = /<span data-ariadne="hidden">[\s\S]*?<\/span>/g;
var MASK = "•••";
/** Для сравнения: регистр и «ё» не важны (длина строки не меняется — позиции совпадают с исходным текстом). */
var fold = (s) => s.toLocaleLowerCase("ru").replace(/ё/g, "е");
var hide = (s) => s.replace(/\\([\\`*_[\]{}()#+\-.!|<>~])/g, (_m, c) => String.fromCharCode(57344 + c.charCodeAt(0)));
var unhide = (s) => s.replace(/[-]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 57344));
function plainOfNote(md) {
	return unhide(markdownToPlain(hide(md).replace(HIDDEN, MASK).replace(/<!--[\s\S]*?-->/g, " ").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/^\|?\s*:?-{3,}.*$/gm, " ").replace(/\|/g, " ")));
}
var NotesIndex = class {
	cache = /* @__PURE__ */ new Map();
	entry(store, n) {
		const stamp = `${n.modifiedAt}:${n.size}`;
		const hit = this.cache.get(n.name);
		if (hit?.stamp === stamp) return hit;
		let plain = "";
		try {
			plain = plainOfNote(store.read(n.name));
		} catch {}
		const e = {
			stamp,
			plain,
			folded: fold(plain)
		};
		this.cache.set(n.name, e);
		return e;
	}
	search(store, query, limit = 200) {
		const q = fold(query.replace(/\s+/g, " ").trim());
		if (!q) return [];
		const list = store.list();
		const alive = new Set(list.map((n) => n.name));
		for (const k of this.cache.keys()) if (!alive.has(k)) this.cache.delete(k);
		const hits = [];
		for (const n of list) {
			const inName = fold(n.name).includes(q);
			const e = this.entry(store, n);
			const at = e.folded.indexOf(q);
			if (!inName && at < 0) continue;
			let snippet = null;
			if (at >= 0) {
				let from = Math.max(0, at - 18);
				const space = e.plain.lastIndexOf(" ", at - 1);
				if (space >= from) from = space + 1;
				const to = Math.min(e.plain.length, at + q.length + 80);
				snippet = [
					(from > 0 ? "…" : "") + e.plain.slice(from, at),
					e.plain.slice(at, at + q.length),
					e.plain.slice(at + q.length, to) + (to < e.plain.length ? "…" : "")
				];
			}
			hits.push({
				name: n.name,
				modifiedAt: n.modifiedAt,
				inName,
				snippet
			});
		}
		hits.sort((a, b) => Number(b.inName) - Number(a.inName) || b.modifiedAt - a.modifiedAt);
		return hits.slice(0, limit);
	}
};
//#endregion
//#region src/shared/notes/watcher.ts
var DEBOUNCE_MS = 150;
/**
* Наблюдение за папкой заметок (ТЗ заметок §3): внешние новые, изменённые, удалённые и переименованные
* `.md` сразу уходят в интерфейс. Переименование приходит парой «удалён + создан».
* Собственные записи приложения отсеиваются (тот же текст, что мы писали) — без эха.
* Папка плоская, поэтому хватает нерекурсивного fs.watch.
*/
var NotesWatcher = class {
	store;
	onChange;
	w = null;
	timers = /* @__PURE__ */ new Map();
	known = /* @__PURE__ */ new Set();
	constructor(store, onChange) {
		this.store = store;
		this.onChange = onChange;
	}
	start() {
		this.stop();
		this.known = new Set(this.store.list().map((n) => n.name));
		this.w = watch(this.store.dir, { persistent: true }, (_event, file) => {
			if (!file) return;
			const f = file.toString();
			if (f.startsWith(".") || f.endsWith(".tmp") || !f.toLowerCase().endsWith(".md")) return;
			const name = f.slice(0, -3);
			clearTimeout(this.timers.get(name));
			this.timers.set(name, setTimeout(() => this.settle(name), DEBOUNCE_MS));
		});
		this.w.on("error", () => this.stop());
	}
	settle(name) {
		this.timers.delete(name);
		const exists = existsSync(join(this.store.dir, `${name}.md`));
		let kind;
		if (!exists) {
			if (!this.known.delete(name)) return;
			kind = "deleted";
		} else if (!this.known.has(name)) {
			this.known.add(name);
			kind = "created";
		} else {
			if (this.store.isOwnWrite(name)) return;
			kind = "modified";
		}
		this.onChange([{
			kind,
			name
		}]);
	}
	/** Своё создание/удаление/переименование — чтобы известный список не разошёлся с диском. */
	sync() {
		this.known = new Set(this.store.list().map((n) => n.name));
	}
	stop() {
		this.w?.close();
		this.w = null;
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
	}
};
//#endregion
//#region src/main/notes.ts
var OWNER_SNAPSHOT_MS = 3e5;
/**
* Раздел «Заметки» в main: папка заметок (по умолчанию `Sessions` в корне программы), хранилище,
* наблюдатель и переезд папки. Путь в настройке хранится относительно корня программы, если папка
* внутри него, — так он переживает смену буквы флешки.
* Внешние .md (компактное окно, ТЗ заметок §6) — отдельные хранилища по папке файла, без служебной `.ariadne/`.
*/
var NotesService = class {
	db;
	appRoot;
	emit;
	store;
	/** Поиск по названию и тексту (индекс в памяти, файлы перечитываются только изменённые) */
	index = new NotesIndex();
	watcher;
	external = /* @__PURE__ */ new Map();
	/** Последний известный текст заметок папки заметок — чтобы перед изменением снаружи сохранить версию. */
	known = /* @__PURE__ */ new Map();
	constructor(db, appRoot, emit) {
		this.db = db;
		this.appRoot = appRoot;
		this.emit = emit;
		this.store = new NotesStore(this.resolveDir());
		this.watcher = new NotesWatcher(this.store, (c) => this.onMainChange(c));
		this.watcher.start();
	}
	/** Текст, который видит окно (прочитан или записан приложением). */
	remember(name, content) {
		this.known.set(name, content);
	}
	/** Изменение снаружи (агент, другая программа): прежний текст — в историю версий (ТЗ заметок §5.9). */
	onMainChange(changes) {
		for (const c of changes) {
			if (c.kind === "deleted") this.known.delete(c.name);
			if (c.kind !== "modified") continue;
			const old = this.known.get(c.name);
			try {
				const now = this.store.read(c.name);
				if (old !== void 0 && old !== now) saveSnapshot(this.store.dir, c.name, old, "external");
				this.known.set(c.name, now);
			} catch {}
		}
		this.emit(changes, null);
	}
	/** Правка владельца: версия не чаще раза в 5 минут — текст до начала серии правок. */
	snapshotBeforeOwnWrite(name, next) {
		try {
			const old = this.store.read(name);
			if (old === next || !old.trim()) return;
			const last = listSnapshots(this.store.dir, name)[0];
			if (!last || Date.now() - last.at > OWNER_SNAPSHOT_MS) saveSnapshot(this.store.dir, name, old, "owner");
		} catch {}
	}
	resolveDir() {
		return notesDirOf(this.db, join(this.appRoot, "data"));
	}
	saveDir(dir) {
		saveNotesDir(this.db, join(this.appRoot, "data"), dir);
	}
	dir() {
		return {
			path: this.store.dir,
			isDefault: resolve(this.store.dir) === resolve(join(this.appRoot, "Sessions"))
		};
	}
	/** Внешний файл лежит в папке заметок — это обычная заметка. */
	isInNotesDir(path) {
		return resolve(dirname(path)).toLowerCase() === resolve(this.store.dir).toLowerCase();
	}
	/** Открыть внешний .md: хранилище его папки (одно на папку) и наблюдение за ней. */
	openExternal(path) {
		const dir = resolve(dirname(path));
		const key = dir.toLowerCase();
		let ext = this.external.get(key);
		if (!ext) {
			const store = new NotesStore(dir, false);
			const watcher = new NotesWatcher(store, (c) => this.emit(c, dir));
			watcher.start();
			ext = {
				store,
				watcher,
				host: `x${this.external.size + 1}`
			};
			this.external.set(key, ext);
		}
		return {
			dir,
			name: basename(path).replace(/\.md$/i, ""),
			host: ext.host
		};
	}
	/** Хранилище по папке из окна: нет папки — папка заметок; чужую папку можно только ранее открытую. */
	storeFor(dir) {
		if (!dir) return this.store;
		const ext = this.external.get(resolve(dir).toLowerCase());
		if (!ext) throw new Error("Эта папка не открыта в Ariadne");
		return ext.store;
	}
	/** Адрес картинок папки внешнего файла (`x<N>`). */
	hostOf(dir) {
		return this.external.get(resolve(dir).toLowerCase())?.host ?? "notes";
	}
	/** Для схемы картинок: `notes` — папка заметок, `x<N>` — папка внешнего файла. */
	storeByHost(host) {
		if (host === "notes") return this.store;
		for (const e of this.external.values()) if (e.host === host) return e.store;
		return null;
	}
	/**
	* Своё создание/удаление/восстановление: наблюдатель такие изменения гасит (чтобы не было эха),
	* поэтому сообщаем окнам сами — список и корзина обновятся, откуда бы ни пришло действие.
	*/
	afterOwnChange(changes, dir = null) {
		if (!dir) this.watcher.sync();
		this.emit(changes, dir);
	}
	/** Запись из одного окна — остальным окнам как изменение снаружи (одна заметка открыта в двух окнах). */
	notifyOthers(sender, name, dir) {
		this.emit([{
			kind: "modified",
			name
		}], dir ? resolve(dir) : null, sender ?? void 0);
	}
	/**
	* Выбрать новую папку и перенести в неё всё (ТЗ заметок §3). Переносим в подпапку `Sessions`
	* выбранного места, если оно не пустое, — чтобы не смешивать заметки с чужими файлами.
	*/
	async chooseDir() {
		const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
		const r = await dialog.showOpenDialog(win, {
			title: "Папка для заметок",
			properties: ["openDirectory", "createDirectory"]
		});
		if (r.canceled || !r.filePaths[0]) return null;
		return this.moveTo(r.filePaths[0]);
	}
	moveTo(target) {
		const old = this.store.dir;
		this.watcher.stop();
		try {
			const { moved } = moveNotesDir(old, target);
			this.saveDir(target);
			this.store = new NotesStore(target);
			this.index = new NotesIndex();
			this.known.clear();
			this.watcher = new NotesWatcher(this.store, (c) => this.onMainChange(c));
			return {
				path: target,
				moved
			};
		} finally {
			this.watcher.start();
			this.emit([], null);
		}
	}
	stop() {
		this.watcher.stop();
		for (const e of this.external.values()) e.watcher.stop();
	}
};
var appRootOf = (dataDir) => dirname(dataDir);
//#endregion
//#region src/main/notesAssets.ts
/** До app.ready: своя схема для картинок заметок (окно не ходит в file://, CSP пускает только её). */
function registerAssetScheme() {
	protocol.registerSchemesAsPrivileged([{
		scheme: ASSET_SCHEME,
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			stream: true
		}
	}]);
}
/**
* `ariadne-asset://notes/_assets/<заметка>/<файл>` → файл из папки вложений текущей папки заметок
* (`x<N>` вместо `notes` — папка внешнего файла, открытого в компактном окне).
* Только картинки и только внутри `_assets/` (проверяет store.resolveHref) — больше ничего этой схемой не прочитать.
*/
function serveAssets(notes) {
	protocol.handle(ASSET_SCHEME, async (req) => {
		try {
			const url = new URL(req.url);
			const rel = url.pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/");
			const store = notes.storeByHost(url.host);
			if (!isImagePath(rel) || !store) return new Response("", { status: 403 });
			const abs = store.resolveHref(rel);
			return await net.fetch(pathToFileURL(abs).toString());
		} catch {
			return new Response("", { status: 404 });
		}
	});
}
//#endregion
//#region src/main/index.ts
var dataDir = resolveDataDir(app.getAppPath());
var runtimeDir = join(dataDir, ".runtime");
for (const key of [
	"userData",
	"sessionData",
	"logs",
	"crashDumps"
]) app.setPath(key, join(runtimeDir, key));
var shotsArg = process.argv.find((a) => a.startsWith("--shots="));
var liveArg = process.argv.find((a) => a.startsWith("--live="));
var flags = {
	bench: process.argv.includes("--bench") || !!shotsArg || !!liveArg,
	dev: !app.isPackaged,
	shots: shotsArg ? shotsArg.slice(8) : liveArg ? liveArg.slice(7) : null,
	live: !!liveArg,
	only: process.argv.find((a) => a.startsWith("--only="))?.slice(7) ?? null
};
var gotLock = flags.bench && !(shotsArg && !liveArg) || app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);
/** .md из аргументов запуска (двойной клик, «Открыть с помощью», перетаскивание на exe). */
var mdArgs = (argv) => argv.slice(1).filter((a) => !a.startsWith("-") && /\.md$/i.test(a) && existsSync(a)).map((a) => resolve(a));
var db = openDb(dataDir);
var overview = new OverviewWriter(db, (e) => console.error("PROJECT_BOARD.md:", e));
var notes = new NotesService(db, appRootOf(dataDir), (changes, dir, except) => {
	for (const w of BrowserWindow.getAllWindows()) if (w.webContents !== except) w.webContents.send("notes:changed", changes, dir);
});
var assoc = new MdAssociation(db, join(runtimeDir, "tmp"), flags.shots ? "HKCU\\Software\\Ariadne-check\\Classes" : void 0);
var mainWin = null;
var compact = /* @__PURE__ */ new Map();
registerIpc({
	db,
	dataDir,
	flags,
	overview,
	notes,
	assoc,
	windows: {
		openNote: (name) => openCompact({ note: name }),
		openFile: (path) => openFile(path),
		openMain: (note) => openMain(note)
	},
	capture: async (name, titlePart) => {
		const win = titlePart && BrowserWindow.getAllWindows().find((w) => w.getTitle().includes(titlePart)) || mainWin || BrowserWindow.getAllWindows()[0];
		if (!win || !flags.shots) return;
		const img = await win.webContents.capturePage();
		mkdirSync(flags.shots, { recursive: true });
		writeFileSync(join(flags.shots, `${name}.png`), img.toPNG());
	},
	onBench: (result) => {
		process.stdout.write("BENCH " + JSON.stringify(result) + "\n");
		app.quit();
	}
});
var UI_KEYS = ["section", "lastNote"];
function readUiState(d) {
	const out = {};
	for (const k of UI_KEYS) {
		const row = d.prepare(`SELECT value FROM meta WHERE key = ?`).get(`ui_${k}`);
		if (row) out[k] = row.value;
	}
	return out;
}
function baseWindow(opts) {
	const win = new BrowserWindow({
		...opts,
		backgroundColor: "#121212",
		autoHideMenuBar: false,
		icon: join(app.getAppPath(), "assets/branding/app-icon.ico"),
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			sandbox: false,
			contextIsolation: true,
			backgroundThrottling: !flags.bench
		}
	});
	win.setMenuBarVisibility(false);
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	win.webContents.on("will-navigate", (e, url) => {
		if (url !== win.webContents.getURL()) e.preventDefault();
	});
	if (flags.bench) {
		win.webContents.on("console-message", (e) => process.stdout.write(`[renderer:${e.level}] ${e.message}\n`));
		win.webContents.on("render-process-gone", (_e, d) => process.stdout.write(`[renderer gone] ${d.reason}\n`));
	}
	return win;
}
function load(win, page, query) {
	if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html?${new URLSearchParams(query)}`);
	else win.loadFile(join(import.meta.dirname, `../renderer/${page}.html`), { query });
}
/** Главное окно (доски и заметки); note — сразу открыть эту заметку. */
function openMain(note) {
	if (mainWin) {
		if (note) mainWin.webContents.send("open-note", note);
		if (mainWin.isMinimized()) mainWin.restore();
		mainWin.focus();
		return;
	}
	const win = baseWindow({
		width: 1440,
		height: 900,
		minWidth: 900,
		minHeight: 600,
		title: "Ariadne"
	});
	mainWin = win;
	win.on("closed", () => mainWin = null);
	const query = readUiState(db);
	if (note) Object.assign(query, {
		section: "notes",
		lastNote: note
	});
	load(win, "index", query);
	watchExternalChanges(win);
}
/**
* Компактное окно одной заметки (ТЗ заметок §6): без досок и холста — отдельная лёгкая страница.
* note — заметка из папки заметок; file — внешний .md (правится прямо в исходном файле).
*/
function openCompact(target) {
	const key = "note" in target ? `note:${target.note.toLowerCase()}` : `file:${target.file.toLowerCase()}`;
	const open = compact.get(key);
	if (open) {
		if (open.isMinimized()) open.restore();
		return open.focus();
	}
	let query;
	let title;
	if ("note" in target) {
		query = { note: target.note };
		title = target.note;
	} else {
		const ext = notes.openExternal(target.file);
		query = {
			note: ext.name,
			dir: ext.dir,
			host: ext.host
		};
		title = basename(target.file);
	}
	const win = baseWindow({
		width: 820,
		height: 760,
		minWidth: 420,
		minHeight: 320,
		title
	});
	compact.set(key, win);
	win.on("closed", () => compact.delete(key));
	load(win, "compact", query);
}
/** Файл из папки заметок — это заметка; любой другой .md — внешний файл. */
function openFile(path) {
	if (notes.isInNotesDir(path)) openCompact({ note: basename(path).replace(/\.md$/i, "") });
	else openCompact({ file: path });
}
function watchExternalChanges(win) {
	let last = dataVersion(db);
	const timer = setInterval(() => {
		const v = dataVersion(db);
		if (v !== last) {
			last = v;
			win.webContents.send("db:changed");
			overview.poke();
		}
	}, 250);
	win.on("closed", () => clearInterval(timer));
}
registerAssetScheme();
app.on("second-instance", (_e, argv) => {
	const files = mdArgs(argv);
	if (files.length) files.forEach(openFile);
	else openMain();
});
app.whenReady().then(() => {
	if (!gotLock) return;
	serveAssets(notes);
	const files = flags.bench ? [] : mdArgs(process.argv);
	if (files.length) files.forEach(openFile);
	else openMain();
});
app.on("window-all-closed", () => {
	notes.stop();
	db.close();
	app.quit();
});
//#endregion
export {};
