"use strict";

if (typeof importScripts === "function") {
  importScripts("state.js", "crypto.js", "api.js", "import.js", "totp.js", "engine.js");
}

const ready = init().catch((e) => console.error("bs init failed:", e));

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleRequest(msg, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message ?? e) }));
  return true;
});

api.alarms.onAlarm.addListener(async (alarm) => {
  await ready;
  if (alarm.name !== "bs-sync") return;
  if (!config) return;
  if (wsDown) connect();
  syncAll().catch(() => {});
});

// handleRequest routes UI messages to the engine.
async function handleRequest(msg, sender) {
  await ready;
  switch (msg.type) {
    case "save-show": {
      const tab = sender && sender.tab;
      if (tab && tab.id !== undefined) {
        await api.tabs
          .sendMessage(tab.id, { type: "bs-save-show", p: msg.p }, { frameId: 0 })
          .catch(() => {});
      }
      return null;
    }
    case "setup":
      return runSetup(msg.url, msg.master, msg.configToken ?? "");
    case "probe":
      return BsApi.probe(msg.url);
    case "reset":
      return resetConfig();
    case "import-bookmarks":
      return runImportBookmarks(msg.tree);
    case "import-passwords":
      return runImportPasswords(msg.text);
    case "password":
      return changePassword(msg.action, msg.entry);
    case "status":
      return {
        configured: config !== null,
        url: config?.url ?? "",
        progress,
        passwordCount: Object.keys(passwords).length,
      };
    case "passwords":
      return Object.values(passwords);
    case "matches":
      return matchEntries(msg.url, msg.kind);
    case "save-check":
      return checkSaveCandidate(msg.url, msg.username, msg.password);
    case "save-login":
      return saveLogin(msg.url, msg.username, msg.password, msg.id ?? "");
    case "save-never":
      return addNever(msg.url);
    case "never-list":
      return Object.keys(never);
    case "never-remove":
      return removeNever(msg.host);
    case "export-bookmarks":
      return exportBookmarks();
    case "export-passwords":
      return exportPasswords();
    default:
      throw new Error("unknown request " + msg.type);
  }
}
