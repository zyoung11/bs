"use strict";

(() => {
  if (globalThis.__bsSaveLoaded) return;
  globalThis.__bsSaveLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;

  const pendingKey = "bs_save_pending";
  const pendingTTL = 20000;
  const debounceMs = 4000;
  const promptDelay = 500;
  const promptTTL = 15000;

  const usernameHints = /user|login|email|mail|account|member|signin|账号|帐户|邮箱|用户|登录/;
  const submitHints = /log\s*in|sign\s*in|login|sign\s*up|register|create\s*account|submit|登录|登陆|注册|创建|提交/;

  const promptCSS = `
    .bs-save-box {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      min-width: 220px; max-width: 300px;
      background: #fff; color: #1c1b1f;
      border: 1px solid #c6c6ca; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      padding: 12px 14px;
    }
    .bs-save-title { font-weight: 600; }
    .bs-save-sub {
      color: #5f6368; font-size: 12px; margin-top: 2px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .bs-save-diff {
      margin-top: 8px; padding: 6px 8px;
      background: #f6f6f8; border-radius: 6px;
      color: #5f6368; font-size: 11px;
    }
    .bs-save-actions { display: flex; gap: 6px; margin-top: 10px; }
    .bs-save-btn {
      padding: 6px 10px; border: 1px solid #c6c6ca; border-radius: 8px;
      background: #fff; color: #1c1b1f;
      font: 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
      cursor: pointer;
    }
    .bs-save-btn:hover { background: #f6f6f8; }
    .bs-save-ok { background: #1c1b1f; color: #fff; border-color: #1c1b1f; }
    .bs-save-ok:hover { background: #33312e; }
    .bs-save-never { margin-left: auto; border: none; background: none; color: #5f6368; }
    .bs-save-never:hover { text-decoration: underline; background: none; }
    .bs-save-toast {
      position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;
      padding: 8px 14px; background: #1c1b1f; color: #fff; border-radius: 6px;
      font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
  `;

  let styleEl = null;
  let promptEl = null;
  let lastCapture = { key: "", ts: 0 };

  function send(msg) {
    return Promise.resolve(api.runtime.sendMessage(msg))
      .then((resp) => (resp && resp.ok ? resp.data : null))
      .catch(() => null);
  }

  function visible(el) {
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
  }

  function isPasswordInput(el) {
    return el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password";
  }

  function isTextish(el) {
    if (el.tagName !== "INPUT" || el.disabled || el.readOnly || !visible(el)) return false;
    const type = (el.type || "text").toLowerCase();
    return type === "text" || type === "email" || type === "tel" || type === "url";
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  // maskSecret renders a secret as first char, bullets, last char.
  function maskSecret(text) {
    if (!text || text.length <= 2) return "••••";
    const mid = "•".repeat(Math.min(text.length - 2, 6));
    return text.charAt(0) + mid + text.charAt(text.length - 1);
  }

  // findLoginPair locates the username and password inputs in a scope.
  // Username lookup follows four priorities: email input, hinted attributes,
  // the text input before the password input, then the first text input.
  function findLoginPair(scope) {
    const root = scope && scope.querySelectorAll ? scope : document;
    const inputs = Array.from(root.querySelectorAll("input"));
    const pass = inputs.find((el) => isPasswordInput(el) && visible(el) && !el.disabled && el.value !== "");
    if (!pass) return null;
    const texts = inputs.filter(isTextish);
    const email = texts.find((el) => (el.type || "").toLowerCase() === "email");
    if (email) return { user: email, pass };
    const hinted = texts.find((el) =>
      usernameHints.test(
        [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete]
          .filter(Boolean).join(" ").toLowerCase(),
      ));
    if (hinted) return { user: hinted, pass };
    const before = texts.filter((el) => inputs.indexOf(el) < inputs.indexOf(pass));
    return { user: before[0] ?? texts[0] ?? null, pass };
  }

  function pendingRead() {
    try {
      return JSON.parse(sessionStorage.getItem(pendingKey) ?? "");
    } catch {
      return null;
    }
  }

  function pendingWrite(p) {
    try {
      sessionStorage.setItem(pendingKey, JSON.stringify(p));
    } catch {}
  }

  function pendingClear() {
    try {
      sessionStorage.removeItem(pendingKey);
    } catch {}
  }

  // capture reads the login pair from a scope and starts the save flow.
  // The credential is checked against the vault before any prompt appears.
  async function capture(scope) {
    const pair = findLoginPair(scope);
    if (!pair) return;
    const username = pair.user ? pair.user.value.trim() : "";
    const password = pair.pass.value;
    if (!password) return;
    const now = Date.now();
    const key = username + "\u0000" + password;
    if (lastCapture.key === key && now - lastCapture.ts < debounceMs) return;
    lastCapture = { key, ts: now };
    const check = await send({ type: "save-check", url: location.href, username, password });
    if (!check || check.mode === "skip") return;
    pendingWrite({ url: location.href, username, password, mode: check.mode, id: check.id ?? "", old: check.old ?? "", ts: now });
    setTimeout(() => routePrompt(pendingRead()), promptDelay);
  }

  // restorePending re-checks and shows a prompt saved before a navigation.
  async function restorePending() {
    const p = pendingRead();
    if (!p) return;
    if (Date.now() - (p.ts || 0) > pendingTTL) {
      pendingClear();
      return;
    }
    const check = await send({ type: "save-check", url: p.url, username: p.username, password: p.password });
    if (!check || check.mode === "skip") {
      pendingClear();
      return;
    }
    routePrompt({ ...p, mode: check.mode, id: check.id ?? "", old: check.old ?? "" });
  }

  // routePrompt sends the prompt payload to the background, which renders
  // it in the top frame. The prompt always lives in the top frame so a
  // small cross-origin iframe cannot clip it, and the credential travels
  // through extension messaging where the page cannot read it.
  function routePrompt(p) {
    void send({ type: "save-show", p });
  }

  function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.textContent = promptCSS;
    document.documentElement.appendChild(styleEl);
  }

  // closePrompt removes the dialog and drops the pending credential.
  function closePrompt() {
    if (promptEl) {
      promptEl.remove();
      promptEl = null;
    }
    pendingClear();
  }

  // showPrompt renders the save or update dialog in the page corner.
  // Only the top frame renders; other frames route through the background.
  // It never renders twice and closes itself after promptTTL.
  function showPrompt(p) {
    if (!p || promptEl || !document.body || window !== window.top) return;
    ensureStyle();
    const updating = p.mode === "update";
    const box = document.createElement("div");
    box.className = "bs-save-box";
    const title = document.createElement("div");
    title.className = "bs-save-title";
    title.textContent = updating ? "更新密码" : "保存密码";
    const sub = document.createElement("div");
    sub.className = "bs-save-sub";
    sub.textContent = (p.username || "无用户名") + " @ " + (hostOf(p.url) || p.url);
    box.append(title, sub);
    if (updating && p.old) {
      const diff = document.createElement("div");
      diff.className = "bs-save-diff";
      const oldLine = document.createElement("div");
      oldLine.textContent = "旧 " + maskSecret(p.old);
      const newLine = document.createElement("div");
      newLine.textContent = "新 " + maskSecret(p.password);
      diff.append(oldLine, newLine);
      box.append(diff);
    }
    const actions = document.createElement("div");
    actions.className = "bs-save-actions";
    const ok = document.createElement("button");
    ok.className = "bs-save-btn bs-save-ok";
    ok.textContent = updating ? "更新" : "保存";
    const skip = document.createElement("button");
    skip.className = "bs-save-btn";
    skip.textContent = "忽略";
    const never = document.createElement("button");
    never.className = "bs-save-btn bs-save-never";
    never.textContent = "不再提示";
    actions.append(ok, skip, never);
    box.append(actions);
    document.body.appendChild(box);
    promptEl = box;

    ok.addEventListener("click", async () => {
      const res = await send({
        type: "save-login",
        url: p.url,
        username: p.username,
        password: p.password,
        id: p.id ?? "",
      });
      closePrompt();
      toast(res ? (updating ? "已更新" : "已保存") : "保存失败");
    });
    skip.addEventListener("click", closePrompt);
    never.addEventListener("click", async () => {
      await send({ type: "save-never", url: p.url });
      closePrompt();
    });
    setTimeout(closePrompt, promptTTL);
  }

  function toast(text) {
    const el = document.createElement("div");
    el.className = "bs-save-toast";
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1600);
  }

  function onSubmit(ev) {
    void capture(ev.target);
  }

  function onClick(ev) {
    const btn = ev.target?.closest?.("button, input[type=submit], input[type=button]");
    if (!btn) return;
    const hay = [btn.textContent, btn.value, btn.id, btn.name].filter(Boolean).join(" ").toLowerCase();
    if ((btn.type || "").toLowerCase() !== "submit" && !submitHints.test(hay)) return;
    void capture(btn.form || btn.closest("form") || document);
  }

  function onEnter(ev) {
    if (ev.key !== "Enter") return;
    const el = document.activeElement;
    if (!isPasswordInput(el)) return;
    void capture(el.form || document);
  }

  document.addEventListener("submit", onSubmit, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onEnter, true);
  api.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "bs-save-show") showPrompt(msg.p);
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void restorePending());
  } else {
    void restorePending();
  }
})();
