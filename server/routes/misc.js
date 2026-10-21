// ═══════════════════════════════════════════════════════════════
//  routes/misc.js — лидерборд, онлайн, пинг, вызовы, общий чат (GET)
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  jwt,
  db,
  app,
  getAuthToken,
  usersCache,
  rowToUser,
  isVip,
  getUser,
  globalChat,
  JWT_SECRET,
  onlineUsers,
  pendingChallenges,
  sanitizeUser,
} = require('../core');

module.exports = function register(app) {
app.get('/api/leaderboard', async (req, res) => {
  const r = await db('SELECT * FROM users ORDER BY rating DESC LIMIT 50');
  res.json(r.rows.map(row => ({ ...sanitizeUser(rowToUser(row)), online: onlineUsers.has(row.username) })));
});


app.get('/api/online',       (req, res) => res.json({ count: onlineUsers.size }));

app.all('/api/ping',         (req, res) => res.status(200).end());

app.get('/api/online/users', (req, res) => {
  const list = [...onlineUsers].map(username => {
    const u = usersCache.get(username.toLowerCase());
    return u ? { username: u.username, rating: u.rating, role: u.role || 'user', vip: isVip(u) } : { username, rating: null, role: 'user', vip: false };
  }).sort((a, b) => {
    if (a.role === 'admin' && b.role !== 'admin') return -1;
    if (b.role === 'admin' && a.role !== 'admin') return 1;
    return a.username.localeCompare(b.username);
  });
  res.json(list);
});


// ──────────────────────────────────────────────────────────────
//  QUESTS API (Сезон 2)
// ──────────────────────────────────────────────────────────────


app.get('/api/challenges', (req, res) => res.json(pendingChallenges.filter(c => Date.now() - c.createdAt < 60000)));

app.get('/api/chat', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const auth = getAuthToken(req);
  let callerUsername = null;
  if (auth) { try { callerUsername = jwt.verify(auth, JWT_SECRET).username.toLowerCase(); } catch {} }
  let isAdmin = false;
  if (callerUsername) {
    const caller = await getUser(callerUsername);
    isAdmin = caller?.role === 'admin';
  }
  // Сообщения теневого бана видит только сам автор и админы — для всех
  // остальных они как будто никогда не отправлялись (см. socket-хендлер
  // global_chat в sockets.js).
  const visible = globalChat.filter(m => {
    if (!m.shadowHidden) return true;
    return isAdmin || (callerUsername && callerUsername === m.username.toLowerCase());
  });
  res.json(visible.slice(-limit));
});


// ── Admin API ─────────────────────────────────────────────────
};
