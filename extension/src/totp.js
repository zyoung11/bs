"use strict";

const BsTotp = {
  async code(secretOrUri) {
    try {
      const spec = parseSecret(secretOrUri);
      if (!spec) return "";
      const counter = Math.floor(Date.now() / 1000 / spec.period);
      const buf = new ArrayBuffer(8);
      const view = new DataView(buf);
      view.setUint32(0, Math.floor(counter / 2 ** 32));
      view.setUint32(4, counter >>> 0);
      const key = await crypto.subtle.importKey(
        "raw",
        spec.key,
        { name: "HMAC", hash: "SHA-1" },
        false,
        ["sign"]
      );
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
      const offset = sig[sig.length - 1] & 0x0f;
      const binary =
        ((sig[offset] & 0x7f) << 24) |
        (sig[offset + 1] << 16) |
        (sig[offset + 2] << 8) |
        sig[offset + 3];
      return String(binary % 10 ** spec.digits).padStart(spec.digits, "0");
    } catch {
      return "";
    }
  },
};

function parseSecret(input) {
  if (!input) return null;
  let secret = input.trim();
  let digits = 6;
  let period = 30;
  if (/^otpauth:\/\//i.test(secret)) {
    const url = new URL(secret);
    secret = url.searchParams.get("secret") ?? "";
    digits = Number(url.searchParams.get("digits") ?? 6);
    period = Number(url.searchParams.get("period") ?? 30);
  }
  const key = base32Decode(secret.replace(/\s+/g, "").toUpperCase());
  if (key.length === 0) return null;
  return { key, digits: digits > 0 ? digits : 6, period: period > 0 ? period : 30 };
}

function base32Decode(text) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = text.replace(/=+$/, "");
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
