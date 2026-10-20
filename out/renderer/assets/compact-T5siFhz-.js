import { C as undo, D as t, X as FolderInput, dt as require_react, ht as __toESM, lt as require_client, n as NoteView, o as doc, s as setDoc, st as AppWindow, t as NoteAgentTools, w as require_jsx_runtime } from "./styles-DE-hp9V6.js";
//#region src/renderer/notes/CompactNote.tsx
var import_client = require_client();
var import_react = /* @__PURE__ */ __toESM(require_react(), 1);
var import_jsx_runtime = require_jsx_runtime();
var C = t.notes.compact;
var q = new URLSearchParams(location.search);
setDoc(q.get("dir"), q.get("host") ?? "notes");
/**
* Компактное окно (ТЗ заметок §6): одна заметка — дата, панель форматирования, редактор. Без досок.
* Заметка из папки заметок — кнопка «Открыть в Ariadne»; внешний .md правится прямо в исходном файле,
* кнопка «Добавить в заметки» переносит его в папку заметок (с подтверждением).
*/
function CompactNote() {
	const [name, setName] = (0, import_react.useState)(q.get("note") ?? "");
	const [dir, setDir] = (0, import_react.useState)(doc.dir);
	const [info, setInfo] = (0, import_react.useState)(null);
	const [missing, setMissing] = (0, import_react.useState)(false);
	const [metaSlot, setMetaSlot] = (0, import_react.useState)(null);
	const [toolbarSlot, setToolbarSlot] = (0, import_react.useState)(null);
	const [actionsSlot, setActionsSlot] = (0, import_react.useState)(null);
	const [toast, setToast] = (0, import_react.useState)(null);
	const [confirm, setConfirm] = (0, import_react.useState)(null);
	const handle = (0, import_react.useRef)(null);
	(0, import_react.useEffect)(() => {
		undo.notify = setToast;
	}, []);
	(0, import_react.useEffect)(() => {
		if (!toast) return;
		const timer = setTimeout(() => setToast(null), 2500);
		return () => clearTimeout(timer);
	}, [toast]);
	(0, import_react.useEffect)(() => {
		let alive = true;
		const load = () => window.api.notesInfo(name, dir).then((i) => {
			if (!alive) return;
			setInfo(i);
			setMissing(!i);
		});
		load();
		const off = window.api.onNotesChanged((changes, d) => d === dir && changes.some((c) => c.name === name) && load());
		return () => {
			alive = false;
			off();
		};
	}, [name, dir]);
	(0, import_react.useEffect)(() => {
		document.title = dir ? `${name}.md — Ariadne` : `${name} — Ariadne`;
	}, [name, dir]);
	const askAdd = async () => setConfirm((await window.api.notesDir()).path);
	const addToNotes = async () => {
		setConfirm(null);
		try {
			await handle.current?.flush();
			const added = await window.api.notesAddFile(`${dir}\\${name}.md`);
			setInfo(null);
			setDoc(null);
			setDir(null);
			setName(added);
			setToast(C.added(added));
		} catch (e) {
			setToast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
		}
	};
	return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
		className: "compact-app",
		children: [
			/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", {
				className: "topbar tall",
				children: [/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "topbar-row",
					children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
						className: "topbar-meta",
						ref: setMetaSlot
					}), /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
						className: "icon-row",
						children: [
							/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
								className: "note-actions",
								ref: setActionsSlot
							}),
							dir ? /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								className: "mini-btn",
								title: C.external(dir),
								onClick: askAdd,
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(FolderInput, { size: 13 }),
									" ",
									C.addToNotes
								]
							}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NoteAgentTools, {
								name,
								flush: () => handle.current?.flush() ?? Promise.resolve()
							}),
							!dir && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("button", {
								className: "mini-btn",
								onClick: () => window.api.openMainWindow(name),
								children: [
									/* @__PURE__ */ (0, import_jsx_runtime.jsx)(AppWindow, { size: 13 }),
									" ",
									C.openInMain
								]
							})
						]
					})]
				}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "topbar-tools",
					ref: setToolbarSlot
				})]
			}),
			/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "notes-main",
				children: info ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(NoteView, {
					note: info,
					metaSlot,
					toolbarSlot,
					actionsSlot,
					handleRef: handle,
					onSaved: setInfo,
					onRenamed: (_from, to) => {
						setName(to);
						setInfo((i) => i ? {
							...i,
							name: to
						} : i);
					}
				}, dir ?? "") : missing && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
					className: "empty-hint",
					children: C.missing
				})
			}),
			confirm && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "modal-backdrop",
				onPointerDown: () => setConfirm(null),
				children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
					className: "modal attach-ask",
					onPointerDown: (e) => e.stopPropagation(),
					children: [
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "modal-title",
							children: C.confirmTitle
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
							className: "attach-files",
							children: C.confirmText(`${name}.md`, confirm)
						}),
						/* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", {
							className: "modal-actions",
							children: [/* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								className: "btn",
								onClick: () => setConfirm(null),
								children: C.cancel
							}), /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", {
								className: "btn primary",
								autoFocus: true,
								onClick: addToNotes,
								children: C.confirmMove
							})]
						})
					]
				})
			}),
			toast && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", {
				className: "toast",
				children: toast
			})
		]
	});
}
//#endregion
//#region src/renderer/compact.tsx
(0, import_client.createRoot)(document.getElementById("root")).render(/* @__PURE__ */ (0, import_jsx_runtime.jsx)(CompactNote, {}));
//#endregion
