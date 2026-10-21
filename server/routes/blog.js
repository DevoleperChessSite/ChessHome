// ═══════════════════════════════════════════════════════════════
//  routes/blog.js — блог (статьи, лайки, комментарии)
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  jwt,
  uuidv4,
  path,
  db,
  app,
  getAuthToken,
  limiterStrict,
  getUser,
  isSiteAdmin,
  blogPosts,
  saveBlogPost,
  JWT_SECRET,
  rateLimit,
  isBlogAdmin,
} = require('../core');

const {
  decodeBlogField,
} = require('./_shared');

const moderation = require('../moderation');

module.exports = function register(app) {
app.get('/api/blog', async (req, res) => {
  const { section, status, sort, q, page: pQ, limit: lQ } = req.query;
  const page  = Math.max(0, parseInt(pQ) || 0);
  const limit = Math.min(50, parseInt(lQ) || 20);

  let callerUsername = null;
  const auth = getAuthToken(req);
  if (auth) { try { callerUsername = jwt.verify(auth, JWT_SECRET).username.toLowerCase(); } catch {} }

  let list = blogPosts.filter(p => {
    if (p.status === 'hidden') {
      // Список скрытых статей виден только администратору и только
      // когда его явно запросили (вкладка "Скрытые").
      return status === 'hidden' && isBlogAdmin(callerUsername);
    }
    if (status === 'hidden') return false;
    if (p.status !== 'published') {
      if (!callerUsername) return false;
      if (!isBlogAdmin(callerUsername) && p.author.toLowerCase() !== callerUsername) return false;
      return status === 'drafts';
    }
    return status !== 'drafts';
  });

  // Список скрытых статей — это единая модераторская вкладка для админа,
  // не привязанная к разделу (иначе статьи, скрытые из другого раздела,
  // "пропадали бы" из виду). То же самое для черновиков АДМИНА: у него
  // могут быть черновики и в official, и в community (например, только
  // что восстановленная статья), и раздел не должен их прятать.
  // Обычным пользователям раздел для черновиков не мешает — у них черновики
  // всегда только в community.
  const bypassSection = status === 'hidden' || (status === 'drafts' && isBlogAdmin(callerUsername));
  if (!bypassSection) {
    if (section === 'official')  list = list.filter(p => !p.community);
    if (section === 'community') list = list.filter(p => !!p.community);
  }

  const searchQ = typeof q === 'string' ? q.trim().toLowerCase() : '';
  if (searchQ.length >= 2) {
    list = list.filter(p =>
      String(p.title || '').toLowerCase().includes(searchQ) ||
      String(p.body || '').toLowerCase().includes(searchQ)
    );
  }

  if (status === 'drafts' || status === 'hidden') {
    list.sort((a,b) => (b.updatedAt||b.createdAt) - (a.updatedAt||a.createdAt));
  } else if (sort === 'popular') {
    list.sort((a,b) => ((b.views||0)+(b.likes||0)*3) - ((a.views||0)+(a.likes||0)*3));
  } else {
    list.sort((a,b) => b.createdAt - a.createdAt);
  }

  // Статьи забаненных авторов скрыты для всех, кроме самого автора и админов
  list = await moderation.filterVisible(req, list, p => p.author);

  res.json({ posts: list.slice(page*limit, page*limit+limit).map(p => blogSanitize(p,false)), total: list.length });
});


app.get('/api/blog/:id', async (req, res) => {
  const post = blogPosts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Статья не найдена' });

  // Прикрытая статья не видна вообще никому (даже автору и админу) —
  // управление такими статьями идёт только через список "Скрытые".
  if (post.status === 'hidden') return res.status(404).json({ error: 'Статья не найдена' });

  // Статья забаненного автора видна только ему самому и админам
  if (!(await moderation.isAuthorVisible(req, post.author))) return res.status(404).json({ error: 'Статья не найдена' });

  if (post.status !== 'published') {
    let callerUsername = null;
    const auth = getAuthToken(req);
    if (auth) { try { callerUsername = jwt.verify(auth, JWT_SECRET).username.toLowerCase(); } catch {} }
    const canSee = callerUsername && (isBlogAdmin(callerUsername) || post.author.toLowerCase() === callerUsername);
    if (!canSee) return res.status(403).json({ error: 'Черновик' });
  }

  const noview = req.query.noview === '1';
  if (!noview && post.status === 'published') {
    let viewerKey = null;
    const authTok = getAuthToken(req);
    if (authTok) { try { viewerKey = 'u:' + jwt.verify(authTok, JWT_SECRET).username.toLowerCase(); } catch {} }
    if (!viewerKey) { const did = req.deviceId; if (did) viewerKey = 'd:' + did; }
    if (viewerKey) {
      try {
        const ins = await db(`INSERT INTO blog_views (viewer_key,post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [viewerKey, post.id]);
        if (ins.rowCount === 1) {
          post.views = (post.views || 0) + 1;
          if (!post._viewTimer) post._viewTimer = setTimeout(() => { saveBlogPost(post).catch(()=>{}); post._viewTimer=null; }, 5000);
        }
      } catch(e) { console.error('[Blog] view:', e.message); }
    }
  }

  let liked = false;
  const auth = getAuthToken(req);
  if (auth) {
    try {
      const dec = jwt.verify(auth, JWT_SECRET);
      const u = await getUser(dec.username.toLowerCase());
      if (u) { const lr = await db('SELECT 1 FROM blog_likes WHERE user_id=$1 AND post_id=$2',[u.id,post.id]); liked = lr.rows.length>0; }
    } catch {}
  }

  res.json({ ...blogSanitize(post,true), liked });
});


app.post('/api/blog', blogAuthMiddleware, rateLimit(limiterStrict), async (req, res) => {
  let { title, body, status, encoding } = req.body;
  title = decodeBlogField(title, encoding);
  body  = decodeBlogField(body, encoding);
  if (!title || !title.trim()) return res.status(400).json({ error: 'Укажите заголовок' });
  if (!body  || !body.trim())  return res.status(400).json({ error: 'Укажите текст' });
  if (title.length > 200)      return res.status(400).json({ error: 'Заголовок слишком длинный (макс 200)' });
  if (body.length > 100000)    return res.status(400).json({ error: 'Текст слишком длинный (макс 100 000 символов)' });

  const user = await getUser(req.blogUser.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.banned) return res.status(403).json({ error: 'Заблокированные пользователи не могут создавать статьи' });

  const isAdmin = isBlogAdmin(user.username);

  if (!isAdmin) {
    const dayStart = new Date(); dayStart.setHours(0,0,0,0);
    const todayCount = blogPosts.filter(p => p.author.toLowerCase() === user.username.toLowerCase() && p.createdAt >= dayStart.getTime()).length;
    if (todayCount >= 1) return res.status(429).json({ error: 'Можно публиковать не более 1 статьи в день. Попробуйте завтра!' });
  }

  const community = !isAdmin;
  const postStatus = ['published','draft'].includes(status) ? status : 'draft';
  const post = { id: uuidv4(), title: title.trim(), body: body.trim(), author: user.username,
    status: postStatus, views: 0, likes: 0, likedBy: [], community, createdAt: Date.now(), updatedAt: null };
  blogPosts.unshift(post);
  await saveBlogPost(post);
  res.json(blogSanitize(post, true));
});


app.patch('/api/blog/:id', blogAuthMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const post = blogPosts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Статья не найдена' });
  const caller = req.blogUser.username;
  if (!isBlogAdmin(caller) && post.author.toLowerCase() !== caller.toLowerCase())
    return res.status(403).json({ error: 'Нет доступа' });
  { const cu = await getUser(caller.toLowerCase()); if (cu && cu.banned && !isBlogAdmin(caller)) return res.status(403).json({ error: 'Заблокированные не могут редактировать статьи' }); }
  let { title, body, status, encoding } = req.body;
  title = decodeBlogField(title, encoding);
  body  = decodeBlogField(body, encoding);
  if (title !== undefined) { if (!title.trim()) return res.status(400).json({ error: 'Заголовок не может быть пустым' }); post.title = title.trim().slice(0,200); }
  if (body  !== undefined) { if (!body.trim())  return res.status(400).json({ error: 'Текст не может быть пустым' }); post.body = body.trim().slice(0,100000); }
  if (status !== undefined && ['published','draft','hidden'].includes(status)) {
    // Прикрывать статью и возвращать её обратно может только администратор.
    if ((status === 'hidden' || post.status === 'hidden') && !isBlogAdmin(caller))
      return res.status(403).json({ error: 'Скрывать и восстанавливать статьи может только администратор' });
    post.status = status;
  }
  post.updatedAt = Date.now();
  await saveBlogPost(post);
  res.json(blogSanitize(post, true));
});

// Некоторые хостинги/прокси режут метод DELETE (запрос не долетает до Express
// и в ответ прилетает HTML-страница ошибки вместо JSON — отсюда и
// "JSON.parse: unexpected character..."). Даём POST-дублёр на всякий случай,
// как уже сделано для /api/admin/chat и /api/admin/puzzles.
app.delete('/api/blog/:id', blogAuthMiddleware, handleDeleteBlogPost);

app.post('/api/blog/:id/delete', blogAuthMiddleware, handleDeleteBlogPost);


app.post('/api/blog/:id/like', blogAuthMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const post = blogPosts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Статья не найдена' });
  if (post.status !== 'published') return res.status(400).json({ error: 'Нельзя лайкнуть черновик' });
  const user = await getUser(req.blogUser.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.banned) return res.status(403).json({ error: 'Заблокированные не могут ставить лайки' });
  const { unlike } = req.body;
  const existing = await db('SELECT 1 FROM blog_likes WHERE user_id=$1 AND post_id=$2',[user.id,post.id]);
  if (unlike) {
    if (existing.rows.length > 0) {
      await db('DELETE FROM blog_likes WHERE user_id=$1 AND post_id=$2',[user.id,post.id]);
      post.likes = Math.max(0,(post.likes||1)-1);
    }
  } else {
    if (existing.rows.length === 0) {
      await db('INSERT INTO blog_likes (user_id,post_id) VALUES ($1,$2)',[user.id,post.id]);
      post.likes = (post.likes||0)+1;
    }
  }
  if (!post._lstTimer) post._lstTimer = setTimeout(()=>{ saveBlogPost(post).catch(()=>{}); post._lstTimer=null; },5000);
  res.json({ likes: post.likes, liked: !unlike });
});


app.get('/blog/:id/comments', (req, res) => {
  const post = blogPosts.find(p => p.id === req.params.id);
  if (!post || post.status === 'hidden') return res.redirect('/404.html');
  res.sendFile(path.join(__dirname, '../public/blog.html'));
});


app.get('/api/blog/:id/comments', async (req, res) => {
  const post = blogPosts.find(p => p.id === req.params.id);
  if (!post || post.status !== 'published') return res.status(404).json({ error: 'Статья не найдена' });

  let callerUsername = null;
  const auth = getAuthToken(req);
  if (auth) { try { callerUsername = jwt.verify(auth,JWT_SECRET).username.toLowerCase(); } catch {} }

  const r = await db('SELECT * FROM blog_comments WHERE post_id=$1 ORDER BY created_at ASC',[req.params.id]);
  const commentIds = r.rows.map(c => c.id);
  let reactions = [];
  if (commentIds.length > 0) {
    const phs = commentIds.map((_,i)=>`$${i+1}`).join(',');
    const rr = await db(`SELECT * FROM blog_comment_reactions WHERE comment_id IN (${phs})`,commentIds);
    reactions = rr.rows;
  }

  let comments = r.rows.map(c => {
    const myReaction = callerUsername ? reactions.find(rr => rr.comment_id===c.id && rr.user_id===callerUsername) : null;
    const reactionMap = {};
    for (const rr of reactions.filter(rr=>rr.comment_id===c.id)) {
      reactionMap[rr.emoji] = (reactionMap[rr.emoji]||0)+1;
    }
    return {
      id: c.id, postId: c.post_id, author: c.author,
      body: c.deleted ? null : c.body,
      deleted: c.deleted, deletedBy: c.deleted_by || null,
      createdAt: Number(c.created_at),
      editCount: Number(c.edit_count || 0),
      editedAt: c.edited_at ? Number(c.edited_at) : null,
      reactions: reactionMap,
      myReaction: myReaction?.emoji || null,
    };
  });

  comments = await moderation.filterVisible(req, comments, c => c.author);

  let myBan = null;
  if (callerUsername) myBan = await getCommentBan(req.params.id, callerUsername);

  res.json({ comments, count: comments.length, myBan: myBan ? { type: myBan.type, until: myBan.until ? Number(myBan.until) : null } : null });
});


app.post('/api/blog/:id/comments', blogAuthMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const post = blogPosts.find(p => p.id === req.params.id);
  if (!post || post.status !== 'published') return res.status(404).json({ error: 'Статья не найдена' });

  const user = await getUser(req.blogUser.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  // Забаненному не сообщаем: комментарий публикуется, но виден только ему (см. GET)

  const ban = await getCommentBan(req.params.id, user.username);
  if (ban) {
    if (ban.type === 'ban') return res.status(403).json({ error: 'Вы заблокированы в комментариях этого блога' });
    const until = Number(ban.until);
    if (until > Date.now()) {
      const mins = Math.ceil((until - Date.now())/60000);
      return res.status(403).json({ error: `Вы замьючены. Осталось ${mins} мин.`, until });
    }
  }

  const body = (req.body.body || '').toString().trim();
  if (!body) return res.status(400).json({ error: 'Пустой комментарий' });
  if (body.length > 4000) return res.status(400).json({ error: 'Максимум 4000 символов' });

  if (!isBlogCommentAdmin(user.username)) {
    const dayStart = new Date(); dayStart.setHours(0,0,0,0);
    const todayCount = await db(`SELECT COUNT(*) AS cnt FROM blog_comments WHERE LOWER(author)=$1 AND created_at>=$2 AND deleted=FALSE`, [user.username.toLowerCase(), dayStart.getTime()]);
    if (Number(todayCount.rows[0]?.cnt || 0) >= 3)
      return res.status(429).json({ error: 'Можно оставить не более 3 комментариев в день. Возвращайтесь завтра!' });
  }

  const ratKey = 'blogcmt_' + user.username.toLowerCase();
  if (!global._blogCmtRate) global._blogCmtRate = new Map();
  const last = global._blogCmtRate.get(ratKey) || 0;
  if (Date.now() - last < 20000) return res.status(429).json({ error: 'Не так быстро! Подождите 20 секунд' });
  global._blogCmtRate.set(ratKey, Date.now());

  moderation.record({ username: user.username, channel: 'blog-comments', text: body });
  const id = uuidv4();
  const createdAt = Date.now();
  await db('INSERT INTO blog_comments (id,post_id,author,body,created_at,deleted,edit_count) VALUES ($1,$2,$3,$4,$5,FALSE,0)', [id, req.params.id, user.username, body, createdAt]);

  res.json({ ok: true, comment: {
    id, postId: req.params.id, author: user.username,
    body, deleted: false, deletedBy: null, createdAt,
    editCount: 0, editedAt: null, reactions: {}, myReaction: null,
  }});
});

app.delete('/api/blog/:id/comments/:cid', blogAuthMiddleware, handleDeleteBlogComment);

app.post('/api/blog/:id/comments/:cid/delete', blogAuthMiddleware, handleDeleteBlogComment);


app.patch('/api/blog/:id/comments/:cid', blogAuthMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const user = await getUser(req.blogUser.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.banned) return res.status(403).json({ error: 'Вы заблокированы' });

  const r = await db('SELECT * FROM blog_comments WHERE id=$1 AND post_id=$2',[req.params.cid,req.params.id]);
  const comment = r.rows[0];
  if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });
  if (comment.deleted) return res.status(400).json({ error: 'Нельзя редактировать удалённый комментарий' });

  const isAuthor = comment.author.toLowerCase() === user.username.toLowerCase();
  const isAdmin  = isBlogCommentAdmin(user.username);
  if (!isAuthor && !isAdmin) return res.status(403).json({ error: 'Нет прав' });

  const editCount = Number(comment.edit_count || 0);
  if (!isAdmin && editCount >= 2)
    return res.status(403).json({ error: 'Комментарий можно редактировать не более 2 раз' });

  const body = (req.body.body || '').toString().trim();
  if (!body) return res.status(400).json({ error: 'Текст не может быть пустым' });
  if (body.length > 4000) return res.status(400).json({ error: 'Максимум 4000 символов' });

  const newEditCount = editCount + 1;
  const editedAt = Date.now();
  await db('UPDATE blog_comments SET body=$1, edit_count=$2, edited_at=$3 WHERE id=$4', [body, newEditCount, editedAt, req.params.cid]);

  res.json({ ok: true, body, editCount: newEditCount, editedAt });
});


app.post('/api/blog/:id/comments/:cid/react', blogAuthMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const user = await getUser(req.blogUser.username.toLowerCase());
  if (!user || user.banned) return res.status(403).json({ error: 'Нет доступа' });

  const r = await db('SELECT id,deleted FROM blog_comments WHERE id=$1 AND post_id=$2',[req.params.cid,req.params.id]);
  if (!r.rows[0] || r.rows[0].deleted) return res.status(404).json({ error: 'Комментарий не найден' });

  const ALLOWED_EMOJIS = ['👍','❤️','😂','😮','😢','😡','♟️','👎'];
  const { emoji } = req.body;
  if (!emoji) {
    await db('DELETE FROM blog_comment_reactions WHERE comment_id=$1 AND user_id=$2',[req.params.cid,user.username.toLowerCase()]);
    const rr = await db('SELECT emoji, COUNT(*) as cnt FROM blog_comment_reactions WHERE comment_id=$1 GROUP BY emoji',[req.params.cid]);
    const reactions = {};
    for (const row of rr.rows) reactions[row.emoji] = Number(row.cnt);
    return res.json({ ok: true, removed: true, reactions, myReaction: null });
  }
  if (!ALLOWED_EMOJIS.includes(emoji)) return res.status(400).json({ error: 'Неверный эмоджи' });

  await db(`INSERT INTO blog_comment_reactions (comment_id,user_id,emoji) VALUES ($1,$2,$3) ON CONFLICT (comment_id,user_id) DO UPDATE SET emoji=$3`, [req.params.cid, user.username.toLowerCase(), emoji]);

  const rr = await db('SELECT emoji, COUNT(*) as cnt FROM blog_comment_reactions WHERE comment_id=$1 GROUP BY emoji',[req.params.cid]);
  const reactions = {};
  for (const row of rr.rows) reactions[row.emoji] = Number(row.cnt);
  res.json({ ok: true, reactions, myReaction: emoji });
});


app.post('/api/blog/:id/comments/mod', blogAuthMiddleware, async (req, res) => {
  const user = await getUser(req.blogUser.username.toLowerCase());
  if (!user || !isBlogCommentAdmin(user.username)) return res.status(403).json({ error: 'Нет прав' });

  const { action, username, global: isGlobal } = req.body;
  if (!action || !username) return res.status(400).json({ error: 'Укажите action и username' });
  const target = username.toLowerCase();
  if (isBlogCommentAdmin(target)) return res.status(403).json({ error: 'Нельзя банить администратора' });

  if (action === 'unban') {
    if (isGlobal) await db('DELETE FROM blog_global_comment_bans WHERE username=$1',[target]);
    else await db('DELETE FROM blog_comment_bans WHERE post_id=$1 AND username=$2',[req.params.id,target]);
    return res.json({ ok: true });
  }

  const type = action === 'ban' ? 'ban' : 'mute';
  const until = type === 'mute' ? Date.now() + 60*60*1000 : null;
  const createdAt = Date.now();

  if (isGlobal) {
    await db(`INSERT INTO blog_global_comment_bans (username,type,until,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO UPDATE SET type=$2,until=$3,created_at=$4`, [target,type,until,createdAt]);
  } else {
    await db(`INSERT INTO blog_comment_bans (post_id,username,type,until,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (post_id,username) DO UPDATE SET type=$3,until=$4,created_at=$5`, [req.params.id,target,type,until,createdAt]);
  }
  res.json({ ok: true, type, until, global: !!isGlobal });
});


// ── Список новостей / статья ─────────────────────────────────

// ── Blog API ──────────────────────────────────────────────────
function blogAuthMiddleware(req, res, next) {
  const auth = getAuthToken(req);
  if (!auth) return res.status(401).json({ error: 'Войдите, чтобы выполнить это действие' });
  try { req.blogUser = jwt.verify(auth, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Неверный токен' }); }
}

function blogSanitize(post, withBody) {
  const o = { id: post.id, title: post.title, author: post.author, status: post.status,
    views: post.views || 0, likes: post.likes || 0,
    community: !!post.community,
    createdAt: post.createdAt, updatedAt: post.updatedAt || null };
  if (withBody) o.body = post.body;
  return o;
}


async function handleDeleteBlogPost(req, res) {
  const idx = blogPosts.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Статья не найдена' });
  const post = blogPosts[idx];
  const caller = req.blogUser.username;
  if (!isBlogAdmin(caller) && post.author.toLowerCase() !== caller.toLowerCase())
    return res.status(403).json({ error: 'Нет доступа' });
  // Отменяем отложенные таймеры сохранения просмотров/лайков (см. комментарий
  // в saveBlogPost) — иначе они всплывут через 5 секунд ПОСЛЕ удаления и
  // заново вставят уже удалённую статью в БД.
  if (post._viewTimer) { clearTimeout(post._viewTimer); post._viewTimer = null; }
  if (post._lstTimer)  { clearTimeout(post._lstTimer);  post._lstTimer  = null; }
  post._deleted = true;
  blogPosts.splice(idx, 1);
  await deleteBlogPost(post.id);
  await db('DELETE FROM blog_likes WHERE post_id=$1',[post.id]).catch(()=>{});
  await db('DELETE FROM blog_views WHERE post_id=$1',[post.id]).catch(()=>{});
  res.json({ ok: true });
}


// ══════════════════════════════════════════════════════════════
//  BLOG COMMENTS API
// ══════════════════════════════════════════════════════════════

function isBlogCommentAdmin(username) {
  return isSiteAdmin(username);
}


async function getCommentBan(postId, username) {
  const uname = username.toLowerCase();
  const glob = await db('SELECT * FROM blog_global_comment_bans WHERE username=$1',[uname]);
  if (glob.rows[0]) {
    const r = glob.rows[0];
    if (r.type === 'ban' || (r.until && Number(r.until) > Date.now())) return r;
    await db('DELETE FROM blog_global_comment_bans WHERE username=$1',[uname]).catch(()=>{});
  }
  const local = await db('SELECT * FROM blog_comment_bans WHERE post_id=$1 AND username=$2',[postId,uname]);
  if (local.rows[0]) {
    const r = local.rows[0];
    if (r.type === 'ban' || (r.until && Number(r.until) > Date.now())) return r;
    await db('DELETE FROM blog_comment_bans WHERE post_id=$1 AND username=$2',[postId,uname]).catch(()=>{});
  }
  return null;
}


async function handleDeleteBlogComment(req, res) {
  const user = await getUser(req.blogUser.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const r = await db('SELECT * FROM blog_comments WHERE id=$1 AND post_id=$2',[req.params.cid,req.params.id]);
  const comment = r.rows[0];
  if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });

  const isAdmin = isBlogCommentAdmin(user.username);
  const isAuthor = comment.author.toLowerCase() === user.username.toLowerCase();
  if (!isAdmin && !isAuthor) return res.status(403).json({ error: 'Нет прав' });

  const deletedBy = isAdmin && !isAuthor ? user.username : null;
  await db('UPDATE blog_comments SET deleted=TRUE, deleted_by=$1 WHERE id=$2',[deletedBy, req.params.cid]);
  res.json({ ok: true, deletedBy });
}
};
