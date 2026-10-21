// ═══════════════════════════════════════════════════════════════
//  routes/games.js — API партий
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  db,
  app,
  tournaments,
  activeGames,
} = require('../core');

module.exports = function register(app) {
app.get('/api/games/:gameId', async (req, res) => {
  const active = activeGames.get(req.params.gameId);
  if (active) return res.json(active);
  const r = await db('SELECT * FROM games WHERE id = $1', [req.params.gameId]);
  if (!r.rows[0]) {
    // Фоллбэк: старые турнирные партии, сохранённые до записи в таблицу games
    for (const t of tournaments) {
      const tg = (t.games || []).find(g => g.id === req.params.gameId);
      if (tg) {
        return res.json({
          id: tg.id, white: tg.white, black: tg.black,
          result: tg.result, reason: tg.reason, moves: tg.moves,
          timeControl: tg.timeControl, endedAt: tg.endedAt || null,
          berserk: tg.berserk, accuracy: tg.accuracy, tournamentId: t.id,
        });
      }
    }
    return res.status(404).json({ error: 'Не найдена' });
  }
  const row = r.rows[0];
  res.json({
    id: row.id, white: row.white, black: row.black,
    result: row.result, reason: row.reason, moves: row.moves,
    timeControl: row.time_control, endedAt: row.ended_at ? Number(row.ended_at) : null,
    rated: row.rated !== false,
  });
});


};
