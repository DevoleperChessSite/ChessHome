// ═══════════════════════════════════════════════════════════════
//  routes/admin-diagnostics.js — админ-диагностика: системные сообщения, аудит ЛС, логи, дашборд
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  uuidv4,
  pool,
  db,
  app,
  limiterStrict,
  bannedIPs,
  bannedDevices,
  getUser,
  SYSTEM_SENDER,
  isSystemSender,
  onlineUsers,
  workers,
  getIP,
  isLocalIP,
  rateLimit,
  logAdminAction,
  authMiddleware,
  requireAdmin,
  sanitizeUser,
  findSocketByUsername,
} = require('../core');

const {
  logDmAudit,
  requireOwner,
} = require('./_shared');

const twins = require('../twins');   // оценка «один человек» по сигналам устройства/сети

module.exports = function register(app) {
app.post('/api/admin/system-message', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  await requireAdmin(req, res, async () => {
    const text = (req.body.text || '').trim();
    const to   = (req.body.to || '').trim();
    if (!text) return res.status(400).json({ error: 'Введите текст сообщения' });
    if (text.length > 2000) return res.status(400).json({ error: 'Максимум 2000 символов' });
    if (!to) return res.status(400).json({ error: 'Укажите получателя' });

    const client = await pool.connect();
    try {
      let recipients;
      if (to.toLowerCase() === 'all') {
        const r = await client.query('SELECT username FROM users');
        recipients = r.rows.map(row => row.username).filter(u => !isSystemSender(u));
      } else {
        const targetUser = await getUser(to.toLowerCase());
        if (!targetUser) return res.status(404).json({ error: 'Пользователь не найден' });
        if (isSystemSender(targetUser.username)) return res.status(400).json({ error: 'Неверный получатель' });
        recipients = [targetUser.username];
      }
      if (!recipients.length) return res.status(400).json({ error: 'Нет получателей' });

      const now = new Date().toISOString();
      await client.query('BEGIN');
      for (const username of recipients) {
        const msg = { id: uuidv4(), from: SYSTEM_SENDER, to: username, text, ts: now, read: false };
        await client.query('INSERT INTO dm_messages (id, from_user, to_user, text, ts, read) VALUES ($1,$2,$3,$4,$5,$6)', [msg.id, msg.from, msg.to, msg.text, msg.ts, msg.read]);
        const sock = findSocketByUsername(username);
        if (sock) sock.emit('dm_message', msg);
      }
      await client.query('COMMIT');
      await logAdminAction(req.user.username, 'system_message', to.toLowerCase() === 'all' ? 'all' : recipients[0], { to: to.toLowerCase() === 'all' ? 'all' : recipients[0], count: recipients.length, text: text.slice(0, 200) });
      res.json({ ok: true, count: recipients.length });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[SystemMessage]', e);
      if (!res.headersSent) res.status(500).json({ error: 'Ошибка отправки: ' + e.message });
    } finally {
      client.release();
    }
  });
});


app.get('/api/admin/dm/conversations/:username', authMiddleware, async (req, res) => {
  await requireOwner(req, res, async () => {
    const target = req.params.username.toLowerCase();
    const targetUser = await getUser(target);
    if (!targetUser) return res.status(404).json({ error: 'Пользователь не найден' });

    const msgs = await db('SELECT from_user, to_user, text, ts FROM dm_messages WHERE from_user ILIKE $1 OR to_user ILIKE $1 ORDER BY ts DESC LIMIT 1000', [target]);
    const convMap = new Map();
    for (const m of msgs.rows) {
      const partner = m.from_user.toLowerCase() === target ? m.to_user : m.from_user;
      const key = partner.toLowerCase();
      if (!convMap.has(key)) convMap.set(key, { partner, lastMsg: m.text, lastTs: m.ts });
    }
    const convs = Array.from(convMap.values()).sort((a, b) => new Date(b.lastTs) - new Date(a.lastTs));

    await logDmAudit(req.user.username, targetUser.username, null, 'list_conversations');
    res.json({ user: sanitizeUser(targetUser), conversations: convs });
  });
});


app.get('/api/admin/dm/messages/:username/:partner', authMiddleware, async (req, res) => {
  await requireOwner(req, res, async () => {
    const target  = req.params.username.toLowerCase();
    const partner = req.params.partner.toLowerCase();
    const targetUser  = await getUser(target);
    const partnerUser = await getUser(partner);
    if (!targetUser || !partnerUser) return res.status(404).json({ error: 'Пользователь не найден' });

    const r = await db(
      "SELECT * FROM (SELECT * FROM dm_messages WHERE (from_user ILIKE $1 AND to_user ILIKE $2) OR (from_user ILIKE $2 AND to_user ILIKE $1) ORDER BY ts DESC LIMIT 1000) sub ORDER BY ts ASC",
      [target, partner]
    );
    const messages = r.rows.map(m => ({ id: m.id, from: m.from_user, to: m.to_user, text: m.text, ts: m.ts, read: m.read }));

    await logDmAudit(req.user.username, targetUser.username, partnerUser.username, 'view_thread');
    res.json({ messages });
  });
});


app.get('/api/admin/dm/audit', authMiddleware, async (req, res) => {
  await requireOwner(req, res, async () => {
    const target = (req.query.target || '').toLowerCase();
    const r = target
      ? await db('SELECT * FROM admin_dm_audit WHERE target ILIKE $1 ORDER BY created_at DESC LIMIT 200', [target])
      : await db('SELECT * FROM admin_dm_audit ORDER BY created_at DESC LIMIT 200');
    res.json(r.rows.map(a => ({ admin: a.admin, target: a.target, partner: a.partner, action: a.action, createdAt: Number(a.created_at) })));
  });
});


// ── Общий лог действий админов ──────────────────────────────────
// Читает admin_action_log, заполняемый logAdminAction() из всех
// модерационных эндпоинтов (бан/разбан, IP-баны, VIP, чат, задачи,
// жалобы, обращения, системные сообщения). Только для чтения.
app.get('/api/admin/logs', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const { admin, action, target } = req.query;
    const conds = [];
    const params = [];
    if (admin)  { params.push(admin.toLowerCase());  conds.push(`LOWER(admin) = $${params.length}`); }
    if (action) { params.push(action);                conds.push(`action = $${params.length}`); }
    if (target) { params.push('%' + target.toLowerCase() + '%'); conds.push(`LOWER(target) LIKE $${params.length}`); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const r = await db(`SELECT * FROM admin_action_log ${where} ORDER BY created_at DESC LIMIT 300`, params);
    res.json(r.rows.map(row => ({
      admin: row.admin, action: row.action, target: row.target,
      details: row.details ? JSON.parse(row.details) : null,
      createdAt: Number(row.created_at),
    })));
  });
});


// ── Подозрения на мультиаккаунты ────────────────────────────────
// Только показывает: группирует существующих пользователей по
// created_from_ip и created_device_id и возвращает группы из 2+
// аккаунтов как "подозрительные". НИКОГО НЕ БАНИТ — исключительно
// информация для ручного решения администратора (см. requireAdmin).
app.get('/api/admin/multiaccounts', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const r = await db('SELECT username, role, banned, ban_reason, created_from_ip, created_device_id, created_at, rating FROM users ORDER BY created_at ASC');

    const byIP = new Map();
    const byDevice = new Map();
    for (const row of r.rows) {
      const u = {
        username: row.username, role: row.role, banned: row.banned,
        banReason: row.ban_reason, createdAt: Number(row.created_at), rating: row.rating,
      };
      const ip = row.created_from_ip;
      if (ip && !isLocalIP(ip)) {
        if (!byIP.has(ip)) byIP.set(ip, []);
        byIP.get(ip).push(u);
      }
      const dev = row.created_device_id;
      if (dev) {
        if (!byDevice.has(dev)) byDevice.set(dev, []);
        byDevice.get(dev).push(u);
      }
    }

    const ipGroups = [...byIP.entries()]
      .filter(([, users]) => users.length > 1)
      .map(([ip, users]) => ({ ip, users }))
      .sort((a, b) => b.users.length - a.users.length);

    const deviceGroups = [...byDevice.entries()]
      .filter(([, users]) => users.length > 1)
      .map(([deviceId, users]) => ({ deviceId, users }))
      .sort((a, b) => b.users.length - a.users.length);

    res.json({ ipGroups, deviceGroups });
  });
});


// ── Вероятностная оценка дубликатов: POST /api/sig, GET /api/admin/twins, POST /api/admin/twins/label ──
twins.mount(app, { authMiddleware, requireAdmin, logAdminAction, getIP });

// ── Дашборд администратора ──────────────────────────────────────
// Сводка для главного экрана админки: онлайн, регистрации/партии по
// дням, баны, открытые жалобы/обращения. Отдельно от публичного
// /api/stats, т.к. включает чувствительные для админов цифры (баны,
// открытые обращения) и более короткое окно (14 дней) для графиков.
app.get('/api/admin/dashboard', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const [
        totalUsers, bannedUsersCnt, newUsersToday, totalGames, gamesToday,
        openReports, openAppeals, regByDay, gamesByDay,
      ] = await Promise.all([
        db('SELECT COUNT(*) FROM users'),
        db('SELECT COUNT(*) FROM users WHERE banned = true'),
        db(`SELECT COUNT(*) FROM users WHERE created_at >= extract(epoch from date_trunc('day', now()))*1000`),
        db('SELECT COUNT(*) FROM games'),
        db(`SELECT COUNT(*) FROM games WHERE ended_at >= extract(epoch from date_trunc('day', now()))*1000`),
        db(`SELECT COUNT(*) FROM reports WHERE status = 'new'`),
        db(`SELECT COUNT(*) FROM appeals WHERE status = 'open'`),
        db(`SELECT DATE(to_timestamp(created_at/1000)) as day, COUNT(*) as cnt FROM users WHERE created_at > extract(epoch from now()-interval '14 days')*1000 GROUP BY day ORDER BY day ASC`),
        db(`SELECT DATE(to_timestamp(ended_at/1000)) as day, COUNT(*) as cnt FROM games WHERE ended_at > extract(epoch from now()-interval '14 days')*1000 GROUP BY day ORDER BY day ASC`),
      ]);

      res.json({
        online: onlineUsers.size,
        workers: [...workers.values()].map(w => ({
          threads: w.threads, busy: w.busy, lastSeen: w.lastSeen,
        })),
        totals: {
          users: parseInt(totalUsers.rows[0].count),
          bannedUsers: parseInt(bannedUsersCnt.rows[0].count),
          newUsersToday: parseInt(newUsersToday.rows[0].count),
          games: parseInt(totalGames.rows[0].count),
          gamesToday: parseInt(gamesToday.rows[0].count),
          bannedIPs: bannedIPs.size,
          bannedDevices: bannedDevices.size,
          openReports: parseInt(openReports.rows[0].count),
          openAppeals: parseInt(openAppeals.rows[0].count),
        },
        charts: { regByDay: regByDay.rows, gamesByDay: gamesByDay.rows },
      });
    } catch (e) {
      console.error('[AdminDashboard]', e.message);
      res.status(500).json({ error: 'Ошибка загрузки дашборда' });
    }
  });
});


};
