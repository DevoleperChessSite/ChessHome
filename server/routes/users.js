// ═══════════════════════════════════════════════════════════════
//  routes/users.js — профили, эмодзи и bio (поиск — в auth.js, порядок как в оригинале)
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  db,
  PROFILE_EMOJIS,
  app,
  getAuthToken,
  getUser,
  saveUser,
  clubs,
  onlineUsers,
  authMiddleware,
  sanitizeUser,
  verifyToken,
} = require('../core');

const {
  getDeletedUser,
  parsePagination,
} = require('./_shared');

module.exports = function register(app) {
app.get('/api/users/:username', async (req, res) => {
  const user = await getUser(req.params.username.toLowerCase());
  if (!user) {
    const gone = await getDeletedUser(req.params.username.toLowerCase());
    if (gone) return res.status(404).json({ error: 'Аккаунт удалён', deleted: true, deletedAt: gone.deletedAt });
    return res.status(404).json({ error: 'Не найден' });
  }
  const payload = verifyToken(getAuthToken(req));
  const isSelf = payload && payload.username && payload.username.toLowerCase() === user.username.toLowerCase();
  const data = isSelf ? { ...sanitizeUser(user, true), email: user.email || null } : sanitizeUser(user, false);
  res.json({ ...data, online: onlineUsers.has(user.username) });
});


app.get('/api/users/:username/games', async (req, res) => {
  const u = req.params.username;
  // Пагинация нормализована (limit=-5 уезжал в SQL как LIMIT -5 → ошибка PG)
  const { limit } = parsePagination(req.query, { defaultLimit: 20, maxLimit: 100 });
  const r = await db('SELECT * FROM games WHERE white = $1 OR black = $1 ORDER BY ended_at DESC LIMIT $2', [u, limit]);
  res.json(r.rows.map(row => ({
    id: row.id, white: row.white, black: row.black,
    result: row.result, reason: row.reason,
    moves: row.moves, timeControl: row.time_control,
    endedAt: row.ended_at ? Number(row.ended_at) : null,
    berserk: row.berserk, accuracy: row.accuracy,
    tournamentId: row.tournament_id,
    rated: row.rated !== false,
  })));
});



app.post('/api/user/emoji', authMiddleware, async (req, res) => {
  try {
    const { emoji } = req.body;
    if (typeof emoji !== 'string') return res.status(400).json({ error: 'Неверный эмодзи' });
    // Белый список: разрешён ТОЛЬКО пустая строка (снять эмодзи) или
    if (emoji !== '' && !PROFILE_EMOJIS.has(emoji)) {
      return res.status(400).json({ error: 'Этот эмодзи запрещён' });
    }
    const userId = req.user.userId;
    await db('UPDATE users SET emoji = $1 WHERE id = $2', [emoji, userId]);
    const user = await getUser(req.user.username.toLowerCase());
    if (user) user.emoji = emoji;
    res.json({ ok: true, emoji });
  } catch (err) {
    console.error('[Emoji update]', err);
    res.status(500).json({ error: 'Ошибка при сохранении эмодзи' });
  }
});


// ──────────────────────────────────────────────────────────────
//  User Profile (описание + внешние рейтинги ФШР/FIDE)
// ──────────────────────────────────────────────────────────────


const INVISIBLE_RE = /[\u00AD\u034F\u115F\u1160\u180E\u200B\u2060\u2800\u3164\uFEFF\uFFA0\u202A-\u202E\u2066-\u2069\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
function cleanBio(raw) {
  const cleaned = String(raw).replace(/\r\n?/g, '\n').replace(INVISIBLE_RE, '').trim();
  // Если кроме пробелов и невидимых символов ничего нет, описание считаем пустым
  if (!cleaned.replace(/[\s\u200C\u200D\u200E\u200F\uFE0F]/gu, '')) return '';
  return cleaned;
}

app.post('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    let { bio, fshrRating, fideRating } = req.body;

    if (bio != null && typeof bio !== 'string') return res.status(400).json({ error: 'Неверное описание' });
    bio = cleanBio(bio || '').slice(0, 400);

    fshrRating = (fshrRating === '' || fshrRating === undefined) ? null : fshrRating;
    fideRating = (fideRating === '' || fideRating === undefined) ? null : fideRating;
    for (const [label, val] of [['ФШР', fshrRating], ['FIDE', fideRating]]) {
      if (val !== null && val !== undefined && (!Number.isFinite(val) || val < 0 || val > 4000)) {
        return res.status(400).json({ error: `Рейтинг ${label} должен быть числом от 0 до 4000` });
      }
    }

    const user = await getUser(req.user.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    user.bio = bio;
    user.fshrRating = fshrRating === null ? null : Number(fshrRating);
    user.fideRating = fideRating === null ? null : Number(fideRating);
    await saveUser(user);

    res.json({ bio: user.bio, fshrRating: user.fshrRating, fideRating: user.fideRating });
  } catch (err) {
    console.error('[Profile update]', err);
    res.status(500).json({ error: 'Ошибка при сохранении профиля' });
  }
});



app.get('/api/users/:username/clubs', (req, res) => {
  const uname = req.params.username.toLowerCase();
  const userClubs = clubs.filter(c => (c.members || []).map(m => m.toLowerCase()).includes(uname));
  res.json(userClubs.map(c => ({ id: c.id, name: c.name, description: c.description, memberCount: c.memberCount || 0, admins: c.admins || [], members: c.members || [], createdBy: c.createdBy, official: !!c.official })));
});


// Два рейтинга задач:
//   GET /api/puzzles/leaderboard             — общий (старая + новая система, как раньше)
//   GET /api/puzzles/leaderboard?system=new  — только новая система (Glicko-2, puzzle_rating_system = 2)
// Одинаковый рейтинг сортируем по числу решённых и нику — иначе порядок «прыгает» между обновлениями.
};
