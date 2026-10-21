// ═══════════════════════════════════════════════════════════════
//  routes/follow.js — подписки
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  db,
  app,
  getUser,
  onlineUsers,
  authMiddleware,
} = require('../core');

module.exports = function register(app) {
app.post('/api/follow/:username', authMiddleware, async (req, res) => {
  try {
    const target = await getUser(req.params.username.toLowerCase());
    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    const follower = req.user.username;
    const following = target.username; // канонический регистр ника из БД
    if (follower.toLowerCase() === following.toLowerCase()) return res.status(400).json({ error: 'Нельзя подписаться на себя' });
    await db(`INSERT INTO follows (follower, following, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [follower, following, Date.now()]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Follow]', e);
    res.status(500).json({ error: 'Ошибка подписки' });
  }
});

// DELETE — основной вариант, POST — резервный (на случай, если хостинг/прокси
// блокирует метод DELETE — именно это похоже на причину "кнопка не работает").
app.delete('/api/follow/:username', authMiddleware, handleUnfollow);

app.post('/api/follow/:username/unfollow', authMiddleware, handleUnfollow);


app.get('/api/follow/check/:username', authMiddleware, async (req, res) => {
  try {
    const target = await getUser(req.params.username.toLowerCase());
    const follower = req.user.username;
    const following = target ? target.username : req.params.username;
    const r = await db(`SELECT 1 FROM follows WHERE follower = $1 AND following = $2`, [follower, following]);
    res.json({ following: r.rows.length > 0 });
  } catch (e) {
    console.error('[FollowCheck]', e);
    res.status(500).json({ error: 'Ошибка проверки подписки' });
  }
});


app.get('/api/follow/counts/:username', async (req, res) => {
  const username = req.params.username;
  const followers = await db(`SELECT COUNT(*) FROM follows WHERE following = $1`, [username]);
  const following = await db(`SELECT COUNT(*) FROM follows WHERE follower = $1`, [username]);
  res.json({ followers: parseInt(followers.rows[0].count), following: parseInt(following.rows[0].count) });
});


app.get('/api/follow/followers/:username', async (req, res) => {
  const username = req.params.username;
  const r = await db(`SELECT follower FROM follows WHERE following = $1 ORDER BY created_at DESC`, [username]);
  const users = [];
  for (const row of r.rows) {
    const u = await getUser(row.follower.toLowerCase());
    if (u) users.push({ username: u.username, online: onlineUsers.has(u.username), rating: u.rating });
  }
  res.json(users);
});


app.get('/api/follow/following/:username', async (req, res) => {
  const username = req.params.username;
  const r = await db(`SELECT following FROM follows WHERE follower = $1 ORDER BY created_at DESC`, [username]);
  const users = [];
  for (const row of r.rows) {
    const u = await getUser(row.following.toLowerCase());
    if (u) users.push({ username: u.username, online: onlineUsers.has(u.username), rating: u.rating });
  }
  res.json(users);
});


app.get('/api/follow/online-friends', authMiddleware, async (req, res) => {
  const me = req.user.username;
  const r = await db(`SELECT following FROM follows WHERE follower = $1`, [me]);
  const online = [];
  for (const row of r.rows) {
    const u = await getUser(row.following.toLowerCase());
    if (u && onlineUsers.has(u.username)) {
      online.push({ username: u.username, rating: u.rating });
    }
  }
  res.json(online);
});



async function handleUnfollow(req, res) {
  try {
    const target = await getUser(req.params.username.toLowerCase());
    const follower = req.user.username;
    const following = target ? target.username : req.params.username;
    await db(`DELETE FROM follows WHERE follower = $1 AND following = $2`, [follower, following]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Unfollow]', e);
    res.status(500).json({ error: 'Ошибка отписки' });
  }
}
};
