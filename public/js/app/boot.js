// ═══════════════════════════════════════════════════════════
//  app/boot.js — инициализация приложения (DOMContentLoaded)
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

document.addEventListener('DOMContentLoaded', async () => {

  // Клик по бейджу онлайн → страница /online
  document.body.addEventListener('click', (e) => {
    const badge = e.target.closest('#ch-online-badge, #online-badge-btn, .online-badge');
    if (badge) {
      e.stopPropagation();
      e.preventDefault();
      window.location.href = '/online';
    }
  });
  applySettings();

  // Фолбэк CH.openAuthModal со страниц без своей модалки (DRY-авторизация):
  // /#login или /#register — открываем соответствующую модалку на главной.
  const authHash = (location.hash || '').replace('#', '');
  if (authHash === 'login' || authHash === 'register') {
    history.replaceState(null, '', location.pathname + location.search);
    setTimeout(() => { if (window.CH) CH.openAuthModal(authHash); }, 300);
  }

  // Регистрируем puzzle страницы ДО showPage
  pages['puzzles'] = () => {
  loadPuzzlesPage();
  // Ждём полной отрисовки и сносим отступ у #app с !important
  setTimeout(() => {
    const app = document.getElementById('app');
    if (app) {
      app.style.setProperty('padding-top', '0', 'important');
      app.style.setProperty('margin-top', '0', 'important');
    }
    // Дополнительно убираем отступы у самой страницы задач
    const puzzlesPage = document.getElementById('page-puzzles');
    if (puzzlesPage) {
      puzzlesPage.style.setProperty('margin-top', '0', 'important');
      puzzlesPage.style.setProperty('padding-top', '0', 'important');
    }
    // Если есть пустой .page-header – скрываем его
    const header = document.querySelector('#page-puzzles .page-header');
    if (header && header.innerText.trim() === '') {
      header.style.display = 'none';
    }
  }, 150);
};
  pages['puzzle-topic']       = () => {};
  pages['puzzle-solve']       = () => {
    if (pz.puzzle && pz.board && pz.board.length) {
      setTimeout(() => pzRender(), 50);
      return;
    }
    try {
      const saved = sessionStorage.getItem('ch_current_puzzle');
      if (saved) {
        const { puzzle, topic } = JSON.parse(saved);
        if (puzzle && puzzle.fen) {
          openPuzzleSolve(puzzle, topic);
          return;
        }
      }
    } catch (e) {}
    // Восстановить нечего — безопасно возвращаем в каталог задач
    showPage('puzzles');
  };
  pages['puzzle-leaderboard'] = loadPuzzleLeaderboardFull;
  pages['storm']             = () => { location.href = '/storm.html'; };
  pages['storm-leaderboard'] = () => { location.href = '/storm.html?tab=leaderboard'; };
  pages['appeal']            = () => { if (typeof loadMyAppeals === 'function') loadMyAppeals(); };

  // fetchOnline не должна блокировать если сервер медленно отвечает
  fetchOnline().catch(() => {});

  await tryAutoLogin();
  updateAuthUI();

  const rawPath = location.pathname.replace(/^\//, '') || 'home';
  const validPages = ['home','game','analysis','editor','lobby','settings','privacy','terms','about','faq','profile','admin','appeal','puzzles','puzzle-topic','puzzle-solve','puzzle-leaderboard'];

  // Поддержка /profile/Username
  let targetPage;
  if (rawPath === 'profile' || rawPath.startsWith('profile/')) {
    targetPage = 'profile';
    // Извлекаем username из пути если есть
    const parts = rawPath.split('/');
    if (parts[1]) window._profileTarget = decodeURIComponent(parts[1]);
    else window._profileTarget = null;
  } else if (rawPath === 'puzzles' || rawPath.startsWith('puzzles/')) {
    targetPage = 'puzzles';
  } else if (rawPath === 'forum' || rawPath.startsWith('forum/')) {
    // Форум — отдельная страница, ничего не делаем
    targetPage = null;
  } else if (rawPath.startsWith('game/')) {
    // /game/UUID — показываем страницу игры, реджойн придёт через сокет
    targetPage = 'game';
    window._pendingGameId = rawPath.split('/')[1] || null;
  } else {
    targetPage = validPages.includes(rawPath) ? rawPath : 'home';
  }

  if (targetPage) {
    showPage(targetPage);
  }


  document.querySelectorAll('[data-page]').forEach(el => {
    el.addEventListener('click', e => { e.preventDefault(); showPage(el.dataset.page); });
  });

  // Запуск турнирной игры из sessionStorage (после отсчёта на странице турнира)
  try {
    const raw = sessionStorage.getItem('ch_launch_game');
    if (raw) {
      sessionStorage.removeItem('ch_launch_game');
      const gameData = JSON.parse(raw);
      if (gameData && gameData.gameId) {
        // Показываем страницу игры
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const gameEl = document.getElementById('page-game');
        if (gameEl) gameEl.classList.add('active');
        history.replaceState({}, '', '/game/' + gameData.gameId);
        // Запускаем игру после того как сокет подключится
        const launchWhenReady = () => {
          if (socket && socket.connected && typeof chessBoard !== 'undefined') {
            if (gameData.moves && gameData.moves.length > 0) {
              // Реджойн
              chessBoard.startGame(gameData);
              socket.emit('rejoin_game', { gameId: gameData.gameId });
            } else {
              startGameUI(gameData);
              if (gameData.tournamentId) {
                setTimeout(() => showTournamentReturnBanner(gameData.tournamentId, gameData.tournamentName, gameData.isInterclub), 300);
              }
            }
          } else {
            setTimeout(launchWhenReady, 100);
          }
        };
        setTimeout(launchWhenReady, 200);
      }
    }
  } catch(e) { console.warn('ch_launch_game parse error', e); }

  setInterval(() => {
    if (document.hidden) return;
    if (socket && socket.connected) {
      // Список онлайн-пользователей обновляем только если открыт модал
      const modal = document.getElementById('modal-online-users');
      if (!modal || modal.style.display === 'none') return;
    }
    fetchOnline();
  }, 10000);
});
// ══════════════════════════════════════════════════════════════
//  PUZZLE MODULE
// ══════════════════════════════════════════════════════════════
