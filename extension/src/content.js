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

  const popupCSS = `
    .bs-box {
      position: fixed; z-index: 2147483647;
      min-width: 240px; max-width: 320px;
      background: #fff; color: #1c1b1f;
      border: 1px solid #c6c6ca; border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      overflow: hidden;
    }
    .bs-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; cursor: pointer; }
    .bs-row.sel { background: #e8f0fe; }
    .bs-av {
      flex: 0 0 22px; height: 22px; border-radius: 50%;
      color: #fff; font-size: 12px; font-weight: 600;
      display: flex; align-items: center; justify-content: center;
    }
    .bs-texts { min-width: 0; flex: 1; }
    .bs-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bs-sub { color: #5f6368; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bs-hint { padding: 5px 10px; background: #f6f6f8; color: #5f6368; font-size: 11px; border-top: 1px solid #e3e3e6; }
    .bs-empty { padding: 12px; color: #5f6368; font-size: 12px; text-align: center; }
  `;

  let activeInput = null;
  let activeKind = null;
  let activeEntries = [];
  let activeToken = null;
  let hideTimer = 0;
  let popup = null;
  let popupRows = [];
  let popupSel = 0;

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

  function toDisplay(entry) {
    return {
      title: entryTitle(entry),
      sub: entrySub(entry),
      av: (entry.name || "?").trim().charAt(0).toUpperCase(),
      color: avatarColor(entry.name || entry.url || "?"),
    };
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

  function fillLogin(entry, scope) {
    const inputs = scopeInputs(scope);
    const pwds = inputs.filter(isPasswordField);
    const users = inputs.filter((el) => !isPasswordField(el) && fieldKind(el) === kindLogin);
    for (const el of users) setNativeValue(el, entry.username ?? "");
    for (const el of pwds) setNativeValue(el, entry.password ?? "");
  }

  function splitExp(exp) {
    const parts = (exp || "").split("/").map((p) => p.trim());
    return { month: parts[0] ?? "", year: parts[1] ?? "" };
  }

  function fillCard(entry, scope) {
    const exp = splitExp(entry.exp);
    for (const el of scopeInputs(scope)) {
      const ac = (el.autocomplete || "").toLowerCase();
      const f = cardAttrs[ac];
      if (!f) continue;
      if (f === "number") setNativeValue(el, entry.number ?? "");
      else if (f === "cvv") setNativeValue(el, entry.cvv ?? "");
      else if (f === "cardholder") setNativeValue(el, entry.cardholder ?? "");
      else if (ac === "cc-exp") setNativeValue(el, entry.exp ?? "");
      else if (ac === "cc-exp-month") setNativeValue(el, exp.month);
      else if (ac === "cc-exp-year") setNativeValue(el, exp.year);
    }
  }

  function fillIdentity(entry, scope) {
    const fullName = entry.fullName ?? "";
    const parts = fullName.trim().split(/\s+/);
    for (const el of scopeInputs(scope)) {
      const ac = (el.autocomplete || "").toLowerCase();
      const f = identityAttrs[ac];
      if (!f) continue;
      if (f === "fullName") setNativeValue(el, fullName);
      else if (f === "firstName") setNativeValue(el, parts[0] ?? "");
      else if (f === "lastName") setNativeValue(el, parts.slice(1).join(" "));
      else if (f === "email") setNativeValue(el, entry.email ?? "");
      else if (f === "phone") setNativeValue(el, entry.phone ?? "");
      else if (f === "address") setNativeValue(el, entry.address ?? "");
      else if (f === "city") setNativeValue(el, entry.city ?? "");
      else if (f === "zip") setNativeValue(el, entry.zip ?? "");
      else if (f === "country") setNativeValue(el, entry.country ?? "");
    }
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

  function toast(text) {
    const box = document.createElement("div");
    box.textContent = text;
    box.style.cssText =
      "position:fixed;z-index:2147483647;right:16px;bottom:16px;padding:8px 14px;" +
      "background:#1c1b1f;color:#fff;border-radius:6px;font:13px/1.3 system-ui,sans-serif;";
    (document.body || document.documentElement).appendChild(box);
    setTimeout(() => box.remove(), 1600);
  }

  function frames() {
    return Array.from(document.querySelectorAll("iframe,frame"));
  }

  function findFrameForSource(source) {
    for (const f of frames()) {
      if (f.contentWindow === source) return f;
    }
    return null;
  }

  function frameContentOffset(frame) {
    const r = frame.getBoundingClientRect();
    const st = getComputedStyle(frame);
    const padT = parseFloat(st.paddingTop) || 0;
    const padL = parseFloat(st.paddingLeft) || 0;
    const borT = parseFloat(st.borderTopWidth) || 0;
    const borL = parseFloat(st.borderLeftWidth) || 0;
    return {
      top: r.top + padT + borT,
      left: r.left + padL + borL,
    };
  }

  function isTopFrame() {
    return window === window.top;
  }

  function sendFocusUp(rect, token, entries) {
    const payload = {
      type: "bs-focus",
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      token,
      entries,
    };
    if (isTopFrame()) {
      showPopup(payload.rect, payload.entries, payload.token);
    } else {
      window.parent.postMessage(payload, "*");
    }
  }

  function relayFocusMessage(ev) {
    const d = ev.data;
    if (!d || d.type !== "bs-focus") return;
    const frame = findFrameForSource(ev.source);
    if (!frame) return;
    const off = frameContentOffset(frame);
    const rect = {
      top: d.rect.top + off.top,
      left: d.rect.left + off.left,
      width: d.rect.width,
      height: d.rect.height,
    };
    if (isTopFrame()) {
      showPopup(rect, d.entries, d.token);
    } else {
      window.parent.postMessage({ type: "bs-focus", rect, token: d.token, entries: d.entries }, "*");
    }
  }

  function dispatchFill(token, index) {
    if (activeToken === token && activeEntries[index]) {
      performFill(index);
      return;
    }
    for (const f of frames()) {
      if (f.contentWindow) {
        f.contentWindow.postMessage({ type: "bs-fill", token, index }, "*");
      }
    }
  }

  function relayFillMessage(ev) {
    const d = ev.data;
    if (!d || d.type !== "bs-fill") return;
    if (activeToken === d.token && activeEntries[d.index]) {
      performFill(d.index);
      return;
    }
    for (const f of frames()) {
      if (f.contentWindow) {
        f.contentWindow.postMessage({ type: "bs-fill", token: d.token, index: d.index }, "*");
      }
    }
  }

  async function performFill(index) {
    const entry = activeEntries[index];
    if (!entry) return;
    const kind = entry.type || kindLogin;
    const scope = (activeInput && activeInput.form) || document;
    hidePopup();
    if (kind === kindCard) {
      fillCard(entry, scope);
      return;
    }
    if (kind === kindIdentity) {
      fillIdentity(entry, scope);
      return;
    }
    fillLogin(entry, scope);
    if (entry.totp) {
      const code = await BsTotp.code(entry.totp);
      if (code) {
        await copyText(code);
        toast("验证码 " + code + " 已复制");
      }
    }
  }

  function ensurePopup() {
    if (popup) return;
    const style = document.createElement("style");
    style.textContent = popupCSS;
    document.documentElement.appendChild(style);
    popup = document.createElement("div");
    popup.className = "bs-box";
    (document.body || document.documentElement).appendChild(popup);
    popup.addEventListener("mousedown", (ev) => ev.preventDefault());
    popup.addEventListener("click", (ev) => {
      const row = ev.target.closest?.(".bs-row");
      if (!row) return;
      const index = Number(row.dataset.index);
      hidePopup();
      dispatchFill(row.dataset.token, index);
    });
    popup.addEventListener("mousemove", (ev) => {
      const row = ev.target.closest?.(".bs-row");
      if (!row) return;
      popupSel = Number(row.dataset.index);
      highlightRows();
    });
  }

  function highlightRows() {
    for (const row of popupRows) {
      row.classList.toggle("sel", Number(row.dataset.index) === popupSel);
    }
  }

  function showPopup(rect, entries, token) {
    ensurePopup();
    popup.textContent = "";
    popupRows = [];
    popupSel = 0;
    if (!entries || entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "bs-empty";
      empty.textContent = "无匹配条目";
      popup.appendChild(empty);
    } else {
      entries.forEach((entry, i) => {
        const row = document.createElement("div");
        row.className = "bs-row";
        row.dataset.index = i;
        row.dataset.token = token;
        const av = document.createElement("div");
        av.className = "bs-av";
        av.textContent = entry.av;
        av.style.background = entry.color;
        const texts = document.createElement("div");
        texts.className = "bs-texts";
        const t = document.createElement("div");
        t.className = "bs-title";
        t.textContent = entry.title;
        const s = document.createElement("div");
        s.className = "bs-sub";
        s.textContent = entry.sub;
        texts.append(t, s);
        row.append(av, texts);
        popup.appendChild(row);
        popupRows.push(row);
      });
      const hint = document.createElement("div");
      hint.className = "bs-hint";
      hint.textContent = "↑↓ 选择 · Enter 填充 · Esc 关闭";
      popup.appendChild(hint);
    }
    popup.style.visibility = "hidden";
    popup.style.display = "block";
    const boxW = popup.offsetWidth;
    const boxH = popup.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.left;
    if (left + boxW > vw - 8) left = Math.max(8, vw - boxW - 8);
    if (left < 8) left = 8;
    let top = rect.top + rect.height + 4;
    if (top + boxH > vh - 8) top = Math.max(8, rect.top - boxH - 4);
    popup.style.left = left + "px";
    popup.style.top = top + "px";
    popup.style.visibility = "visible";
  }

  function hidePopup() {
    if (popup) popup.style.display = "none";
    popupRows = [];
    popupSel = 0;
  }

  function moveSel(dir) {
    if (popupRows.length === 0) return;
    popupSel = (popupSel + dir + popupRows.length) % popupRows.length;
    highlightRows();
    popupRows[popupSel]?.scrollIntoView({ block: "nearest" });
  }

  async function onFocusIn(ev) {
    clearTimeout(hideTimer);
    const el = ev.target;
    if (el === activeInput && activeEntries.length > 0) return;
    const kind = fieldKind(el);
    if (!kind) return;
    activeInput = el;
    activeKind = kind;
    activeToken = crypto.randomUUID();
    const entries = await requestMatches(kind);
    if (activeInput !== el) return;
    activeEntries = entries;
    const display = entries.map(toDisplay);
    const rect = el.getBoundingClientRect();
    sendFocusUp(rect, activeToken, display);
  }

  function onFocusOut() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePopup, 180);
  }

  function onRelayMessage(ev) {
    relayFocusMessage(ev);
    relayFillMessage(ev);
  }

  function onKeyDown(ev) {
    if (!popup || popup.style.display === "none" || ev.target !== activeInput) return;
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      moveSel(1);
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      moveSel(-1);
    } else if (ev.key === "Enter" && popupRows.length > 0) {
      ev.preventDefault();
      const index = popupSel;
      hidePopup();
      dispatchFill(activeToken, index);
    } else if (ev.key === "Escape") {
      hidePopup();
    }
  }

  window.addEventListener("message", onRelayMessage);
  document.addEventListener("focusin", onFocusIn, true);
  document.addEventListener("focusout", onFocusOut, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", hidePopup, true);
  window.addEventListener("resize", hidePopup);
})();
