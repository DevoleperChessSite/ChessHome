// ═══════════════════════════════════════════════════════════════
//  routes/news.js — новости + загрузка обложек
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  jwt,
  uuidv4,
  path,
  fs,
  db,
  app,
  getAuthToken,
  limiterStrict,
  getUser,
  newsPosts,
  saveNewsPost,
  newsAuthors,
  JWT_SECRET,
  rateLimit,
  NEWS_OWNER_USERNAME,
  isNewsOwner,
} = require('../core');

const {
  decodeBlogField,
} = require('./_shared');

const moderation = require('../moderation');
const multer  = require('multer');   // multipart/form-data для загрузки обложек новостей

module.exports = function register(app) {
app.get('/api/news', (req, res) => {
  const { status, page: pQ, limit: lQ } = req.query;
  const page  = Math.max(0, parseInt(pQ) || 0);
  const limit = Math.min(50, parseInt(lQ) || 20);

  let callerUsername = null;
  const auth = getAuthToken(req);
  if (auth) { try { callerUsername = jwt.verify(auth, JWT_SECRET).username.toLowerCase(); } catch {} }

  let list = newsPosts.filter(p => {
    if (p.status === 'hidden') {
      // Список прикрытых новостей виден только владельцу и только когда
      // он явно его запросил (вкладка "Скрытые").
      return status === 'hidden' && isNewsOwner(callerUsername);
    }
    if (status === 'hidden') return false;
    if (p.status !== 'published') {
      if (!callerUsername) return false;
      if (!isNewsOwner(callerUsername) && p.author.toLowerCase() !== callerUsername) return false;
      return status === 'drafts';
    }
    return status !== 'drafts';
  });

  if (status === 'drafts' || status === 'hidden') list.sort((a,b) => (b.updatedAt||b.createdAt) - (a.updatedAt||a.createdAt));
  else list.sort((a,b) => b.createdAt - a.createdAt);

  res.json({ posts: list.slice(page*limit, page*limit+limit).map(p => newsSanitize(p,false)), total: list.length });
});


app.get('/api/news/:id', async (req, res) => {
  const post = newsPosts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Новость не найдена' });

  // Прикрытая новость не видна вообще никому (даже автору и владельцу) —
  // управление такими новостями идёт только через список "Скрытые".
  if (post.status === 'hidden') return res.status(404).json({ error: 'Новость не найдена' });

  let callerUsername = null;
  const auth = getAuthToken(req);
  if (auth) { try { callerUsername = jwt.verify(auth, JWT_SECRET).username.toLowerCase(); } catch {} }

  if (post.status !== 'published') {
    const canSee = callerUsername && (isNewsOwner(callerUsername) || post.author.toLowerCase() === callerUsername);
    if (!canSee) return res.status(403).json({ error: 'Черновик' });
  }

  const noview = req.query.noview === '1';
  if (!noview && post.status === 'published') {
    let viewerKey = callerUsername ? 'u:' + callerUsername : null;
    if (!viewerKey) { const did = req.deviceId; if (did) viewerKey = 'd:' + did; }
    if (viewerKey) {
      try {
        const ins = await db(`INSERT INTO news_views (viewer_key,post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [viewerKey, post.id]);
        if (ins.rowCount === 1) {
          post.views = (post.views || 0) + 1;
          if (!post._viewTimer) post._viewTimer = setTimeout(() => { saveNewsPost(post).catch(()=>{}); post._viewTimer=null; }, 5000);
        }
      } catch(e) { console.error('[News] view:', e.message); }
    }
  }

  let liked = false, disliked = false;
  if (callerUsername) {
    const u = await getUser(callerUsername);
    if (u) {
      const [lr, dr] = await Promise.all([
        db('SELECT 1 FROM news_likes WHERE user_id=$1 AND post_id=$2',[u.id,post.id]),
        db('SELECT 1 FROM news_dislikes WHERE user_id=$1 AND post_id=$2',[u.id,post.id]),
      ]);
      liked = lr.rows.length>0; disliked = dr.rows.length>0;
    }
  }

  res.json({ ...newsSanitize(post,true), liked, disliked });
});


app.post('/api/news', newsAuthMiddleware, rateLimit(limiterStrict), async (req, res) => {
  if (!isNewsAuthorUser(req.newsUser.username)) return res.status(403).json({ error: 'Только авторы новостей могут писать статьи' });

  let { title, body, cover, status, encoding } = req.body;
  title = decodeBlogField(title, encoding);
  body  = decodeBlogField(body, encoding);
  if (!title || !title.trim()) return res.status(400).json({ error: 'Укажите заголовок' });
  if (!body  || !body.trim())  return res.status(400).json({ error: 'Укажите текст' });
  if (title.length > 200)      return res.status(400).json({ error: 'Заголовок слишком длинный (макс 200)' });
  if (body.length > 100000)    return res.status(400).json({ error: 'Текст слишком длинный (макс 100 000 символов)' });
  if (cover !== undefined && cover !== null && (typeof cover !== 'string' || cover.length > 500))
    return res.status(400).json({ error: 'Некорректная обложка' });

  const user = await getUser(req.newsUser.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.banned) return res.status(403).json({ error: 'Заблокированные пользователи не могут создавать новости' });

  const postStatus = ['published','draft'].includes(status) ? status : 'draft';
  const post = { id: uuidv4(), title: title.trim(), body: body.trim(), author: user.username,
    status: postStatus, views: 0, likes: 0, dislikes: 0, cover: cover || '', createdAt: Date.now(), updatedAt: null };
  newsPosts.unshift(post);
  await saveNewsPost(post);
  res.json(newsSanitize(post, true));
});


app.patch('/api/news/:id', newsAuthMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const post = newsPosts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Новость не найдена' });
  const caller = req.newsUser.username;
  if (!isNewsOwner(caller) && post.author.toLowerCase() !== caller.toLowerCase())
    return res.status(403).json({ error: 'Нет доступа' });

  let { title, body, cover, status, encoding } = req.body;
  title = decodeBlogField(title, encoding);
  body  = decodeBlogField(body, encoding);
  if (title !== undefined) { if (!title.trim()) return res.status(400).json({ error: 'Заголовок не может быть пустым' }); post.title = title.trim().slice(0,200); }
  if (body  !== undefined) { if (!body.trim())  return res.status(400).json({ error: 'Текст не может быть пустым' }); post.body = body.trim().slice(0,100000); }
  if (cover !== undefined) { post.cover = (typeof cover === 'string' ? cover.slice(0,500) : ''); }
  if (status !== undefined && ['published','draft','hidden'].includes(status)) {
    // Прикрывать новость и возвращать её обратно может только владелец.
    if ((status === 'hidden' || post.status === 'hidden') && !isNewsOwner(caller))
      return res.status(403).json({ error: 'Скрывать и восстанавливать новости может только владелец' });
    post.status = status;
  }
  post.updatedAt = Date.now();
  await saveNewsPost(post);
  res.json(newsSanitize(post, true));
});

app.delete('/api/news/:id', newsAuthMiddleware, handleDeleteNewsPost);

app.post('/api/news/:id/delete', newsAuthMiddleware, handleDeleteNewsPost);


// ── Лайк / дизлайк (взаимоисключающие) ───────────────────────
app.post('/api/news/:id/like', newsAuthMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const post = newsPosts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Новость не найдена' });
  if (post.status !== 'published') return res.status(400).json({ error: 'Нельзя оценить черновик' });
  const user = await getUser(req.newsUser.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.banned) return res.status(403).json({ error: 'Заблокированные не могут ставить оценки' });

  const { unlike } = req.body;
  const existingLike = await db('SELECT 1 FROM news_likes WHERE user_id=$1 AND post_id=$2',[user.id,post.id]);
  if (unlike) {
    if (existingLike.rows.length > 0) {
      await db('DELETE FROM news_likes WHERE user_id=$1 AND post_id=$2',[user.id,post.id]);
      post.likes = Math.max(0,(post.likes||1)-1);
    }
  } else if (existingLike.rows.length === 0) {
    await db('INSERT INTO news_likes (user_id,post_id) VALUES ($1,$2)',[user.id,post.id]);
    post.likes = (post.likes||0)+1;
    const existingDislike = await db('SELECT 1 FROM news_dislikes WHERE user_id=$1 AND post_id=$2',[user.id,post.id]);
    if (existingDislike.rows.length > 0) {
      await db('DELETE FROM news_dislikes WHERE user_id=$1 AND post_id=$2',[user.id,post.id]);
      post.dislikes = Math.max(0,(post.dislikes||1)-1);
    }
  }
  if (!post._lstTimer) post._lstTimer = setTimeout(()=>{ saveNewsPost(post).catch(()=>{}); post._lstTimer=null; },5000);
  res.json({ likes: post.likes, dislikes: post.dislikes, liked: !unlike, disliked: false });
});


app.post('/api/news/:id/dislike', newsAuthMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const post = newsPosts.find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Новость не найдена' });
  if (post.status !== 'published') return res.status(400).json({ error: 'Нельзя оценить черновик' });
  const user = await getUser(req.newsUser.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.banned) return res.status(403).json({ error: 'Заблокированные не могут ставить оценки' });

  const { undislike } = req.body;
  const existingDislike = await db('SELECT 1 FROM news_dislikes WHERE user_id=$1 AND post_id=$2',[user.id,post.id]);
  if (undislike) {
    if (existingDislike.rows.length > 0) {
      await db('DELETE FROM news_dislikes WHERE user_id=$1 AND post_id=$2',[user.id,post.id]);
      post.dislikes = Math.max(0,(post.dislikes||1)-1);
    }
  } else if (existingDislike.rows.length === 0) {
    await db('INSERT INTO news_dislikes (user_id,post_id) VALUES ($1,$2)',[user.id,post.id]);
    post.dislikes = (post.dislikes||0)+1;
    const existingLike = await db('SELECT 1 FROM news_likes WHERE user_id=$1 AND post_id=$2',[user.id,post.id]);
    if (existingLike.rows.length > 0) {
      await db('DELETE FROM news_likes WHERE user_id=$1 AND post_id=$2',[user.id,post.id]);
      post.likes = Math.max(0,(post.likes||1)-1);
    }
  }
  if (!post._lstTimer) post._lstTimer = setTimeout(()=>{ saveNewsPost(post).catch(()=>{}); post._lstTimer=null; },5000);
  res.json({ likes: post.likes, dislikes: post.dislikes, liked: false, disliked: !undislike });
});


// ── Авторы новостей (владелец) ───────────────────────────────
app.get('/api/news/authors', (req, res) => {
  res.json({ owner: NEWS_OWNER_USERNAME, authors: newsAuthors });
});


app.post('/api/news/authors', newsAuthMiddleware, async (req, res) => {
  if (!isNewsOwner(req.newsUser.username)) return res.status(403).json({ error: 'Только владелец может назначать авторов' });
  const { username } = req.body;
  if (!username || !username.trim()) return res.status(400).json({ error: 'Укажите никнейм' });
  const target = await getUser(username.trim().toLowerCase());
  if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
  if (isNewsOwner(target.username)) return res.status(400).json({ error: 'Владелец и так может публиковать новости' });
  if (newsAuthors.some(a => a.toLowerCase() === target.username.toLowerCase()))
    return res.status(400).json({ error: 'Этот пользователь уже автор новостей' });

  await db(`INSERT INTO news_authors (username,username_low,created_at) VALUES ($1,$2,$3) ON CONFLICT (username_low) DO NOTHING`, [target.username, target.username.toLowerCase(), Date.now()]);
  newsAuthors.push(target.username);
  res.json({ ok: true, authors: newsAuthors });
});


app.post('/api/news/authors/remove', newsAuthMiddleware, async (req, res) => {
  if (!isNewsOwner(req.newsUser.username)) return res.status(403).json({ error: 'Только владелец может снимать авторов' });
  const { username } = req.body;
  if (!username || !username.trim()) return res.status(400).json({ error: 'Укажите никнейм' });
  const low = username.trim().toLowerCase();
  await db('DELETE FROM news_authors WHERE username_low=$1',[low]);
  for (let i = newsAuthors.length - 1; i >= 0; i--) {
    if (newsAuthors[i].toLowerCase() === low) newsAuthors.splice(i, 1);
  }
  res.json({ ok: true, authors: newsAuthors });
});


app.get('/api/news/:id/comments', async (req, res) => {
  const post = newsPosts.find(p => p.id === req.params.id);
  if (!post || post.status !== 'published') return res.status(404).json({ error: 'Новость не найдена' });

  let callerUsername = null;
  const auth = getAuthToken(req);
  if (auth) { try { callerUsername = jwt.verify(auth,JWT_SECRET).username.toLowerCase(); } catch {} }

  const r = await db('SELECT * FROM news_comments WHERE post_id=$1 ORDER BY created_at ASC',[req.params.id]);
  let comments = r.rows.map(c => ({
    id: c.id, postId: c.post_id, author: c.author,
    body: c.deleted ? null : c.body,
    deleted: c.deleted, deletedBy: c.deleted_by || null,
    createdAt: Number(c.created_at),
  }));
  comments = await moderation.filterVisible(req, comments, c => c.author);

  let myBan = null;
  if (callerUsername) {
    const mute = await getNewsCommentMute(req.params.id, callerUsername);
    if (mute) myBan = { type: 'mute', until: Number(mute.until) };
  }

  res.json({ comments, count: comments.length, myBan });
});


app.post('/api/news/:id/comments', newsAuthMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const post = newsPosts.find(p => p.id === req.params.id);
  if (!post || post.status !== 'published') return res.status(404).json({ error: 'Новость не найдена' });

  const user = await getUser(req.newsUser.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  // Забаненному не сообщаем: комментарий публикуется, но виден только ему (см. GET)

  const mute = await getNewsCommentMute(req.params.id, user.username);
  if (mute) {
    const mins = Math.ceil((Number(mute.until) - Date.now())/60000);
    return res.status(403).json({ error: `Вы замьючены. Осталось ${mins} мин.`, until: Number(mute.until) });
  }

  const body = (req.body.body || '').toString().trim();
  if (!body) return res.status(400).json({ error: 'Пустой комментарий' });
  if (body.length > 4000) return res.status(400).json({ error: 'Максимум 4000 символов' });

  if (!isNewsOwner(user.username)) {
    const dayStart = new Date(); dayStart.setHours(0,0,0,0);
    const todayCount = await db(`SELECT COUNT(*) AS cnt FROM news_comments WHERE LOWER(author)=$1 AND created_at>=$2 AND deleted=FALSE`, [user.username.toLowerCase(), dayStart.getTime()]);
    if (Number(todayCount.rows[0]?.cnt || 0) >= 10)
      return res.status(429).json({ error: 'Можно оставить не более 10 комментариев в день. Возвращайтесь завтра!' });
  }

  const ratKey = 'newscmt_' + user.username.toLowerCase();
  if (!global._newsCmtRate) global._newsCmtRate = new Map();
  const last = global._newsCmtRate.get(ratKey) || 0;
  if (Date.now() - last < 20000) return res.status(429).json({ error: 'Не так быстро! Подождите 20 секунд' });
  global._newsCmtRate.set(ratKey, Date.now());

  moderation.record({ username: user.username, channel: 'news-comments', text: body });
  const id = uuidv4();
  const createdAt = Date.now();
  await db('INSERT INTO news_comments (id,post_id,author,body,created_at,deleted) VALUES ($1,$2,$3,$4,$5,FALSE)', [id, req.params.id, user.username, body, createdAt]);

  res.json({ ok: true, comment: {
    id, postId: req.params.id, author: user.username,
    body, deleted: false, deletedBy: null, createdAt,
  }});
});

app.delete('/api/news/:id/comments/:cid', newsAuthMiddleware, handleDeleteNewsComment);

app.post('/api/news/:id/comments/:cid/delete', newsAuthMiddleware, handleDeleteNewsComment);


app.post('/api/news/:id/comments/mod', newsAuthMiddleware, async (req, res) => {
  const user = await getUser(req.newsUser.username.toLowerCase());
  if (!user || !isNewsOwner(user.username)) return res.status(403).json({ error: 'Нет прав' });

  const { action, username } = req.body;
  if (!action || !username) return res.status(400).json({ error: 'Укажите action и username' });
  const target = username.toLowerCase();
  if (isNewsOwner(target)) return res.status(403).json({ error: 'Нельзя замьютить владельца' });

  if (action === 'unmute') {
    await db('DELETE FROM news_comment_mutes WHERE post_id=$1 AND username=$2',[req.params.id,target]);
    return res.json({ ok: true });
  }
  if (action !== 'mute') return res.status(400).json({ error: 'Неверное действие' });

  const until = Date.now() + 60*60*1000;
  const createdAt = Date.now();
  await db(`INSERT INTO news_comment_mutes (post_id,username,until,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (post_id,username) DO UPDATE SET until=$3,created_at=$4`, [req.params.id,target,until,createdAt]);
  res.json({ ok: true, type: 'mute', until });
});


app.post('/api/upload', newsAuthMiddleware, rateLimit(limiterStrict), (req, res) => {
  if (!isNewsAuthorUser(req.newsUser.username)) return res.status(403).json({ error: 'Только авторы новостей могут загружать изображения' });
  uploadImage.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не удалось загрузить файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не передан' });
    const fd = fs.openSync(req.file.path, 'r');
    const buf = Buffer.alloc(16);
    let read = 0;
    try { read = fs.readSync(fd, buf, 0, 16, 0); } finally { fs.closeSync(fd); }
    const sniffed = sniffImageMime(buf.subarray(0, read));
    if (!sniffed) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Файл не является изображением' });
    }
    res.json({ url: '/uploads/' + req.file.filename });
  });
});


// ── Clubs API ─────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════
//  NEWS API
//  Контракт см. в комментарии наверху public/news.html.
//  В отличие от блога, публиковать новости может не любой юзер, а
//  только авторы, назначенные владельцем (username 'chesshome').
// ══════════════════════════════════════════════════════════════
function newsAuthMiddleware(req, res, next) {
  const auth = getAuthToken(req);
  if (!auth) return res.status(401).json({ error: 'Войдите, чтобы выполнить это действие' });
  try { req.newsUser = jwt.verify(auth, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Неверный токен' }); }
}

function isNewsAuthorUser(username) {
  if (!username) return false;
  if (isNewsOwner(username)) return true;
  const low = username.toLowerCase();
  return newsAuthors.some(a => a.toLowerCase() === low);
}


function newsSanitize(post, withBody) {
  const o = { id: post.id, title: post.title, author: post.author, status: post.status,
    cover: post.cover || '', views: post.views || 0, likes: post.likes || 0, dislikes: post.dislikes || 0,
    createdAt: post.createdAt, updatedAt: post.updatedAt || null };
  if (withBody) o.body = post.body;
  return o;
}


async function handleDeleteNewsPost(req, res) {
  const idx = newsPosts.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Новость не найдена' });
  const post = newsPosts[idx];
  const caller = req.newsUser.username;
  if (!isNewsOwner(caller) && post.author.toLowerCase() !== caller.toLowerCase())
    return res.status(403).json({ error: 'Нет доступа' });
  // См. аналогичный комментарий в handleDeleteBlogPost про отложенные таймеры.
  if (post._viewTimer) { clearTimeout(post._viewTimer); post._viewTimer = null; }
  if (post._lstTimer)  { clearTimeout(post._lstTimer);  post._lstTimer  = null; }
  post._deleted = true;
  newsPosts.splice(idx, 1);
  await deleteNewsPost(post.id);
  await db('DELETE FROM news_likes WHERE post_id=$1',[post.id]).catch(()=>{});
  await db('DELETE FROM news_dislikes WHERE post_id=$1',[post.id]).catch(()=>{});
  await db('DELETE FROM news_views WHERE post_id=$1',[post.id]).catch(()=>{});
  await db('DELETE FROM news_comments WHERE post_id=$1',[post.id]).catch(()=>{});
  await db('DELETE FROM news_comment_mutes WHERE post_id=$1',[post.id]).catch(()=>{});
  res.json({ ok: true });
}


// ══════════════════════════════════════════════════════════════
//  NEWS COMMENTS API
// ══════════════════════════════════════════════════════════════
async function getNewsCommentMute(postId, username) {
  const uname = username.toLowerCase();
  const r = await db('SELECT * FROM news_comment_mutes WHERE post_id=$1 AND username=$2',[postId,uname]);
  const row = r.rows[0];
  if (!row) return null;
  if (Number(row.until) > Date.now()) return row;
  await db('DELETE FROM news_comment_mutes WHERE post_id=$1 AND username=$2',[postId,uname]).catch(()=>{});
  return null;
}


async function handleDeleteNewsComment(req, res) {
  const user = await getUser(req.newsUser.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const r = await db('SELECT * FROM news_comments WHERE id=$1 AND post_id=$2',[req.params.cid,req.params.id]);
  const comment = r.rows[0];
  if (!comment) return res.status(404).json({ error: 'Комментарий не найден' });

  const isOwnerCaller = isNewsOwner(user.username);
  const isAuthor = comment.author.toLowerCase() === user.username.toLowerCase();
  if (!isOwnerCaller && !isAuthor) return res.status(403).json({ error: 'Нет прав' });

  const deletedBy = isOwnerCaller && !isAuthor ? user.username : null;
  await db('UPDATE news_comments SET deleted=TRUE, deleted_by=$1 WHERE id=$2',[deletedBy, req.params.cid]);
  res.json({ ok: true, deletedBy });
}


// ── Загрузка изображений (обложки новостей) ──────────────────
const UPLOADS_DIR = path.join(__dirname, '../public/uploads');

try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (e) { console.error('[Upload] Не удалось создать папку uploads:', e.message); }


const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const extByMime = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
    cb(null, `${Date.now()}_${uuidv4()}${extByMime[file.mimetype] || '.bin'}`);
  },
});

// Magic bytes реальных изображений — проверка содержимого, а не декларации клиента.
const IMAGE_MAGIC = [
  { mime: 'image/jpeg', bytes: [0xFF, 0xD8, 0xFF] },
  { mime: 'image/png',  bytes: [0x89, 0x50, 0x4E, 0x47] },
  { mime: 'image/gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] }, // RIFF....WEBP — первые 4 байта + проверка 8-11
];
function sniffImageMime(buf) {
  for (const sig of IMAGE_MAGIC) {
    if (sig.bytes.every((b, i) => buf[i] === b)) {
      if (sig.mime === 'image/webp') {
        // Доп. проверка строки WEBP на смещении 8
        return buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50 ? sig.mime : null;
      }
      return sig.mime;
    }
  }
  return null;
}

const uploadImage = multer({
  storage: uploadStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    if (!/^image\/(jpeg|png|gif|webp)$/.test(file.mimetype)) return cb(new Error('Разрешены только изображения (jpeg, png, gif, webp)'));
    cb(null, true);
  },
});
};
