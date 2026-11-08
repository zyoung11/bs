"use strict";

// parseBookmarksHtml parses a Netscape bookmark export into nested nodes.
function parseBookmarksHtml(text) {
  const doc = new DOMParser().parseFromString(text, "text/html");
  const roots = [];
  const dls = doc.querySelectorAll("dl");
  const firstDl = dls[0];
  if (!firstDl) return roots;
  walkBookmarkDl(firstDl, { children: roots });
  return roots;
}

// walkBookmarkDl fills parent.children from one DL element.
function walkBookmarkDl(dl, parent) {
  for (const dt of dl.children) {
    if (dt.tagName !== "DT") continue;
    const h3 = dt.querySelector(":scope > h3");
    const a = dt.querySelector(":scope > a");
    if (h3) {
      const folder = { type: "folder", title: h3.textContent.trim(), children: [] };
      parent.children.push(folder);
      const childDl = dt.querySelector(":scope > dl");
      if (childDl) walkBookmarkDl(childDl, folder);
    } else if (a) {
      parent.children.push({
        type: "bookmark",
        title: a.textContent.trim(),
        url: a.getAttribute("href") ?? "",
      });
    }
  }
}

// parsePasswordsCsv reads a Chrome or Firefox password CSV export.
function parsePasswordsCsv(text) {
  const rows = splitCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const colName = header.indexOf("name");
  const colUrl = header.indexOf("url");
  const colUser = header.indexOf("username");
  const colPass = header.indexOf("password");
  if (colUser < 0 || colPass < 0) throw new Error("CSV 缺少 username 或 password 列");
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length === 1 && row[0] === "") continue;
    out.push({
      name: colName >= 0 ? row[colName] ?? "" : "",
      url: colUrl >= 0 ? row[colUrl] ?? "" : "",
      username: row[colUser] ?? "",
      password: row[colPass] ?? "",
      note: "",
    });
  }
  return out;
}

// splitCsv splits CSV text into rows handling quoted fields.
function splitCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

// buildImportOps converts a parsed tree into create ops under sync roots.
function buildImportOps(tree) {
  const ops = [];
  const roots = assignImportRoots(tree);
  for (const [parentSync, items] of Object.entries(roots)) {
    items.forEach((item, index) => collectImportOps(item, parentSync, index, ops));
  }
  return ops;
}

// assignImportRoots places top level items into the sync roots.
// Roots are built from RoleAlias so the set always tracks the roles.
function assignImportRoots(tree) {
  const roots = {};
  for (const role of Object.keys(RoleAlias)) {
    roots["root:" + role] = [];
  }
  const fallback = roots["root:unfiled"] ?? roots[Object.keys(roots)[0]];
  for (const item of tree) {
    const role = item.type === "folder" ? matchRole(item.title) : null;
    if (role && roots["root:" + role]) {
      for (const child of item.children) roots["root:" + role].push(child);
    } else {
      fallback.push(item);
    }
  }
  return roots;
}

// matchRole maps an exported root folder name to a sync role.
function matchRole(title) {
  const t = title.trim().toLowerCase();
  for (const [role, names] of Object.entries(RoleAlias)) {
    if (names.includes(t)) return role;
  }
  return null;
}

// collectImportOps flattens one subtree into ordered create ops.
function collectImportOps(item, parentSync, index, ops) {
  const id = crypto.randomUUID();
  ops.push({
    t: "c",
    id,
    parent: parentSync,
    index,
    type: item.type,
    title: item.title,
    url: item.url ?? "",
  });
  if (item.type === "folder") {
    item.children.forEach((child, i) => collectImportOps(child, id, i, ops));
  }
}

// buildBookmarksHtml serializes nested nodes into a Netscape bookmark
// export that parseBookmarksHtml and browsers can read back.
function buildBookmarksHtml(items) {
  const parts = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  for (const item of items) parts.push(buildBookmarkItem(item, 1));
  parts.push("</DL><p>");
  return parts.join("\n") + "\n";
}

// buildBookmarkItem serializes one node with one indent level per depth.
function buildBookmarkItem(item, depth) {
  const pad = "  ".repeat(depth);
  if (item.type === "folder") {
    const kids = (item.children ?? []).map((child) => buildBookmarkItem(child, depth + 1));
    return (
      pad + "<DT><H3>" + escapeHtml(item.title ?? "") + "</H3>\n" +
      pad + "<DL><p>\n" + kids.join("\n") + "\n" +
      pad + "</DL><p>"
    );
  }
  return pad + '<DT><A HREF="' + escapeAttr(item.url ?? "") + '">' + escapeHtml(item.title ?? "") + "</A>";
}

function escapeHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

// buildPasswordsCsv serializes login entries into a Chrome compatible
// password CSV with a name, url, username, password header.
function buildPasswordsCsv(entries) {
  const rows = [["name", "url", "username", "password"]];
  for (const entry of entries) {
    rows.push([entry.name ?? "", entry.url ?? "", entry.username ?? "", entry.password ?? ""]);
  }
  return rows.map((row) => row.map(csvField).join(",")).join("\n") + "\n";
}

function csvField(value) {
  const text = String(value);
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}
