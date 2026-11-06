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

function readFile(input) {
  const file = input.files[0];
  if (!file) return Promise.reject(new Error("先选择文件"));
  return file.text();
}

let configured = false;

// render draws the setup panel from the current login state.
// When configured the address and master password lock and only reset stays.
async function render() {
  const st = await send({ type: "status" });
  configured = st.configured;
  if (configured) {
    $("url").value = st.url;
    $("url").disabled = true;
    $("master").disabled = true;
    $("master").placeholder = "已锁定，重置后可改";
    $("configToken").value = "";
    $("tokenRow").classList.add("hidden");
    $("setup").classList.add("hidden");
    $("reset").classList.remove("hidden");
    $("reRegister").classList.add("hidden");
    $("setupNote").textContent = "已连接服务器。地址和主密码已锁定，更改请先重置。";
    $("status").textContent =
      "已连接 " + st.url +
      " · 书签 " + st.progress.bookmarks.seq + " 条操作" +
      " · 密码 " + st.passwordCount + " 条";
    return;
  }
  $("url").disabled = false;
  $("master").disabled = false;
  $("master").placeholder = "派生加密密钥和认证令牌";
  $("setup").classList.remove("hidden");
  $("reset").classList.add("hidden");
  $("status").textContent = "未配置。填写表单连接服务器。";
  await updateTokenVisibility();
}

// updateTokenVisibility probes the server and hides the token field when
// the server already holds a registered token, so the second machine and
// re-login only need the master password.
async function updateTokenVisibility() {
  const url = $("url").value.trim();
  if (!url) {
    $("tokenRow").classList.remove("hidden");
    $("reRegister").classList.add("hidden");
    $("setupNote").textContent = "填服务器地址后自动判断是否需要 config token。";
    return;
  }
  const res = await send({ type: "probe", url }).catch(() => null);
  if (res && res.registered) {
    $("tokenRow").classList.add("hidden");
    $("configToken").value = "";
    $("reRegister").classList.remove("hidden");
    $("setupNote").textContent = "服务器已注册，输入主密码即可登录。";
    return;
  }
  $("tokenRow").classList.remove("hidden");
  $("reRegister").classList.add("hidden");
  $("setupNote").textContent = "服务器未注册，首次连接需要 config token。";
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
    await render();
  } catch (e) {
    say("setupMsg", e.message, false);
  }
});

$("reset").addEventListener("click", async () => {
  try {
    await send({ type: "reset" });
    $("master").value = "";
    $("configToken").value = "";
    say("setupMsg", "已重置，请重新填写", true);
    await render();
  } catch (e) {
    say("setupMsg", e.message, false);
  }
});

$("reRegister").addEventListener("click", () => {
  $("tokenRow").classList.remove("hidden");
  $("reRegister").classList.add("hidden");
  $("setupNote").textContent = "填 config token 和新主密码以重新注册。";
});

$("url").addEventListener("change", () => {
  if (!configured) updateTokenVisibility();
});

$("htmlFile").addEventListener("change", async () => {
  try {
    const text = await readFile($("htmlFile"));
    const tree = parseBookmarksHtml(text);
    const res = await send({ type: "import-bookmarks", tree });
    say("htmlMsg", "导入 " + res.count + " 个节点", true);
  } catch (e) {
    say("htmlMsg", e.message, false);
  }
});

$("csvFile").addEventListener("change", async () => {
  try {
    const text = await readFile($("csvFile"));
    const res = await send({ type: "import-passwords", text });
    say("csvMsg", "导入 " + res.count + " 条密码", true);
  } catch (e) {
    say("csvMsg", e.message, false);
  }
});

// renderNever lists the never-save sites, each with a remove button.
async function renderNever() {
  const hosts = await send({ type: "never-list" });
  const box = $("neverList");
  box.textContent = "";
  if (hosts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "空。保存弹窗选「不再提示」的站点列在这里。";
    box.appendChild(empty);
    return;
  }
  for (const host of hosts.sort()) {
    const row = document.createElement("div");
    row.className = "field-row never-row";
    const name = document.createElement("span");
    name.textContent = host;
    const btn = document.createElement("button");
    btn.className = "link-btn";
    btn.textContent = "移除";
    btn.addEventListener("click", async () => {
      await send({ type: "never-remove", host });
      await renderNever();
    });
    row.append(name, btn);
    box.appendChild(row);
  }
}

render().catch((e) => {
  $("status").textContent = "状态读取失败：" + e.message;
});
renderNever().catch(() => {});
