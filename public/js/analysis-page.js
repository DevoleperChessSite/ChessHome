// ═══════════════════════════════════════════════════════════
//  analysis-page.js — отдельная страница «Анализ партии» (/analysis)
// ═══════════════════════════════════════════════════════════
//  Вынесено из SPA (index.html + app/analysis.js). Логика загрузки FEN/PGN
//  не менялась; заменены SPA-хуки (pages['analysis'], showPage) на
//  собственный запуск. Обычный классический скрипт, подключается после
//  board.js и stockfish-ui.js.

// stockfish-ui.js и board.js проверяют глобальный socket (удалённый движок)
let socket = null;

// ─── i18n-хелпер (как в SPA: app/core.js) ───────────────────
function T(key, fallback) {
  try {
    const v = window.CH_I18N ? window.CH_I18N.t(key) : undefined;
    if (v && v !== key) return v;
  } catch (e) { /* i18n недоступен */ }
  return fallback !== undefined ? fallback : key;
}

// ─── Настройки интерфейса (как в SPA: app/settings.js) ──────
// board.js проверяет typeof getSettings === 'function' (звуки, подсказки, координаты)
function getSettings() {
  const defaults = { sounds: true, hints: true, coords: true, animation: true, boardLight: '#f0d9b5', boardDark: '#b58863' };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('ch_settings') || '{}') }; } catch { return defaults; }
}
function applySettings() {
  const s = getSettings();
  document.documentElement.style.setProperty('--board-light', s.boardLight || '#f0d9b5');
  document.documentElement.style.setProperty('--board-dark',  s.boardDark  || '#b58863');
}
applySettings();

// ─── Запросы анализа: склеиваем подряд идущие вызовы ────────
// При старте страницы анализ может запрашиваться несколько раз подряд
// (loadAnalysis → loadFEN → явный requestAnalysis), а стрелки ← → тоже шлют
// запрос на каждый шаг. Один отложенный вызов вместо пачки.
(function () {
  const original = window.requestAnalysis;
  if (typeof original !== 'function') return;
  let timer = null;
  window.requestAnalysis = function () {
    clearTimeout(timer);
    timer = setTimeout(original, 150);
  };
})();

// ─── Удалённый движок (домашний воркер) — как в SPA, только для вошедших ───
// Гости считаются локальным Stockfish в браузере.
async function connectRemoteEngine() {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (!r.ok || typeof io !== 'function') return;
    socket = io();
    socket.on('analyze_line', line => StockfishAnalyzer.handleRemoteMessage(line));
    socket.on('analyze_unavailable', () => StockfishAnalyzer.handleRemoteUnavailable());
  } catch (e) { /* без сокета работает локальный движок */ }
}

// ─── Загрузка позиции / партии (код из app/analysis.js, без изменений логики) ───
function loadAnalysisFENFrom(fen) {
  if (!fen || typeof fen !== 'string') return;
  if (!isValidAnalysisFEN(fen)) {
    chessBoard.loadAnalysis();
    toast(T('game.fen_invalid', 'Неверный FEN'), 'error');
    return;
  }
  chessBoard.loadFEN(fen);
  const fenEl = document.getElementById('analysis-current-fen');
  if (fenEl) fenEl.textContent = fen;
  setTimeout(() => { if (typeof requestAnalysis === 'function') requestAnalysis(); }, 60);
}

// Базовая проверка FEN перед отдачей движку: распарсился и оба короля на месте
function isValidAnalysisFEN(fen) {
  try {
    const st = ChessEngine.parseFEN(fen);
    if (!st || !st.board || st.board.length !== 64) return false;
    let kings = 0;
    for (const p of st.board) { if (p && p.type === 'K') kings++; }
    return kings === 2;
  } catch (e) { return false; }
}

function loadGameIntoAnalysis(game) {
  if (!game.moves || !game.moves.length) {
    chessBoard.loadAnalysis();
    return;
  }
  chessBoard.loadGameMoves(game.moves);
  toast(T('game.loaded_for_analysis', 'Партия: {w} vs {b} · {n} ходов')
    .replace('{w}', game.white || '?').replace('{b}', game.black || '?')
    .replace('{n}', Math.floor(game.moves.length / 2)), 'success');
}

function loadAnalysisFEN() {
  const fen = document.getElementById('analysis-fen-input')?.value?.trim();
  if (!fen) return;
  loadAnalysisFENFrom(fen);
  toast('Позиция загружена', 'success');
}

function loadPGN() {
  const pgn = document.getElementById('pgn-input')?.value?.trim();
  if (!pgn) return;
  try {
    let state = ChessEngine.parseFEN(ChessEngine.START_FEN);
    const movesText = pgn.replace(/\[.*?\]\s*/g,'').trim();
    const cleaned   = movesText.replace(/\{[^}]*\}/g,'').replace(/\([^)]*\)/g,'');
    const tokens    = cleaned.split(/\s+/).filter(t => t && !t.match(/^\d+\./) && !['*','1-0','0-1','1/2-1/2'].includes(t));
    const histStates = [ChessEngine.deepClone(state)];
    for (const token of tokens) {
      const moves = ChessEngine.allLegalMoves(state);
      const found = moves.find(m => ChessEngine.toSAN(state, m) === token);
      if (!found) { toast('Не удалось распознать ход: ' + token, 'error'); break; }
      const san = ChessEngine.toSAN(state, found);
      state = ChessEngine.applyMove(state, found);
      state.history = [...histStates[histStates.length-1].history, { ...found, san }];
      histStates.push(ChessEngine.deepClone(state));
    }
    // Загружаем ФИНАЛЬНУЮ позицию (иначе пользователь видел бы пустую доску)
    chessBoard.loadFEN(ChessEngine.toFEN(histStates[histStates.length - 1]));
    toast(`PGN загружен: ${tokens.length} ходов`, 'success');
  } catch(e) { toast('Ошибка загрузки PGN', 'error'); console.error(e); }
}

// ─── Запуск страницы (вместо pages['analysis'] из SPA) ───────
function initAnalysisPage() {
  if (!StockfishAnalyzer.isReady()) StockfishAnalyzer.init();
  connectRemoteEngine();

  // Передача позиции/партии с других страниц идёт через sessionStorage/localStorage
  let pendingFen = null;
  try { pendingFen = sessionStorage.getItem('ch_analysis_fen'); } catch (e) {}
  let savedGame = null;
  try { savedGame = localStorage.getItem('ch_analysis_game'); } catch (e) {}

  if (pendingFen) {
    try { sessionStorage.removeItem('ch_analysis_fen'); } catch (e) {}
    // loadAnalysis() переводит доску в режим анализа (иначе ходы на ней не
    // анализировались бы), затем ставим переданную позицию.
    chessBoard.loadAnalysis();
    loadAnalysisFENFrom(pendingFen);
  } else if (savedGame) {
    try { localStorage.removeItem('ch_analysis_game'); } catch (e) {}
    try {
      loadGameIntoAnalysis(JSON.parse(savedGame));
    } catch (e) { chessBoard.loadAnalysis(); }
  } else {
    chessBoard.loadAnalysis();            // обычный запуск со стартовой позиции
  }

  chessBoard.render();
  chessBoard.initSizeSlider();

  // Текущий FEN под полем ввода
  setInterval(() => {
    const el = document.getElementById('analysis-current-fen');
    if (el) el.textContent = chessBoard.getFEN();
  }, 1000);
}

// Ждём словарь i18n, чтобы подписи панели (AI-комментатор) не мигали ключами
if (window.CH_I18N && window.CH_I18N.onReady) window.CH_I18N.onReady(initAnalysisPage);
else initAnalysisPage();