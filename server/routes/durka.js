// ═══════════════════════════════════════════════════════════════
//  routes/durka.js — внешние турниры «дурки» (доступ по ключу)
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  db,
  withTransaction,
  app,
  limiterStrict,
  tournaments,
  rateLimit,
} = require('../core');

module.exports = function register(app) {
app.get('/api/durka/leaderboard', async (req, res) => {
  try {
    const r = await db(`SELECT username, points, tournaments FROM durka_players WHERE points > 0 ORDER BY points DESC, tournaments DESC LIMIT 200`);
    res.json(r.rows.map((row, i) => ({
      rank: i + 1,
      username: row.username,
      points: Number(row.points) || 0,
      tournaments: Number(row.tournaments) || 0,
    })));
  } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});


// Список уже засчитанных турниров — чтобы видеть историю на странице.
app.get('/api/durka/tournaments', async (req, res) => {
  try {
    const r = await db(`SELECT id, name, url, players, created_at FROM durka_tournaments ORDER BY created_at DESC LIMIT 100`);
    res.json(r.rows.map(row => ({
      id: row.id, name: row.name, url: row.url,
      players: Number(row.players) || 0,
      createdAt: Number(row.created_at),
    })));
  } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});


// Приём результатов одного турнира от hi.py.
// body: { tournamentId, name, url, results: [{ username, points, rank }] }
app.post('/api/durka/add-tournament', rateLimit(limiterStrict, 'Слишком много запросов.'), durkaKeyMiddleware, async (req, res) => {
  try {
    const { tournamentId, name, url, results } = req.body || {};
    if (!tournamentId || !Array.isArray(results) || !results.length) {
      return res.status(400).json({ error: 'tournamentId и results обязательны' });
    }

    const already = await db(`SELECT id FROM durka_tournaments WHERE id = $1`, [tournamentId]);
    if (already.rows.length && req.query.force !== '1') {
      return res.status(409).json({ error: 'Этот турнир уже засчитан в лидерборд', tournamentId });
    }

    const cleaned = results
      .map(r => ({
        username: String(r.username || '').trim(),
        points: Number(r.points) || 0,
        rank: r.rank != null ? Number(r.rank) : null,
      }))
      .filter(r => r.username);

    if (!cleaned.length) return res.status(400).json({ error: 'Пустой список результатов' });

    await withTransaction(async (client) => {
      // Если пересчитываем турнир (force=1) — сначала вычитаем его старый вклад.
      if (already.rows.length) {
        const old = await client.query(`SELECT username_low, points FROM durka_tournament_results WHERE tournament_id = $1`, [tournamentId]);
        for (const row of old.rows) {
          await client.query(
            `UPDATE durka_players SET points = GREATEST(points - $1, 0), tournaments = GREATEST(tournaments - 1, 0) WHERE username_low = $2`,
            [row.points, row.username_low]
          );
        }
        await client.query(`DELETE FROM durka_tournament_results WHERE tournament_id = $1`, [tournamentId]);
      }

      for (const r of cleaned) {
        const usernameLow = r.username.toLowerCase();
        await client.query(
          `INSERT INTO durka_tournament_results (tournament_id, username_low, username, points, rank)
           VALUES ($1, $2, $3, $4, $5)`,
          [tournamentId, usernameLow, r.username, r.points, r.rank]
        );
        await client.query(
          `INSERT INTO durka_players (username_low, username, points, tournaments, updated_at)
           VALUES ($1, $2, $3, 1, $4)
           ON CONFLICT (username_low) DO UPDATE SET
             username = EXCLUDED.username,
             points = durka_players.points + EXCLUDED.points,
             tournaments = durka_players.tournaments + 1,
             updated_at = EXCLUDED.updated_at`,
          [usernameLow, r.username, r.points, Date.now()]
        );
      }

      await client.query(
        `INSERT INTO durka_tournaments (id, name, url, players, added_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, url = EXCLUDED.url, players = EXCLUDED.players, created_at = durka_tournaments.created_at`,
        [tournamentId, name || tournamentId, url || null, cleaned.length, 'hi.py', Date.now()]
      );
    });

    console.log(`[Durka] Турнир ${tournamentId} засчитан: ${cleaned.length} игроков`);
    res.json({ ok: true, tournamentId, playersAdded: cleaned.length });
  } catch(e) {
    console.error('[Durka] add-tournament error:', e.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});



function durkaKeyMiddleware(req, res, next) {
  const key = process.env.DURKA_ADMIN_KEY;
  if (!key) return res.status(500).json({ error: 'DURKA_ADMIN_KEY не настроен на сервере' });
  if (typeof req.headers['x-durka-key'] !== 'string' || !safeSecretEqual(req.headers['x-durka-key'], key)) {
    return res.status(403).json({ error: 'Неверный ключ' });
  }
  next();
}
};
