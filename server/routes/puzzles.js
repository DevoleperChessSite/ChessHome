// ═══════════════════════════════════════════════════════════════
//  routes/puzzles.js — задачи: каталог, решение, рейтинг
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  jwt,
  uuidv4,
  db,
  app,
  getAuthToken,
  limiterStrict,
  cacheUser,
  getUser,
  JWT_SECRET,
  rateLimit,
  logAdminAction,
  authMiddleware,
  requireAdmin,
} = require('../core');

const {
  dailyPuzzleCache,
} = require('./_shared');

const puzzleService = require('../services/puzzle.service'); // задачи: проверка ходов + рейтинг Glicko-2

puzzleService.ensureSchema().catch(() => {});              // колонки рейтинга создаются при старте (идемпотентно)

module.exports = function register(app) {
app.get('/api/puzzles/leaderboard', async (req, res) => {
  try {
    await puzzleService.ensureSchema();
    const onlyNew = String(req.query.system || '').toLowerCase() === 'new';
    const r = await db(`SELECT username,puzzle_rating,puzzle_solved,puzzle_attempted,puzzle_rating_system,role FROM users WHERE puzzle_attempted > 0${onlyNew ? ' AND puzzle_rating_system = 2' : ''} ORDER BY puzzle_rating DESC, puzzle_solved DESC, username ASC LIMIT 50`);
    res.json(r.rows.map((row,i) => ({
      rank: i+1, username: row.username,
      oldSystem: Number(row.puzzle_rating_system) === 1,   // рейтинг набран по старой системе, ещё не сброшен
      puzzleRating: row.puzzle_rating||1200,
      puzzleSolved: row.puzzle_solved||0,
      puzzleAttempted: row.puzzle_attempted||0,
      accuracy: (row.puzzle_attempted||0)>0 ? Math.round((row.puzzle_solved||0)/row.puzzle_attempted*100) : 0,
      role: row.role,
    })));
  } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});


app.get('/api/puzzles/topics', async (req, res) => {
  try {
    const r = await db(`SELECT pt.*, COUNT(p.id) as puzzle_count FROM puzzle_topics pt LEFT JOIN puzzles p ON p.topic=pt.id GROUP BY pt.id ORDER BY pt.sort_order ASC`);
    res.json(r.rows.map(row => ({
      id: row.id, name: row.name, icon: row.icon,
      description: row.description, puzzleCount: Number(row.puzzle_count||0)
    })));
  } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});


// Публичный лидерборд — сумма очков по всем засчитанным турнирам.

app.get('/api/puzzles/daily', async (req, res) => {
  try {
    const dayIndex = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
    if (dailyPuzzleCache.day === dayIndex && dailyPuzzleCache.payload) {
      return res.json(dailyPuzzleCache.payload);
    }
    const cnt = await db('SELECT COUNT(*) AS n FROM puzzles');
    const total = parseInt(cnt.rows[0].n);
    if (!total) return res.json(null);
    const idx = dayIndex % total;
    const r = await db('SELECT id, title, description, fen, topic, difficulty FROM puzzles ORDER BY created_at ASC LIMIT 1 OFFSET $1', [idx]);
    if (!r.rows.length) return res.json(null);
    const puzzle = r.rows[0];
    const payload = { id: puzzle.id, title: puzzle.title, description: puzzle.description, fen: puzzle.fen, topic: puzzle.topic, difficulty: puzzle.difficulty };
    dailyPuzzleCache = { day: dayIndex, payload };
    res.json(payload);
  } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});


app.get('/api/puzzles', async (req, res) => {
  try {
    const { topic, difficulty, limit=20, offset=0 } = req.query;
    const lim = Math.min(50, parseInt(limit)||20);
    const off = parseInt(offset)||0;

    let userId = null;
    const ah = getAuthToken(req);
    if (ah) {
      try {
        const dec = jwt.verify(ah, JWT_SECRET);
        const u = await getUser(dec.username.toLowerCase());
        if (u) userId = u.id;
      } catch {}
    }

    let sql, params, solvedSet = new Set(), attemptedSet = new Set();

    if (userId) {
      const conditions = ['1=1'];
      params = [userId];
      let i = 2;
      if (topic)      { conditions.push(`p.topic=$${i++}`);      params.push(topic); }
      if (difficulty) { conditions.push(`p.difficulty=$${i++}`); params.push(difficulty); }
      params.push(lim, off);

      sql = `
        SELECT p.*,
          pa.correct  AS _correct,
          CASE
            WHEN pa.id IS NULL        THEN 0
            WHEN pa.correct = false   THEN 1
            WHEN pa.correct = true    THEN 2
            ELSE 0
          END AS _sort_priority
        FROM puzzles p
        LEFT JOIN puzzle_attempts pa ON pa.puzzle_id = p.id AND pa.user_id = $1
        WHERE ${conditions.join(' AND ')}
        ORDER BY _sort_priority ASC, p.created_at ASC
        LIMIT $${i++} OFFSET $${i++}
      `;

      const r = await db(sql, params);

      const att = await db('SELECT puzzle_id, correct FROM puzzle_attempts WHERE user_id=$1', [userId]);
      for (const a of att.rows) {
        if (a.correct) solvedSet.add(a.puzzle_id);
        else attemptedSet.add(a.puzzle_id);
      }

      return res.json(r.rows.map(row => ({
        id: row.id, title: row.title, description: row.description,
        fen: row.fen, topic: row.topic, difficulty: row.difficulty,
        playCount: row.play_count, correctCount: row.correct_count, rating: puzzleService.publicPuzzleRating(row),
        userStatus: solvedSet.has(row.id) ? 'solved' : attemptedSet.has(row.id) ? 'attempted' : 'new',
      })));
    }

    const conditions = ['1=1'];
    params = []; let i = 1;
    if (topic)      { conditions.push(`topic=$${i++}`);      params.push(topic); }
    if (difficulty) { conditions.push(`difficulty=$${i++}`); params.push(difficulty); }
    params.push(lim, off);
    sql = `SELECT * FROM puzzles WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC LIMIT $${i++} OFFSET $${i++}`;
    const r = await db(sql, params);
    return res.json(r.rows.map(row => ({
      id: row.id, title: row.title, description: row.description,
      fen: row.fen, topic: row.topic, difficulty: row.difficulty,
      playCount: row.play_count, correctCount: row.correct_count, rating: puzzleService.publicPuzzleRating(row),
      userStatus: 'new',
    })));

  } catch(e) { console.error('[Puzzles]', e.message); res.status(500).json({ error: 'Ошибка' }); }
});


app.get('/api/puzzles/:id', async (req, res) => {
  try {
    const r = await db('SELECT * FROM puzzles WHERE id=$1',[req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Не найдена' });
    const p = r.rows[0];
    res.json({ id:p.id, title:p.title, description:p.description, fen:p.fen, topic:p.topic, difficulty:p.difficulty, playCount:p.play_count, correctCount:p.correct_count, rating: puzzleService.publicPuzzleRating(p) });
  } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});


// ── Задачи: сервер — единственный судья ─────────────────────────
// Позицию, шаг и результат ведёт сервер (сессия «пользователь + задача»).
// Клиент шлёт только ход. Мат засчитывается всегда. Рейтинг — Glicko-2,
// один раз за первую попытку. Подробности: services/puzzle.service.js.
// Показывать ли кнопку «Сбросить старый рейтинг» (только тем, кто ещё на старой системе).
app.get('/api/puzzles/rating/status', authMiddleware, async (req, res) => {
  try {
    const user = await getUser(req.user.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const st = await puzzleService.getRatingStatus(user.id);
    res.json({ canReset: !!(st && st.canReset), rating: st ? st.rating : 1200 });
  } catch(e) { console.error('[Puzzle rating status]', e.message); res.status(500).json({ error: 'Ошибка' }); }
});

// Одноразовый сброс старого рейтинга: дальше игрок живёт по Glicko-2 и с 1200.
app.post('/api/puzzles/rating/reset', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  try {
    const user = await getUser(req.user.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const row = await puzzleService.resetRating(user.id);
    if (!row) return res.json({ ok: true, alreadyReset: true, rating: user.puzzle_rating || 1200 });
    user.puzzle_rating    = row.puzzle_rating;
    user.puzzle_solved    = row.puzzle_solved;
    user.puzzle_attempted = row.puzzle_attempted;
    cacheUser(user);
    res.json({ ok: true, alreadyReset: false, rating: row.puzzle_rating });
  } catch(e) { console.error('[Puzzle rating reset]', e.message); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/puzzles/:id/start', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  try {
    const r = await db('SELECT id, fen, solution FROM puzzles WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Задача не найдена' });
    const user = await getUser(req.user.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const { rated } = await puzzleService.startSession(user.id, r.rows[0]);
    res.json({ ok: true, rated });
  } catch(e) { console.error('[Puzzle start]', e.message); res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/puzzles/:id/move', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  try {
    const { moveIndex, move } = req.body || {};
    if (typeof move !== 'string' || move.length > 12) return res.status(400).json({ error: 'Укажите move' });
    const r = await db('SELECT id, fen, solution FROM puzzles WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Задача не найдена' });
    const user = await getUser(req.user.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const out = await puzzleService.handleMove(user.id, r.rows[0], move, moveIndex);
    // Решение клиенту НИКОГДА не уходит — только верно/неверно и ответный ход.
    if (out.status === 'restart') return res.json({ correct: false, restart: true });
    if (out.status === 'illegal') return res.json({ correct: false, illegal: true });
    if (out.status === 'done')    return res.json({ correct: false, finished: true });

    const payload = { correct: out.correct, autoMove: out.autoMove, finished: out.finished };
    if (out.rating) {
      const rt = out.rating;
      if (rt.userRow) {
        user.puzzle_rating    = rt.userRow.puzzle_rating;
        user.puzzle_solved    = rt.userRow.puzzle_solved;
        user.puzzle_attempted = rt.userRow.puzzle_attempted;
        cacheUser(user);
      }
      payload.rating = { rated: true, delta: rt.delta, newRating: rt.newRating, rd: rt.rd };
      // Совместимость со старым клиентом из кэша браузера:
      payload.ratingDelta = rt.delta;
      payload.newPuzzleRating = rt.newRating;
    }
    res.json(payload);
  } catch(e) { console.error('[Puzzle move]', e.message); res.status(500).json({ error: 'Ошибка' }); }
});

// Устаревший эндпоинт: раньше клиент присылал список ходов и сам «сообщал»
// результат (и получал в ответ решение). Теперь он ничего не судит — просто
// отдаёт итог серверной сессии, чтобы старый клиент из кэша не ломался.
// Можно удалить через пару дней после выкладки нового app.js.
app.post('/api/puzzles/:id/attempt', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  try {
    const user = await getUser(req.user.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    const sr = puzzleService.getSessionResult(user.id, req.params.id);
    const rt = sr && sr.rating;
    res.json({
      correct: !!(sr && sr.finished),
      ratingDelta: rt ? rt.delta : 0,
      newPuzzleRating: rt ? rt.newRating : (user.puzzle_rating || 1200),
      alreadySolved: !!(sr && sr.finished && !rt),
    });
  } catch(e) { console.error('[Puzzle attempt]', e.message); res.status(500).json({ error: 'Ошибка' }); }
});


// ══════════════════════════════════════════════════════════════
//  PUZZLE STORM API — старый анонимный эндпоинт с УТЕЧКОЙ РЕШЕНИЙ

// ══════════════════════════════════════════════════════════════
//  PUZZLE STORM API
//


app.post('/api/admin/puzzles', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const { title,description,fen,solution,topic,difficulty } = req.body;
    if (!title||!fen||!solution||!topic) return res.status(400).json({ error: 'title,fen,solution,topic обязательны' });
    const id = uuidv4();
    await db(`INSERT INTO puzzles (id,title,description,fen,solution,topic,difficulty,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id,title.trim().slice(0,100),(description||'').trim().slice(0,300), fen.trim(),solution.trim(),topic,difficulty||'medium',req.user.username,Date.now()]);
    await logAdminAction(req.user.username, 'puzzle_create', id, { title: title.trim().slice(0,100), topic, difficulty: difficulty||'medium' });
    res.json({ ok:true, id });
  });
});

app.delete('/api/admin/puzzles/:id', authMiddleware, handleDeletePuzzle);

app.post('/api/admin/puzzles/:id/delete', authMiddleware, handleDeletePuzzle);



async function handleDeletePuzzle(req, res) {
  await requireAdmin(req, res, async () => {
    await db('DELETE FROM puzzles WHERE id=$1',[req.params.id]);
    await logAdminAction(req.user.username, 'puzzle_delete', req.params.id, {});
    res.json({ ok:true });
  });
}
};
