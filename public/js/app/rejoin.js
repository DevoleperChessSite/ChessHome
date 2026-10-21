// ═══════════════════════════════════════════════════════════
//  app/rejoin.js — баннер возврата в незавершённую партию
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

let _rejoinData = null;

function showRejoinBanner(data) {
  data._rejoinReceivedAt = Date.now(); // фиксируем момент получения данных
  _rejoinData = data;
  const banner = document.getElementById('rejoin-banner');
  const info   = document.getElementById('rejoin-info');
  if (!banner) return;
  const moves = data.moves ? data.moves.length : 0;
  const colorRu = data.color === 'white' ? 'Белые ♙' : 'Чёрные ♟';
  if (info) info.textContent = `Соперник: ${data.opponent} · ${colorRu} · ${moves} ход${moves === 1 ? '' : moves < 5 ? 'а' : 'ов'} сыграно`;
  banner.style.display = 'flex';
  // Автоскрыть через 30 секунд
  clearTimeout(banner._timer);
  banner._timer = setTimeout(hideRejoinBanner, 30000);
}

function hideRejoinBanner() {
  const banner = document.getElementById('rejoin-banner');
  if (banner) banner.style.display = 'none';
  clearTimeout(banner?._timer);
}

function doRejoin() {
  if (!_rejoinData) return;
  const data = _rejoinData;
  _rejoinData = null;
  _currentGameData = data; // сохраняем для повторного реджойна при уходе со страницы
  hideRejoinBanner();

  // Корректируем оставшееся время: пока юзер смотрел на баннер — время шло
  if (data._rejoinReceivedAt && data.whiteTime !== undefined) {
    const elapsed = (Date.now() - data._rejoinReceivedAt) / 1000;
    // turn: белые ходят на нечётных полуходах (1,3,5...), чёрные на чётных
    const isWhiteTurn = (data.moves?.length ?? 0) % 2 === 0;
    if (isWhiteTurn) data.whiteTime = Math.max(0, data.whiteTime - elapsed);
    else             data.blackTime = Math.max(0, data.blackTime - elapsed);
  }

  toast(`Игра восстановлена! Вы ${data.color === 'white' ? 'белые ♙' : 'чёрные ♟'}`, 'success');

  // 1. Переключаем страницу синхронно
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
  const gameEl = document.getElementById('page-game');
  if (gameEl) gameEl.classList.add('active');
  history.pushState({}, '', '/game/' + (data.gameId || ''));

  // Рейтинги
  const myRating  = currentUser ? currentUser.rating : '?';
  const oppRating = data.opponentRating || '?';
  const topEl    = document.getElementById('rating-top');
  const bottomEl = document.getElementById('rating-bottom');
  if (topEl)    topEl.textContent    = 'Рейтинг: ' + oppRating;
  if (bottomEl) bottomEl.textContent = 'Рейтинг: ' + myRating;

  // 2. Ждём 50ms — за это время браузер гарантированно применит display к странице
  setTimeout(() => {
    // Убеждаемся что #chess-board в правильном контейнере
    const container = document.getElementById('game-board-container');
    const boardEl   = document.getElementById('chess-board');
    if (boardEl && container && boardEl.parentElement !== container) {
      container.appendChild(boardEl);
    }

    // 3. Запускаем игру (применяет ходы, таймер, рендер)
    chessBoard.startGame(data);

    // 4. Сообщаем серверу что мы снова в игре (обновляет socket в сессии)
    if (socket?.connected && data.gameId) {
      socket.emit('rejoin_game', { gameId: data.gameId });
    }

    // 5. Дополнительные рендеры с нарастающими задержками — страховка
    setTimeout(() => chessBoard.render(), 50);
    setTimeout(() => chessBoard.render(), 200);
  }, 50);
}

// ─── СПИСОК ОНЛАЙН ────────────────────────────────────────────
