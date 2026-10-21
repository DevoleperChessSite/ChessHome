// ═══════════════════════════════════════════════════════════════
//  routes/storm.js — Puzzle Storm (серверные забеги)
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  uuidv4,
  db,
  app,
  limiterStrict,
  STORM_MAX_TIME_MS,
  STORM_MIN_MS_PER_PUZZLE,
  stormRuns,
  cacheUser,
  getUser,
  rateLimit,
  authMiddleware,
} = require('../core');

const {
  parsePuzzleSolution,
} = require('./_shared');

const puzzleService = require('../services/puzzle.service'); // задачи: проверка ходов + рейтинг Glicko-2

module.exports = function register(app) {
app.post('/api/storm/start', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const runId = uuidv4();
  stormRuns.set(runId, {
    userId:      req.user.userId,
    username:    req.user.username,
    startedAt:   Date.now(),
    // puzzleId -> { playerMoves, autoMoves, step, done }
    answers:     new Map(),
    solvedCount: 0,
    wrongSet:    new Set(),
    // защита от двойной отправки финиша
    finished:    false,
  });
  res.json({ runId });
});

app.get('/api/storm/puzzles', authMiddleware, async (req, res) => {
  try {
    const { runId } = req.query;
    const run = typeof runId === 'string' ? stormRuns.get(runId) : null;
    if (!run || run.userId !== req.user.userId) {
      return res.status(400).json({ error: 'Забег не найден. Начните игру заново.' });
    }
    const topicsParam = req.query.topics || 'mate1,mate2';
    const topics = topicsParam.split(',').map(t => t.trim()).filter(Boolean).slice(0, 8);
    if (!topics.length) return res.status(400).json({ error: 'Неверные темы' });
    const placeholders = topics.map((_, i) => `$${i + 1}`).join(',');
    const r = await db(`SELECT id,fen,solution,topic,difficulty FROM puzzles WHERE topic IN (${placeholders}) ORDER BY RANDOM() LIMIT 80`, topics);
    // Решения остаются на сервере — клиенту уезжает только игровое поле.
    // movesCount нужен лишь для подписи «Мат в 1/2 хода» в интерфейсе.
    const puzzles = r.rows.map(row => {
      const { playerMoves, autoMoves } = parsePuzzleSolution(row.solution);
      run.answers.set(row.id, {
        fen: row.fen,        // текущая позиция: сервер ведёт её сам (нужна для проверки мата)
        playerMoves,
        autoMoves,
        step: 0,
        done: false,
      });
      return { id: row.id, fen: row.fen, topic: row.topic, difficulty: row.difficulty, movesCount: playerMoves.length };
    });
    res.json(puzzles);
  } catch(e) { console.error('[Storm puzzles]', e.message); res.status(500).json({ error: 'Ошибка' }); }
});

// Один ход игрока: сервер проверяет по решению и сам ведёт счёт.
app.post('/api/storm/move', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  try {
    const { runId, puzzleId, uci } = req.body || {};
    if (typeof runId !== 'string' || typeof puzzleId !== 'string' || typeof uci !== 'string') {
      return res.status(400).json({ error: 'Неверные данные' });
    }
    // UCI вида e2e4 / e7e8q — ничего больше не принимаем.
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
      return res.status(400).json({ error: 'Неверный формат хода' });
    }
    const run = stormRuns.get(runId);
    if (!run || run.userId !== req.user.userId) {
      return res.status(400).json({ error: 'Забег не найден. Начните игру заново.' });
    }
    const p = run.answers.get(puzzleId);
    if (!p) return res.status(400).json({ error: 'Задача не из этого забега' });

    if (p.done) return res.json({ correct: false, finished: true });

    // Ход судит сервер по реальной позиции: совпал с решением ИЛИ ставит мат.
    const expectedRaw = p.playerMoves[p.step];
    const j = puzzleService.judgeSolverMove(p.fen, uci, expectedRaw);
    let isCorrect, isMate = false, canon = uci.toLowerCase().trim();
    if (j.fallback) {
      isCorrect = puzzleService.legacyMatch(uci, expectedRaw);   // chess.js не разобрал FEN
    } else if (!j.legal) {
      return res.json({ correct: false, illegal: true });        // невозможный ход — не засчитываем и не штрафуем
    } else {
      isCorrect = j.matches || j.mate;
      isMate = j.mate;
      canon = j.canon;
    }

    if (!isCorrect) {
      // Ошибка в задаче засчитывается один раз (клиент после неё уходит
      // к следующей задаче, но досылы/дубли не должны раздувать счёт).
      if (!run.wrongSet.has(puzzleId)) run.wrongSet.add(puzzleId);
      return res.json({ correct: false });
    }

    p.step++;
    let autoMove = p.autoMoves[p.step - 1] || null;
    let finished = isMate || p.step >= p.playerMoves.length;
    if (!finished && !j.fallback) {
      const nextFen = autoMove ? puzzleService.applyUci(j.fenAfter, autoMove) : null;
      if (nextFen) p.fen = nextFen;
      else { autoMove = null; finished = true; }   // в данных ход соперника невозможен
    }
    if (finished) { autoMove = null; p.done = true; run.solvedCount++; }
    return res.json({ correct: true, canon, autoMove, finished });
  } catch(e) { console.error('[Storm move]', e.message); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/storm/finish', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  try {
    const { score, totalAttempted, correct, wrong, timeBonus, runId } = req.body;
    for (const v of [score, totalAttempted, correct, wrong, timeBonus]) {
      if (v !== undefined && !Number.isFinite(Number(v))) return res.status(400).json({ error: 'Неверные данные' });
    }

    // ── Авторитетный подсчёт результата ──
    // 1) Забег должен быть начат через /api/storm/start этим же пользователем.
    const run = typeof runId === 'string' ? stormRuns.get(runId) : null;
    if (!run || run.userId !== req.user.userId) {
      return res.status(400).json({ error: 'Забег не найден. Начните игру заново.' });
    }
    if (run.finished) return res.status(400).json({ error: 'Забег уже завершён' });
    run.finished = true;
    stormRuns.delete(runId); // одноразовый — повторно этот runId использовать нельзя

    const elapsedMs = Date.now() - run.startedAt;
    // 2) Результат не может превышать лимит времени игры (+ разумный запас на сеть).
    if (elapsedMs > STORM_MAX_TIME_MS) {
      return res.status(400).json({ error: 'Забег просрочен' });
    }

    // 3) Очки — ТОЛЬКО серверные счётчики (клиентские score/correct игнорируются).
    const finalScore   = run.solvedCount;
    const finalWrong   = run.wrongSet.size;
    // 4) Нельзя решить больше задач, чем физически влезает во время игры.
    const maxPossible = Math.floor(elapsedMs / STORM_MIN_MS_PER_PUZZLE);
    if (finalScore + finalWrong > maxPossible) {
      return res.status(400).json({ error: 'Результат не прошёл проверку' });
    }

    const user = await getUser(req.user.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Не найден' });
    await db(`INSERT INTO puzzle_storm_runs (id,user_id,username,score,total_attempted,correct,wrong,time_bonus,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [uuidv4(), user.id, user.username, finalScore, finalScore + finalWrong, finalScore, finalWrong, Math.min(600, Number(timeBonus) || 0), Date.now()]);
    const isBest  = finalScore > (user.storm_best || 0);
    const newBest = isBest ? finalScore : (user.storm_best || 0);
    const newRuns = (user.storm_runs || 0) + 1;
    await db('UPDATE users SET storm_best=$1,storm_runs=$2 WHERE id=$3', [newBest, newRuns, user.id]);
    user.storm_best = newBest; user.storm_runs = newRuns; cacheUser(user);
    res.json({ ok:true, isBest, newBest, totalRuns:newRuns, score: finalScore, correct: finalScore, wrong: finalWrong });
  } catch(e) { console.error('[Storm finish]',e.message); res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/storm/leaderboard', async (req, res) => {
  try {
    const r = await db(`SELECT username,storm_best,storm_runs FROM users WHERE storm_runs>0 ORDER BY storm_best DESC LIMIT 50`);
    res.json(r.rows.map((u,i) => ({ rank:i+1, username:u.username, best:u.storm_best||0, runs:u.storm_runs||0 })));
  } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.get('/api/storm/player/:username', async (req, res) => {
  try {
    const user = await getUser(req.params.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Не найден' });
    const runs = await db(`SELECT score,correct,wrong,created_at FROM puzzle_storm_runs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10`, [user.id]);
    res.json({ username:user.username, best:user.storm_best||0, runs:user.storm_runs||0, history: runs.rows.map(r => ({ score:r.score, correct:r.correct, wrong:r.wrong, at:Number(r.created_at) })) });
  } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});


};