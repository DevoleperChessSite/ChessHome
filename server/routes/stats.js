// ═══════════════════════════════════════════════════════════════
//  routes/stats.js — общая статистика платформы
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  db,
  app,
  tournaments,
  clubs,
  forumReplies,
  blogPosts,
} = require('../core');

const {
  countDeletedUsers,
} = require('./_shared');

module.exports = function register(app) {
app.get('/api/stats', async (req, res) => {
  try {
    if (statsCache.data && Date.now() - statsCache.ts < STATS_TTL_MS) return res.json(statsCache.data);
    // Одновременные запросы делят одну пересборку, а не запускают по 24 запроса каждый
    if (!statsCache.pending) {
      statsCache.pending = buildStats().finally(() => { statsCache.pending = null; });
    }
    const data = await statsCache.pending;
    statsCache.data = data;
    statsCache.ts = Date.now();
    res.json(data);
  } catch (e) {
    console.error('[Stats]', e.message);
    if (statsCache.data) return res.json(statsCache.data);   // при сбое БД — прошлая версия
    res.status(500).json({ error: 'Ошибка' });
  }
});

async function buildStats() {
    const FOUNDED = new Date('2026-03-30T00:00:00Z');
    const daysAlive = Math.floor((Date.now() - FOUNDED.getTime()) / 86400000);

    const [ users, games, dm, chat, clubChat, blogPosts, blogComments, blogLikes, blogViews, forums, forumReplies, tournaments, clubs, puzzleAttempts, puzzleSolved, topRating, topPuzzle, topGames, gamesByTC, gamesByResult, registrationsByDay, gamesByDay, biggestWinStreak, avgGameMoves ] = await Promise.all([
      db('SELECT COUNT(*) FROM users'),
      db('SELECT COUNT(*) FROM games'),
      db('SELECT COUNT(*) FROM dm_messages'),
      db('SELECT COUNT(*) FROM chat_messages'),
      db('SELECT COUNT(*) FROM club_chat_messages'),
      db('SELECT COUNT(*) FROM blog_posts'),
      db('SELECT COUNT(*) FROM blog_comments'),
      db('SELECT COUNT(*) FROM blog_likes'),
      db('SELECT COUNT(*) FROM blog_views'),
      db('SELECT COUNT(*) FROM forum_threads'),
      db('SELECT COUNT(*) FROM forum_replies'),
      db('SELECT COUNT(*) FROM tournaments'),
      db('SELECT COUNT(*) FROM clubs'),
      db('SELECT COUNT(*) FROM puzzle_attempts'),
      db("SELECT COUNT(*) FROM puzzle_attempts WHERE correct=true"),
      db('SELECT username, rating FROM users ORDER BY rating DESC LIMIT 5'),
      db('SELECT username, puzzle_rating FROM users WHERE puzzle_attempted > 0 ORDER BY puzzle_rating DESC LIMIT 5'),
      db('SELECT username, games_played FROM users ORDER BY games_played DESC LIMIT 5'),
      db("SELECT time_control, COUNT(*) as cnt FROM games WHERE time_control IS NOT NULL GROUP BY time_control ORDER BY cnt DESC LIMIT 8"),
      db("SELECT result, COUNT(*) as cnt FROM games GROUP BY result"),
      db(`SELECT DATE(to_timestamp(created_at/1000)) as day, COUNT(*) as cnt FROM users WHERE created_at > extract(epoch from now()-interval '30 days')*1000 GROUP BY day ORDER BY day ASC`),
      db(`SELECT DATE(to_timestamp(ended_at/1000)) as day, COUNT(*) as cnt FROM games WHERE ended_at > extract(epoch from now()-interval '30 days')*1000 GROUP BY day ORDER BY day ASC`),
      db('SELECT username, wins FROM users ORDER BY wins DESC LIMIT 1'),
      db('SELECT AVG(jsonb_array_length(moves::jsonb)) as avg FROM games WHERE moves IS NOT NULL AND moves != \'[]\' AND moves != \'null\''),
    ]);

    const totalMessages = parseInt(dm.rows[0].count) + parseInt(chat.rows[0].count) + parseInt(clubChat.rows[0].count);
    const deletedUsers = await countDeletedUsers();   // удалённые аккаунты остаются в общем счётчике

    return ({
      meta: { daysAlive, founded: '30.03.2026' },
      totals: {
        users: parseInt(users.rows[0].count) + deletedUsers, deletedUsers, games: parseInt(games.rows[0].count), messages: totalMessages,
        dmMessages: parseInt(dm.rows[0].count), chatMessages: parseInt(chat.rows[0].count), clubMessages: parseInt(clubChat.rows[0].count),
        blogPosts: parseInt(blogPosts.rows[0].count), blogComments: parseInt(blogComments.rows[0].count),
        blogLikes: parseInt(blogLikes.rows[0].count), blogViews: parseInt(blogViews.rows[0].count),
        forums: parseInt(forums.rows[0].count), forumReplies: parseInt(forumReplies.rows[0].count),
        tournaments: parseInt(tournaments.rows[0].count), clubs: parseInt(clubs.rows[0].count),
        puzzleAttempts: parseInt(puzzleAttempts.rows[0].count), puzzleSolved: parseInt(puzzleSolved.rows[0].count),
      },
      leaders: { rating: topRating.rows, puzzle: topPuzzle.rows, games: topGames.rows, mostWins: biggestWinStreak.rows[0] || null },
      charts: { gamesByTC: gamesByTC.rows, gamesByResult: gamesByResult.rows, regByDay: registrationsByDay.rows, gamesByDay: gamesByDay.rows },
      misc: { avgGameMoves: Math.round(parseFloat(avgGameMoves.rows[0]?.avg) || 0), puzzleSuccessRate: puzzleAttempts.rows[0].count > 0 ? Math.round(parseInt(puzzleSolved.rows[0].count) / parseInt(puzzleAttempts.rows[0].count) * 100) : 0 }
    });
}


// ── Dev Diary API ───────────────────────────────────────────
};
