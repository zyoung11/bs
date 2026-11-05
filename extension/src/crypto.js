"use strict";

const BsCrypto = {
  salt: new TextEncoder().encode("bs-v1-salt"),
  iterations: 600000,

  async derive(master) {
    const base = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(master),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: this.salt, iterations: this.iterations, hash: "SHA-256" },
        base,
        512
      )
    );
    const keyRaw = b64(bits.slice(0, 32));
    const token = hex(bits.slice(32));
    return { keyRaw, token };
  },

  async importKey(keyRaw) {
    return crypto.subtle.importKey(
      "raw",
      u8(keyRaw),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  },

  async encrypt(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(JSON.stringify(obj))
      )
    );
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv, 0);
    out.set(ct, iv.length);
    return b64(out);
  },

  async decrypt(keyRaw, data) {
    const key = await this.importKey(keyRaw);
    const raw = u8(data);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: raw.slice(0, 12) },
      key,
      raw.slice(12)
    );
    return JSON.parse(new TextDecoder().decode(pt));
  },
};

function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function u8(b64str) {
  const s = atob(b64str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function hex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
