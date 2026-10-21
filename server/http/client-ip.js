// ═══════════════════════════════════════════════════════════════
//  http/client-ip.js — определение реального IP клиента
// ═══════════════════════════════════════════════════════════════
// ── Получение реального IP клиента ───────────────────────────
// Порядок приоритетов:
//   1. req.ip  — Express разбирает x-forwarded-for сам после app.set('trust proxy', 2)
//                и возвращает уже проверенный реальный IP (безопасно, спуфинг невозможен)
//   2. x-forwarded-for — берём первый IP из списка (крайний левый = клиент)
//   3. x-real-ip       — Nginx часто выставляет это поле напрямую
//   4. socket.remoteAddress — прямое соединение (без прокси / локальный запуск)
// Заголовки x-real-ip / x-forwarded-for доверяем ТОЛЬКО если TCP-сосед — наш
// прокси (loopback или приватная сеть: nginx на этой же машине / docker bridge).
// Иначе любой клиент, обратившийся к Node напрямую, подделает свой IP.
function isTrustedProxyPeer(peer) {
  if (!peer || typeof peer !== 'string') return false;
  const p = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
  if (p === '::1' || p === '127.0.0.1' || p.startsWith('127.')) return true;
  if (p.startsWith('10.') || p.startsWith('192.168.')) return true;
  const m = /^172\.(\d{1,2})\./.exec(p);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(p)) return true; // IPv6 ULA fc00::/7
  return false;
}
function cleanIpHeader(v) {
  if (typeof v !== 'string') return null;
  const ip = v.split(',')[0].trim();
  return require('net').isIP(ip) ? ip : null;
}
function getIP(req) {
  // 1) req.ip — Express сам разбирает x-forwarded-for по trust proxy.
  // 2) fallback — только x-real-ip и только от доверенного прокси
  const peer = req.socket?.remoteAddress;
  return req.ip
    || (isTrustedProxyPeer(peer) ? cleanIpHeader(req.headers['x-real-ip']) : null)
    || peer
    || 'unknown';
}

function isLocalIP(ip) {
  if (!ip || ip === 'unknown') return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  if (ip.startsWith('::ffff:127.')) return true;
  return false;
}

module.exports = { isTrustedProxyPeer, cleanIpHeader, getIP, isLocalIP };
