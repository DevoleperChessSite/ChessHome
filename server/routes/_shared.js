// ═══════════════════════════════════════════════════════════════
//  routes/_shared.js — общие хелперы доменных роут-модулей
// ═══════════════════════════════════════════════════════════════
//  Раньше эти функции жили в routes.js/core.js. Подключается агрегатором
//  первым (побочный эффект: CREATE TABLE deleted_usernames — как в оригинале).

const { db } = require('../db');

// ── Удалённые аккаунты ────────────────────────────────────────
// Ник удалённого аккаунта навсегда занят (проверка в /api/register), а сам
// аккаунт продолжает учитываться в общей статистике.
db(`CREATE TABLE IF NOT EXISTS deleted_usernames (username_low TEXT PRIMARY KEY, deleted_at BIGINT NOT NULL)`).catch(() => {});
async function countDeletedUsers() {
  try { return parseInt((await db('SELECT COUNT(*) FROM deleted_usernames')).rows[0].count) || 0; }
  catch { return 0; }
}
async function getDeletedUser(usernameLow) {
  try {
    const r = await db('SELECT deleted_at FROM deleted_usernames WHERE username_low = $1', [usernameLow]);
    return r.rows[0] ? { deletedAt: Number(r.rows[0].deleted_at) } : null;
  } catch { return null; }
}

// ── Владельцы сайта ───────────────────────────────────────────
// Только они могут выдавать/снимать роль админа и читать переписки.
const SITE_OWNERS = ['chesshome', 'marina64'];
const isSiteOwner = (u) => !!u && SITE_OWNERS.includes(String(u.username || '').toLowerCase());
function requireOwner(req, res, next) {
  if (!isSiteOwner(req.user)) return res.status(403).json({ error: 'Доступно только владельцам сайта' });
  return next();
}

// ── Общие хелперы валидации (DRY) ─────────────────────────────
function parsePagination(query, { defaultLimit = 20, maxLimit = 100 } = {}) {
  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;
  let offset = parseInt(query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  let page = parseInt(query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  return { limit, offset, page };
}

// Контроль времени «10+0», «3+2», «60+0s» — единая проверка для турниров
const TIME_CONTROL_RE = /^\d{1,3}(\.\d)?\+\d{1,2}(s)?$/;
function parseTimeControl(tc) {
  if (typeof tc !== 'string' || !TIME_CONTROL_RE.test(tc)) return null;
  const [base, inc] = tc.split('+');
  const seconds = base.endsWith('s') ? (parseInt(base, 10) || 15) : (parseFloat(base) || 10) * 60;
  return { raw: tc, baseSeconds: Math.min(seconds, 3 * 3600), increment: parseInt(inc, 10) || 0 };
}

// Кэш «задачи дня» (см. GET /api/puzzles/daily): пересчёт раз в сутки.
let dailyPuzzleCache = { day: -1, payload: null };

// ── Админ: просмотр переписок пользователя ──────────────────────
// Доступ только через requireAdmin (роль admin). Каждый просмотр
// пишется в admin_dm_audit (кто из админов, чью переписку и когда
// смотрел) — это не ограничивает доступ, но даёт возможность потом
// расследовать злоупотребления и отвечает перед пользователями за
// то, что доступ к их ЛС отслеживается.
async function logDmAudit(admin, target, partner, action) {
  try {
    await db('INSERT INTO admin_dm_audit (id, admin, target, partner, action, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv4(), admin, target, partner, action, Date.now()]);
  } catch (e) { console.error('[DM Audit]', e.message); }
}

// Заголовок и текст статьи блога иногда приезжают в base64 (поле encoding:'b64') —
// так фронтенд обходит ложные срабатывания WAF/ModSecurity на длинном сыром
// markdown-тексте (WAF видит бессмысленный base64 вместо спецсимволов и не блокирует
function decodeBlogField(value, encoding) {
  if (typeof value !== 'string' || encoding !== 'b64') return value;
  try { return Buffer.from(value, 'base64').toString('utf8'); }
  catch { return value; }
}

function parsePuzzleSolution(solution) {
  const all = (solution || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const playerMoves = all.filter((_, i) => i % 2 === 0);
  const autoMoves   = all.filter((_, i) => i % 2 === 1);
  return { all, playerMoves, autoMoves };
}

module.exports = {
  countDeletedUsers, getDeletedUser, logDmAudit,
  SITE_OWNERS, isSiteOwner, requireOwner,
  parsePagination, TIME_CONTROL_RE, parseTimeControl, dailyPuzzleCache,
  decodeBlogField, parsePuzzleSolution,
};
