// ═══════════════════════════════════════════════════════════════
//  routes/game-page.js — серверный рендер страницы партии /game/:gameId
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  db,
  app,
  tournaments,
  activeGames,
} = require('../core');

const { escapeHtml } = require('../utils');

module.exports = function register(app) {
app.get('/game/:gameId', async (req, res) => {
  const gameId = req.params.gameId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(gameId)) {
    return res.status(404).send('Игра не найдена');
  }
  // Получаем данные игры через API (переиспользуем логику)
  let game = activeGames.get(gameId);
  if (!game) {
    const dbGame = await db('SELECT * FROM games WHERE id = $1', [gameId]);
    if (dbGame.rows.length === 0) {
      // Фоллбэк: старые турнирные партии, сохранённые до записи в таблицу games
      let tournamentGame = null, tournamentMeta = null;
      for (const t of tournaments) {
        const tg = (t.games || []).find(g => g.id === gameId);
        if (tg) { tournamentGame = tg; tournamentMeta = t; break; }
      }
      if (!tournamentGame) {
        return res.status(404).send('Игра не найдена');
      }
      game = {
        id: tournamentGame.id, white: tournamentGame.white, black: tournamentGame.black,
        result: tournamentGame.result, reason: tournamentGame.reason, moves: tournamentGame.moves,
        timeControl: tournamentGame.timeControl, endedAt: tournamentGame.endedAt || null,
        tournamentId: tournamentMeta.id, tournamentName: tournamentMeta.name,
      };
    } else {
      const row = dbGame.rows[0];
      game = {
        id: row.id, white: row.white, black: row.black,
        result: row.result, reason: row.reason, moves: row.moves,
        timeControl: row.time_control, endedAt: row.ended_at ? Number(row.ended_at) : null
      };
    }
  }

  const jsonForInline = (v) => JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const movesJson = jsonForInline(game.moves || []);
  const titleWhite = escapeHtml(game.white);
  const titleBlack = escapeHtml(game.black);
  const reasonSafe = escapeHtml(game.reason);
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Партия · ${titleWhite} vs ${titleBlack}</title>
      <link href="/css/vendor/chessboard2.min.css" rel="stylesheet">
      <style>
        body { font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
        .container { max-width: 700px; width: 100%; background: #0f0f1e; border-radius: 20px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
        h1 { font-size: 1.5rem; margin: 0 0 4px; }
        .players { display: flex; justify-content: space-between; margin-bottom: 20px; font-weight: bold; background: #1e1e2a; padding: 12px 16px; border-radius: 12px; }
        .player { font-size: 1.2rem; }
        .result { font-size: 1.1rem; color: #c9a84c; }
        #board { width: 100%; max-width: 500px; margin: 0 auto 20px; }
        .controls { display: flex; gap: 12px; justify-content: center; margin-top: 20px; }
        button { background: #2a2a3a; border: none; padding: 8px 16px; border-radius: 8px; color: #fff; cursor: pointer; font-weight: 600; transition: 0.1s; }
        button:hover { background: #c9a84c; color: #000; }
        .move-list { background: #0a0a14; border-radius: 12px; padding: 12px; margin-top: 20px; max-height: 200px; overflow-y: auto; font-family: monospace; font-size: 13px; }
        .move { display: inline-block; margin-right: 12px; }
        .current-move { font-weight: bold; color: #c9a84c; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="players">
          <span class="player">♔ ${escapeHtml(game.white)}</span>
          <span class="player">♚ ${escapeHtml(game.black)}</span>
        </div>
        <div style="text-align:center; margin-bottom:12px">
          <span class="result">${formatGameResult(game.result, game.white, game.black)}</span>
          ${game.reason ? `<span style="margin-left:12px;color:#aaa">(${reasonSafe})</span>` : ''}
        </div>
        <div id="board"></div>
        <div class="controls">
          <button id="prevBtn">◀ Пред.</button>
          <button id="nextBtn">След. ▶</button>
          <button id="pgnBtn">⬇ Скачать PGN</button>
        </div>
        <div class="move-list" id="moveList"></div>
      </div>

      <script src="/js/vendor/chess.js"></script>
      <script src="/js/vendor/chessboard2.min.js"></script>
      <script>
        const moves = ${movesJson};
        const gameId = ${jsonForInline(gameId)};
        const gameWhite = ${jsonForInline(game.white)};
        const gameBlack = ${jsonForInline(game.black)};
        const gameResult = ${jsonForInline(game.result || null)};
        const gameEndedAt = ${jsonForInline(game.endedAt || null)};
        const gameTournamentName = ${jsonForInline(game.tournamentName || null)};
        const boardEl = document.getElementById('board');
        let currentIndex = 0;
        let gameState = new Chess();

        function applyMovesUpTo(index) {
          gameState = new Chess();
          for (let i = 0; i < index && i < moves.length; i++) {
            const mv = moves[i];
            const from = numberToAlgebraic(mv.from);
            const to = numberToAlgebraic(mv.to);
            const promotion = mv.promotion ? mv.promotion.toLowerCase() : undefined;
            try { gameState.move({ from, to, promotion }); } catch (e) { /* пропускаем битые записи */ }
          }
          if (board) { try { board.position(gameState.fen()); } catch(e) {} }
        }

        function numberToAlgebraic(sq) {
          const files = 'abcdefgh';
          const rank = Math.floor(sq / 8);
          const file = sq % 8;
          return files[file] + (rank + 1);
        }

        function updateUI() {
          applyMovesUpTo(currentIndex);
          const moveItems = document.querySelectorAll('.move');
          moveItems.forEach((el, idx) => {
            if (idx === currentIndex) el.classList.add('current-move');
            else el.classList.remove('current-move');
          });
          const listDiv = document.getElementById('moveList');
          if (listDiv && currentIndex >= 0) {
            const activeMoveSpan = listDiv.querySelector('.move.current-move');
            if (activeMoveSpan) activeMoveSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }

        function renderMoveList() {
          const container = document.getElementById('moveList');
          container.innerHTML = '';
          for (let i = 0; i < moves.length; i++) {
            const mv = moves[i];
            const moveText = \`\${numberToAlgebraic(mv.from)}→\${numberToAlgebraic(mv.to)}\${mv.promotion ? '='+mv.promotion.toUpperCase() : ''}\`;
            const moveSpan = document.createElement('span');
            moveSpan.className = 'move';
            moveSpan.textContent = moveText;
            moveSpan.style.cursor = 'pointer';
            moveSpan.onclick = () => { currentIndex = i; updateUI(); };
            container.appendChild(moveSpan);
            if ((i+1) % 8 === 0) container.appendChild(document.createElement('br'));
          }
          if (moves.length === 0) container.textContent = 'Нет ходов';
        }

        function buildPgn() {
          const pgnGame = new Chess();
          const headers = {
            Event: gameTournamentName ? gameTournamentName : 'Casual Game',
            Site: 'ChessHome',
            Date: gameEndedAt ? new Date(gameEndedAt).toISOString().slice(0,10).replace(/-/g, '.') : '????.??.??',
            White: gameWhite,
            Black: gameBlack,
            Result: gameResult === 'white' ? '1-0' : gameResult === 'black' ? '0-1' : gameResult === 'draw' ? '1/2-1/2' : '*'
          };
          for (const mv of moves) {
            const from = numberToAlgebraic(mv.from);
            const to = numberToAlgebraic(mv.to);
            const promotion = mv.promotion ? mv.promotion.toLowerCase() : undefined;
            try { pgnGame.move({ from, to, promotion }); } catch (e) { /* пропускаем битые записи */ }
          }
          let pgn = '';
          for (const [key, value] of Object.entries(headers)) {
            pgn += '[' + key + ' "' + String(value).replace(/"/g, '') + '"]\\n';
          }
          pgn += '\\n';
          pgn += pgnGame.pgn();
          if (headers.Result !== '*') pgn += ' ' + headers.Result;
          return pgn;
        }

        function downloadPgn() {
          const pgn = buildPgn();
          const blob = new Blob([pgn], { type: 'application/x-chess-pgn' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'game_' + gameId + '.pgn';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }

        let board;
        window.addEventListener('DOMContentLoaded', () => {
          try {
            if (typeof Chessboard2 !== 'undefined') {
              board = Chessboard2('board', { position: 'start', draggable: false, pieceTheme: '/img/pieces/{piece}.svg' });
            } else {
              document.getElementById('board').innerHTML = '<div style="text-align:center;color:#aaa;padding:20px">Доска недоступна (ошибка загрузки библиотеки), но ходы и PGN доступны</div>';
            }
          } catch (e) {
            document.getElementById('board').innerHTML = '<div style="text-align:center;color:#aaa;padding:20px">Доска недоступна (ошибка загрузки библиотеки), но ходы и PGN доступны</div>';
          }
          renderMoveList();
          updateUI();
          document.getElementById('prevBtn').onclick = () => { if (currentIndex > 0) { currentIndex--; updateUI(); } };
          document.getElementById('nextBtn').onclick = () => { if (currentIndex < moves.length) { currentIndex++; updateUI(); } };
          document.getElementById('pgnBtn').onclick = downloadPgn;
        });
      </script>
    </body>
    </html>
  `);

  // Единая безопасная реализация экранирования (P0, унификация escapeHtml)
  // импортирована из server/utils.js — экранирует ВСЕ пять спецсимволов HTML,
  // включая кавычки ' и ".
  // XSS (P0): ники игроков вставляются в сгенерированную HTML-страницу —
  // обязаны проходить через escapeHtml, иначе ник вида
  // `<img src=x onerror=...>` исполнялся бы в браузере у любого открывшего.
  function formatGameResult(result, white, black) {
    const safeWhite = escapeHtml(white);
    const safeBlack = escapeHtml(black);
    if (result === 'white') return `🏆 ${safeWhite} победил`;
    if (result === 'black') return `🏆 ${safeBlack} победил`;
    if (result === 'draw') return `🤝 Ничья`;
    return `Партия завершена`;
  }
});


};
