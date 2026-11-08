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
    return;
  }
  $("url").disabled = false;
  $("master").disabled = false;
  $("master").placeholder = "派生加密密钥和认证令牌";
  $("setup").classList.remove("hidden");
  $("reset").classList.add("hidden");
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

// applyTheme sets the page theme and refreshes the toggle icon.
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.classList.toggle("is-light", theme === "light");
}

// changeTheme applies a theme with a view transition when motion is allowed.
function changeTheme(theme) {
  const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (document.startViewTransition && !calm) {
    document.startViewTransition(() => applyTheme(theme));
  } else {
    applyTheme(theme);
  }
}

const savedTheme = localStorage.getItem("theme");
applyTheme(savedTheme === "light" || savedTheme === "dark" ? savedTheme : "dark");
$("theme-toggle").addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  changeTheme(theme);
  localStorage.setItem("theme", theme);
});

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
// The panel hides entirely while the list is empty.
async function renderNever() {
  const hosts = await send({ type: "never-list" });
  const box = $("neverList");
  box.textContent = "";
  $("neverPanel").classList.toggle("hidden", hosts.length === 0);
  for (const host of hosts.sort()) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("div");
    name.className = "row-main";
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

// downloadText saves text as a file through a temporary blob link.
function downloadText(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("exportHtml").addEventListener("click", async () => {
  try {
    const html = await send({ type: "export-bookmarks" });
    downloadText("bookmarks.html", html, "text/html");
    say("exportHtmlMsg", "已导出 bookmarks.html", true);
  } catch (e) {
    say("exportHtmlMsg", e.message, false);
  }
});

$("exportCsv").addEventListener("click", async () => {
  try {
    const csv = await send({ type: "export-passwords" });
    downloadText("passwords.csv", csv, "text/csv");
    say("exportCsvMsg", "已导出 passwords.csv", true);
  } catch (e) {
    say("exportCsvMsg", e.message, false);
  }
});

render().catch((e) => {
  say("setupMsg", "状态读取失败：" + e.message, false);
});
renderNever().catch(() => {});
