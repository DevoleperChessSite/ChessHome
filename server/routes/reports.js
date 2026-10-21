// ═══════════════════════════════════════════════════════════════
//  routes/reports.js — жалобы
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  uuidv4,
  db,
  app,
  limiterStrict,
  getUser,
  rateLimit,
  logAdminAction,
  authMiddleware,
  requireAdmin,
  emitToAdmins,
} = require('../core');

module.exports = function register(app) {
app.post('/api/report', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const { targetUsername, reason, details } = req.body;
  if (!targetUsername || !reason) return res.status(400).json({ error: 'Укажите причину' });
  
  const target = await getUser((targetUsername || '').toLowerCase());
  if (!target) return res.status(404).json({ error: 'Не найден' });
  if (targetUsername === req.user.username) return res.status(400).json({ error: 'Нельзя жаловаться на себя' });

  // Проверка лимита: 1 жалоба на одного и того же человека в неделю
  const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const recentReport = await db(
    'SELECT created_at FROM reports WHERE reporter = $1 AND target_username = $2 ORDER BY created_at DESC LIMIT 1',
    [req.user.username, target.username]
  );

  if (recentReport.rows.length > 0) {
    const lastReportTime = Number(recentReport.rows[0].created_at);
    if (Date.now() - lastReportTime < ONE_WEEK_MS) {
      return res.status(429).json({ 
        error: 'Вы уже отправляли жалобу на этого игрока. Повторную жалобу можно отправить через неделю.' 
      });
    }
  }

  const report = {
    id: uuidv4(), reporter: req.user.username, targetUsername: target.username,
    reason, details: (details || '').slice(0, 500), status: 'new', createdAt: Date.now()
  };
  
  await db('INSERT INTO reports (id, reporter, target_username, reason, details, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [report.id, report.reporter, report.targetUsername, report.reason, report.details, report.status, report.createdAt]);
    
  const total = (await db("SELECT COUNT(*) FROM reports WHERE status='new'")).rows[0].count;
  await emitToAdmins('new_report', { report, total: Number(total) });
  res.json({ ok: true });
});


app.get('/api/admin/reports', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const status = req.query.status;
    const r = status
      ? await db('SELECT * FROM reports WHERE status = $1 ORDER BY created_at DESC LIMIT 100', [status])
      : await db('SELECT * FROM reports ORDER BY created_at DESC LIMIT 100');
    res.json(r.rows.map(row => ({
      id: row.id, reporter: row.reporter, targetUsername: row.target_username,
      reason: row.reason, details: row.details, status: row.status,
      createdAt: Number(row.created_at), reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at,
    })));
  });
});

// PATCH — основной вариант. Некоторые хостинги/прокси режут методы PATCH/DELETE,
// поэтому дублируем ту же логику через POST — фронтенд теперь ходит именно сюда.
app.patch('/api/admin/reports/:reportId', authMiddleware, handleUpdateReportStatus);

app.post('/api/admin/reports/:reportId/status', authMiddleware, handleUpdateReportStatus);



async function handleUpdateReportStatus(req, res) {
  await requireAdmin(req, res, async () => {
    try {
      const status = req.body.status || 'reviewed';
      const r = await db('UPDATE reports SET status=$1, reviewed_by=$2, reviewed_at=$3 WHERE id=$4',
        [status, req.user.username, Date.now(), req.params.reportId]);
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Жалоба не найдена (возможно, неверный id)' });
      }
      await logAdminAction(req.user.username, 'report_status', req.params.reportId, { status });
      res.json({ ok: true });
    } catch (e) {
      console.error('[Reports PATCH]', e.message);
      res.status(500).json({ error: 'Ошибка обновления статуса: ' + e.message });
    }
  });
}
};
