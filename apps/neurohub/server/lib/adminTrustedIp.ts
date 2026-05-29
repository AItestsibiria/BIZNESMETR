// Eugene 2026-05-17 Босс: trusted IP whitelist для admin — пропуск email 2FA
// если admin login пришёл с известного IP. Записывается в env как
// `ADMIN_TRUSTED_IPS=1.2.3.4,5.6.7.8,2a03:6f00:a::1:2be7` (CSV, IPv4/IPv6).
//
// Логика:
// • Если ADMIN_TRUSTED_IPS не задан → ВСЕ admin login требуют 2FA (default
//   strict).
// • Если req.ip совпадает с одним из whitelisted (после нормализации) →
//   возвращаем true → 2FA пропускается, login сразу выдаёт session token.
// • IPv4: точное совпадение или /24 prefix (опц. через slash в env:
//   `185.123.45.0/24`).
// • IPv6: точное или /48 prefix.

import type { Request } from "express";

function normalizeIp(raw: string): string {
  // Извлекаем чистый IP (без порта, без скобок IPv6 brackets).
  let ip = String(raw || "").trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7); // IPv4-mapped IPv6 → IPv4
  ip = ip.replace(/^\[|\]$/g, ""); // [::1] → ::1
  // X-Forwarded-For может быть «1.2.3.4, 5.6.7.8» → первый.
  ip = ip.split(",")[0].trim();
  return ip;
}

function inCidr(ip: string, cidr: string): boolean {
  // Поддержка CIDR (1.2.3.0/24 или 2a03:6f00::/32).
  const [network, bitsStr] = cidr.split("/");
  if (!network) return false;
  if (!bitsStr) return normalizeIp(network) === ip;
  const bits = parseInt(bitsStr, 10);
  if (isNaN(bits)) return false;

  const isV4 = network.includes(".");
  if (isV4) {
    const toInt = (s: string) => s.split(".").map(Number).reduce((a, b) => (a << 8) | b, 0) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (toInt(ip) & mask) === (toInt(network) & mask);
  } else {
    // IPv6 prefix compare (simple — by first N hex groups).
    const expand = (s: string) => s.toLowerCase().split("::").join(":0:").split(":").map(g => g.padStart(4, "0")).join("");
    const groups = Math.floor(bits / 16);
    return expand(ip).slice(0, groups * 4) === expand(network).slice(0, groups * 4);
  }
}

export function getTrustedIpList(): string[] {
  const raw = String(process.env.ADMIN_TRUSTED_IPS || "").trim();
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

export function isAdminTrustedIp(req: Request): boolean {
  const list = getTrustedIpList();
  if (list.length === 0) return false;
  // Безопасность (Eugene 2026-05-29): доверяем ТОЛЬКО req.ip. За nginx при
  // `trust proxy=1` (index.ts) Express берёт req.ip из доверенного прокси-хопа —
  // его НЕЛЬЗЯ подделать. Сырые заголовки X-Forwarded-For / X-Real-IP клиент
  // присылает сам → их использовать НЕЛЬЗЯ: иначе обход IP-гейта (прислал
  // заголовок с доверенным IP → пропуск 2FA + auto-apply). Fail-closed: если
  // req.ip не доверенный — просто требуется 2FA (не блокировка).
  const ip = normalizeIp(req.ip || "");
  if (!ip) return false;
  return list.some(entry => (entry.includes("/") ? inCidr(ip, entry) : normalizeIp(entry) === ip));
}
