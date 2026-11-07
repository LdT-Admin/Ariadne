let electron = require("electron");
//#region src/preload/index.ts
var call = (method) => (...args) => electron.ipcRenderer.invoke("db", method, ...args);
var api = Object.fromEntries([
	"listBoards",
	"createBoard",
	"renameBoard",
	"reorderBoards",
	"deleteBoard",
	"restoreBoard",
	"getGraph",
	"getBlockDetails",
	"createBlock",
	"updateBlock",
	"moveBlocks",
	"resizeBlock",
	"deleteBlock",
	"restoreBlock",
	"createLink",
	"updateLink",
	"deleteLink",
	"restoreLink",
	"setBlockTags",
	"updateTag",
	"addComment",
	"deleteComment",
	"addChecklistItems",
	"updateChecklistItem",
	"deleteChecklistItem",
	"addLinkAttachment",
	"addCodeAttachment",
	"pickAttachmentFiles",
	"saveAttachmentBytes",
	"deleteAttachment",
	"openAttachment",
	"attachmentDataUrl",
	"openExternal",
	"agentsInfo",
	"connectAgent",
	"chooseProjectDir",
	"clearProjectDir",
	"writeInstructions",
	"copyTaskPrompt",
	"copyText",
	"exportPng",
	"clipboardRead",
	"notesDir",
	"notesList",
	"notesRead",
	"notesWrite",
	"notesCreate",
	"notesRename",
	"uiSet",
	"notesTrash",
	"notesTrashList",
	"notesRestore",
	"notesPurgeTrash",
	"notesChooseDir",
	"notesMoveTo",
	"notesWriteExternal",
	"notesOrg",
	"notesPin",
	"notesGroupCreate",
	"notesGroupRename",
	"notesGroupDelete",
	"notesGroupCollapse",
	"notesMoveToGroup",
	"notesFolderCreate",
	"notesFolderRename",
	"notesFolderDelete",
	"notesFolderCollapse",
	"notesMoveToFolder",
	"notesPinFolder",
	"notesGroupPlace",
	"notesFolderPlace",
	"notesPlace",
	"notesSearch",
	"testWindows",
	"testEval",
	"testWriteFile",
	"testReadFile",
	"testSecondInstance",
	"notesHistory",
	"notesSnapshot",
	"notesRestoreVersion",
	"notesExportPdf",
	"notesAccess",
	"notesSetAccess",
	"notesAgentPrompt",
	"boardNotes",
	"boardNotesEnable",
	"boardNotesLink",
	"boardNotesUnlink",
	"notesInfo",
	"notesAddFile",
	"notesPickMarkdown",
	"openNoteWindow",
	"openFileWindow",
	"openMainWindow",
	"assocStatus",
	"assocEnable",
	"assocDisable",
	"notesSaveAsset",
	"notesImportFile",
	"notesPickFiles",
	"notesLinkHref",
	"notesFileInfo",
	"notesOpenFile",
	"notesShowFile",
	"search",
	"listTrash",
	"purgeTrash",
	"generateLoadBoard",
	"launchFlags",
	"updatesCheck",
	"updatesApply",
	"syncStatus",
	"syncRegister",
	"syncLogin",
	"syncLogout",
	"syncNow",
	"boardShare",
	"noteShare",
	"reportBench",
	"capture"
].map((m) => [m, call(m)]));
api.onDbChanged = (cb) => {
	const listener = () => cb();
	electron.ipcRenderer.on("db:changed", listener);
	return () => electron.ipcRenderer.removeListener("db:changed", listener);
};
api.onNotesChanged = (cb) => {
	const listener = (_e, changes, dir) => cb(changes, dir ?? null);
	electron.ipcRenderer.on("notes:changed", listener);
	return () => electron.ipcRenderer.removeListener("notes:changed", listener);
};
api.onOpenNote = (cb) => {
	const listener = (_e, name) => cb(name);
	electron.ipcRenderer.on("open-note", listener);
	return () => electron.ipcRenderer.removeListener("open-note", listener);
};
api.onUpdateAvailable = (cb) => {
	const listener = (_e, info) => cb(info);
	electron.ipcRenderer.on("update:available", listener);
	return () => electron.ipcRenderer.removeListener("update:available", listener);
};
api.onUpdateProgress = (cb) => {
	const listener = (_e, p) => cb(p);
	electron.ipcRenderer.on("update:progress", listener);
	return () => electron.ipcRenderer.removeListener("update:progress", listener);
};
api.onSyncDone = (cb) => {
	const listener = (_e, s) => cb(s);
	electron.ipcRenderer.on("sync:done", listener);
	return () => electron.ipcRenderer.removeListener("sync:done", listener);
};
api.onSyncError = (cb) => {
	const listener = (_e, s) => cb(s);
	electron.ipcRenderer.on("sync:error", listener);
	return () => electron.ipcRenderer.removeListener("sync:error", listener);
};
api.filePathOf = (file) => electron.webUtils.getPathForFile(file);
electron.contextBridge.exposeInMainWorld("api", api);
//#endregion
