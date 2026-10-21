// ═══════════════════════════════════════════════════════════════
//  routes/dev-diary.js — дневник разработки
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  jwt,
  db,
  app,
  getAuthToken,
  getUser,
  JWT_SECRET,
  logAdminAction,
  authMiddleware,
  requireAdmin,
} = require('../core');

const moderation = require('../moderation');

module.exports = function register(app) {
app.get('/api/dev-diary', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(20, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const sort = req.query.sort === 'asc' ? 'ASC' : 'DESC';

  const totalRes = await db('SELECT COUNT(*) AS total FROM dev_diary');
  const total = parseInt(totalRes.rows[0].total);

  const rows = await db(`
    SELECT id, author, title, content, created_at
    FROM dev_diary
    ORDER BY created_at ${sort}
    LIMIT $1 OFFSET $2
  `, [limit, offset]);

  res.json({
    entries: rows.rows.map(r => ({
      id: r.id, author: r.author, title: r.title, content: r.content, createdAt: Number(r.created_at)
    })),
    total, page, totalPages: Math.ceil(total / limit)
  });
});


app.post('/api/dev-diary', authMiddleware, async (req, res) => {
  const user = await getUser(req.user.username.toLowerCase());
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Только администраторы могут добавлять записи' });

  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Заполните заголовок и текст' });
  if (title.length > 100) return res.status(400).json({ error: 'Заголовок не длиннее 100 символов' });
  if (content.length > 2000) return res.status(400).json({ error: 'Текст не длиннее 2000 символов' });

  const id = require('crypto').randomUUID();
  await db('INSERT INTO dev_diary (id, author, title, content, created_at) VALUES ($1,$2,$3,$4,$5)', [id, user.username, title.trim(), content.trim(), Date.now()]);
  res.json({ ok: true, id });
});

// DELETE — основной вариант, POST — резервный на случай, если хостинг режет DELETE.
app.delete('/api/dev-diary/:id', authMiddleware, handleDeleteDevDiaryEntry);

app.post('/api/dev-diary/:id/delete', authMiddleware, handleDeleteDevDiaryEntry);


// ── Dev Diary: реакции ────────────────────────────────────────
// Таблицы создаются в main()

app.get('/api/dev-diary/:entryId/reactions', async (req, res) => {
  try {
    const rows = await db(
      `SELECT emoji, COUNT(*) AS cnt FROM dev_diary_reactions WHERE entry_id=$1 GROUP BY emoji`,
      [req.params.entryId]
    );
    // Своя реакция текущего пользователя (опционально по токену)
    let myEmoji = null;
    const auth = getAuthToken(req);
    if (auth) {
      try {
        const payload = jwt.verify(auth, JWT_SECRET);
        const r2 = await db(
          `SELECT emoji FROM dev_diary_reactions WHERE entry_id=$1 AND username_low=$2`,
          [req.params.entryId, payload.username.toLowerCase()]
        );
        if (r2.rows[0]) myEmoji = r2.rows[0].emoji;
      } catch {}
    }
    const counts = {};
    for (const r of rows.rows) counts[r.emoji] = parseInt(r.cnt);
    res.json({ counts, myEmoji });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/dev-diary/:entryId/reactions', authMiddleware, async (req, res) => {
  const ALLOWED_EMOJIS = ['👍','❤️','🔥','😂','🤯'];
  const { emoji } = req.body;
  if (!ALLOWED_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Недопустимый эмодзи' });
  const usernameLow = req.user.username.toLowerCase();
  // Проверяем, есть ли уже реакция
  const existing = await db(
    `SELECT emoji FROM dev_diary_reactions WHERE entry_id=$1 AND username_low=$2`,
    [req.params.entryId, usernameLow]
  );
  if (existing.rows[0]) {
    if (existing.rows[0].emoji === emoji) {
      // Снять реакцию
      await db(`DELETE FROM dev_diary_reactions WHERE entry_id=$1 AND username_low=$2`,
        [req.params.entryId, usernameLow]);
      return res.json({ ok: true, removed: true });
    } else {
      // Заменить
      await db(`UPDATE dev_diary_reactions SET emoji=$1 WHERE entry_id=$2 AND username_low=$3`,
        [emoji, req.params.entryId, usernameLow]);
      return res.json({ ok: true, replaced: true });
    }
  }
  await db(`INSERT INTO dev_diary_reactions (entry_id, username_low, emoji, created_at) VALUES ($1,$2,$3,$4)`,
    [req.params.entryId, usernameLow, emoji, Date.now()]);
  res.json({ ok: true });
});


// ── Dev Diary: комментарии ────────────────────────────────────

app.get('/api/dev-diary/:entryId/comments', async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;
    // Комментарии забаненных / тенево-забаненных / «забаненных в дневнике» видит
    // только их автор и админы — для всех остальных их как будто нет.
    const hidden = await moderation.commentExclusions(req, 'diary');
    const totalR = await db(`SELECT COUNT(*) AS total FROM dev_diary_comments WHERE entry_id=$1 AND username_low <> ALL($2::text[])`, [req.params.entryId, hidden]);
    const total = parseInt(totalR.rows[0].total);
    const rows = await db(
      `SELECT id, entry_id, username, content, created_at
       FROM dev_diary_comments WHERE entry_id=$1 AND username_low <> ALL($4::text[])
       ORDER BY created_at ASC LIMIT $2 OFFSET $3`,
      [req.params.entryId, limit, offset, hidden]
    );
    res.json({
      comments: rows.rows.map(r => ({ id: r.id, username: r.username, content: r.content, createdAt: Number(r.created_at) })),
      total, page, totalPages: Math.ceil(total / limit)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/api/dev-diary/:entryId/comments', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.user.username.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Не авторизован' });
    // Бан / теневой бан / бан комментариев дневника: человеку НЕ говорим об этом —
    // комментарий публикуется как обычно, но видит его только он сам и админы
    // (фильтрация — в GET выше, через moderation.commentExclusions).

    // Лимит 5 в день
    const dayStart = Date.now() - 24 * 60 * 60 * 1000;
    const countR = await db(
      `SELECT COUNT(*) AS cnt FROM dev_diary_comments WHERE username_low=$1 AND created_at > $2`,
      [user.username.toLowerCase(), dayStart]
    );
    if (parseInt(countR.rows[0].cnt) >= 5) return res.status(429).json({ error: 'Лимит 5 комментариев в сутки исчерпан' });

    const { content } = req.body;
    if (!content || !content.trim()) return res.status(400).json({ error: 'Пустой комментарий' });
    if (content.length > 500) return res.status(400).json({ error: 'Комментарий не длиннее 500 символов' });

    moderation.record({ username: user.username, channel: 'dev-diary', text: content });
    const id = require('crypto').randomUUID();
    await db(`INSERT INTO dev_diary_comments (id, entry_id, username, username_low, content, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.params.entryId, user.username, user.username.toLowerCase(), content.trim(), Date.now()]);
    res.json({ ok: true, id, username: user.username, content: content.trim(), createdAt: Date.now() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/dev-diary/comments/:commentId', authMiddleware, handleDeleteDevDiaryComment);

app.post('/api/dev-diary/comments/:commentId/delete', authMiddleware, handleDeleteDevDiaryComment);


// Бан/разбан юзера в комментариях дневника
app.post('/api/admin/dev-diary-comment-ban', authMiddleware, async (req, res) => {
  try {
    await requireAdmin(req, res, async () => {
      const { username, action } = req.body; // action: 'ban' | 'unban'
      if (!username) return res.status(400).json({ error: 'username обязателен' });
      const ulow = username.toLowerCase();
      if (action === 'ban') {
        await db(`INSERT INTO dev_diary_comment_bans (username_low, created_at) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [ulow, Date.now()]);
      } else {
        await db(`DELETE FROM dev_diary_comment_bans WHERE username_low=$1`, [ulow]);
      }
      await logAdminAction(req.user.username, 'dev_diary_comment_' + (action === 'ban' ? 'ban' : 'unban'), username, {});
      res.json({ ok: true });
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



async function handleDeleteDevDiaryEntry(req, res) {
  try {
    const user = await getUser(req.user.username.toLowerCase());
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Доступ запрещён' });
    await db('DELETE FROM dev_diary WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DevDiary DELETE]', e);
    res.status(500).json({ error: 'Ошибка удаления записи: ' + e.message });
  }
}


async function handleDeleteDevDiaryComment(req, res) {
  try {
    const user = await getUser(req.user.username.toLowerCase());
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Нет прав' });
    await db(`DELETE FROM dev_diary_comments WHERE id=$1`, [req.params.commentId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
};
