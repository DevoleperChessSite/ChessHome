// ═══════════════════════════════════════════════════════════════
//  sockets/games.js — геймплей: ходы, финалы, сдача, ничьи, чат партии
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного sockets.js в рамках рефакторинга.
//  Код обработчиков не изменён.

const {
  activeGames,
  endGameAuthoritative,
  findSocketByUsername,
  emitToAdmins,
  FIRST_MOVE_TIMEOUT,
  serverChess,
} = require('../core');

module.exports = function registerGames(socket) {
  socket.on('rejoin_game', ({ gameId }) => {
    if (!socket.username) return;
    const game = activeGames.get(gameId);
    if (!game || (game.white !== socket.username && game.black !== socket.username)) return;
    game._board = serverChess.rebuildBoard(game.moves);
    socket.emit('rejoin_ack', { gameId, moves: game.moves, turn: game.turn, whiteTime: game.whiteTime, blackTime: game.blackTime, chatMessages: game.chatMessages || [] });
  });

  socket.on('make_move', ({ gameId, move }) => {
    if (!socket.username) return;
    const game = activeGames.get(gameId);
    if (!game) { socket.emit('error', 'Партия не найдена (возможно, уже завершилась)'); return; }
    if (typeof move !== 'object' || move === null || typeof move.from !== 'number' || typeof move.to !== 'number'
        || move.from < 0 || move.from > 63 || move.to < 0 || move.to > 63) {
      socket.emit('move_rejected', { gameId, reason: 'invalid' });
      return;
    }
    if (move.promotion != null && !['q', 'r', 'b', 'n'].includes(move.promotion)) {
      socket.emit('move_rejected', { gameId, reason: 'invalid' });
      return;
    }
    if (game.white !== socket.username && game.black !== socket.username) return;
    const pc = game.white === socket.username ? 'white' : 'black';
    if (game.turn !== pc) {
      socket.emit('move_rejected', {
        gameId, reason: 'not-your-turn',
        moves: game.moves, whiteTime: game.whiteTime, blackTime: game.blackTime, lastMoveAt: game.lastMoveAt,
      });
      return;
    }
    if (game._board) {
      const moveObj = { from: move.from, to: move.to, promotion: move.promotion || null };
      if (!serverChess.isLegalMove(game._board, moveObj)) {
        const rebuilt = serverChess.rebuildBoard(game.moves);
        if (!serverChess.isLegalMove(rebuilt, moveObj)) {
          socket.emit('move_rejected', {
            gameId, reason: 'illegal-move',
            moves: game.moves, whiteTime: game.whiteTime, blackTime: game.blackTime, lastMoveAt: game.lastMoveAt,
          });
          return;
        }
        game._board = rebuilt;
        console.warn(`[make_move] Ресинхронизация доски для игры ${gameId} (игрок: ${socket.username})`);
      }
      try { const found = serverChess.findMove(game._board, moveObj); game._board = serverChess.applyMove(game._board, found); } catch (e) { console.warn('[make_move] applyMove error:', e); }
    }
    const now = Date.now();
    if (game.lastMoveAt !== null && game.whiteTime !== undefined) {
      const elapsed = (now - game.lastMoveAt) / 1000;
      if (pc === 'white') game.whiteTime = Math.max(0, game.whiteTime - elapsed + (game.tcIncrement || 0));
      else                game.blackTime = Math.max(0, game.blackTime - elapsed + (game.tcIncrement || 0));
    }
    if (!game._acMoveTimes)  game._acMoveTimes = { white: [], black: [] };
    if (!game._acSuspect)    game._acSuspect   = { white: 0, black: 0 };
    if (game._acLastMoveAt && game.moves.length > 4) {
      const moveMs = now - game._acLastMoveAt;
      const times = game._acMoveTimes[pc]; times.push(moveMs); if (times.length > 20) times.shift();
      if (times.length >= 10) {
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        if (avg < 900 && times.every(t => t < 1200)) {
          game._acSuspect[pc]++;
          if (game._acSuspect[pc] >= 3) {
            emitToAdmins('anticheat_alert', { username: socket.username, gameId, avgMs: Math.round(avg), suspectLevel: game._acSuspect[pc], message: `🚨 Возможный движок: ${socket.username} (avg ${Math.round(avg)}ms/ход)` }).catch(() => {});
          }
        } else if (avg > 3000) { game._acSuspect[pc] = Math.max(0, game._acSuspect[pc] - 1); }
      }
    }
    game._acLastMoveAt = now;
    game.lastMoveAt = now;
    game.moves.push(move); game.turn = game.turn === 'white' ? 'black' : 'white'; game.lastActivity = now;
    if (game.moveCounts) game.moveCounts[pc] = (game.moveCounts[pc] || 0) + 1;
    if (game.firstMoveDeadline) {
      if (game.moves.length === 1) {
        // Белые сделали первый ход — даём чёрным отдельные 20 сек на их первый ход
        game.firstMoveDeadline = now + FIRST_MOVE_TIMEOUT;
      } else if (game.moves.length === 2) {
        // Чёрные тоже сходили первый раз — таймер первого хода больше не нужен
        game.firstMoveDeadline = null;
      }
    }
    const other = findSocketByUsername(pc === 'white' ? game.black : game.white);
    const timePayload = { move, gameId, whiteTime: game.whiteTime, blackTime: game.blackTime, serverAt: now, firstMoveDeadline: game.firstMoveDeadline };
    socket.emit('move_confirmed', timePayload);
    if (other) other.emit('opponent_move', timePayload);
  });

  socket.on('game_over', async ({ gameId, result, reason, accuracy }) => {
    if (!socket.username) return;
    const game = activeGames.get(gameId); if (!game) return;
    // Игрок должен быть участником этой партии, чтобы вообще заявлять об её завершении
    if (socket.username !== game.white && socket.username !== game.black) return;

    if (reason === 'timeout' || reason === 'flag') {
      socket.emit('error', 'Таймаут определяется сервером');
      return;
    }

    const ALLOWED_REASONS = ['checkmate', 'stalemate', 'threefold-repetition', 'fifty-move', 'insufficient-material'];
    if (!ALLOWED_REASONS.includes(reason)) { socket.emit('error', 'Недопустимая причина завершения'); return; }

    const norm = result === 'w' ? 'white' : result === 'b' ? 'black' : result;
    if (norm !== 'white' && norm !== 'black' && norm !== 'draw') return;

    // ── Мат/пат — проверяем по реальной позиции на сервере, а не
    // просто принимаем то, что прислал клиент.
    if (reason === 'checkmate' || reason === 'stalemate') {
      const board = game._board || serverChess.rebuildBoard(game.moves);
      const boardTurnColor = board.turn === 'w' ? 'white' : 'black';
      if (reason === 'checkmate') {
        if (!serverChess.isCheckmate(board)) { socket.emit('error', 'Мат не подтверждён сервером'); return; }
        const expectedWinner = boardTurnColor === 'white' ? 'black' : 'white';
        if (norm !== expectedWinner) { socket.emit('error', 'Некорректный результат мата'); return; }
      } else {
        if (!serverChess.isStalemate(board)) { socket.emit('error', 'Пат не подтверждён сервером'); return; }
        if (norm !== 'draw') { socket.emit('error', 'Некорректный результат пата'); return; }
      }
    }

    // ── Ничьи по правилам (50 ходов / недостаток материала / троекратное
    // повторение позиции) — тоже перепроверяем по истории ходов, а не
    // просто верим клиенту.
    if (reason === 'threefold-repetition' || reason === 'fifty-move' || reason === 'insufficient-material') {
      if (norm !== 'draw') { socket.emit('error', 'Некорректный результат ничьей'); return; }
      if (reason === 'threefold-repetition' && !serverChess.isThreefoldRepetition(game.moves)) {
        socket.emit('error', 'Повторение позиции не подтверждено сервером'); return;
      }
      if (reason === 'fifty-move' && !serverChess.isFiftyMoveRule(game.moves)) {
        socket.emit('error', 'Правило 50 ходов не подтверждено сервером'); return;
      }
      if (reason === 'insufficient-material') {
        const board = game._board || serverChess.rebuildBoard(game.moves);
        if (!serverChess.isInsufficientMaterial(board.squares)) {
          socket.emit('error', 'Недостаток материала не подтверждён сервером'); return;
        }
      }
    }

    // Удаляем сразу — чтобы второй клиент не мог вызвать game_over дважды на ту же игру.
    // Accuracy: принимаем только числа в диапазоне 0..100 и только по известным ключам.
    if (accuracy && typeof accuracy === 'object') {
      const safe = {};
      for (const key of ['white', 'black']) {
        const v = Number(accuracy[key]);
        if (Number.isFinite(v)) safe[key] = Math.max(0, Math.min(100, v));
      }
      if (Object.keys(safe).length) game.accuracy = safe;
    }
    await endGameAuthoritative(gameId, game, norm, reason);
  });

  socket.on('resign', async ({ gameId }) => {
    if (!socket.username) return;
    const game = activeGames.get(gameId); if (!game) return;
    if (game.white !== socket.username && game.black !== socket.username) return;
    // Двойной учёт (P1, устранено): хендлер больше не завершает партию сам
    // (свой delete из карт + recordGame + updateStats + finishTournamentGame),
    // а передаёт всё в единую авторитарную точку endGameAuthoritative — как
    // уже делают game_over и серверный тик часов. Она защищена флагом
    // _finishing от гонки с параллельным resign/timeout/game_over и
    // гарантирует ровно один финал: одна запись в БД, один инкремент
    // статистики, одни очки турнира, одно broadcast game_ended.
    const winner = game.white === socket.username ? 'black' : 'white';
    await endGameAuthoritative(gameId, game, winner, 'resign');
  });

  socket.on('offer_draw', ({ gameId }) => {
    if (!socket.username) return;
    const game = activeGames.get(gameId); if (!game) return;
    if (game.white !== socket.username && game.black !== socket.username) return;
    const nowD = Date.now();
    if (socket._lastDrawOfferAt && nowD - socket._lastDrawOfferAt < 2000) {
      return socket.emit('error', 'Не так часто — подождите пару секунд');
    }
    socket._lastDrawOfferAt = nowD;
    const opp = game.white === socket.username ? game.black : game.white;
    const os = findSocketByUsername(opp); if (os) os.emit('draw_offered', { gameId, from: socket.username });
  });

  socket.on('accept_draw', async ({ gameId }) => {
    if (!socket.username) return;
    const game = activeGames.get(gameId); if (!game) return;
    if (game.white !== socket.username && game.black !== socket.username) return;
    // Двойной учёт (P1, устранено): завершение — только через единую
    // авторитарную точку endGameAuthoritative (см. resign выше).
    await endGameAuthoritative(gameId, game, 'draw', 'agreement');
  });

  socket.on('game_chat', ({ gameId, message }) => {
    if (!socket.username) return socket.emit('error', 'Сначала войдите в аккаунт');
    const game = activeGames.get(gameId);
    if (!game) return socket.emit('error', 'Партия не найдена (чат недоступен)');
    if (game.white !== socket.username && game.black !== socket.username) return;
    const text = (typeof message === 'string' ? message : '').trim().slice(0, 300); if (!text) return;
    const opp = game.white === socket.username ? game.black : game.white;
    const msg = { from: socket.username, message: text, gameId, ts: Date.now() };
    if (!game.chatMessages) game.chatMessages = [];
    game.chatMessages.push(msg);
    if (game.chatMessages.length > 100) game.chatMessages.shift();
    socket.emit('game_chat', msg);
    const os = findSocketByUsername(opp); if (os) os.emit('game_chat', msg);
  });
}
