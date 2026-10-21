// ═══════════════════════════════════════════════════════════════
//  security/vpn-check.js — VPN / Proxy / Tor детект с кэшем
// ═══════════════════════════════════════════════════════════════
const { isLocalIP } = require('../http/client-ip');

// ── VPN / Proxy / Tor детект ──────────────────────────────────
const vpnCheckCache = new Map();

const VPN_CACHE_TTL = 60 * 60 * 1000;


async function isVpnOrProxy(ip) {
  if (isLocalIP(ip)) return false;
  const cached = vpnCheckCache.get(ip);
  if (cached && Date.now() - cached.cachedAt < VPN_CACHE_TTL) {
    return cached.result;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=proxy,hosting,tor`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    const data = await resp.json();
    const isVpn = !!(data.proxy || data.hosting || data.tor);
    vpnCheckCache.set(ip, { result: isVpn, cachedAt: Date.now() });
    if (isVpn) console.log(`[VPN block] ${ip} — proxy:${data.proxy} hosting:${data.hosting} tor:${data.tor}`);
    return isVpn;
  } catch (e) {
    console.warn('[VPN check] Ошибка проверки IP:', ip, e.message);
    return false;
  }
}

module.exports = { vpnCheckCache, VPN_CACHE_TTL, isVpnOrProxy };
