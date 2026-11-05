"use strict";

if (typeof importScripts === "function") {
  importScripts("state.js", "crypto.js", "api.js", "import.js", "engine.js");
}

init().catch((e) => console.error("bs init failed:", e));

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleRequest(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message ?? e) }));
  return true;
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "bs-sync") return;
  if (!config) return;
  if (wsDown) connect();
  syncAll().catch(() => {});
});

// handleRequest routes UI messages to the engine.
async function handleRequest(msg) {
  switch (msg.type) {
    case "setup":
      return runSetup(msg.url, msg.master, msg.configToken ?? "");
    case "import-bookmarks":
      return runImportBookmarks(msg.text);
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
    default:
      throw new Error("unknown request " + msg.type);
  }
}
