// ═══════════════════════════════════════════════════════════════
//  routes/forum.js — форум
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  jwt,
  uuidv4,
  db,
  app,
  getAuthToken,
  limiterStrict,
  getUser,
  forumThreads,
  forumReplies,
  saveForumThread,
  deleteForumThread,
  saveForumReply,
  deleteForumReply,
  JWT_SECRET,
  getIP,
  rateLimit,
  authMiddleware,
} = require('../core');

module.exports = function register(app) {
app.get('/api/forum/threads', (req, res) => {
  const page  = Math.max(0, parseInt(req.query.page) || 0);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const sorted = [...forumThreads].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  res.json({ threads: sorted.slice(page * limit, page * limit + limit), total: sorted.length, page, limit });
});

app.get('/api/forum/threads/:slug', async (req, res) => {
  const thread = forumThreads.find(t => t.slug === req.params.slug || t.id === req.params.slug);
  if (!thread) return res.status(404).json({ error: 'Тема не найдена' });

  const replyPage = Math.max(1, parseInt(req.query.replyPage) || 1);
  const replyLimit = Math.min(100, parseInt(req.query.replyLimit) || 50);
  const start = (replyPage - 1) * replyLimit;
  const end = start + replyLimit;

  let allReplies = forumReplies.filter(r => r.threadId === thread.id).sort((a, b) => a.createdAt - b.createdAt);
  const totalReplies = allReplies.length;
  const replies = allReplies.slice(start, end);

  let viewerUsername = null;
  const authTok946 = getAuthToken(req);
  if (authTok946) { try { viewerUsername = jwt.verify(authTok946, JWT_SECRET).username.toLowerCase(); } catch {} }
  if (replies.length) {
    const ids = replies.map(r => r.id);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const params = viewerUsername ? [...ids, viewerUsername] : ids;
    const rrows = await db(
      `SELECT reply_id, emoji, COUNT(*) AS cnt${viewerUsername ? ', BOOL_OR(username_low = $' + (ids.length + 1) + ') AS mine' : ''}
         FROM forum_reply_reactions WHERE reply_id IN (${placeholders})
         GROUP BY reply_id, emoji`,
      params
    ).catch(() => ({ rows: [] }));
    const byReply = new Map();
    for (const row of rrows.rows) {
      if (!byReply.has(row.reply_id)) byReply.set(row.reply_id, { reactions: {}, myReaction: null });
      const entry = byReply.get(row.reply_id);
      entry.reactions[row.emoji] = Number(row.cnt);
      if (row.mine) entry.myReaction = row.emoji;
    }
    for (const r of replies) {
      const e = byReply.get(r.id);
      r.reactions = e?.reactions || {};
      r.myReaction = e?.myReaction || null;
    }
  }

  let viewerKey;
  const authTok945 = getAuthToken(req);
  if (authTok945) {
    try { const p = jwt.verify(authTok945, JWT_SECRET); viewerKey = 'u:' + p.username.toLowerCase(); }
    catch { viewerKey = 'ip:' + getIP(req); }
  } else { viewerKey = 'ip:' + getIP(req); }
  // Утечка памяти (P1): учёт просмотрщиков вынесен в trackForumView (core.js),
  // где размер forumViewSessions ограничен (лимит тем и лимит Set на тему).
  if (trackForumView(thread.id, viewerKey)) {
    thread.views++; saveForumThread(thread).catch(() => {});
  }

  res.json({
    thread,
    replies,
    replyMeta: {
      page: replyPage,
      limit: replyLimit,
      total: totalReplies,
      totalPages: Math.ceil(totalReplies / replyLimit)
    }
  });
});


// Метод DELETE у части посетителей режется на уровне nginx/WAF (см. тот же
// фикс для комментариев блога) — поэтому удаление темы форума теперь
// доступно и через POST .../delete, а не только через DELETE.
async function handleDeleteForumThread(req, res) {
  const user = await getUser(req.user.username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Не авторизован' });
  const idx = forumThreads.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Не найдено' });
  const thread = forumThreads[idx];
  if (user.role !== 'admin' && thread.author !== user.username) return res.status(403).json({ error: 'Нет прав' });
  forumThreads.splice(idx, 1);
  forumReplies.splice(0, forumReplies.length, ...forumReplies.filter(r => r.threadId !== thread.id));
  await deleteForumThread(thread.id);
  res.json({ ok: true });
}
app.delete('/api/forum/threads/:id', authMiddleware, handleDeleteForumThread);
app.post('/api/forum/threads/:id/delete', authMiddleware, handleDeleteForumThread);


app.get('/api/forum/threads/:slug/search', (req, res) => {
  const thread = forumThreads.find(t => t.slug === req.params.slug || t.id === req.params.slug);
  if (!thread) return res.status(404).json({ error: 'Тема не найдена' });
  const q = (req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ results: [] });
  const allReplies = forumReplies.filter(r => r.threadId === thread.id).sort((a, b) => a.createdAt - b.createdAt);
  const repliesPerPage = 50;
  const results = [];
  allReplies.forEach((reply, idx) => {
    if (reply.body.toLowerCase().includes(q)) {
      const page = Math.floor(idx / repliesPerPage) + 1;
      results.push({ reply, page });
    }
  });
  res.json({ results: results.map(r => ({
    id: r.reply.id,
    author: r.reply.author,
    body: r.reply.body.slice(0, 200) + (r.reply.body.length > 200 ? '…' : ''),
    createdAt: r.reply.createdAt,
    page: r.page
  })) });
});


app.post('/api/forum/threads/:id/replies', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const user = await getUser(req.user.username.toLowerCase());
  if (!user || user.banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });
  const thread = forumThreads.find(t => t.id === req.params.id);
  if (!thread) return res.status(404).json({ error: 'Тема не найдена' });
  const { body } = req.body;
  if (!body || body.trim().length < 2)  return res.status(400).json({ error: 'Ответ слишком короткий' });
  if (body.trim().length > 5000)        return res.status(400).json({ error: 'Ответ слишком длинный (макс. 5 000 символов)' });
  if (countTodayByUser(forumReplies, user.username) >= 10)
    return res.status(429).json({ error: 'Вы уже написали 10 ответов сегодня. Лимит сбросится в полночь.' });
  const now = Date.now();
  const reply = { id: uuidv4(), threadId: thread.id, author: user.username, authorId: user.id, body: body.trim(), createdAt: now };
  forumReplies.push(reply);
  thread.replyCount = (thread.replyCount || 0) + 1;
  thread.lastActivityAt = now;
  await saveForumThread(thread);
  await saveForumReply(reply);
  res.json({ ok: true, reply });
});


async function handleDeleteForumReply(req, res) {
  const user = await getUser(req.user.username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Не авторизован' });
  const idx = forumReplies.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Не найдено' });
  const reply = forumReplies[idx];
  if (user.role !== 'admin' && reply.author !== user.username) return res.status(403).json({ error: 'Нет прав' });
  const thread = forumThreads.find(t => t.id === reply.threadId);
  if (thread) { thread.replyCount = Math.max(0, (thread.replyCount || 1) - 1); await saveForumThread(thread); }
  forumReplies.splice(idx, 1);
  await deleteForumReply(reply.id);
  res.json({ ok: true });
}
app.delete('/api/forum/replies/:id', authMiddleware, handleDeleteForumReply);
app.post('/api/forum/replies/:id/delete', authMiddleware, handleDeleteForumReply);


const FORUM_REPLY_EMOJIS = ['👍','👎','❤️','😂','😮','♟️'];
app.post('/api/forum/replies/:id/react', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const user = await getUser(req.user.username.toLowerCase());
  if (!user || user.banned) return res.status(403).json({ error: 'Нет доступа' });
  const reply = forumReplies.find(r => r.id === req.params.id);
  if (!reply) return res.status(404).json({ error: 'Ответ не найден' });

  const { emoji } = req.body;
  if (!FORUM_REPLY_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Неверный эмоджи' });
  const usernameLow = user.username.toLowerCase();

  const existing = await db('SELECT emoji FROM forum_reply_reactions WHERE reply_id=$1 AND username_low=$2', [reply.id, usernameLow]);
  if (existing.rows[0]?.emoji === emoji) {
    await db('DELETE FROM forum_reply_reactions WHERE reply_id=$1 AND username_low=$2', [reply.id, usernameLow]);
  } else if (existing.rows[0]) {
    await db('UPDATE forum_reply_reactions SET emoji=$1 WHERE reply_id=$2 AND username_low=$3', [emoji, reply.id, usernameLow]);
  } else {
    await db('INSERT INTO forum_reply_reactions (reply_id, username_low, emoji, created_at) VALUES ($1,$2,$3,$4)', [reply.id, usernameLow, emoji, Date.now()]);
  }

  const rr = await db('SELECT emoji, COUNT(*) AS cnt FROM forum_reply_reactions WHERE reply_id=$1 GROUP BY emoji', [reply.id]);
  const reactions = {};
  for (const row of rr.rows) reactions[row.emoji] = Number(row.cnt);
  const mineNow = existing.rows[0]?.emoji === emoji ? null : emoji;
  res.json({ ok: true, reactions, myReaction: mineNow });
});


app.post('/api/forum/threads', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const user = await getUser(req.user.username.toLowerCase());
  if (!user || user.banned) return res.status(403).json({ error: 'Аккаунт заблокирован' });

  const { title, body } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'Укажите заголовок' });
  if (!body || !body.trim()) return res.status(400).json({ error: 'Укажите текст' });
  if (title.length > 120) return res.status(400).json({ error: 'Заголовок слишком длинный (макс 120)' });
  if (body.length > 10000) return res.status(400).json({ error: 'Текст слишком длинный (макс 10 000)' });

  // Ограничение: не более 3 тем в сутки — через общий countTodayByUser
  if (countTodayByUser(forumThreads, user.username) >= 3) {
    return res.status(429).json({ error: 'Вы уже создали 3 темы сегодня. Лимит сбросится в полночь.' });
  }

  const id = uuidv4();
  const slug = makeSlug(title, id);
  const now = Date.now();
  const thread = {
    id,
    slug,
    author: user.username,
    authorId: user.id,
    title: title.trim(),
    body: body.trim(),
    createdAt: now,
    lastActivityAt: now,
    replyCount: 0,
    views: 0
  };

  forumThreads.unshift(thread);
  await saveForumThread(thread);
  res.json({ ok: true, thread: { id: thread.id, slug: thread.slug, title: thread.title } });
});


// ── FOLLOWS (подписки) API ───────────────────────────────────

// ── Forum API ─────────────────────────────────────────────────
function countTodayByUser(arr, username) {
  const midnight = new Date(); midnight.setHours(0,0,0,0);
  return arr.filter(x => x.author === username && x.createdAt >= midnight.getTime()).length;
}

function makeSlug(title, id) {
  const s = title.toLowerCase()
    .replace(/[а-яё]/g, c => ({а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'j',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya'}[c]||''))
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'topic';
  return s + '-' + id.slice(0, 6);
}


const forumViewSessions = new Map();
const FORUM_VIEW_MAX_THREADS = 1000; // сколько тем держим в памяти
const FORUM_VIEW_MAX_VIEWERS = 5000; // сколько уникальных просмотрщиков на тему

// Возвращает true, если viewerKey для темы виден впервые (тему нужно
// +1 к счётчику просмотров), и в любом случае гарантирует соблюдение
// лимитов коллекции.
function trackForumView(threadId, viewerKey) {
  // Просроченные/удалённые темы постепенно выдавливаются лимитом MAX_THREADS.
  if (forumViewSessions.size >= FORUM_VIEW_MAX_THREADS && !forumViewSessions.has(threadId)) {
    const oldest = forumViewSessions.keys().next().value;
    if (oldest !== undefined) forumViewSessions.delete(oldest);
  }
  let viewers = forumViewSessions.get(threadId);
  if (!viewers) { viewers = new Set(); forumViewSessions.set(threadId, viewers); }
  if (viewers.has(viewerKey)) return false;
  if (viewers.size >= FORUM_VIEW_MAX_VIEWERS) return false; // Set полон — новые просмотрщики не копим
  viewers.add(viewerKey);
  return true;
}
};
