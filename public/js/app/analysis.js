// ═══════════════════════════════════════════════════════════
//  app/analysis.js — анализ партий: переходы на страницу /analysis
// ═══════════════════════════════════════════════════════════
//  Сам анализ (доска, движок, FEN/PGN) вынесен в отдельную страницу
//  /analysis (public/analysis.html + public/js/analysis-page.js).
//  В SPA осталось только то, что нужно другим разделам.

// Читается в app/core.js (showPage); оставлена для совместимости.
let _loadingGameIntoAnalysis = false;

// Любой showPage('analysis') (меню, нижняя навигация, кнопки на главной)
// теперь ведёт на отдельную страницу.
(function () {
  const spaShowPage = window.showPage;
  window.showPage = function (name) {
    if (name === 'analysis') { window.location.href = '/analysis'; return; }
    return spaShowPage.apply(this, arguments);
  };
})();

// Кнопка «Анализ» в игре / в окне результата: передаём ходы текущей партии
// через localStorage (подхватывает страница /analysis) и переходим на неё.
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
  window.location.href = '/analysis';
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