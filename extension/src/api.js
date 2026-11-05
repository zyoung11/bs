"use strict";

const BsApi = {
  baseUrl: "",
  token: "",

  configure(url, token) {
    this.baseUrl = url.replace(/\/+$/, "");
    this.token = token;
  },

  async request(method, path, body, bearer) {
    const headers = {};
    if (bearer) headers["Authorization"] = "Bearer " + bearer;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const resp = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data.error || resp.statusText);
      err.status = resp.status;
      throw err;
    }
    return data;
  },

  register(configToken, token) {
    return this.request("POST", "/api/register", { token }, configToken);
  },

  push(log, entries) {
    return this.request("POST", "/api/ops", { log, entries }, this.token);
  },

  pull(log, since) {
    return this.request(
      "GET",
      "/api/ops?log=" + encodeURIComponent(log) + "&since=" + since,
      undefined,
      this.token
    );
  },

  reset(log) {
    return this.request("POST", "/api/reset", { log }, this.token);
  },

  openSocket(onMessage, onClose) {
    const wsUrl =
      this.baseUrl.replace(/^http/, "ws") + "/api/ws?token=" + encodeURIComponent(this.token);
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (ev) => onMessage(ev.data);
    ws.onclose = () => onClose();
    return ws;
  },
};
