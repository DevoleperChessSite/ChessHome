// ═══════════════════════════════════════════════════════════════
//  routes/dm.js — личные сообщения
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  uuidv4,
  db,
  app,
  limiterStrict,
  isVip,
  getUser,
  isSystemSender,
  rateLimit,
  authMiddleware,
  findSocketByUsername,
  emitToAdmins,
} = require('../core');

const moderation = require('../moderation');

module.exports = function register(app) {
app.get('/api/dm/conversations', authMiddleware, async (req, res) => {
  const me = req.user.username.toLowerCase();

  const msgs = await db('SELECT id, from_user, to_user, text, ts, shadow_hidden FROM dm_messages WHERE from_user ILIKE $1 OR to_user ILIKE $1 ORDER BY ts DESC LIMIT 500', [me]);
  const convMap = new Map();
  for (const m of msgs.rows) {
    // Сообщение теневого бана от partner'а мне — как будто его никогда не
    // было: не создаёт (и не поднимает) беседу в списке. Свои же собственные
    // "невидимые" исходящие сообщения я по-прежнему вижу как обычно.
    if (m.shadow_hidden && m.from_user.toLowerCase() !== me) continue;
    const partner = m.from_user.toLowerCase() === me ? m.to_user : m.from_user;
    const key = dmRoomKey(me, partner.toLowerCase());
    if (!convMap.has(key)) convMap.set(key, { partner, lastMsg: m.text, lastTs: m.ts });
  }

  const unreadRows = await db("SELECT from_user, COUNT(*) as cnt FROM dm_messages WHERE to_user ILIKE $1 AND read = false AND shadow_hidden = false GROUP BY from_user", [me]);
  const unreadMap = new Map(unreadRows.rows.map(r => [r.from_user.toLowerCase(), Number(r.cnt)]));

  const blockedRows = await db('SELECT blocked FROM dm_blocks WHERE blocker ILIKE $1', [me]);
  const blockedSet = new Set(blockedRows.rows.map(r => r.blocked.toLowerCase()));

  const convsBase = Array.from(convMap.values())
    .map(c => ({ ...c, unread: unreadMap.get(c.partner.toLowerCase()) || 0, blocked: blockedSet.has(c.partner.toLowerCase()) }));
  // getUser() бьёт в кэш, если собеседник уже когда-то загружался — реального похода в БД
  // почти никогда не будет; нужен только чтобы узнать текущий (живой) статус VIP.
  const convs = (await Promise.all(convsBase.map(async c => ({ ...c, vip: isVip(await getUser(c.partner.toLowerCase())) }))))
    .sort((a, b) => new Date(b.lastTs) - new Date(a.lastTs));

  res.json(convs);
});


app.get('/api/dm/messages/:partner', authMiddleware, async (req, res) => {
  const me = req.user.username.toLowerCase();
  const partner = req.params.partner.toLowerCase();
  if (me === partner) return res.status(400).json({ error: 'Нельзя переписываться с собой' });
  const since = req.query.since ? new Date(req.query.since) : null;
  const r = since
    ? await db("SELECT * FROM dm_messages WHERE ((from_user ILIKE $1 AND to_user ILIKE $2) OR (from_user ILIKE $2 AND to_user ILIKE $1)) AND ts > $3 ORDER BY ts ASC LIMIT 100", [me, partner, since.toISOString()])
    : await db("SELECT * FROM (SELECT * FROM dm_messages WHERE ((from_user ILIKE $1 AND to_user ILIKE $2) OR (from_user ILIKE $2 AND to_user ILIKE $1)) ORDER BY ts DESC LIMIT 100) sub ORDER BY ts ASC", [me, partner]);
  // Сообщения, отправленные теневым баном, видит только сам отправитель —
  // если это писал partner, а не я, они для меня как будто не существуют.
  const rows = r.rows.filter(m => !m.shadow_hidden || m.from_user.toLowerCase() === me);
  const quotedIds = rows.map(m => m.reply_to_id).filter(Boolean);
  const quotedMap = new Map();
  if (quotedIds.length) {
    const uniq = [...new Set(quotedIds)];
    const placeholders = uniq.map((_, i) => `$${i + 1}`).join(',');
    const qr = await db(`SELECT id, from_user, text FROM dm_messages WHERE id IN (${placeholders})`, uniq).catch(() => ({ rows: [] }));
    for (const qm of qr.rows) quotedMap.set(qm.id, { id: qm.id, from: qm.from_user, text: String(qm.text || '').slice(0, 140) });
  }
  const msgs = rows.map(m => ({
    id: m.id, from: m.from_user, to: m.to_user, text: m.text, ts: m.ts, read: m.read,
    replyTo: m.reply_to_id ? (quotedMap.get(m.reply_to_id) || null) : null,
  }));
  const blockedByMe      = await db('SELECT 1 FROM dm_blocks WHERE blocker ILIKE $1 AND blocked ILIKE $2', [me, partner]);
  const blockedByPartner = await db('SELECT 1 FROM dm_blocks WHERE blocker ILIKE $1 AND blocked ILIKE $2', [partner, me]);
  const partnerVip = isVip(await getUser(partner));
  res.json({ messages: msgs, blocked: blockedByMe.rows.length > 0, blockedByPartner: blockedByPartner.rows.length > 0, partnerVip });
});


app.post('/api/dm/send', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const me = req.user.username;
  const meUser = await getUser(me.toLowerCase());
  if (!meUser || meUser.banned) return res.status(403).json({ error: 'Ваш аккаунт заблокирован' });
  const { to, text, replyTo } = req.body;
  if (!to || !text || !text.trim()) return res.status(400).json({ error: 'Укажите получателя и текст' });
  if (to.toLowerCase() === me.toLowerCase()) return res.status(400).json({ error: 'Нельзя писать самому себе' });
  if (isSystemSender(to)) return res.status(403).json({ error: 'Этому аккаунту нельзя написать' });
  if (text.length > 500) return res.status(400).json({ error: 'Максимум 500 символов' });
  const toUser = await getUser(to.toLowerCase());
  if (!toUser) return res.status(404).json({ error: 'Пользователь не найден' });
  const blocked = await db('SELECT 1 FROM dm_blocks WHERE (blocker ILIKE $1 AND blocked ILIKE $2) OR (blocker ILIKE $2 AND blocked ILIKE $1)', [me, to]);
  if (blocked.rows.length > 0) return res.status(403).json({ error: 'Переписка заблокирована' });

  let replyToId = null;
  if (typeof replyTo === 'string' && replyTo) {
    const q = await db('SELECT id FROM dm_messages WHERE id = $1 AND ((from_user ILIKE $2 AND to_user ILIKE $3) OR (from_user ILIKE $3 AND to_user ILIKE $2)) LIMIT 1', [replyTo, me.toLowerCase(), to.toLowerCase()]);
    if (!q.rows[0]) return res.status(400).json({ error: 'Сообщение для ответа не найдено' });
    replyToId = q.rows[0].id;
  }

  moderation.record({ username: me, channel: 'dm', text, target: to });
  const shadowHidden = !!meUser.shadowBanned;
  const msg = { id: uuidv4(), from: me, to, text: text.trim(), ts: new Date().toISOString(), read: false, replyTo: replyToId };
  await db('INSERT INTO dm_messages (id, from_user, to_user, text, ts, read, shadow_hidden, reply_to_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [msg.id, msg.from, msg.to, msg.text, msg.ts, msg.read, shadowHidden, replyToId]);
  // Теневой бан: получателю сообщение НЕ шлём вообще (для него это как будто
  // никогда не отправлялось) — только отправителю, чтобы у него всё выглядело
  // как обычная успешная отправка.
  if (!shadowHidden) {
    const recipientSocket = findSocketByUsername(to);
    if (recipientSocket) recipientSocket.emit('dm_message', msg);
  } else {
    emitToAdmins('dm_message', msg).catch(() => {});
  }
  const senderSocket = findSocketByUsername(me);
  if (senderSocket) senderSocket.emit('dm_message', msg);
  res.json(msg);
});


app.post('/api/dm/read', authMiddleware, async (req, res) => {
  const me = req.user.username.toLowerCase();
  const partner = (req.body.partner || '').toLowerCase();
  if (!partner) return res.status(400).json({ error: 'Укажите partner' });
  await db("UPDATE dm_messages SET read = true WHERE to_user ILIKE $1 AND from_user ILIKE $2 AND read = false", [me, partner]);
  const partnerSocket = findSocketByUsername(req.body.partner);
  if (partnerSocket) partnerSocket.emit('dm_read', { by: req.user.username });
  res.json({ ok: true });
});


app.post('/api/dm/block', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const { username } = req.body;
  if (!username || username.toLowerCase() === me.toLowerCase()) return res.status(400).json({ error: 'Неверный запрос' });
  await db('INSERT INTO dm_blocks (blocker, blocked, ts) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [me, username, Date.now()]);
  res.json({ ok: true });
});


app.post('/api/dm/unblock', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Укажите username' });
  await db('DELETE FROM dm_blocks WHERE blocker ILIKE $1 AND blocked ILIKE $2', [me, username]);
  res.json({ ok: true });
});


// ── Системные сообщения: админ → одному пользователю или всем ──
// Приходят как обычные ЛС от имени SYSTEM_SENDER, но получатель не
// может на них ответить (фронтенд прячет поле ввода для этого
// отправителя, а /api/dm/send выше отдельно блокирует запись ЕМУ).

// ── DM: Личные Сообщения ──────────────────────────────────────
function dmRoomKey(a, b) { return [a.toLowerCase(), b.toLowerCase()].sort().join('::'); }


};
