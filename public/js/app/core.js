// ═══════════════════════════════════════════════════════════
//  app/core.js — ядро: сокет, авторизация, страницы, модалки, зал вызовов
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

// ══════════════════════════════════════════════════════════════
//  Chess Home — Главный файл приложения
// ══════════════════════════════════════════════════════════════

// HTTP-клиент (apiGet/apiPost/parseApiResponse) и фильтр чата
// (MAT_WORDS/SPAM_WORDS/normalizeWord/normalize/containsBadWords)
// вынесены в общие модули /js/api.js и /js/utils.js (2А, 2В — унификация):
// index.html подключает их до app.js, глобальные имена доступны и здесь.

let socket = null;
let currentUser = null;

// i18n-хелпер: словарь может быть ещё не загружен — тогда русский fallback
function T(key, fallback) {
  try {
    const v = window.CH_I18N ? window.CH_I18N.t(key) : undefined;
    if (v && v !== key) return v;
  } catch (e) { /* i18n недоступен */ }
  return fallback !== undefined ? fallback : key;
}

function toggleLoginPasswordVisibility(btn) {
  const input = document.getElementById('login-password');
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
  btn.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
}
// Токен авторизации и device id больше НЕ хранятся в localStorage —
// они живут только в HttpOnly-cookie на сервере (ch_token, ch_device_id),
// недоступной для чтения из JS. Это защищает от кражи токена через XSS
// и от простого сброса/подмены device id через консоль браузера.
// Браузер сам прикладывает эти cookie к каждому запросу на тот же origin.

const STREAMERS = ['VLAD', 'Solo', 'aaa', 'GGbers'];


// ─── ФИЛЬТР ЧАТА ───────────────────────────────────────────
// Мат / реальные ругательства. Убрал сюда генерические оскорбления
// ("дебил","идиот","тварь","урод","мразь","чмо","аутист","даун",
// "жиробас") — это токсичность, а не мат, они были причиной того что
// фильтр казался слишком строгим. Настоящие ругательства остаются
// под запретом.
// ФИЛЬТР ЧАТА (MAT_WORDS/SPAM_WORDS/normalizeWord/normalize/
// containsBadWords) вынесен в /js/utils.js (2В, унификация) —
// единая реализация работает и в лобби, и в клубах.

// ─── ROUTER ───────────────────────────────────────────────────
const pages = {};

function showPage(name) {
  // Если уходим со страницы game во время активной онлайн-игры — показываем реджойн-баннер
  const gamePageActive = document.getElementById('page-game')?.classList.contains('active');
  if (gamePageActive && name !== 'game' && typeof chessBoard !== 'undefined') {
    const gId = chessBoard.gameId;
    const gMode = chessBoard.playerColor; // будет truthy только если игра запущена
    if (gId) {
      // Собираем данные текущей игры чтобы передать в баннер
      const currentGameData = _currentGameData;
      if (currentGameData) {
        currentGameData._rejoinReceivedAt = Date.now();
        showRejoinBanner(currentGameData);
      }
    }
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-links a').forEach(a => {
    a.classList.toggle('active', a.dataset.page === name);
  });
  const el = document.getElementById('page-' + name);
  if (el) {
    el.classList.add('active');
    if (pages[name]) pages[name]();
    if ((name === 'game' || name === 'analysis') && typeof chessBoard !== 'undefined' && !_loadingGameIntoAnalysis) {
      setTimeout(() => { chessBoard.render(); chessBoard.initSizeSlider(); }, 0);
    }
  }
  history.pushState({}, '', '/' + (name === 'home' ? '' : name));
}

// ─── API ──────────────────────────────────────────────────────
// apiGet/apiPost/parseApiResponse вынесены в /js/api.js (2А, унификация):
// единый HTTP-клиент для SPA и всех standalone-страниц.

// ─── TOAST ────────────────────────────────────────────────────

// ─── AUTH ──────────────────────────────────────────────────────
function updateAuthUI() {
  // Делегируем в универсальный хедер (header.js / window.CH)
  if (window.CH) {
    // Переопределяем openAuthModal чтобы открывал наши модалки
    CH.openAuthModal = (mode) => openModal('modal-' + mode);
    // Переопределяем logout чтобы использовал нашу функцию
    CH.logout = logout;
    CH.setCurrentUser(currentUser || null);
    return;
  }
  // Фолбек: если CH ещё не загружен — ждём и повторяем
  setTimeout(updateAuthUI, 50);
}

// Мёртвые функции дропдауна toggleUserMenu/closeUserMenu УДАЛЕНЫ:
// элемент #ch-udrop и его обработчики — в header.js.

async function handleRegister(e) {
  e.preventDefault();
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const errEl    = document.getElementById('reg-error');
  errEl.textContent = '';

  // Honeypot: передаём скрытое поле (у людей оно всегда пустое)
  const _hp = (document.getElementById('reg-hp') || {}).value || '';

  try {
    const data = await apiPost('/register', { username, password, _hp });
    currentUser = data.user; // сервер уже установил HttpOnly cookie ch_token
    closeModal('modal-register');
    updateAuthUI(); connectSocket();
    toast('Добро пожаловать, ' + currentUser.username + '! 👋', 'success');
    showPage('lobby');
  } catch (err) {
    errEl.textContent = err.message;
  }
}


function setLoginSubmitLoading(loading) {
  const btn = document.getElementById('login-submit-btn');
  if (!btn) return;
  btn.disabled = loading;
  btn.classList.toggle('loading', loading);
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  errEl.textContent = '';

  setLoginSubmitLoading(true);

  try {
    const data = await apiPost('/login', { username, password });
    currentUser = data.user; // сервер уже установил HttpOnly cookie ch_token
    closeModal('modal-login');
    updateAuthUI(); connectSocket();
    toast('С возвращением, ' + username + '! ♟️', 'success');
    showPage('lobby');
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    setLoginSubmitLoading(false);
  }
}

// --------------ВЫХОД----------------------------------------------

async function logout() {
  try { await apiPost('/logout', {}); } catch {}
  currentUser = null;
  if (socket) socket.disconnect();
  updateAuthUI(); showPage('home');
  toast('До свидания! 👋');
}
// -----------------------------------------------------------------
async function tryAutoLogin() {
  // Токен хранится только в HttpOnly cookie — JS не может её прочитать,
  // поэтому просто спрашиваем сервер, есть ли валидная сессия.
  try {
    currentUser = await apiGet('/me');
    updateAuthUI();
    connectSocket();
  } catch (e) {
    // Нет валидной cookie-сессии — пользователь просто не залогинен
  }
}

async function refreshCurrentUser() {
  if (!currentUser) return;
  try {
    const updated = await apiGet('/users/' + currentUser.username);
    currentUser = { ...currentUser, ...updated };
    updateAuthUI();
  } catch {}
}

// ─── SOCKET ───────────────────────────────────────────────────
let _socketAuthed = false;
let _pendingGlobalMsgs = [];

let _pendingGameplayEvents = [];
function emitGameplayEvent(event, payload) {
  if (_socketAuthed) { socket.emit(event, payload); return; }
  if (_pendingGameplayEvents.length < 50) {
    _pendingGameplayEvents.push({ event, payload });
  }
}
function flushPendingGameplayEvents() {
  if (!socket || !_socketAuthed) return;
  while (_pendingGameplayEvents.length) {
    const { event, payload } = _pendingGameplayEvents.shift();
    socket.emit(event, payload);
  }
}

function connectSocket() {
  if (!currentUser) return;
  socket = io();
  socket.on('connect', () => {
    _socketAuthed = false; // на реконнекте ждём новое auth_ok заново
    socket.emit('auth'); // токен сервер берёт из HttpOnly cookie в handshake
  });
  socket.on('disconnect', () => { _socketAuthed = false; });
  socket.on('auth_ok', () => {
    _socketAuthed = true;
    flushPendingGlobalMsgs();
    flushPendingGameplayEvents();
  });
  socket.on('online_count', count => {
  // Элемент #online-count в разметке не существует — реальный счётчик
  // в шапке это #chat-online-count. Раньше обращение к null кидало
  // TypeError (молча гасилось) и список в модалке не обновлялся.
  const el = document.getElementById('online-count') || document.getElementById('chat-online-count');
  if (el) el.textContent = count;
});
  socket.on('challenges_update', challenges => renderChallengeList(challenges));
  socket.on('game_start', data => {
    if (data.moves && data.moves.length > 0) {
      if (location.pathname === '/game/' + data.gameId) {
        _rejoinData = data;
        doRejoin();
      } else {
        showRejoinBanner(data);
      }
    } else if (data.tournamentId) {
      // Турнирная партия — сразу запускаем игру
      document.getElementById('pending-t-banner')?.remove();
      _pendingTournamentGame = null;
      toast(`⚔️ Турнирная партия! Вы ${data.color === 'white' ? 'белые ♙' : 'чёрные ♟'}`, 'success');
      startGameUI(data);
      // После старта — показываем кнопку возврата в турнир
      setTimeout(() => showTournamentReturnBanner(data.tournamentId, data.tournamentName, data.isInterclub), 300);
    } else {
      // Обычная игра — сразу
      const kind = data.rated === false ? ' (товарищеская)' : '';
      toast(`Игра! Вы ${data.color === 'white' ? 'белые ♙' : 'чёрные ♟'}${kind}`, 'success');
      startGameUI(data);
    }
  });
  socket.on('opponent_move', (data) => chessBoard.applyOpponentMove(data.move, data.whiteTime, data.blackTime));
  socket.on('move_confirmed', (data) => chessBoard.syncClockFromServer(data.whiteTime, data.blackTime));
  socket.on('move_rejected', (data) => {
    const reasons = {
      'not-your-turn': 'Ход не принят: рассинхронизация с сервером',
      'illegal-move':  'Ход не принят: незаконный ход',
    };
    toast(reasons[data.reason] || 'Ход не принят сервером', 'error');
    chessBoard.resyncFromServer(data);
  });
  socket.on('incoming_challenge', ({ from, socketId, rated, timeControl }) => showIncomingChallenge(from, socketId, rated, timeControl));
  // ── Анализ через домашний воркер (см. worker-client/) ──────────
  // Сервер прислал сырую UCI-строку от настоящего Stockfish на вашем
  // ПК — просто отдаём её тому же парсеру, что обрабатывает и локальный
  // движок в браузере (см. stockfish-ui.js:handleMessage).
  socket.on('analyze_line', (line) => {
    if (typeof StockfishAnalyzer !== 'undefined') StockfishAnalyzer.handleRemoteMessage(line);
  });
  // Воркеров нет свободных (или единственный отвалился прямо во время
  // анализа) — молча уходим на локальный анализ в браузере.
  socket.on('analyze_unavailable', () => {
    if (typeof StockfishAnalyzer !== 'undefined') StockfishAnalyzer.handleRemoteUnavailable();
  });
  socket.on('challenge_declined', by => toast(by + ' отклонил вызов', 'info'));
  socket.on('game_ended', data => {
    const wasInTournament = _currentGameData && _currentGameData.tournamentId;
    const tId = wasInTournament ? _currentGameData.tournamentId : null;
    const tName = wasInTournament ? _currentGameData.tournamentName : null;
    const tIsInterclub = wasInTournament ? _currentGameData.isInterclub : null;
    _currentGameData = null;
    _pendingTournamentGame = null;
    document.getElementById('pending-t-banner')?.remove();
    chessBoard.onGameEnded(data);
    // После турнирной партии — показываем кнопку возврата
    if (tId) {
      setTimeout(() => showTournamentReturnBanner(tId, tName, tIsInterclub), 800);
    }
  });
  socket.on('draw_offered', ({ from }) => {
    if (confirm(from + ' предлагает ничью. Принять?')) socket.emit('accept_draw', { gameId: chessBoard.gameId });
  });
  socket.on('game_chat', ({ from, message }) => appendChatMsg(from, message, false));

  // ── Реджойн: восстанавливаем чат после перезагрузки страницы ──
  socket.on('rejoin_ack', (data) => {
    if (data.chatMessages && data.chatMessages.length > 0) {
      // Восстанавливаем чат — board.js уже умеет это делать
      const el = document.getElementById('chat-messages');
      if (el) {
        el.innerHTML = '';
        el._restoringChat = true;
        data.chatMessages.forEach(m => {
          const isMine = m.from === currentUser?.username;
          appendChatMsg(m.from, m.message, isMine);
        });
        el._restoringChat = false;
      }
    }
  });

  socket.on('global_chat', msg => appendGlobalChatMsg(msg));
  socket.on('chat_msg_deleted', (msgId) => {
    const el = document.getElementById('chatmsg-' + msgId);
    if (el) el.remove();
  });
  socket.on('new_report', ({ report, total }) => {
    // Показываем уведомление только если текущий пользователь — admin
    if (currentUser?.role === 'admin') {
      const reasons = { cheat:'читы', abuse:'оскорбления', disconnect:'дисконнекты', multiaccounting:'мульти-аккаунты', spam:'спам', other:'другое' };
      toast('🚩 Новая жалоба на ' + report.targetUsername + ' (' + (reasons[report.reason]||report.reason) + '). Всего новых: ' + total, 'info');
    }
  });
  socket.on('error', msg => toast(msg, 'error'));
  // Бан аккаунта: сервер присылает 'banned' и рвёт соединение
  socket.on('banned', (data) => {
    toast('Ваш аккаунт заблокирован' + (data && data.reason ? ': ' + data.reason : ''), 'error');
    try { socket.disconnect(); } catch {}
    setTimeout(() => location.reload(), 2500);
  });
  // Бан в чате на время: сервер присылает 'chat_banned' { until }
  socket.on('chat_banned', (data) => {
    window._chatBannedUntil = (data && data.until) ? data.until : Date.now() + 5 * 60000;
    toast('Вы забанены в чате', 'error');
  });
  socket.on('tournament_created', (t) => {
    toast('🎯 Новый турнир: ' + t.name + ' (' + t.timeControl + ')', 'info');
  });
  socket.on('tournament_finished', (data) => {
    toast('🏆 Турнир завершён. Победитель: ' + (data?.winner || '—'), 'success');
  });

  socket.on('anticheat_compensation', (data) => {
    toast(data.message, 'success');
  });

  socket.on('tournament_banned', (data) => {
    toast(data.message, 'error');
    // Если игрок сейчас на странице турнира — перезагружаем её
    if (window.location.pathname.startsWith('/tournament')) {
      setTimeout(() => window.location.reload(), 2000);
    }
  });

  socket.on('anticheat_ban', (data) => {
    // Показываем только если это не про нас (нам уже показали tournament_banned)
    if (data.username !== currentUser?.username) {
      toast(data.message, 'error');
    }
  });

  // ─── ЛС: уведомление на любой странице кроме /inbox ─────────
  socket.on('dm_message', (msg) => {
    if (msg.to !== currentUser?.username) return;
    if (window.location.pathname.startsWith('/inbox')) return;
    showDmNotification(msg.from, msg.text);
  });
}

// ─── МОБИЛЬНОЕ МЕНЮ (делегируем в CH из header.js) ──────────────────────────
function toggleMobileNav() {
  if (window.CH) CH.openMobileNav();
}
function closeMobileNav() {
  if (window.CH) CH.closeMobileNav();
}


// Закрывать мобильное меню по Escape и свайпу назад
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMobileNav(); });

// ─── MODALS ───────────────────────────────────────────────────
function openModal(id)  {
  document.getElementById(id)?.classList.add('open');
}
function closeModal(id) {
  document.getElementById(id)?.classList.remove('open');
  document.querySelectorAll('.form-error').forEach(e => e.textContent = '');
}
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal-overlay')) e.target.classList.remove('open');
});

// ─── ONLINE COUNT ─────────────────────────────────────────────
async function fetchOnline() {
  try {
    const d = await apiGet('/online');
    // Элемента #online-count нет в index.html (реальный счётчик —
    // #chat-online-count): обращение к null ронило функцию TypeError'ом
    // на каждом вызове (раз в 10 секунд), и открытый список
    // онлайн-игроков никогда не обновлялся.
    const el = document.getElementById('online-count') || document.getElementById('chat-online-count');
    if (el) el.textContent = d.count;
    // Если модал открыт — обновляем список
    const modal = document.getElementById('modal-online-users');
    if (modal && modal.style.display !== 'none') {
      renderOnlineUsersList();
    }
  } catch {}
}


// ─── LOBBY ────────────────────────────────────────────────────
let selectedTC = '10+0';
let selectedColor = 'random';
let selectedRated = true;
let myCurrentChallengeId = null; // ID своего вызова в зале

pages['lobby'] = async () => {
  if (!currentUser) { toast('Войдите, чтобы зайти в игровой зал', 'info'); showPage('home'); return; }
  await fetchChallenges();
};

async function fetchChallenges() {
  try { renderChallengeList(await apiGet('/challenges')); } catch {}
}

function renderChallengeList(challenges) {
  const list = document.getElementById('challenge-list');
  if (!list) return;
  const countEl = document.getElementById('challenges-count');

  const myChallenge = challenges.find(c => c.from === currentUser?.username);
  myCurrentChallengeId = myChallenge?.id || null;

  if (!challenges.length) {
    if (countEl) countEl.textContent = '';
    list.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🏰</div><p>Нет открытых вызовов.<br>Создайте первый!</p></div>';
    return;
  }

  if (countEl) countEl.textContent = '(' + challenges.length + ')';
  list.innerHTML = '';

  challenges.forEach(c => {
    const isMe = c.from === currentUser?.username;
    const tcColor = c.color === 'random' ? '🎲 случайный' : c.color === 'white' ? '⬜ белые' : '⬛ чёрные';

    const item = document.createElement('div');
    item.className = 'challenge-item' + (isMe ? ' my-challenge' : '');
    if (isMe) item.style.borderColor = 'var(--accent)';

    // Аватар
    const av = document.createElement('div');
    av.className = 'player-avatar';
    av.style.cursor = 'pointer';
    av.textContent = c.from[0].toUpperCase();
    av.addEventListener('click', () => openUserProfile(c.from));
    item.appendChild(av);

    // Инфо
    const info = document.createElement('div');
    info.className = 'challenge-info';
    const nameEl = document.createElement('div');
    nameEl.className = 'challenge-name';
    nameEl.style.cursor = 'pointer';
    nameEl.textContent = c.from;
    if (isMe) {
      const badge = document.createElement('span');
      badge.style.cssText = 'color:var(--accent);font-size:11px;margin-left:6px';
      badge.textContent = '(вы)';
      nameEl.appendChild(badge);
    }
    nameEl.addEventListener('click', () => openUserProfile(c.from));
    const meta = document.createElement('div');
    meta.className = 'challenge-meta';
    meta.textContent = '⏱ ' + c.timeControl + ' · ' + tcColor + (c.rated === false ? ' · 🤝 товарищеская' : '');
    info.appendChild(nameEl);
    info.appendChild(meta);
    item.appendChild(info);

    // Кнопка
    if (isMe) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-danger btn-sm';
      btn.textContent = '✕ Отменить';
      btn.addEventListener('click', cancelChallenge);
      item.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.className = 'btn btn-primary btn-sm';
      btn.textContent = 'Играть';
      btn.addEventListener('click', () => {
        // См. фикс в postChallenge() — socket.connected не блокируем, Socket.IO
        // сам доставит emit после доли секунды переподключения.
        socket.emit('accept_challenge', c.id);
      });
      item.appendChild(btn);
    }

    list.appendChild(item);
  });
}

function selectTC(tc) {
  selectedTC = tc;
  document.querySelectorAll('.tc-btn[data-tc]').forEach(b => b.classList.toggle('selected', b.dataset.tc === tc));
}

function selectColor(color) {
  selectedColor = color;
  document.querySelectorAll('.color-btn').forEach(b => b.classList.toggle('selected', b.dataset.color === color));
}

function selectRated(rated) {
  selectedRated = rated;
  document.querySelectorAll('.rated-btn').forEach(b => b.classList.toggle('selected', b.dataset.rated === String(rated)));
}

function postChallenge() {
  if (!currentUser) { openModal('modal-login'); return; }
  if (!socket) { toast('Нет соединения. Войдите заново.', 'error'); return; }
  socket.emit('post_challenge', { timeControl: selectedTC, color: selectedColor, rated: selectedRated });
  toast(selectedRated ? 'Вызов выставлен в зал!' : 'Товарищеский вызов выставлен в зал!', 'success');
}

function cancelChallenge() {
  if (!socket) return;
  socket.emit('cancel_challenge');
  toast('Вызов отменён', 'info');
}

function acceptChallenge(id) {
  if (!currentUser) { openModal('modal-login'); return; }
  socket.emit('accept_challenge', id);
}

function showIncomingChallenge(from, socketId, rated = true, timeControl = '10+0') {
  // Уже открыт диалог другого вызова — новый отклоняем автоматически:
  // наслоившиеся блокирующие confirm() приводили к тому, что принятие
  // «старого» вызова ломало игру (игроки уходили в чужую партию).
  if (showIncomingChallenge._open) {
    socket.emit('decline_challenge', socketId);
    return;
  }
  showIncomingChallenge._open = true;
  const kind = rated === false ? 'товарищескую партию' : 'партию';
  let accept = false;
  try { accept = confirm(`${from} вызывает вас на ${kind} (${timeControl})! Принять?`); }
  finally { showIncomingChallenge._open = false; }
  if (accept) socket.emit('accept_direct_challenge', { fromSocketId: socketId, rated });
  else socket.emit('decline_challenge', socketId);
}
// -----------------------------------------------------------------------------------------------------------------
// ─── ПОИСК И ПРОФИЛИ ИГРОКОВ ──────────────────────────────────
