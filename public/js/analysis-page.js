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

// ═══ v2: движок вкл/выкл, настройки, авто-FEN/PGN, стрелка, график, разбор партии ═══
const $id = id => document.getElementById(id);
const sanTok = t => t.replace(/[+#!?]/g, '');
let _evals = [], _sig = '', _lastFen = '';

function buildPGN() {
  const h = chessBoard.history, fens = chessBoard.getFENs();
  if (!h.length) return '';
  const p = fens[0].split(' '); let n = +p[5] || 1, white = p[1] !== 'b', out = '';
  h.forEach((m, i) => { if (white) out += n + '. '; else if (i === 0) out += n + '... '; out += m.san + ' '; if (!white) n++; white = !white; });
  return out.trim();
}

function onBoardRender() {
  const fens = chessBoard.getFENs(), view = chessBoard.getViewFEN();
  const sig = fens.length + fens[0] + fens[fens.length - 1];
  if (sig !== _sig) { _sig = sig; _evals = []; }
  const fi = $id('analysis-fen-input'), pg = $id('pgn-input');
  if (fi && document.activeElement !== fi) fi.value = view;
  if (pg && document.activeElement !== pg) pg.value = buildPGN();
  const c = $id('move-counter'); if (c) c.textContent = chessBoard.viewIndex + ' / ' + (fens.length - 1);
  if (view !== _lastFen) { _lastFen = view; requestAnalysis(); }
  markMoves(); drawArrow(); drawGraph();
}
document.addEventListener('board:render', onBoardRender);
document.addEventListener('sf:lines', drawArrow);
document.addEventListener('sf:done', e => {
  if (e.detail.fen === chessBoard.getViewFEN() && e.detail.ev !== null) { _evals[chessBoard.viewIndex] = e.detail.ev; markMoves(); drawGraph(); }
});

// ── пометки ?! ? ?? в списке ходов ──
function markMoves() {
  document.querySelectorAll('#moves-table-body .move-cell').forEach((td, k) => {
    const a = _evals[k], b = _evals[k + 1];
    if (a == null || b == null) return;
    const A = Math.max(-10, Math.min(10, a)), B = Math.max(-10, Math.min(10, b));
    const loss = k % 2 ? B - A : A - B;
    const q = loss >= 3 ? ['blunder', 'Зевок'] : loss >= 1.5 ? ['mistake', 'Ошибка'] : loss >= 0.7 ? ['inacc', 'Неточность'] : null;
    if (q) { td.classList.add('q-' + q[0]); td.title = q[1] + ' (−' + loss.toFixed(1) + ')'; }
  });
}

// ── стрелки лучших ходов поверх доски ──
function drawArrow() {
  const board = $id('chess-board'); if (!board) return;
  board.querySelector('.sf-arrows')?.remove();
  const cfg = StockfishAnalyzer.cfg(), s = StockfishAnalyzer.snapshot();
  if (!cfg.enabled || !cfg.arrow || !s.lines.length || s.fen !== chessBoard.getViewFEN()) return;
  const flip = chessBoard.flipped;
  const pos = sq => { const f = sq.charCodeAt(0) - 97, r = +sq[1] - 1; return [((flip ? 7 - f : f) + .5) * 12.5, ((flip ? r : 7 - r) + .5) * 12.5]; };
  let h = '';
  s.lines.slice(0, 3).reverse().forEach((l, k, arr) => {
    const i = arr.length - 1 - k, u = l.pv[0]; if (!u) return;
    const [x1, y1] = pos(u.slice(0, 2)), [x2, y2] = pos(u.slice(2, 4));
    const a = Math.atan2(y2 - y1, x2 - x1), ex = x2 - Math.cos(a) * 4, ey = y2 - Math.sin(a) * 4, w = 2.3;
    const col = i === 0 ? 'rgba(201,168,76,.9)' : 'rgba(85,136,224,.6)';
    h += `<line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="${col}" stroke-width="${i ? 1.4 : 1.9}" stroke-linecap="round"/>` +
      `<polygon fill="${col}" points="${x2},${y2} ${ex - Math.sin(a) * w},${ey + Math.cos(a) * w} ${ex + Math.sin(a) * w},${ey - Math.cos(a) * w}"/>`;
  });
  board.style.position = 'relative';
  board.insertAdjacentHTML('beforeend', `<svg class="sf-arrows" viewBox="0 0 100 100" style="position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:9">${h}</svg>`);
}

// ── график оценки (клик — переход к ходу) ──
function drawGraph() {
  const box = $id('eval-graph'); if (!box) return;
  const n = chessBoard.getFENs().length, pts = [];
  _evals.forEach((v, i) => { if (v != null) pts.push([i, Math.max(-5, Math.min(5, v))]); });
  box.hidden = pts.length < 2; if (box.hidden) return;
  const X = i => (i / Math.max(1, n - 1)) * 300, Y = v => 30 - v / 5 * 28;
  const line = pts.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ');
  const area = `${X(pts[0][0])},30 ${line} ${X(pts[pts.length - 1][0])},30`;
  box.innerHTML = `<svg viewBox="0 0 300 60" preserveAspectRatio="none"><polygon points="${area}" fill="rgba(201,168,76,.22)"/><polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/><line x1="0" x2="300" y1="30" y2="30" stroke="var(--border-light)" stroke-width=".5"/><line x1="${X(chessBoard.viewIndex)}" x2="${X(chessBoard.viewIndex)}" y1="0" y2="60" stroke="var(--text-primary)" stroke-width="1" vector-effect="non-scaling-stroke"/></svg>`;
  box.onclick = e => { const r = box.getBoundingClientRect(); chessBoard.gotoMove(Math.round((e.clientX - r.left) / r.width * (n - 1))); };
}

async function reviewGame() {
  const btn = $id('review-btn');
  if (StockfishAnalyzer.reviewing) { StockfishAnalyzer.cancelReview(); return; }
  const fens = chessBoard.getFENs();
  if (fens.length < 2) return toast('Сначала загрузите партию или сыграйте ходы', 'error');
  if (!StockfishAnalyzer.cfg().enabled) StockfishAnalyzer.setEnabled(true);
  _evals = [];
  const res = await StockfishAnalyzer.review(fens, 12, (i, ev, n) => { _evals[i] = ev; btn.textContent = `⏹ ${i + 1}/${n}`; drawGraph(); markMoves(); });
  btn.textContent = '🔍 Разобрать партию';
  _lastFen = ''; requestAnalysis();
  if (res && res.length === fens.length) toast('Разбор готов: ошибки помечены в списке ходов', 'success');
}

// ── PGN: загрузка с полным списком ходов, автоматически при вводе ──
function loadPGN(silent) {
  const raw = $id('pgn-input')?.value?.trim();
  if (!raw) return;
  try {
    let st = ChessEngine.parseFEN(ChessEngine.START_FEN);
    const text = raw.replace(/\[[^\]]*\]/g, ' ').replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/\$\d+/g, ' ');
    const tokens = text.split(/\s+/).map(t => t.replace(/^\d+\.+/, '')).filter(t => t && !['*', '1-0', '0-1', '1/2-1/2'].includes(t));
    const moves = [];
    for (const tok of tokens) {
      const f = ChessEngine.allLegalMoves(st).find(m => sanTok(ChessEngine.toSAN(st, m)) === sanTok(tok));
      if (!f) { if (!silent) toast('Не удалось распознать ход: ' + tok, 'error'); break; }
      moves.push(f); st = ChessEngine.applyMove(st, f);
    }
    if (!moves.length) return;
    chessBoard.loadGameMoves(moves); chessBoard.gotoLast();
    if (!silent) toast(`PGN загружен: ${moves.length} полуходов`, 'success');
  } catch (e) { if (!silent) toast('Ошибка загрузки PGN', 'error'); console.error(e); }
}

function copyField(id) {
  navigator.clipboard?.writeText($id(id).value).then(() => toast('Скопировано', 'success'));
}
function toggleSfSettings() { const p = $id('sf-settings'); p.hidden = !p.hidden; }

function syncSupport() {
  if (!StockfishAnalyzer.isReady()) return;
  const noT = !StockfishAnalyzer.hasOpt('Threads');
  $id('set-threads').disabled = noT; $id('set-hash').disabled = !StockfishAnalyzer.hasOpt('Hash');
  $id('set-hint').textContent = noT ? 'Эта сборка Stockfish однопоточная: потоки и хеш недоступны.'
    : (!window.crossOriginIsolated ? 'Несколько потоков заработают, только если сервер отдаёт заголовки COOP/COEP.' : '');
}

function initV2UI() {
  const c = StockfishAnalyzer.cfg();
  $id('set-threads').max = Math.min(navigator.hardwareConcurrency || 4, 32);
  [['set-threads', 'threads'], ['set-hash', 'hash'], ['set-lines', 'multipv'], ['set-depth', 'depth'], ['set-arrow', 'arrow'], ['set-remote', 'remote']].forEach(([id, key]) => {
    const el = $id(id), chk = el.type === 'checkbox', out = $id(id + '-v');
    if (chk) el.checked = c[key]; else el.value = c[key];
    if (out) out.textContent = c[key];
    el.addEventListener('input', () => out && (out.textContent = el.value));
    el.addEventListener('change', () => { StockfishAnalyzer.set({ [key]: chk ? el.checked : +el.value }); if (key === 'arrow') drawArrow(); });
  });
  document.addEventListener('sf:ready', syncSupport);
  document.addEventListener('sf:toggle', drawArrow);
  const pg = $id('pgn-input'); let t;
  pg.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => loadPGN(true), 700); });
  $id('analysis-fen-input').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const v = e.target.value.trim();
    if (!isValidAnalysisFEN(v)) return toast('Неверный FEN', 'error');
    loadAnalysisFENFrom(v);
  });
  document.addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.ctrlKey || e.metaKey) return;
    if (e.key === 'f') chessBoard.flipBoard();
    else if (e.key === 'e') StockfishAnalyzer.setEnabled(!StockfishAnalyzer.cfg().enabled);
  });
  document.addEventListener('click', e => { if (!e.target.closest('#sf-settings') && !e.target.closest('#sf-gear')) $id('sf-settings').hidden = true; });
}
initV2UI();

// Ждём словарь i18n, чтобы подписи панели (AI-комментатор) не мигали ключами
if (window.CH_I18N && window.CH_I18N.onReady) window.CH_I18N.onReady(initAnalysisPage);
else initAnalysisPage();