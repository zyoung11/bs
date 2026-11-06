"use strict";

const $ = (id) => document.getElementById(id);

function say(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
}

// entrySummary picks the display columns for one vault entry by type.
function entrySummary(entry) {
  const type = entry.type ?? "login";
  if (type === "card") {
    const last4 = (entry.number ?? "").replace(/\D/g, "").slice(-4);
    return { head: "信用卡" + (last4 ? " ··" + last4 : ""), sub: entry.cardholder ?? "", secret: entry.number ?? "" };
  }
  if (type === "identity") {
    return { head: entry.fullName ?? "", sub: entry.email ?? entry.phone ?? "", secret: entry.phone ?? "" };
  }
  return { head: entry.url ?? "", sub: entry.username ?? "", secret: entry.password ?? "" };
}

function send(msg) {
  return api.runtime.sendMessage(msg).then((resp) => {
    if (!resp.ok) throw new Error(resp.error);
    return resp.data;
  });
}

async function refreshStatus() {
  try {
    const st = await send({ type: "status" });
    if (!st.configured) {
      $("status").textContent = "未配置。填写下方初始化表单。";
      return;
    }
    $("status").textContent =
      "已连接 " + st.url +
      "，书签 " + st.progress.bookmarks.seq + " 条操作" +
      "，密码 " + st.passwordCount + " 条";
    await refreshPasswords();
  } catch (e) {
    $("status").textContent = "状态读取失败：" + e.message;
  }
}

async function refreshPasswords() {
  const list = await send({ type: "passwords" });
  const table = $("pwTable");
  const tbody = table.querySelector("tbody");
  tbody.textContent = "";
  if (list.length === 0) {
    table.classList.add("hidden");
    return;
  }
  table.classList.remove("hidden");
  for (const entry of list) {
    const tr = document.createElement("tr");
    const summary = entrySummary(entry);
    for (const value of [entry.name ?? "", summary.head, summary.sub]) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }
    const tdPass = document.createElement("td");
    const btnShow = document.createElement("button");
    btnShow.textContent = "显示";
    btnShow.addEventListener("click", () => {
      tdPass.textContent = tdPass.textContent === "****" ? summary.secret ?? "" : "****";
    });
    tdPass.appendChild(btnShow);
    tr.appendChild(tdPass);
    const tdDel = document.createElement("td");
    const btnDel = document.createElement("button");
    btnDel.textContent = "删除";
    btnDel.addEventListener("click", async () => {
      try {
        await send({ type: "password", action: "delete", entry });
        await refreshPasswords();
        say("pwMsg", "已删除", true);
      } catch (e) {
        say("pwMsg", e.message, false);
      }
    });
    tdDel.appendChild(btnDel);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  }
}

function readFile(input) {
  const file = input.files[0];
  if (!file) return Promise.reject(new Error("先选择文件"));
  return file.text();
}

$("setup").addEventListener("click", async () => {
  try {
    await send({
      type: "setup",
      url: $("url").value.trim(),
      master: $("master").value,
      configToken: $("configToken").value.trim(),
    });
    say("setupMsg", "连接成功", true);
    await refreshStatus();
  } catch (e) {
    say("setupMsg", e.message, false);
  }
});

$("importHtml").addEventListener("click", async () => {
  try {
    const text = await readFile($("htmlFile"));
    const tree = parseBookmarksHtml(text);
    const res = await send({ type: "import-bookmarks", tree });
    say("htmlMsg", "导入 " + res.count + " 个节点", true);
  } catch (e) {
    say("htmlMsg", e.message, false);
  }
});

$("importCsv").addEventListener("click", async () => {
  try {
    const text = await readFile($("csvFile"));
    const res = await send({ type: "import-passwords", text });
    say("csvMsg", "导入 " + res.count + " 条密码", true);
  } catch (e) {
    say("csvMsg", e.message, false);
  }
});

$("pwAdd").addEventListener("click", async () => {
  try {
    const type = $("pwType").value;
    const entry = { type, note: "" };
    for (const input of document.querySelectorAll("[data-field]")) {
      entry[input.dataset.field] = input.value.trim();
    }
    await send({ type: "password", action: "create", entry });
    say("pwMsg", "已添加", true);
    await refreshPasswords();
  } catch (e) {
    say("pwMsg", e.message, false);
  }
});

$("pwType").addEventListener("change", () => {
  const type = $("pwType").value;
  for (const row of document.querySelectorAll("[data-types]")) {
    row.classList.toggle("hidden", !row.dataset.types.split(" ").includes(type));
  }
});
document.getElementById("pwType").dispatchEvent(new Event("change"));

refreshStatus();
