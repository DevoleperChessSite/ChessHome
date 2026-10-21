// ═══════════════════════════════════════════════════════════════
//  routes/appeals.js — апелляции / обращения (тикеты)
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  uuidv4,
  db,
  app,
  limiterStrict,
  rateLimit,
  logAdminAction,
  authMiddleware,
  requireAdmin,
  findSocketByUsername,
  emitToAdmins,
} = require('../core');

module.exports = function register(app) {
app.post('/api/appeals', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const { reason, message } = req.body;
  if (!reason || !APPEAL_REASONS.includes(reason)) return res.status(400).json({ error: 'Укажите тему обращения' });
  const text = (message || '').trim();
  if (!text) return res.status(400).json({ error: 'Напишите сообщение' });
  if (text.length > 1000) return res.status(400).json({ error: 'Слишком длинное сообщение (макс. 1000 символов)' });

  const openExisting = await db(
    `SELECT id FROM appeals WHERE username = $1 AND status = 'open' LIMIT 1`,
    [req.user.username]
  );
  if (openExisting.rows.length > 0) {
    return res.status(409).json({
      error: 'У вас уже есть открытое обращение. Дождитесь ответа администратора.',
      appealId: openExisting.rows[0].id
    });
  }

  const id = uuidv4();
  const now = Date.now();
  await db(
    `INSERT INTO appeals (id, username, reason, status, awaiting, created_at, updated_at) VALUES ($1,$2,$3,'open','admin',$4,$4)`,
    [id, req.user.username, reason, now]
  );
  await db(
    `INSERT INTO appeal_messages (id, appeal_id, author, is_admin, message, created_at) VALUES ($1,$2,$3,FALSE,$4,$5)`,
    [uuidv4(), id, req.user.username, text, now]
  );

  const total = (await db(`SELECT COUNT(*) FROM appeals WHERE status='open' AND awaiting='admin'`)).rows[0].count;
  await emitToAdmins('new_appeal', { appealId: id, username: req.user.username, reason, total: Number(total) });
  res.json({ ok: true, appealId: id });
});


app.get('/api/appeals/mine', authMiddleware, async (req, res) => {
  const list = await db(`SELECT * FROM appeals WHERE username = $1 ORDER BY created_at DESC LIMIT 20`, [req.user.username]);
  const ids = list.rows.map(r => r.id);
  const byAppeal = new Map();
  if (ids.length) {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const allMsgs = await db(`SELECT * FROM appeal_messages WHERE appeal_id IN (${placeholders}) ORDER BY created_at ASC`, ids);
    for (const m of allMsgs.rows) {
      if (!byAppeal.has(m.appeal_id)) byAppeal.set(m.appeal_id, []);
      byAppeal.get(m.appeal_id).push(m);
    }
  }
  const appeals = list.rows.map(row => ({
    id: row.id, reason: row.reason, status: row.status, awaiting: row.awaiting,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    messages: (byAppeal.get(row.id) || []).map(m => ({ id: m.id, author: m.author, isAdmin: m.is_admin, message: m.message, createdAt: Number(m.created_at) }))
  }));
  res.json(appeals);
});


app.post('/api/appeals/:id/reply', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const text = (req.body.message || '').trim();
  if (!text) return res.status(400).json({ error: 'Напишите сообщение' });
  if (text.length > 1000) return res.status(400).json({ error: 'Слишком длинное сообщение (макс. 1000 символов)' });

  const r = await db(`SELECT * FROM appeals WHERE id = $1`, [req.params.id]);
  const appeal = r.rows[0];
  if (!appeal) return res.status(404).json({ error: 'Обращение не найдено' });
  if (appeal.username !== req.user.username) return res.status(403).json({ error: 'Это не ваше обращение' });
  if (appeal.status === 'closed') return res.status(400).json({ error: 'Обращение закрыто администратором' });
  if (appeal.awaiting !== 'user') return res.status(400).json({ error: 'Дождитесь ответа администратора, прежде чем писать снова' });

  const now = Date.now();
  await db(
    `INSERT INTO appeal_messages (id, appeal_id, author, is_admin, message, created_at) VALUES ($1,$2,$3,FALSE,$4,$5)`,
    [uuidv4(), appeal.id, req.user.username, text, now]
  );
  await db(`UPDATE appeals SET awaiting='admin', updated_at=$1 WHERE id=$2`, [now, appeal.id]);

  const total = (await db(`SELECT COUNT(*) FROM appeals WHERE status='open' AND awaiting='admin'`)).rows[0].count;
  await emitToAdmins('new_appeal', { appealId: appeal.id, username: req.user.username, reason: appeal.reason, total: Number(total) });
  res.json({ ok: true });
});


app.get('/api/admin/appeals', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const status = req.query.status;
    const r = status
      ? await db(`SELECT * FROM appeals WHERE status = $1 ORDER BY updated_at DESC LIMIT 200`, [status])
      : await db(`SELECT * FROM appeals ORDER BY updated_at DESC LIMIT 200`);
    res.json(r.rows.map(row => ({
      id: row.id, username: row.username, reason: row.reason, status: row.status,
      awaiting: row.awaiting, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    })));
  });
});


app.get('/api/admin/appeals/:id', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const r = await db(`SELECT * FROM appeals WHERE id = $1`, [req.params.id]);
    const appeal = r.rows[0];
    if (!appeal) return res.status(404).json({ error: 'Не найдено' });
    const msgs = await db(`SELECT * FROM appeal_messages WHERE appeal_id = $1 ORDER BY created_at ASC`, [appeal.id]);
    res.json({
      id: appeal.id, username: appeal.username, reason: appeal.reason, status: appeal.status,
      awaiting: appeal.awaiting, createdAt: Number(appeal.created_at), updatedAt: Number(appeal.updated_at),
      messages: msgs.rows.map(m => ({ id: m.id, author: m.author, isAdmin: m.is_admin, message: m.message, createdAt: Number(m.created_at) }))
    });
  });
});


app.post('/api/admin/appeals/:id/reply', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  await requireAdmin(req, res, async () => {
    const text = (req.body.message || '').trim();
    if (!text) return res.status(400).json({ error: 'Напишите сообщение' });
    if (text.length > 2000) return res.status(400).json({ error: 'Слишком длинное сообщение' });

    const r = await db(`SELECT * FROM appeals WHERE id = $1`, [req.params.id]);
    const appeal = r.rows[0];
    if (!appeal) return res.status(404).json({ error: 'Не найдено' });
    if (appeal.status === 'closed') return res.status(400).json({ error: 'Обращение закрыто — сначала откройте его заново' });

    const now = Date.now();
    await db(
      `INSERT INTO appeal_messages (id, appeal_id, author, is_admin, message, created_at) VALUES ($1,$2,$3,TRUE,$4,$5)`,
      [uuidv4(), appeal.id, req.user.username, text, now]
    );
    await db(`UPDATE appeals SET awaiting='user', updated_at=$1 WHERE id=$2`, [now, appeal.id]);

    const sock = findSocketByUsername(appeal.username);
    if (sock) sock.emit('appeal_reply', { appealId: appeal.id });
    await logAdminAction(req.user.username, 'appeal_reply', appeal.username, { appealId: appeal.id, text: text.slice(0, 200) });
    res.json({ ok: true });
  });
});

app.patch('/api/admin/appeals/:id', authMiddleware, handleUpdateAppealStatus);

app.post('/api/admin/appeals/:id/status', authMiddleware, handleUpdateAppealStatus);

// ── Tournaments API ───────────────────────────────────────────

// ── Апелляции / обращения (тикеты) ─────────────────────────────
// Правило: пока не ответит вторая сторона, писать снова нельзя —
// поле `awaiting` хранит, чья очередь отвечать ('admin' | 'user').
// Закрытые тикеты блокируют переписку до тех пор, пока админ не
// откроет их заново через PATCH.
const APPEAL_REASONS = ['ban', 'cheater', 'rating', 'other'];


async function handleUpdateAppealStatus(req, res) {
  await requireAdmin(req, res, async () => {
    try {
      const status = req.body.status;
      if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Некорректный статус' });
      const r = await db(`SELECT id FROM appeals WHERE id = $1`, [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'Не найдено' });

      const now = Date.now();
      if (status === 'open') {
        // Реоткрытие — очередь снова переходит к пользователю
        await db(`UPDATE appeals SET status='open', awaiting='user', updated_at=$1 WHERE id=$2`, [now, req.params.id]);
      } else {
        await db(`UPDATE appeals SET status='closed', updated_at=$1 WHERE id=$2`, [now, req.params.id]);
      }
      await logAdminAction(req.user.username, 'appeal_status', req.params.id, { status });
      res.json({ ok: true });
    } catch (e) {
      console.error('[Appeals PATCH]', e);
      res.status(500).json({ error: 'Ошибка обновления статуса обращения' });
    }
  });
}
};
