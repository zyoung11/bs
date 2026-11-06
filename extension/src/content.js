"use strict";

(() => {
  if (globalThis.__bsAutofillLoaded) return;
  globalThis.__bsAutofillLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;

  const kindLogin = "login";
  const kindCard = "card";
  const kindIdentity = "identity";

  const cardAttrs = {
    "cc-number": "number",
    "cc-exp": "exp",
    "cc-exp-month": "exp",
    "cc-exp-year": "exp",
    "cc-csc": "cvv",
    "cc-name": "cardholder",
  };

  const identityAttrs = {
    "name": "fullName",
    "given-name": "firstName",
    "family-name": "lastName",
    "email": "email",
    "tel": "phone",
    "street-address": "address",
    "address-line1": "address",
    "address-level2": "city",
    "address-level1": "city",
    "postal-code": "zip",
    "country": "country",
    "country-name": "country",
  };

  const usernameHints = /user|login|email|mail|account|member|signin|账号|帐户|邮箱|用户|登录/;

  const panelCSS = `
    :host { all: initial; }
    .panel {
      position: fixed; z-index: 2147483647;
      min-width: 260px; max-width: 340px;
      background: #fff; color: #1c1b1f;
      border: 1px solid #c6c6ca; border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
      font: 13px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
      overflow: hidden;
    }
    .row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; }
    .row.sel { background: #e8f0fe; }
    .avatar {
      flex: 0 0 22px; height: 22px; border-radius: 50%;
      color: #fff; font-size: 12px; font-weight: 600;
      display: flex; align-items: center; justify-content: center;
    }
    .texts { min-width: 0; flex: 1; }
    .title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { color: #5f6368; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hint { padding: 5px 10px; background: #f6f6f8; color: #5f6368; font-size: 11px; border-top: 1px solid #e3e3e6; }
    .toast {
      position: fixed; z-index: 2147483647;
      right: 16px; bottom: 16px; padding: 8px 14px;
      background: #1c1b1f; color: #fff; border-radius: 6px;
      font: 13px/1.3 system-ui, sans-serif;
    }
    .hidden { display: none; }
  `;

  let host = null;
  let shadow = null;
  let panel = null;
  let listEl = null;
  let toastEl = null;
  let activeInput = null;
  let items = [];
  let selected = 0;
  let hideTimer = 0;

  function ensurePanel() {
    if (panel) return;
    host = document.createElement("div");
    shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = panelCSS;
    panel = document.createElement("div");
    panel.className = "panel hidden";
    listEl = document.createElement("div");
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "↑↓ 选择 · Enter 填充 · Esc 关闭";
    panel.append(listEl, hint);
    toastEl = document.createElement("div");
    toastEl.className = "toast hidden";
    shadow.append(style, panel, toastEl);
    document.documentElement.appendChild(host);
    panel.addEventListener("mousedown", (ev) => ev.preventDefault());
    panel.addEventListener("click", (ev) => {
      const row = ev.target.closest?.(".row");
      if (!row) return;
      choose(Number(row.dataset.index));
    });
    panel.addEventListener("mousemove", (ev) => {
      const row = ev.target.closest?.(".row");
      if (!row) return;
      selected = Number(row.dataset.index);
      highlight();
    });
  }

  function visible(el) {
    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
  }

  function isPasswordField(el) {
    return el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password";
  }

  function fieldKind(el) {
    if (el.tagName !== "INPUT" || !visible(el) || el.disabled || el.readOnly) return "";
    const ac = (el.autocomplete || "").toLowerCase();
    if (cardAttrs[ac]) return kindCard;
    if (identityAttrs[ac]) return kindIdentity;
    const type = (el.type || "text").toLowerCase();
    if (isPasswordField(el)) return kindLogin;
    if (type !== "text" && type !== "email" && type !== "tel" && type !== "url") return "";
    if (ac === "username" || ac === "email") return kindLogin;
    const hay = [el.name, el.id, el.placeholder, el.getAttribute("aria-label")]
      .filter(Boolean).join(" ").toLowerCase();
    if (usernameHints.test(hay)) return kindLogin;
    if (el.form && el.form.querySelector('input[type="password"]')) return kindLogin;
    return "";
  }

  function requestMatches(kind) {
    return Promise.resolve(api.runtime.sendMessage({ type: "matches", url: location.href, kind }))
      .then((resp) => (resp && resp.ok ? resp.data : []))
      .catch(() => []);
  }

  function entrySub(entry) {
    const type = entry.type || kindLogin;
    if (type === kindCard) return entry.cardholder || "";
    if (type === kindIdentity) return entry.email || entry.phone || "";
    return entry.username || "";
  }

  function entryTitle(entry) {
    const type = entry.type || kindLogin;
    if (type === kindCard) {
      const last4 = (entry.number || "").replace(/\D/g, "").slice(-4);
      return (entry.name || "信用卡") + (last4 ? " ··" + last4 : "");
    }
    return entry.name || entry.username || entry.url || "条目";
  }

  function avatarColor(name) {
    const colors = ["#8aadf4", "#a6da95", "#eed49f", "#f5a97f", "#c6a0f6", "#7dc4e4", "#f38ba8"];
    let sum = 0;
    for (const ch of name) sum += ch.codePointAt(0);
    return colors[sum % colors.length];
  }

  function render() {
    listEl.textContent = "";
    items.forEach((entry, i) => {
      const row = document.createElement("div");
      row.className = "row";
      row.dataset.index = i;
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      const title = entryTitle(entry);
      avatar.textContent = (entry.name || "?").trim().charAt(0).toUpperCase();
      avatar.style.background = avatarColor(entry.name || entry.url || "?");
      const texts = document.createElement("div");
      texts.className = "texts";
      const t = document.createElement("div");
      t.className = "title";
      t.textContent = title;
      const s = document.createElement("div");
      s.className = "sub";
      s.textContent = entrySub(entry);
      texts.append(t, s);
      row.append(avatar, texts);
      listEl.appendChild(row);
    });
    highlight();
  }

  function highlight() {
    for (const row of listEl.children) {
      row.classList.toggle("sel", Number(row.dataset.index) === selected);
    }
  }

  function positionPanel(input) {
    const rect = input.getBoundingClientRect();
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    panel.style.left = left + "px";
    panel.style.top = top + "px";
  }

  function showPanel(input) {
    ensurePanel();
    panel.classList.remove("hidden");
    positionPanel(input);
  }

  function hidePanel() {
    if (panel) panel.classList.add("hidden");
    activeInput = null;
    items = [];
    selected = 0;
  }

  function toast(text) {
    ensurePanel();
    toastEl.textContent = text;
    toastEl.classList.remove("hidden");
    setTimeout(() => toastEl.classList.add("hidden"), 1600);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function scopeInputs(scope) {
    const out = [];
    for (const el of scope.querySelectorAll("input, textarea")) {
      if (visible(el) && !el.disabled && !el.readOnly) out.push(el);
    }
    return out;
  }

  function fillLogin(entry) {
    const scope = (activeInput && activeInput.form) || document;
    const inputs = scopeInputs(scope);
    const passwords = inputs.filter(isPasswordField);
    const usernames = inputs.filter((el) => !isPasswordField(el) && fieldKind(el) === kindLogin);
    for (const el of usernames) setNativeValue(el, entry.username ?? "");
    for (const el of passwords) setNativeValue(el, entry.password ?? "");
  }

  function splitExp(exp) {
    const parts = (exp || "").split("/").map((p) => p.trim());
    return { month: parts[0] ?? "", year: parts[1] ?? "" };
  }

  function fillCard(entry) {
    const scope = (activeInput && activeInput.form) || document;
    const exp = splitExp(entry.exp);
    for (const el of scopeInputs(scope)) {
      const ac = (el.autocomplete || "").toLowerCase();
      const field = cardAttrs[ac];
      if (!field) continue;
      if (field === "number") setNativeValue(el, entry.number ?? "");
      else if (field === "cvv") setNativeValue(el, entry.cvv ?? "");
      else if (field === "cardholder") setNativeValue(el, entry.cardholder ?? "");
      else if (ac === "cc-exp") setNativeValue(el, entry.exp ?? "");
      else if (ac === "cc-exp-month") setNativeValue(el, exp.month);
      else if (ac === "cc-exp-year") setNativeValue(el, exp.year);
    }
  }

  function fillIdentity(entry) {
    const scope = (activeInput && activeInput.form) || document;
    const fullName = entry.fullName ?? "";
    const parts = fullName.trim().split(/\s+/);
    for (const el of scopeInputs(scope)) {
      const ac = (el.autocomplete || "").toLowerCase();
      const field = identityAttrs[ac];
      if (!field) continue;
      if (field === "fullName") setNativeValue(el, fullName);
      else if (field === "firstName") setNativeValue(el, parts[0] ?? "");
      else if (field === "lastName") setNativeValue(el, parts.slice(1).join(" "));
      else if (field === "email") setNativeValue(el, entry.email ?? "");
      else if (field === "phone") setNativeValue(el, entry.phone ?? "");
      else if (field === "address") setNativeValue(el, entry.address ?? "");
      else if (field === "city") setNativeValue(el, entry.city ?? "");
      else if (field === "zip") setNativeValue(el, entry.zip ?? "");
      else if (field === "country") setNativeValue(el, entry.country ?? "");
    }
  }

  async function choose(index) {
    const entry = items[index];
    if (!entry) return;
    const kind = entry.type || kindLogin;
    hidePanel();
    if (kind === kindCard) fillCard(entry);
    else if (kind === kindIdentity) fillIdentity(entry);
    else {
      fillLogin(entry);
      if (entry.totp) {
        const code = await BsTotp.code(entry.totp);
        if (code) {
          await copyText(code);
          toast("验证码 " + code + " 已复制");
        }
      }
    }
  }

  function move(dir) {
    if (items.length === 0) return;
    selected = (selected + dir + items.length) % items.length;
    highlight();
    listEl.children[selected]?.scrollIntoView({ block: "nearest" });
  }

  async function onFocusIn(ev) {
    clearTimeout(hideTimer);
    const el = ev.target;
    if (el === activeInput && items.length > 0) return;
    const kind = fieldKind(el);
    if (!kind) return;
    activeInput = el;
    const data = await requestMatches(kind);
    if (activeInput !== el) return;
    items = data;
    if (items.length === 0) {
      hidePanel();
      return;
    }
    selected = 0;
    render();
    showPanel(el);
  }

  function onFocusOut() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePanel, 180);
  }

  function onKeyDown(ev) {
    if (!panel || panel.classList.contains("hidden") || ev.target !== activeInput) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      move(1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      move(-1);
    } else if (ev.key === "Enter" && items.length > 0) {
      ev.preventDefault();
      choose(selected);
    } else if (ev.key === "Escape") {
      hidePanel();
    }
  }

  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", hidePanel, true);
  window.addEventListener("resize", hidePanel);
})();
