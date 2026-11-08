"use strict";

const RoleNames = ["toolbar", "unfiled"];

const RoleAlias = {
  toolbar: ["书签栏", "书签工具栏", "工具栏", "bookmarks bar", "bookmarks toolbar", "toolbar"],
  unfiled: ["其他书签", "未分类书签", "未分类", "other bookmarks", "unsorted bookmarks"],
};

const RoleByLocalId = {
  "1": "toolbar",
  "2": "unfiled",
  "toolbar_____": "toolbar",
  "unfiled_____": "unfiled",
};

const PasswordFields = [
  "name", "type", "url", "username", "password", "note", "totp",
  "cardholder", "number", "exp", "cvv",
  "fullName", "email", "phone", "address", "city", "zip", "country",
];

let config = null;
let idmap = { l2s: {}, s2l: {} };
let snapshot = {};
let progress = { bookmarks: { gen: 0, seq: 0 }, passwords: { gen: 0, seq: 0 } };
let passwords = {};
let never = {};
let ws = null;
let wsDown = false;
let diffTimer = null;
let applying = 0;
let pushedIds = new Set();

// init loads persisted state and starts the sync channel.
async function init() {
  config = await Store.get("bs_config", null);
  idmap = await Store.get("bs_idmap", { l2s: {}, s2l: {} });
  snapshot = await Store.get("bs_snapshot", {});
  progress = await Store.get("bs_progress", { bookmarks: { gen: 0, seq: 0 }, passwords: { gen: 0, seq: 0 }, settings: { gen: 0, seq: 0 } });
  progress.settings ??= { gen: 0, seq: 0 };
  passwords = await Store.get("bs_passwords", {});
  never = await Store.get("bs_never", {});
  wireEvents();
  api.alarms.create("bs-sync", { periodInMinutes: 1 });
  if (!config) return;
  BsApi.configure(config.url, config.token);
  await resolveRoles();
  connect();
  syncAll().catch(() => {});
}

// resolveRoles maps the browser root folders to the two sync roles.
async function resolveRoles() {
  const tree = await api.bookmarks.getTree();
  const root = tree[0];
  const roles = {};
  for (const child of root.children ?? []) {
    const role = RoleByLocalId[child.id];
    if (role) roles[role] = child.id;
  }
  for (const role of RoleNames) {
    const syncId = "root:" + role;
    idmap.s2l[syncId] = roles[role];
    idmap.l2s[roles[role]] = syncId;
  }
  await Store.set("bs_idmap", idmap);
}

// connect opens the WebSocket and restarts it after a drop.
function connect() {
  ws = BsApi.openSocket(onSocketMessage, () => {
    wsDown = true;
    setTimeout(() => {
      if (config) connect();
    }, 5000);
  });
  ws.onopen = () => {
    wsDown = false;
    syncAll().catch(() => {});
  };
}

// onSocketMessage applies pushed ops and reacts to resets.
function onSocketMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === "op") {
    handleRemoteOp(msg.log, msg.entry);
  } else if (msg.type === "reset") {
    progress[msg.log].gen = 0;
    syncLog(msg.log).catch(() => {});
  }
}

// syncAll pulls both logs and reconciles the local mirror.
async function syncAll() {
  for (const log of ["bookmarks", "passwords", "settings"]) {
    await syncLog(log);
  }
}

// syncLog pulls the ops a log missed and applies them in order.
async function syncLog(log) {
  const res = await BsApi.pull(log, progress[log].seq);
  if (res.gen !== progress[log].gen) {
    await replayLocal(log);
    return;
  }
  applying++;
  try {
    for (const entry of res.entries ?? []) {
      if (entry.seq <= progress[log].seq) continue;
      await applyEntry(log, entry);
      progress[log].seq = entry.seq;
    }
    if (progress[log].seq < res.latest) progress[log].seq = res.latest;
    progress[log].gen = res.gen;
    await Store.set("bs_progress", progress);
    if (log === "bookmarks") await refreshSnapshot();
    if (log === "passwords") await Store.set("bs_passwords", passwords);
    if (log === "settings") await Store.set("bs_never", never);
  } finally {
    applying--;
  }
}

// replayLocal wipes the local mirror and rebuilds it from the log.
async function replayLocal(log) {
  applying++;
  try {
    await wipeLocal(log);
    const res = await BsApi.pull(log, 0);
    for (const entry of res.entries ?? []) {
      await applyEntry(log, entry);
      progress[log].seq = entry.seq;
    }
    progress[log].gen = res.gen;
    if (progress[log].seq < res.latest) progress[log].seq = res.latest;
    await Store.set("bs_progress", progress);
    if (log === "bookmarks") await refreshSnapshot();
    if (log === "passwords") await Store.set("bs_passwords", passwords);
    if (log === "settings") await Store.set("bs_never", never);
  } finally {
    applying--;
  }
}

// handleRemoteOp applies one pushed op and tracks the cursor.
// Entries we pushed ourselves come back as broadcast echoes and are
// skipped by their recorded entry id, so a local change is never
// re-applied as a remote one.
function handleRemoteOp(log, entry) {
  if (!entry || entry.seq <= progress[log].seq) return;
  if (pushedIds.has(entry.id)) {
    pushedIds.delete(entry.id);
    progress[log].seq = entry.seq;
    Store.set("bs_progress", progress).catch(() => {});
    return;
  }
  if (entry.seq > progress[log].seq + 1) {
    syncLog(log).catch(() => {});
    return;
  }
  applying++;
  applyEntry(log, entry)
    .then(async () => {
      progress[log].seq = entry.seq;
      await Store.set("bs_progress", progress);
      if (log === "bookmarks") await refreshSnapshot();
      if (log === "passwords") await Store.set("bs_passwords", passwords);
      if (log === "settings") await Store.set("bs_never", never);
    })
    .catch(() => {})
    .finally(() => {
      applying--;
    });
}

// applyEntry decrypts one entry and dispatches it by log type.
async function applyEntry(log, entry) {
  const op = await BsCrypto.decrypt(config.keyRaw, entry.data);
  if (log === "bookmarks") {
    await applyBookmarkOp(op);
  } else if (log === "settings") {
    applySettingsOp(op);
  } else {
    applyPasswordOp(op);
  }
}

// applyBookmarkOp mutates the bookmark tree for one remote op.
async function applyBookmarkOp(op) {
  if (op.t === "c") {
    const parentLocal = idmap.s2l[op.parent];
    if (!parentLocal) return;
    const params = { parentId: parentLocal, index: op.index, title: op.title };
    if (op.type === "bookmark") params.url = op.url;
    const created = await api.bookmarks.create(params).catch(() => null);
    if (!created) return;
    idmap.s2l[op.id] = created.id;
    idmap.l2s[created.id] = op.id;
    await Store.set("bs_idmap", idmap);
    return;
  }
  const localId = idmap.s2l[op.id];
  if (!localId) return;
  if (op.t === "d") {
    await api.bookmarks.removeTree(localId).catch(() => {});
    delete idmap.s2l[op.id];
    delete idmap.l2s[localId];
    await Store.set("bs_idmap", idmap);
    return;
  }
  if (op.t === "u") {
    const params = { title: op.title };
    if (op.type === "bookmark") params.url = op.url;
    await api.bookmarks.update(localId, params).catch(() => {});
    return;
  }
  if (op.t === "m") {
    const parentLocal = idmap.s2l[op.parent];
    if (!parentLocal) return;
    await api.bookmarks.move(localId, { parentId: parentLocal, index: op.index }).catch(() => {});
  }
}

// applySettingsOp merges one remote settings op into the local state.
function applySettingsOp(op) {
  if (op.t === "never") {
    never[op.host] = true;
    return;
  }
  if (op.t === "unnever") {
    delete never[op.host];
  }
}

// applyPasswordOp merges one remote password op into the local vault.
function applyPasswordOp(op) {
  if (op.t === "d") {
    delete passwords[op.id];
    return;
  }
  const entry = passwords[op.id] ?? {};
  for (const field of PasswordFields) {
    if (op[field] !== undefined) entry[field] = op[field];
  }
  entry.id = op.id;
  passwords[op.id] = entry;
}

// wipeLocal clears the local mirror before a full replay.
async function wipeLocal(log) {
  if (log === "bookmarks") {
    for (const role of RoleNames) {
      const localRoot = idmap.s2l["root:" + role];
      if (!localRoot) continue;
      const children = await api.bookmarks.getChildren(localRoot).catch(() => []);
      for (const child of children) {
        const syncId = idmap.l2s[child.id];
        if (syncId && syncId.startsWith("root:")) continue;
        await api.bookmarks.removeTree(child.id).catch(() => {});
      }
    }
    const kept = { l2s: {}, s2l: {} };
    for (const role of RoleNames) {
      const syncId = "root:" + role;
      kept.s2l[syncId] = idmap.s2l[syncId];
      kept.l2s[idmap.s2l[syncId]] = syncId;
    }
    idmap = kept;
    await Store.set("bs_idmap", idmap);
    return;
  }
  if (log === "settings") {
    never = {};
    await Store.set("bs_never", never);
    return;
  }
  passwords = {};
  await Store.set("bs_passwords", passwords);
}

// collectNodes flattens the managed bookmark subtree into a node list.
// When assign is true every node without a sync id gets a fresh one so
// that child nodes can reference their new parents.
async function collectNodes(assign) {
  const out = [];
  for (const role of RoleNames) {
    const localRoot = idmap.s2l["root:" + role];
    if (!localRoot) continue;
    const subs = await api.bookmarks.getSubTree(localRoot).catch(() => []);
    if (subs.length === 0) continue;
    walkNodes(subs[0].children ?? [], "root:" + role, out, assign);
  }
  return out;
}

// walkNodes flattens the tree depth first. A role root nested under
// another role root is skipped because its own pass collects it.
function walkNodes(nodes, parentSync, out, assign) {
  for (const node of nodes) {
    let syncId = idmap.l2s[node.id] ?? null;
    if (syncId && syncId.startsWith("root:")) continue;
    if (!syncId && assign) {
      syncId = crypto.randomUUID();
      idmap.l2s[node.id] = syncId;
      idmap.s2l[syncId] = node.id;
    }
    out.push({
      localId: node.id,
      syncId,
      parent: parentSync,
      index: node.index,
      type: node.url ? "bookmark" : "folder",
      title: node.title,
      url: node.url ?? "",
    });
    if (node.children) {
      walkNodes(node.children, syncId ?? parentSync, out, assign);
    }
  }
}

// refreshSnapshot stores the current managed tree state for diffing.
async function refreshSnapshot() {
  const nodes = await collectNodes(false);
  const next = {};
  for (const node of nodes) {
    if (!node.syncId) continue;
    next[node.syncId] = {
      parent: node.parent,
      index: node.index,
      type: node.type,
      title: node.title,
      url: node.url,
    };
  }
  snapshot = next;
  await Store.set("bs_snapshot", snapshot);
}

// scheduleDiff queues a bookmark diff with a short debounce.
function scheduleDiff() {
  clearTimeout(diffTimer);
  diffTimer = setTimeout(() => diffAndPush().catch(() => {}), 300);
}

// diffAndPush turns local bookmark changes into encrypted ops.
async function diffAndPush() {
  if (!config) return;
  if (applying > 0) {
    scheduleDiff();
    return;
  }
  const nodes = await collectNodes(true);
  const current = {};
  const creates = [];
  const moves = [];
  const updates = [];
  for (const node of nodes) {
    const syncId = node.syncId;
    const state = { parent: node.parent, index: node.index, type: node.type, title: node.title, url: node.url };
    current[syncId] = state;
    const old = snapshot[syncId];
    if (!old) {
      creates.push({ t: "c", id: syncId, parent: node.parent, index: node.index, type: node.type, title: node.title, url: node.url });
      continue;
    }
    if (old.title !== state.title || old.url !== state.url || old.type !== state.type) {
      updates.push({ t: "u", id: syncId, type: state.type, title: state.title, url: state.url });
    }
    if (old.parent !== state.parent || old.index !== state.index) {
      moves.push({ t: "m", id: syncId, parent: state.parent, index: state.index });
    }
  }
  const deletes = [];
  for (const syncId of Object.keys(snapshot)) {
    if (!current[syncId]) {
      deletes.push({ t: "d", id: syncId });
    }
  }
  deletes.reverse();
  const ops = [...deletes, ...creates, ...updates, ...moves];
  await Store.set("bs_idmap", idmap);
  snapshot = current;
  await Store.set("bs_snapshot", snapshot);
  if (ops.length === 0) return;
  await pushOps("bookmarks", ops);
}

// rememberPush records a pushed entry id so its broadcast echo is skipped.
// The set is bounded so a dropped echo cannot grow it without limit.
function rememberPush(id) {
  pushedIds.add(id);
  if (pushedIds.size > 2000) {
    for (const stale of pushedIds) {
      pushedIds.delete(stale);
      if (pushedIds.size <= 1000) break;
    }
  }
}

// pushOps encrypts ops and appends them to a log in chunks.
async function pushOps(log, ops) {
  const key = await BsCrypto.importKey(config.keyRaw);
  for (let i = 0; i < ops.length; i += 500) {
    const chunk = ops.slice(i, i + 500);
    const entries = [];
    for (const op of chunk) {
      const entryId = crypto.randomUUID();
      rememberPush(entryId);
      entries.push({ id: entryId, data: await BsCrypto.encrypt(key, op) });
    }
    const res = await BsApi.push(log, entries);
    progress[log].gen = res.gen;
    if (res.latest > progress[log].seq) progress[log].seq = res.latest;
  }
  await Store.set("bs_progress", progress);
}

// wireEvents routes bookmark events into the diff queue.
function wireEvents() {
  api.bookmarks.onCreated.addListener(scheduleDiff);
  api.bookmarks.onRemoved.addListener(scheduleDiff);
  api.bookmarks.onChanged.addListener(scheduleDiff);
  api.bookmarks.onMoved.addListener(scheduleDiff);
  api.bookmarks.onChildrenReordered.addListener(scheduleDiff);
}

// resetConfig drops all local state and returns the extension to the
// unconfigured state. Server data is left untouched.
async function resetConfig() {
  config = null;
  idmap = { l2s: {}, s2l: {} };
  snapshot = {};
  progress = { bookmarks: { gen: 0, seq: 0 }, passwords: { gen: 0, seq: 0 }, settings: { gen: 0, seq: 0 } };
  passwords = {};
  never = {};
  applying = 0;
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  wsDown = false;
  await Store.set("bs_config", null);
  await Store.set("bs_idmap", idmap);
  await Store.set("bs_snapshot", snapshot);
  await Store.set("bs_progress", progress);
  await Store.set("bs_passwords", passwords);
  await Store.set("bs_never", never);
  return { ok: true };
}

// runSetup stores the credentials and seeds or replays the local tree.
async function runSetup(url, master, configToken) {
  const derived = await BsCrypto.derive(master);
  BsApi.configure(url, derived.token);
  if (configToken) {
    await BsApi.register(configToken, derived.token);
  }
  const probeBookmarks = await BsApi.pull("bookmarks", 0).catch((e) => {
    throw new Error(e.status === 401 ? "认证失败：主密码错误或服务器未注册" : "无法连接服务器");
  });
  const probePasswords = await BsApi.pull("passwords", 0);
  const probeSettings = await BsApi.pull("settings", 0);
  config = { url, keyRaw: derived.keyRaw, token: derived.token };
  await Store.set("bs_config", config);
  progress = {
    bookmarks: { gen: probeBookmarks.gen, seq: 0 },
    passwords: { gen: probePasswords.gen, seq: 0 },
    settings: { gen: probeSettings.gen, seq: 0 },
  };
  await Store.set("bs_progress", progress);
  await resolveRoles();
  if (probeBookmarks.latest > 0) {
    await replayLocal("bookmarks");
  } else {
    await diffAndPush();
  }
  if (probePasswords.latest > 0) {
    await replayLocal("passwords");
  }
  if (probeSettings.latest > 0) {
    await replayLocal("settings");
  }
  connect();
  return { ok: true };
}

// runImportBookmarks replaces the bookmark log with a parsed tree.
async function runImportBookmarks(tree) {
  const ops = buildImportOps(tree);
  const res = await BsApi.reset("bookmarks");
  progress.bookmarks = { gen: res.gen, seq: 0 };
  await Store.set("bs_progress", progress);
  await pushOps("bookmarks", ops);
  await replayLocal("bookmarks");
  return { count: ops.length };
}

// runImportPasswords replaces the password log with a CSV export.
async function runImportPasswords(text) {
  const rows = parsePasswordsCsv(text);
  const res = await BsApi.reset("passwords");
  progress.passwords = { gen: res.gen, seq: 0 };
  await Store.set("bs_progress", progress);
  const ops = rows.map((row) => ({ t: "c", id: crypto.randomUUID(), type: "login", ...row }));
  await pushOps("passwords", ops);
  await replayLocal("passwords");
  return { count: ops.length };
}

// matchEntries returns vault entries for the content script. Login
// entries match by base domain and entries without a URL always match,
// cards and identities list in full.
function matchEntries(url, kind) {
  const list = [];
  for (const entry of Object.values(passwords)) {
    if ((entry.type || "login") !== kind) continue;
    list.push(entry);
  }
  if (kind !== "login") return list;
  const target = hostOf(url);
  return list.filter((entry) => {
    if (!hostOf(entry.url)) return true;
    return target !== "" && sameSite(entry.url, target);
  });
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function sameSite(entryUrl, targetHost) {
  const host = hostOf(entryUrl);
  if (!host) return false;
  return host === targetHost || baseDomain(host) === baseDomain(targetHost);
}

function baseDomain(host) {
  return host.split(".").slice(-2).join(".");
}

// checkSaveCandidate classifies a captured credential. It returns skip
// when the site is ignored or the vault already holds the same secret,
// update when an entry differs, and new otherwise.
function checkSaveCandidate(url, username, password) {
  if (!config) return { mode: "skip" };
  const target = hostOf(url);
  const host = baseDomain(target);
  if (!host || never[host]) return { mode: "skip" };
  for (const entry of Object.values(passwords)) {
    if ((entry.type || "login") !== "login") continue;
    if (hostOf(entry.url) && !sameSite(entry.url, target)) continue;
    if ((entry.username || "") !== username) continue;
    if (entry.password === password) return { mode: "skip" };
    return { mode: "update", id: entry.id, old: entry.password };
  }
  return { mode: "new" };
}

// saveLogin stores a captured credential, updating the entry with the
// given id or creating a new login entry named after its host.
async function saveLogin(url, username, password, id) {
  if (id && passwords[id]) {
    const merged = { ...passwords[id], url, username, password };
    return changePassword("update", merged);
  }
  return changePassword("create", {
    name: hostOf(url) || username,
    type: "login",
    url,
    username,
    password,
    note: "",
    totp: "",
  });
}

// addNever marks the base domain of url as never-save and syncs the
// change through the settings log.
async function addNever(url) {
  const host = baseDomain(hostOf(url));
  if (!host || never[host]) return { ok: true };
  await pushOps("settings", [{ t: "never", host }]);
  never[host] = true;
  await Store.set("bs_never", never);
  return { ok: true };
}

// removeNever drops one base domain from the never-save list and syncs
// the change through the settings log.
async function removeNever(host) {
  if (!never[host]) return { ok: true };
  await pushOps("settings", [{ t: "unnever", host }]);
  delete never[host];
  await Store.set("bs_never", never);
  return { ok: true };
}

// changePassword pushes one password vault mutation.
async function changePassword(action, entry) {
  if (action === "delete") {
    await pushOps("passwords", [{ t: "d", id: entry.id }]);
    delete passwords[entry.id];
  } else {
    const id = entry.id ?? crypto.randomUUID();
    const op = { t: action === "update" ? "u" : "c", id };
    for (const field of PasswordFields) op[field] = entry[field] ?? "";
    await pushOps("passwords", [op]);
    passwords[id] = { ...op, id };
  }
  await Store.set("bs_passwords", passwords);
  return { ok: true };
}

// exportNodes flattens one local bookmark subtree into nested nodes.
async function exportNodes(localId) {
  const kids = await api.bookmarks.getChildren(localId);
  const out = [];
  for (const kid of kids) {
    if (kid.url) {
      out.push({ type: "bookmark", title: kid.title, url: kid.url });
      continue;
    }
    out.push({ type: "folder", title: kid.title, children: await exportNodes(kid.id) });
  }
  return out;
}

// exportBookmarks returns a Netscape HTML export of the two sync roots
// under the standard Chrome root folder names so import maps them back.
// Roots resolve from the live bookmark tree on every call, so a cold
// background start or a stale id map cannot yield an empty export.
// It throws when no root can be found or when both roots hold no items.
async function exportBookmarks() {
  const tree = await api.bookmarks.getTree();
  const top = tree[0] ?? { children: [] };
  const names = { toolbar: "Bookmarks Bar", unfiled: "Other Bookmarks" };
  const items = [];
  let found = 0;
  for (const role of RoleNames) {
    const localRoot = (top.children ?? []).find((child) => RoleByLocalId[child.id] === role);
    if (!localRoot) continue;
    found++;
    items.push({
      type: "folder",
      title: names[role] ?? role,
      children: await exportNodes(localRoot.id),
    });
  }
  if (found === 0) throw new Error("未找到书签同步根");
  if (items.every((item) => item.children.length === 0)) throw new Error("同步根下无书签");
  return buildBookmarksHtml(items);
}

// exportPasswords returns a Chrome compatible CSV of the login entries.
// Cards and identities are left out, matching browser CSV exports.
// Entries without a name fall back to their host like saved logins do.
function exportPasswords() {
  const list = Object.values(passwords)
    .filter((entry) => (entry.type || "login") === "login")
    .map((entry) => ({
      name: entry.name || hostOf(entry.url) || entry.username,
      url: entry.url,
      username: entry.username,
      password: entry.password,
    }));
  return buildPasswordsCsv(list);
}
