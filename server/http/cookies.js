// ═══════════════════════════════════════════════════════════════
//  http/cookies.js — cookie-парсер, получение JWT, опции auth-cookie
// ═══════════════════════════════════════════════════════════════
//  (раньше жили в core.js)
// ── Cookie-парсер (без внешней зависимости) ───────────────────
// Разбирает заголовок Cookie в req.cookies, используется вместо
// хранения JWT/device-id в localStorage (защита от чтения через XSS).
function parseCookieHeader(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  });
  return out;
}


const isProd = process.env.NODE_ENV === 'production';

const AUTH_COOKIE_OPTS = { httpOnly: true, secure: isProd, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' };

const DEVICE_COOKIE_OPTS = { httpOnly: true, secure: isProd, sameSite: 'lax', maxAge: 5 * 365 * 24 * 60 * 60 * 1000, path: '/' };


// ── Получение JWT: приоритет — HttpOnly cookie, затем заголовок ──
// (заголовок оставлен как резерв для не-браузерных клиентов;
// само веб-приложение больше не хранит и не отправляет токен через JS)
function getAuthToken(req) {
  if (req.cookies && req.cookies.ch_token) return req.cookies.ch_token;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) return h.slice(7);
  return null;
}

module.exports = { parseCookieHeader, getAuthToken, isProd, AUTH_COOKIE_OPTS, DEVICE_COOKIE_OPTS };
