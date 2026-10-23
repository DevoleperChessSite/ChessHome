// ═══════════════════════════════════════════════════════════════
//  routes/blind.js — Blind Puzzle: тактика по памяти
// ═══════════════════════════════════════════════════════════════
//  Позицию показывают N секунд, затем фигуры скрываются, ходы вводятся
//  «вслепую». Режим тренировочный:
//    • рейтинг задач (Glicko-2) НЕ затрагивается — здесь нет ни
//      startSession, ни handleMove, только stateless-судья
//      (judgeSolverMove / applyUci), как в Puzzle Storm;
//    • сервер — единственный судья; решение клиенту уходит только
//      после окончания задачи;
//    • результаты пишутся в отдельную таблицу blind_puzzle_stats.

const {
  db,
  getUser,
  uuidv4,
  path,
  rateLimit,
  limiterStrict,
  authMiddleware,
  sendVersionedHtml,
} = require('../core');

const { parsePuzzleSolution } = require('./_shared');
const puzzleService = require('../services/puzzle.service');

// ── Уровни: время на запоминание ≠ сложность задачи (выбираются отдельно) ──
const LEVELS = {
  easy:   { memorizeMs: 10000, points: 1, maxPieces: 12 },
  medium: { memorizeMs: 5000,  points: 2, maxPieces: 18 },
  hard:   { memorizeMs: 2000,  points: 3, maxPieces: 26 },
  insane: { memorizeMs: 1000,  points: 4, maxPieces: 32 },
};
const LEVEL_KEYS = Object.keys(LEVELS);
const PUZZLE_DIFFS = ['easy', 'medium', 'hard'];
const MOVE_GRACE_MS = 500;            // допуск на сетевую задержку при проверке «рано»
const SESSION_TTL_MS = 20 * 60 * 1000;
const RECENT_KEEP = 20;               // не повторять последние N задач одному игроку

db(`CREATE TABLE IF NOT EXISTS blind_puzzle_stats (
  user_id     TEXT    NOT NULL,
  username    TEXT    NOT NULL,
  level       TEXT    NOT NULL,
  solved      INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  streak      INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  points      INTEGER NOT NULL DEFAULT 0,
  updated_at  BIGINT  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, level)
)`).catch(e => console.error('[Blind] ensure table:', e.message));

// sessionId -> сессия; activeByUser: userId -> sessionId (одна активная на игрока)
const sessions = new Map();
const activeByUser = new Map();
const recentByUser = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.startedAt > SESSION_TTL_MS) { sessions.delete(id); if (activeByUser.get(s.userId) === id) activeByUser.delete(s.userId); }
  }
}, 5 * 60 * 1000).unref();

function countPieces(fen) {
  const m = String(fen || '').split(' ')[0].match(/[pnbrqkPNBRQK]/g);
  return m ? m.length : 0;
}

// Запись результата попытки. solved: true/false. Возвращает актуальную статистику уровня.
async function recordResult(s, solved) {
  const lv = LEVELS[s.level];
  const gained = solved ? lv.points : 0;
  const r = await db(
    `INSERT INTO blind_puzzle_stats (user_id,username,level,solved,attempts,streak,best_streak,points,updated_at)
     VALUES ($1,$2,$3,$4,1,$4,$4,$5,$6)
     ON CONFLICT (user_id, level) DO UPDATE SET
       username    = EXCLUDED.username,
       solved      = blind_puzzle_stats.solved + $4,
       attempts    = blind_puzzle_stats.attempts + 1,
       streak      = CASE WHEN $4 = 1 THEN blind_puzzle_stats.streak + 1 ELSE 0 END,
       best_streak = GREATEST(blind_puzzle_stats.best_streak, CASE WHEN $4 = 1 THEN blind_puzzle_stats.streak + 1 ELSE 0 END),
       points      = blind_puzzle_stats.points + $5,
       updated_at  = $6
     RETURNING solved, attempts, streak, best_streak, points`,
    [s.userId, s.username, s.level, solved ? 1 : 0, gained, Date.now()]
  );
  const row = r.rows[0] || {};
  return {
    gained,
    solved: row.solved, attempts: row.attempts,
    streak: row.streak, bestStreak: row.best_streak, points: row.points,
  };
}

// Завершение сессии ровно один раз (защита от двойной отправки).
async function finishSession(s, solved) {
  if (s.over) return null;
  s.over = true;
  sessions.delete(s.id);
  if (activeByUser.get(s.userId) === s.id) activeByUser.delete(s.userId);
  return recordResult(s, solved);
}

function revealPayload(s) {
  return { fen: s.startFen, solution: s.all, played: s.played };
}

module.exports = function register(app) {

  // ── Страница ────────────────────────────────────────────────
  app.get('/blind-puzzle', (req, res) =>
    sendVersionedHtml(res, path.join(__dirname, '../../public/blind-puzzle.html')));

  // ── Новая задача ────────────────────────────────────────────
  app.get('/api/blind/puzzle', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
    try {
      const level = String(req.query.level || '');
      const lv = LEVELS[level];
      if (!lv) return res.status(400).json({ error: 'Неверный уровень' });
      const diff = PUZZLE_DIFFS.includes(req.query.difficulty) ? req.query.difficulty : null;

      const user = await getUser(req.user.username.toLowerCase());
      if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
      const userId = String(user.id);

      // Брошенная после запоминания задача считается неудачной попыткой,
      // иначе можно «подсмотреть» позицию и выбрать задачу полегче.
      const prevId = activeByUser.get(userId);
      const prev = prevId && sessions.get(prevId);
      if (prev && !prev.over && Date.now() - prev.startedAt >= prev.memorizeMs) {
        await finishSession(prev, false);
      } else if (prev) {
        sessions.delete(prevId);
      }
      activeByUser.delete(userId);

      const rows = (await db(
        `SELECT id, fen, solution, difficulty FROM puzzles ${diff ? 'WHERE difficulty=$1' : ''} ORDER BY RANDOM() LIMIT 80`,
        diff ? [diff] : []
      )).rows;

      const recent = recentByUser.get(userId) || [];
      const parsed = rows.map(row => ({ row, sol: parsePuzzleSolution(row.solution), pieces: countPieces(row.fen) }))
        // короткие задачи: 1–2 хода игрока, решение должно быть однозначным по длине
        .filter(c => c.sol.playerMoves.length >= 1 && c.sol.playerMoves.length <= 2);

      // Подбор: сначала по лимиту фигур и без повторов, затем ослабляем условия.
      const pick = (maxPieces, skipRecent) => parsed.find(c =>
        c.pieces <= maxPieces && (!skipRecent || !recent.includes(c.row.id)));
      const chosen = pick(lv.maxPieces, true) || pick(lv.maxPieces + 8, true) || pick(99, true) || pick(99, false);
      if (!chosen) return res.status(404).json({ error: 'Нет подходящих задач' });

      const { row, sol } = chosen;
      const s = {
        id: uuidv4(), userId, username: user.username, level,
        puzzleId: row.id, startFen: row.fen, fen: row.fen,
        all: sol.all, playerMoves: sol.playerMoves, autoMoves: sol.autoMoves,
        step: 0, played: [], startedAt: Date.now(), memorizeMs: lv.memorizeMs, over: false,
      };
      sessions.set(s.id, s);
      activeByUser.set(userId, s.id);
      recentByUser.set(userId, [row.id, ...recent].slice(0, RECENT_KEEP));

      // Решение и название/тему задачи клиенту не отдаём.
      res.json({
        sessionId: s.id, level, fen: row.fen, difficulty: row.difficulty,
        memorizeMs: lv.memorizeMs, movesCount: sol.playerMoves.length, points: lv.points,
      });
    } catch (e) { console.error('[Blind puzzle]', e.message); res.status(500).json({ error: 'Ошибка' }); }
  });

  // ── Ход игрока ──────────────────────────────────────────────
  app.post('/api/blind/move', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
    try {
      const { sessionId, uci } = req.body || {};
      if (typeof sessionId !== 'string' || typeof uci !== 'string') {
        return res.status(400).json({ error: 'Неверные данные' });
      }
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
        return res.status(400).json({ error: 'Неверный формат хода' });
      }
      const user = await getUser(req.user.username.toLowerCase());
      const s = sessions.get(sessionId);
      if (!user || !s || s.userId !== String(user.id) || s.over) {
        return res.status(400).json({ error: 'Сессия не найдена. Начните задачу заново.', restart: true });
      }
      // Ходить можно только после фазы запоминания (клиент прячет фигуры сам,
      // сервер хотя бы не принимает ходы, пока позиция ещё «на виду»).
      if (Date.now() - s.startedAt < s.memorizeMs - MOVE_GRACE_MS) {
        return res.status(400).json({ error: 'Ещё идёт запоминание', early: true });
      }

      const expectedRaw = s.playerMoves[s.step];
      const j = puzzleService.judgeSolverMove(s.fen, uci, expectedRaw);
      let isCorrect, isMate = false, canon = uci.toLowerCase();
      if (j.fallback) {
        isCorrect = puzzleService.legacyMatch(uci, expectedRaw);
      } else if (!j.legal) {
        return res.json({ correct: false, illegal: true });   // невозможный ход — без штрафа
      } else {
        isCorrect = j.matches || j.mate;
        isMate = j.mate;
        canon = j.canon;
      }
      s.played.push(canon);

      if (!isCorrect) {
        const result = await finishSession(s, false);
        return res.json({ correct: false, finished: true, result, reveal: revealPayload(s) });
      }

      s.step++;
      let autoMove = s.autoMoves[s.step - 1] || null;
      let finished = isMate || s.step >= s.playerMoves.length;
      if (!finished && !j.fallback) {
        const nextFen = autoMove ? puzzleService.applyUci(j.fenAfter, autoMove) : null;
        if (nextFen) s.fen = nextFen;
        else { autoMove = null; finished = true; }            // в данных ход соперника невозможен
      }
      if (finished) {
        const result = await finishSession(s, true);
        return res.json({ correct: true, canon, finished: true, result, reveal: revealPayload(s) });
      }
      res.json({ correct: true, canon, autoMove, finished: false });
    } catch (e) { console.error('[Blind move]', e.message); res.status(500).json({ error: 'Ошибка' }); }
  });

  // ── Статистика ──────────────────────────────────────────────
  function shapeStats(rows) {
    const levels = {};
    let points = 0, solved = 0, attempts = 0;
    for (const k of LEVEL_KEYS) levels[k] = { solved: 0, attempts: 0, accuracy: 0, bestStreak: 0, streak: 0, points: 0 };
    for (const r of rows) {
      if (!levels[r.level]) continue;
      levels[r.level] = {
        solved: r.solved, attempts: r.attempts,
        accuracy: r.attempts ? Math.round(r.solved * 100 / r.attempts) : 0,
        bestStreak: r.best_streak, streak: r.streak, points: r.points,
      };
      points += r.points; solved += r.solved; attempts += r.attempts;
    }
    return { levels, totals: { points, solved, attempts, accuracy: attempts ? Math.round(solved * 100 / attempts) : 0 } };
  }

  app.get('/api/blind/stats', authMiddleware, async (req, res) => {
    try {
      const user = await getUser(req.user.username.toLowerCase());
      if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
      const r = await db('SELECT level, solved, attempts, streak, best_streak, points FROM blind_puzzle_stats WHERE user_id=$1', [String(user.id)]);
      res.json(shapeStats(r.rows));
    } catch (e) { console.error('[Blind stats]', e.message); res.status(500).json({ error: 'Ошибка' }); }
  });

  // Публичная статистика игрока — для карточки в профиле.
  app.get('/api/blind/stats/:username', async (req, res) => {
    try {
      const name = String(req.params.username || '').slice(0, 40);
      const r = await db('SELECT level, solved, attempts, streak, best_streak, points FROM blind_puzzle_stats WHERE LOWER(username)=LOWER($1)', [name]);
      res.json(shapeStats(r.rows));
    } catch (e) { console.error('[Blind stats user]', e.message); res.status(500).json({ error: 'Ошибка' }); }
  });

  app.get('/api/blind/leaderboard', async (req, res) => {
    try {
      const r = await db(`SELECT MAX(username) AS username, SUM(points)::int AS points,
                                 SUM(solved)::int AS solved, SUM(attempts)::int AS attempts
                            FROM blind_puzzle_stats GROUP BY user_id
                           HAVING SUM(points) > 0 ORDER BY points DESC LIMIT 20`);
      res.json(r.rows.map((u, i) => ({ rank: i + 1, username: u.username, points: u.points, solved: u.solved, attempts: u.attempts })));
    } catch (e) { console.error('[Blind leaderboard]', e.message); res.status(500).json({ error: 'Ошибка' }); }
  });
};