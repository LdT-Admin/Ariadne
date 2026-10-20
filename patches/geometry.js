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
