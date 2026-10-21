// ═══════════════════════════════════════════════════════════
//  app/analysis.js — анализ партий: FEN, PGN, загрузка в анализ
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

let _loadingGameIntoAnalysis = false;

pages['analysis'] = () => {
  if (!StockfishAnalyzer.isReady()) StockfishAnalyzer.init();

  let pendingFen = null;
  try { pendingFen = sessionStorage.getItem('ch_analysis_fen'); } catch (e) {}
  if (pendingFen) {
    try { sessionStorage.removeItem('ch_analysis_fen'); } catch (e) {}
    _loadingGameIntoAnalysis = true;
    setTimeout(() => {
      _loadingGameIntoAnalysis = false;
      loadAnalysisFENFrom(pendingFen);
    }, 80);
    return;
  }

  // 2) Партия, переданная из истории профиля / модалки результата
  const savedGame = localStorage.getItem('ch_analysis_game');
  if (savedGame) {
    localStorage.removeItem('ch_analysis_game');
    try {
      const game = JSON.parse(savedGame);
      _loadingGameIntoAnalysis = true;
      setTimeout(() => {
        _loadingGameIntoAnalysis = false;
        loadGameIntoAnalysis(game);
      }, 80);
      return;
    } catch(e) {}
  }

  // 3) Обычный запуск анализа со стартовой позицией
  chessBoard.loadAnalysis();
};

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

function analyzeCurrentGame() {
  let moves = [];
  try {
    const hist = (chessBoard.state && chessBoard.state.history) || [];
    moves = hist
      .filter(h => h && h.from !== undefined && h.to !== undefined)
      .map(h => ({ from: h.from, to: h.to, promotion: h.promotion }));
  } catch (e) {}
  if (moves.length) {
    try { localStorage.setItem('ch_analysis_game', JSON.stringify({ moves })); } catch (e) {}
  }
  showPage('analysis');
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

// ─── ПРОЧЕЕ ───────────────────────────────────────────────────

function setBoardTheme(light, dark) {
  document.documentElement.style.setProperty('--board-light', light);
  document.documentElement.style.setProperty('--board-dark',  dark);
  saveSetting('boardLight', light);
  saveSetting('boardDark',  dark);
  chessBoard.render();
  toast('Тема доски изменена', 'success');
}

function loadAnalysisFEN() {
  const fen = document.getElementById('analysis-fen-input')?.value?.trim();
  if (!fen) return;
  loadAnalysisFENFrom(fen);
  toast('Позиция загружена', 'success');
}

setInterval(() => {
  const el = document.getElementById('analysis-current-fen');
  if (el && document.getElementById('page-analysis')?.classList.contains('active')) {
    el.textContent = chessBoard.getFEN();
  }
}, 2000);

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
    // Загружаем ФИНАЛЬНУЮ позицию: раньше брали histStates[0] — стартовую,
    // и после «PGN загружен: N ходов» пользователь видел пустую доску.
    chessBoard.loadFEN(ChessEngine.toFEN(histStates[histStates.length - 1]));
    toast(`PGN загружен: ${tokens.length} ходов`, 'success');
  } catch(e) { toast('Ошибка загрузки PGN', 'error'); console.error(e); }
}


// ─── РЕПОРТЫ ──────────────────────────────────────────────────
