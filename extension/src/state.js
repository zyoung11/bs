"use strict";

const api = globalThis.browser ?? globalThis.chrome;

const Store = {
  async get(key, fallback) {
    const data = await api.storage.local.get(key);
    return data[key] ?? fallback;
  },

  async set(key, value) {
    await api.storage.local.set({ [key]: value });
  },
};
