// ═══════════════════════════════════════════════════════════
//  app/game.js — онлайн-партия: баннеры турниров, реджойн, старт UI
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

let _currentGameData = null; // текущие данные активной онлайн-игры для реджойна

// ── PENDING TOURNAMENT GAME ──────────────────────────────────
let _pendingTournamentGame = null;

function showPendingTournamentBanner(data) {
  document.getElementById('pending-t-banner')?.remove();

  const b = document.createElement('div');
  b.id = 'pending-t-banner';
  Object.assign(b.style, {
    position:'fixed', bottom:'28px', left:'50%', transform:'translateX(-50%)',
    background:'var(--bg-card)', border:'2px solid var(--accent)',
    borderRadius:'16px', padding:'16px 22px',
    display:'flex', alignItems:'center', gap:'16px',
    boxShadow:'0 8px 48px rgba(0,0,0,0.7)', zIndex:'99999',
    minWidth:'320px', maxWidth:'92vw', fontFamily:'var(--font-body)',
    animation:'ptbUp 0.4s cubic-bezier(0.34,1.56,0.64,1)'
  });

  const colorRu = data.color === 'white' ? '♙ Белые' : '♟ Чёрные';
  b.innerHTML = `
    <div style="font-size:28px">⚔️</div>
    <div style="flex:1;min-width:0">
      <div style="font-weight:700;font-size:14px;color:var(--text-primary)">Вас ждёт турнирная партия!</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-top:3px">
        ${colorRu} · vs <b>${escapeHtml(data.opponent||'?')}</b> · ${escapeHtml(data.timeControl||'')}
      </div>
    </div>
    <button onclick="goToTournamentGame()"
      style="background:linear-gradient(135deg,var(--accent),var(--accent-dark));
      color:#000;border:none;border-radius:10px;padding:10px 18px;
      font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap;flex-shrink:0">
      ⚔️ Перейти
    </button>
    <button onclick="document.getElementById('pending-t-banner')?.remove()"
      style="background:transparent;border:none;color:var(--text-muted);
      font-size:20px;cursor:pointer;padding:0 4px;flex-shrink:0;line-height:1">✕</button>`;

  document.body.appendChild(b);

  if (!document.getElementById('ptb-style')) {
    const s = document.createElement('style');
    s.id = 'ptb-style';
    s.textContent = '@keyframes ptbUp{from{opacity:0;transform:translateX(-50%) translateY(24px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
    document.head.appendChild(s);
  }
}

function goToTournamentGame() {
  const data = _pendingTournamentGame;
  if (!data || !data.tournamentId) return;
  document.getElementById('pending-t-banner')?.remove();
  // Переходим на страницу турнира — там socket получит game_start и запустит отсчёт
  window.location.href = (data.isInterclub ? '/tournament/interclub/' : '/tournament/') + data.tournamentId;
}

// ── БАННЕР ВОЗВРАТА В ТУРНИР ─────────────────────────────────
function showTournamentReturnBanner(tournamentId, tournamentName, isInterclub) {
  document.getElementById('t-ret-banner')?.remove();
  const b = document.createElement('div');
  b.id = 't-ret-banner';
  Object.assign(b.style, {
    position:'fixed', top:'72px', right:'18px',
    background:'var(--bg-card)', border:'2px solid var(--accent)',
    borderRadius:'14px', padding:'14px 18px',
    display:'flex', alignItems:'center', gap:'14px',
    boxShadow:'0 8px 40px rgba(201,168,76,0.35)', zIndex:'9999',
    minWidth:'260px', maxWidth:'90vw', fontFamily:'var(--font-body)',
    animation:'ptbUp 0.4s cubic-bezier(0.34,1.56,0.64,1)'
  });
  const label = tournamentName ? escapeHtml(tournamentName) : 'турнир';
  const tUrl = (isInterclub ? '/tournament/interclub/' : '/tournament/') + tournamentId;
  b.innerHTML = `
    <div style="font-size:24px">🏆</div>
    <div style="flex:1">
      <div style="font-weight:700;font-size:14px;color:var(--accent)">Вы в турнире</div>
      <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">${label}</div>
    </div>
    <button onclick="window.location.href='${tUrl}'"
      style="background:linear-gradient(135deg,var(--accent),var(--accent-dark));
      color:#000;border:none;border-radius:8px;padding:8px 14px;
      font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap">← В турнир</button>
    <button onclick="document.getElementById('t-ret-banner')?.remove()"
      style="background:transparent;border:none;color:var(--text-muted);
      font-size:18px;cursor:pointer;padding:2px 4px;flex-shrink:0">✕</button>`;
  document.body.appendChild(b);
  if (!document.getElementById('ptb-style')) {
    const s = document.createElement('style');
    s.id = 'ptb-style';
    s.textContent = '@keyframes ptbUp{from{opacity:0;transform:translateY(-16px)}to{opacity:1;transform:translateY(0)}}';
    document.head.appendChild(s);
  }
}

function startGameUI(data) {
  _currentGameData = data; // сохраняем для реджойн-баннера при уходе со страницы
  // Небольшая задержка — даём challenges_update отработать первым
  // чтобы DOM лобби не перезаписал наш переход на game
  setTimeout(() => {
    // Переключаем страницу напрямую (без pages['game'] чтобы не сбросить онлайн-игру)
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
    const gameEl = document.getElementById('page-game');
    if (gameEl) gameEl.classList.add('active');
    history.pushState({}, '', '/game/' + (data.gameId || ''));

    // Запускаем игру
    chessBoard.startGame(data);

    // Рейтинги
    const myRating  = currentUser ? currentUser.rating : '?';
    const oppRating = data.opponentRating || '?';
    const topEl    = document.getElementById('rating-top');
    const bottomEl = document.getElementById('rating-bottom');
    if (topEl)    topEl.textContent    = chT('game.rating_prefix', 'Рейтинг:') + ' ' + oppRating;
    if (bottomEl) bottomEl.textContent = chT('game.rating_prefix', 'Рейтинг:') + ' ' + myRating;

    // Второй рендер — гарантирует правильный контейнер
    setTimeout(() => chessBoard.render(), 50);
  }, 100);
}

// ─── GAME CHAT ────────────────────────────────────────────────
