"use strict";

const $ = (id) => document.getElementById(id);

function say(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
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
    for (const field of ["name", "url", "username"]) {
      const td = document.createElement("td");
      td.textContent = entry[field] ?? "";
      tr.appendChild(td);
    }
    const tdPass = document.createElement("td");
    const btnShow = document.createElement("button");
    btnShow.textContent = "显示";
    btnShow.addEventListener("click", () => {
      tdPass.textContent = tdPass.textContent === "****" ? entry.password ?? "" : "****";
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
    const res = await send({ type: "import-bookmarks", text });
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
    await send({
      type: "password",
      action: "create",
      entry: {
        name: $("pwName").value.trim(),
        url: $("pwUrl").value.trim(),
        username: $("pwUser").value.trim(),
        password: $("pwPass").value,
        note: "",
      },
    });
    say("pwMsg", "已添加", true);
    await refreshPasswords();
  } catch (e) {
    say("pwMsg", e.message, false);
  }
});

refreshStatus();
