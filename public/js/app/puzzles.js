// ═══════════════════════════════════════════════════════════
//  app/puzzles.js — пазлы: каталог, решатель, рейтинг, лидерборд
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

const PUZZLE_PIECE_IMG = {
  wk:'wK',wq:'wQ',wr:'wR',wb:'wB',wn:'wN',wp:'wP',
  bk:'bK',bq:'bQ',br:'bR',bb:'bB',bn:'bN',bp:'bP',
};

// Безопасный доступ к словарю i18n: CH_I18N может быть ещё не загружен,
// тогда возвращаем русский fallback (строки ниже дублируют ru.json).
function chT(key, fallback) {
  try {
    const v = window.CH_I18N ? window.CH_I18N.t(key) : undefined;
    if (v && v !== key) return v;
  } catch (e) { /* i18n недоступен */ }
  return fallback !== undefined ? fallback : key;
}
// Метка сложности задачи ("🟢 Лёгкая" / "🟡 Средняя" / "🔴 Сложная")
function pzDiffLabel(d) {
  if (d === 'easy')   return chT('puzzles.diff_easy',   '🟢 Лёгкая');
  if (d === 'medium') return chT('puzzles.diff_medium', '🟡 Средняя');
  if (d === 'hard')   return chT('puzzles.diff_hard',   '🔴 Сложная');
  return d || '';
}

const pz = {
  puzzle:null, topic:null, topicList:[], idx:0,
  board:[], flipped:false, solved:false, selected:null,
  lastMove:null, playerTurn:null, difficulty:'', offset:0,
  _dailyPuzzle:null,
  // История позиций для навигации стрелками
  _history:[],       // [{board, lastMove, label}]
  _historyIdx:-1,    // -1 = текущая позиция
  _legalDests:{},    // {fromSq: [toSq,...]} — легальные ходы текущей позиции
  _failed:false,     // была ли ошибка в текущей задаче
};

function pzFenToBoard(fen) {
  const board = Array(64).fill(null);
  const rows = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') { f += +ch; }
      else { board[(7-r)*8+f] = { color: ch===ch.toUpperCase()?'w':'b', type: ch.toLowerCase() }; f++; }
    }
  }
  return board;
}
function pzBoardTurn(fen) { return (fen.split(' ')[1]||'w'); }
function pzSqToUCI(sq) { return 'abcdefgh'[sq%8]+(Math.floor(sq/8)+1); }

function pzRender() {
  const el = document.getElementById('puzzle-board');
  if (!el) return;
  const sqSize = Math.floor((el.offsetWidth||360)/8);

  // Если просматриваем историю — берём ту позицию
  const viewingHistory = pz._historyIdx >= 0 && pz._historyIdx < pz._history.length;
  const displayBoard   = viewingHistory ? pz._history[pz._historyIdx].board   : pz.board;
  const displayLast    = viewingHistory ? pz._history[pz._historyIdx].lastMove : pz.lastMove;

  el.innerHTML = '';
  for (let i = 0; i < 64; i++) {
    const sq = pz.flipped
      ? (7 - i%8) + Math.floor(i/8)*8
      : (56 - Math.floor(i/8)*8 + i%8);
    const r = Math.floor(sq/8), f = sq%8;
    const light = (r+f)%2!==0;
    const isSelected  = !viewingHistory && pz.selected===sq;
    const isLastMove  = displayLast && (displayLast.from===sq || displayLast.to===sq);
    const legalDests  = !viewingHistory ? (pz._legalDests[sq] || []) : [];
    const isLegalDest = !viewingHistory && pz.selected !== null && (pz._legalDests[pz.selected]||[]).includes(sq);
    const piece       = displayBoard[sq];
    const isCapture   = isLegalDest && !!piece;

    let bg = light ? 'var(--board-light,#f0d9b5)' : 'var(--board-dark,#b58863)';
    if (isSelected)       bg = 'rgba(100,200,100,0.7)';
    else if (isLastMove)  bg = light ? 'rgba(205,210,106,0.85)' : 'rgba(170,162,58,0.85)';

    const div = document.createElement('div');
    div.style.cssText = `position:relative;display:flex;align-items:center;justify-content:center;cursor:pointer;background:${bg};`;

    // Подсветка легальных ходов (кружок или рамка при взятии)
    if (isLegalDest) {
      const hint = document.createElement('div');
      if (isCapture) {
        hint.style.cssText = `position:absolute;inset:0;border-radius:50%;box-shadow:inset 0 0 0 4px rgba(0,0,0,0.35);pointer-events:none;z-index:1;`;
      } else {
        const r = Math.floor(sqSize*0.27);
        hint.style.cssText = `position:absolute;width:${r*2}px;height:${r*2}px;border-radius:50%;background:rgba(0,0,0,0.22);pointer-events:none;z-index:1;`;
      }
      div.appendChild(hint);
    }

    if (piece) {
      const imgName = PUZZLE_PIECE_IMG[piece.color+piece.type];
      if (imgName) {
        const img = document.createElement('img');
        img.src = '/img/pieces/' + imgName + '.svg';
        img.style.cssText = 'position:relative;z-index:2;width:'+Math.floor(sqSize*0.85)+'px;height:'+Math.floor(sqSize*0.85)+'px;pointer-events:none;user-select:none;display:block;';
        img.draggable = false;
        div.appendChild(img);
      }
    }

    // Координаты (буква внизу по краю, цифра слева по краю)
    const isFirstFile = pz.flipped ? f === 7 : f === 0;
    const isLastRank  = pz.flipped ? r === 7 : r === 0;
    const coordColor  = light ? 'var(--board-dark,#b58863)' : 'var(--board-light,#f0d9b5)';
    if (isFirstFile) {
      const label = document.createElement('span');
      label.style.cssText = `position:absolute;top:2px;left:3px;font-size:${Math.max(9,sqSize*0.18)}px;font-weight:700;color:${coordColor};line-height:1;z-index:3;pointer-events:none;`;
      label.textContent = Math.floor(sq/8)+1;
      div.appendChild(label);
    }
    if (isLastRank) {
      const label = document.createElement('span');
      label.style.cssText = `position:absolute;bottom:2px;right:3px;font-size:${Math.max(9,sqSize*0.18)}px;font-weight:700;color:${coordColor};line-height:1;z-index:3;pointer-events:none;`;
      label.textContent = 'abcdefgh'[sq%8];
      div.appendChild(label);
    }

    if (!viewingHistory) {
      div.addEventListener('click', () => pzClickSquare(sq));
    }
    el.appendChild(div);
  }

  // Обновляем кнопки навигации (стрелки)
  pzUpdateNavArrows();
}

// Вычисляем реальные легальные ходы через ChessEngine
function pzComputeLegalDests() {
  pz._legalDests = {};
  if (!pz.puzzle || !pz.playerTurn) return;

  try {
    // Строим состояние: парсим FEN задачи и применяем все ходы из истории
    let state = ChessEngine.parseFEN(pz.puzzle.fen);
    for (const h of pz._history) {
      const moves = ChessEngine.legalMoves(state, h.lastMove.from);
      const m = moves.find(mv => mv.to === h.lastMove.to);
      if (m) state = ChessEngine.applyMove(state, m);
    }

    // Для каждой своей фигуры получаем легальные ходы
    for (let sq = 0; sq < 64; sq++) {
      const piece = state.board ? state.board[sq] : (pz.board[sq]);
      // Проверяем что это фигура игрока
      const p = pz.board[sq];
      if (!p || p.color !== pz.playerTurn) continue;

      const moves = ChessEngine.legalMoves(state, sq);
      if (moves && moves.length) {
        pz._legalDests[sq] = moves.map(m => m.to);
      }
    }
  } catch(e) {
    console.warn('[pzComputeLegalDests] fallback:', e.message);
    // Fallback — хотя бы запрещаем ход на свои фигуры
    for (let sq = 0; sq < 64; sq++) {
      const p = pz.board[sq];
      if (!p || p.color !== pz.playerTurn) continue;
      const dests = [];
      for (let to = 0; to < 64; to++) {
        if (to === sq) continue;
        const t = pz.board[to];
        if (t && t.color === pz.playerTurn) continue;
        dests.push(to);
      }
      pz._legalDests[sq] = dests;
    }
  }
}

function pzClickSquare(sq) {
  if (!pz.puzzle || pz.solved || pz._autoPlaying) return;
  if (pz._historyIdx >= 0) return; // в режиме просмотра истории — ходить нельзя

  const piece = pz.board[sq];

  if (pz.selected === null) {
    // Выбираем фигуру — только свою
    if (piece && piece.color === pz.playerTurn) {
      pz.selected = sq;
      pzRender();
    }
  } else {
    const from = pz.selected;

    // Клик на ту же фигуру — снимаем выделение
    if (from === sq) { pz.selected = null; pzRender(); return; }

    // Клик на другую свою фигуру — переключаемся на неё
    if (piece && piece.color === pz.playerTurn) {
      pz.selected = sq;
      pzRender();
      return;
    }

    // Проверяем что ход хотя бы формально возможен (не ходим на свою фигуру)
    const dests = pz._legalDests[from] || [];
    if (!dests.includes(sq)) {
      // Невозможный ход — просто снимаем выделение
      pz.selected = null;
      pzRender();
      return;
    }

    pz.selected = null;
    pzDoMove(from, sq);
  }
}

async function pzDoMove(from, to, promoChoice) {
  if (!pz.puzzle || pz.solved || pz._autoPlaying) return;

  // Определяем превращение пешки
  const movingPiece = pz.board[from];
  const toRank = Math.floor(to / 8);
  const isPromotion = movingPiece && movingPiece.type === 'p' &&
    ((movingPiece.color === 'w' && toRank === 7) ||
     (movingPiece.color === 'b' && toRank === 0));

  // Если превращение и выбор не указан — показываем диалог
  if (isPromotion && !promoChoice) {
    pzShowPromotionDialog(from, to);
    return;
  }

  const promo = isPromotion ? (promoChoice || 'q') : '';
  const move = pzSqToUCI(from) + pzSqToUCI(to) + promo;

  // Применяем ход на доске
  const nb = [...pz.board];
  nb[to] = isPromotion
    ? { color: movingPiece.color, type: promoChoice || 'q' }
    : nb[from];
  nb[from] = null;
  pz.board = nb; pz.lastMove = { from, to };
  // После хода игрока — теперь ходит соперник
  pz.playerTurn = pz.playerTurn === 'w' ? 'b' : 'w';

  // Пишем в историю
  pz._history.push({ board: [...pz.board], lastMove: { from, to }, label: move, byPlayer: true });
  pz._historyIdx = -1; // сбрасываем просмотр

  const ml = document.getElementById('puzzle-moves-list');
  if (ml) ml.textContent = (ml.textContent === '—' ? '' : ml.textContent + ' ') + move;
  pzRender();

  try {
    if (pz._startP) { try { await pz._startP; } catch (e) {} }
    const res = await apiPost('/puzzles/' + pz.puzzle.id + '/move', { moveIndex: pz._moveIndex || 0, move });

    if (res.restart) {
      // Сервер потерял сессию (например, перезапуск) — начинаем задачу заново.
      toast(chT('puzzles.session_restart', 'Сессия задачи сброшена — начни задачу заново'), 'info');
      puzzleReset();
      return;
    }

    if (res.illegal) {
      // Невозможный ход: штрафа нет, просто возвращаем фигуру.
      const fbI = document.getElementById('puzzle-feedback');
      if (fbI) { fbI.style.display = 'block'; fbI.className = 'puzzle-feedback wrong'; fbI.textContent = chT('puzzles.feedback_illegal', '✗ Так ходить нельзя'); }
      setTimeout(pzRollbackLastPlayerMove, 700);
      return;
    }

    if (!res.correct) {
      // Неверный ход
      pz._failed = true;
      const fb = document.getElementById('puzzle-feedback');
      if (fb) { fb.style.display = 'block'; fb.className = 'puzzle-feedback wrong'; fb.textContent = chT('puzzles.feedback_wrong', '✗ Неверно — попробуй ещё раз'); }
      // Рейтинг (Glicko-2) считает сервер и присылает в ответе на ход.
      if (res.rating && res.rating.delta) {
        const rc = document.getElementById('puzzle-rating-change');
        const rd = document.getElementById('puzzle-rating-delta');
        const rn = document.getElementById('puzzle-new-rating');
        if (rc) rc.style.display = 'block';
        if (rd) { rd.textContent = (res.rating.delta > 0 ? '+' : '') + res.rating.delta; rd.style.color = res.rating.delta > 0 ? '#2ecc71' : '#e74c3c'; }
        if (rn) rn.textContent = chT('puzzles.rating_prefix', 'Рейтинг:') + ' ' + res.rating.newRating;
      }
      setTimeout(() => {
        // Откатываем к позиции до неверного хода
        pz._history.pop();
        pz.board = pzFenToBoard(pz.puzzle.fen);
        // Восстанавливаем доску до текущего состояния (все правильные ходы до ошибки)
        for (const h of pz._history) {
          const nb2 = [...pz.board]; nb2[h.lastMove.to] = nb2[h.lastMove.from]; nb2[h.lastMove.from] = null;
          pz.board = nb2;
        }
        pz.lastMove = pz._history.length ? pz._history[pz._history.length-1].lastMove : null;
        pz.selected = null;
        pz._historyIdx = -1;
        // Восстанавливаем playerTurn: стартовый цвет + кол-во ходов игрока в истории
        const startTurn = pzBoardTurn(pz.puzzle.fen);
        const playerMovesCount = pz._history.filter(h => h.byPlayer).length;
        // Нечётное кол-во ходов игрока = сейчас ждём ответа соперника? Нет — в истории только законченные пары
        // Если последний ход в истории byPlayer=false (ответ соперника) — значит ходит игрок
        const lastH = pz._history[pz._history.length - 1];
        if (!lastH || !lastH.byPlayer) {
          // Ходит игрок (исходный цвет)
          pz.playerTurn = startTurn;
        } else {
          // Ходит соперник — но мы откатили ошибочный ход игрока, значит ходит игрок
          pz.playerTurn = startTurn;
        }
        // Проще: playerTurn всегда возвращается к исходному после отката
        // потому что история содержит только полные пары (ход игрока + ответ)
        pz.playerTurn = startTurn;
        // Поправка: если в истории нечётное число ходов (незавершённая пара) —
        // это ход соперника (byPlayer=false последний), значит снова ходит исходный цвет
        if (ml) ml.textContent = pz._history.filter(h=>h.byPlayer).map(h=>h.label).join(' ') || '—';
        if (fb) fb.style.display = 'none';
        pzComputeLegalDests();
        pzRender();
      }, 1200);
      return;
    }

    // Ход верный
    pz._moveIndex = (pz._moveIndex || 0) + 1;

    if (res.finished) {
      pzShowSuccess({
        ratingDelta: res.rating ? res.rating.delta : 0,
        newPuzzleRating: res.rating ? res.rating.newRating : undefined,
        unrated: !res.rating,   // повторное решение — рейтинг не меняется
      });
      return;
    }

    // Ответный ход автомата
    if (res.autoMove) {
      pz._autoPlaying = true;
      const fb = document.getElementById('puzzle-feedback');
      if (fb) { fb.style.display = 'block'; fb.className = 'puzzle-feedback correct'; fb.textContent = chT('puzzles.feedback_correct', '✓ Верно! Соперник отвечает...'); }
      setTimeout(() => {
        const autoFrom = pzUCIToSq(res.autoMove.slice(0, 2));
        const autoTo   = pzUCIToSq(res.autoMove.slice(2, 4));
        const autoPromo = res.autoMove.length === 5 ? res.autoMove[4] : null;
        const ab = [...pz.board];
        ab[autoTo] = autoPromo
          ? { color: ab[autoFrom] ? ab[autoFrom].color : 'w', type: autoPromo }
          : ab[autoFrom];
        ab[autoFrom] = null;
        pz.board = ab; pz.lastMove = { from: autoFrom, to: autoTo };
        // После хода соперника — снова ходит игрок
        pz.playerTurn = pz.playerTurn === 'w' ? 'b' : 'w';

        // Пишем ход соперника в историю
        pz._history.push({ board: [...pz.board], lastMove: { from: autoFrom, to: autoTo }, label: res.autoMove, byPlayer: false });

        if (ml) ml.textContent = (ml.textContent === '—' ? '' : ml.textContent + ' ') + res.autoMove;
        pz._autoPlaying = false;
        if (fb) fb.style.display = 'none';
        // После хода соперника — снова ход игрока, пересчитываем легальные
        pzComputeLegalDests();
        pzRender();
      }, 600);
    }
  } catch(e) {
    // Нет связи с сервером. Решения на клиенте нет (так и задумано), поэтому
    // локально проверять нечем — возвращаем фигуру и просим повторить.
    const fb = document.getElementById('puzzle-feedback');
    if (fb) { fb.style.display = 'block'; fb.className = 'puzzle-feedback wrong'; fb.textContent = chT('puzzles.feedback_network', 'Нет связи с сервером — попробуй ещё раз'); }
    setTimeout(pzRollbackLastPlayerMove, 1200);
  }
}

// Конвертация UCI-нотации (e2) в индекс клетки
// ── Диалог выбора фигуры при превращении пешки ───────────────
function pzShowPromotionDialog(from, to) {
  const old = document.getElementById('pz-promo-dialog');
  if (old) old.remove();

  const movingPiece = pz.board[from];
  const color = movingPiece ? movingPiece.color : 'w';
  const labelsW = { q:'♕ Ферзь', r:'♖ Ладья', b:'♗ Слон', n:'♘ Конь' };
  const labelsB = { q:'♛ Ферзь', r:'♜ Ладья', b:'♝ Слон', n:'♞ Конь' };
  const labels  = color === 'w' ? labelsW : labelsB;

  const overlay = document.createElement('div');
  overlay.id = 'pz-promo-dialog';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg-card,#1e1e2e);border:2px solid var(--accent,#c9a84c);border-radius:16px;padding:24px 32px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,.7);';
  box.innerHTML = '<div style="font-size:16px;font-weight:700;margin-bottom:16px;color:var(--text-primary)">Превращение пешки</div>';

  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex;gap:12px;justify-content:center;';
  ['q','r','b','n'].forEach(function(p) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary';
    btn.style.cssText = 'font-size:22px;min-width:64px;padding:10px 8px;cursor:pointer;';
    btn.textContent = labels[p];
    btn.addEventListener('click', function() { overlay.remove(); pzDoMove(from, to, p); });
    btns.appendChild(btn);
  });
  box.appendChild(btns);
  overlay.appendChild(box);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) { overlay.remove(); pz.selected = null; pzRender(); }
  });
  document.body.appendChild(overlay);
}


function pzUCIToSq(uci) {
  const col = uci.charCodeAt(0) - 97; // a=0..h=7
  const row = parseInt(uci[1]) - 1;   // 1=0..8=7
  return row * 8 + col;
}

// ─── Навигация по истории ходов пазла (стрелки) ───────────────
function pzUpdateNavArrows() {
  const btnFirst = document.getElementById('pz-nav-first');
  const btnPrev  = document.getElementById('pz-nav-prev');
  const btnNext  = document.getElementById('pz-nav-next');
  const btnLast  = document.getElementById('pz-nav-last');
  const hasHistory = pz._history.length > 0;
  const atStart = pz._historyIdx === 0 || (!hasHistory);
  const atEnd   = pz._historyIdx === -1 || pz._historyIdx === pz._history.length - 1;
  if (btnFirst) btnFirst.disabled = atStart;
  if (btnPrev)  btnPrev.disabled  = atStart;
  if (btnNext)  btnNext.disabled  = atEnd;
  if (btnLast)  btnLast.disabled  = atEnd;
}

function pzNavFirst() {
  if (!pz._history.length) return;
  pz._historyIdx = 0;
  pzRender();
}
function pzNavPrev() {
  if (!pz._history.length) return;
  if (pz._historyIdx === -1) pz._historyIdx = pz._history.length - 1;
  if (pz._historyIdx > 0) pz._historyIdx--;
  pzRender();
}
function pzNavNext() {
  if (!pz._history.length || pz._historyIdx === -1) return;
  if (pz._historyIdx < pz._history.length - 1) {
    pz._historyIdx++;
  } else {
    pz._historyIdx = -1; // вернулись к текущей позиции
  }
  pzRender();
}
function pzNavLast() {
  if (!pz._history.length) return;
  pz._historyIdx = -1; // текущая позиция = последняя
  pzRender();
}

// Клавиши стрелок на странице пазла
document.addEventListener('keydown', (e) => {
  const isPuzzlePage = document.getElementById('page-puzzle-solve')?.classList.contains('active');
  if (!isPuzzlePage) return;
  if (e.key === 'ArrowLeft')  { pzNavPrev();  e.preventDefault(); }
  else if (e.key === 'ArrowRight') { pzNavNext();  e.preventDefault(); }
  else if (e.key === 'ArrowUp')    { pzNavFirst(); e.preventDefault(); }
  else if (e.key === 'ArrowDown')  { pzNavLast();  e.preventDefault(); }
});

function pzShowSuccess(data) {
  pz.solved = true;
  const fb = document.getElementById('puzzle-feedback');
  const alreadySolved = data && (data.alreadySolved || data.unrated);
  const feedbackText = alreadySolved ? chT('puzzles.feedback_solved_already', '✓ Правильно! (повторная попытка — рейтинг не меняется)') : chT('puzzles.feedback_solved', '✓ Отлично! Задача решена!');
  if (fb) { fb.style.display = 'block'; fb.className = 'puzzle-feedback correct'; fb.textContent = feedbackText; }
  if (data && data.ratingDelta !== undefined && data.ratingDelta !== 0 && !alreadySolved) {
    const rc = document.getElementById('puzzle-rating-change');
    const rd = document.getElementById('puzzle-rating-delta');
    const rn = document.getElementById('puzzle-new-rating');
    if (rc) rc.style.display = 'block';
    if (rd) { rd.textContent = (data.ratingDelta > 0 ? '+' : '') + data.ratingDelta; rd.style.color = data.ratingDelta > 0 ? '#2ecc71' : '#e74c3c'; }
    if (rn) rn.textContent = chT('puzzles.rating_prefix', 'Рейтинг:') + ' ' + data.newPuzzleRating;
  }
  const nb = document.getElementById('puzzle-nav-btns');
  if (nb) nb.style.display = 'flex';
  pz._moveIndex = 0;
}

function puzzleFlip()  { pz.flipped=!pz.flipped; pzRender(); }
function puzzleReset() {
  if (!pz.puzzle) return;
  pz.solved=false; pz.selected=null; pz.lastMove=null; pz._moveIndex=0; pz._autoPlaying=false;
  pz._history=[]; pz._historyIdx=-1; pz._failed=false;
  pz.board=pzFenToBoard(pz.puzzle.fen);
  pzComputeLegalDests();
  const ml=document.getElementById('puzzle-moves-list'); if(ml) ml.textContent='—';
  const fb=document.getElementById('puzzle-feedback'); if(fb) fb.style.display='none';
  const nb=document.getElementById('puzzle-nav-btns'); if(nb) nb.style.display='none';
  const rc=document.getElementById('puzzle-rating-change'); if(rc) rc.style.display='none';
  pz._startP = pzStartSession(pz.puzzle);
  pzRender();
}

async function loadPuzzlesPage() {
  // Задача дня
  try {
    const p = await apiGet('/puzzles/daily');
    if (p) {
      pz._dailyPuzzle = p;
      const card=document.getElementById('puzzle-daily-card');
      const tEl=document.getElementById('daily-puzzle-title');
      const dEl=document.getElementById('daily-puzzle-desc');
      const diffEl=document.getElementById('daily-puzzle-diff');
      if(card) card.style.display='block';
      if(tEl) tEl.textContent=p.title;
      if(dEl) dEl.textContent=p.description||'';
      if(diffEl){ diffEl.textContent=pzDiffLabel(p.difficulty)||p.difficulty; diffEl.className='puzzle-diff-badge '+(p.difficulty||''); }
    }
  } catch(e) { console.warn('[Puzzles daily]',e.message); }

  // Темы
  const grid = document.getElementById('puzzle-topics-grid');
  if (grid) {
    try {
      const topics = await apiGet('/puzzles/topics');
      grid.innerHTML = '';
      if (!topics.length) {
        grid.innerHTML='<div style="color:var(--text-muted);font-size:14px;padding:16px;grid-column:1/-1">'+chT('puzzles.topics_empty','Тем пока нет — добавьте задачи через Admin API')+'</div>';
      } else {
        for (const t of topics) {
          const card=document.createElement('div'); card.className='puzzle-topic-card';
          card.innerHTML=`<div class="puzzle-topic-icon">${t.icon}</div>
            <div class="puzzle-topic-name">${escapeHtml(t.name)}</div>
            <div class="puzzle-topic-desc">${escapeHtml(t.description||'')}</div>
            <span class="puzzle-topic-count">${chT('puzzles.count_in_topic','{n} задач').replace('{n}', t.puzzleCount)}</span>`;
          card.addEventListener('click', ()=>openPuzzleTopic(t));
          grid.appendChild(card);
        }
      }
    } catch(e) {
      console.error('[Puzzles topics]', e.message);
      grid.innerHTML='<div style="color:var(--red);padding:16px;font-size:13px;grid-column:1/-1">'+chT('puzzles.topics_error','Ошибка загрузки тем: ')+escapeHtml(e.message)+'</div>';
    }
  }

  // Мини-лидерборд
  try {
    const lb = await apiGet('/puzzles/leaderboard');
    const el = document.getElementById('puzzle-leaderboard-mini');
    if (el) {
      if (!lb.length) { el.innerHTML='<div style="padding:16px;color:var(--text-muted);font-size:13px;text-align:center">'+chT('puzzles.lb_empty','Ещё никто не решал')+'</div>'; }
      else {
        el.innerHTML='';
        lb.slice(0,10).forEach((u,i)=>{
          const row=document.createElement('div'); row.className='puzzle-lb-row';
          row.innerHTML=`<div class="puzzle-lb-rank">${i<3?['🥇','🥈','🥉'][i]:u.rank}</div>
            <div class="puzzle-lb-name">${escapeHtml(u.username)}${pzOldSystemBadge(u)}</div>
            <div class="puzzle-lb-rating">${u.puzzleRating}</div>`;
          row.addEventListener('click',()=>openUserProfile(u.username));
          el.appendChild(row);
        });
      }
    }
  } catch(e) { console.warn('[Puzzles lb]',e.message); }
}

function openDailyPuzzle() { if (pz._dailyPuzzle) openPuzzleSolve(pz._dailyPuzzle, null); }

async function openPuzzleTopic(topic) {
  pz.topic=topic; pz.difficulty=''; pz.offset=0; pz.topicList=[];
  const tEl=document.getElementById('puzzle-topic-title');
  const dEl=document.getElementById('puzzle-topic-desc');
  if(tEl) tEl.textContent=topic.icon+' '+topic.name;
  if(dEl) dEl.textContent=topic.description||'';
  showPage('puzzle-topic');
  await fetchTopicPuzzles(true);
}

async function fetchTopicPuzzles(reset) {
  if (!pz.topic) return;
  const listEl=document.getElementById('puzzle-list');
  const moreEl=document.getElementById('puzzle-load-more');
  if (!listEl) return;
  if (reset) { listEl.innerHTML='<div style="padding:16px;color:var(--text-muted);font-size:13px">'+chT('puzzles.loading','Загрузка...')+'</div>'; pz.topicList=[]; }
  try {
    let url=`/puzzles?topic=${pz.topic.id}&limit=15&offset=${pz.offset}`;
    if (pz.difficulty) url+='&difficulty='+pz.difficulty;
    const puzzles=await apiGet(url);
    if (reset) listEl.innerHTML='';
    if (!puzzles.length && reset) {
      listEl.innerHTML='<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:14px">'+chT('puzzles.empty_topic','Задач пока нет')+'</div>';
      if(moreEl) moreEl.style.display='none'; return;
    }
    const base=pz.offset;
    pz.topicList.push(...puzzles);
    puzzles.forEach((p,i)=>{
      const gi=base+i;
      const item=document.createElement('div');
      const st=p.userStatus;
      item.className='puzzle-list-item'+(st==='solved'?' solved':st==='attempted'?' attempted':'');
      item.innerHTML=`<div class="puzzle-list-num">${gi+1}</div>
        <div class="puzzle-list-info">
          <div class="puzzle-list-title">${escapeHtml(p.title)}</div>
          <div class="puzzle-list-meta">
            <span class="puzzle-diff-badge ${p.difficulty}">${pzDiffLabel(p.difficulty)}</span>
            ${p.playCount?`<span>${chT('puzzles.solved_count','Решено: {count}').replace('{count}', p.correctCount+'/'+p.playCount)}</span>`:''}
          </div>
        </div>
        <div style="font-size:18px">${st==='solved'?'✅':st==='attempted'?'❌':'⬜'}</div>`;
      item.addEventListener('click',()=>{ pz.idx=gi; openPuzzleSolve(p, pz.topic); });
      listEl.appendChild(item);
    });
    if(moreEl) moreEl.style.display=puzzles.length===15?'block':'none';
    pz.offset+=puzzles.length;
  } catch(e) {
    console.error('[fetchTopicPuzzles]',e);
    if(reset&&listEl) listEl.innerHTML='<div style="padding:16px;color:var(--red);font-size:13px">Ошибка: '+escapeHtml(e.message)+'</div>';
  }
}

function loadMorePuzzles() { fetchTopicPuzzles(false); }

function filterPuzzleDiff(diff) {
  pz.difficulty=diff; pz.offset=0; pz.topicList=[];
  document.querySelectorAll('#puzzle-diff-filter .tc-btn').forEach(b=>b.classList.toggle('selected',b.dataset.diff===diff));
  fetchTopicPuzzles(true);
}

// Серверная сессия задачи: позицию и результат ведёт сервер, клиент шлёт только ходы.
async function pzStartSession(puzzle) {
  if (!currentUser || !puzzle || !puzzle.id) return;
  try { await apiPost('/puzzles/' + puzzle.id + '/start', {}); } catch (e) { /* первый ход создаст сессию сам */ }
}

// Откат последнего хода игрока (сервер ход не принял или нет связи).
function pzRollbackLastPlayerMove() {
  pz._history.pop();
  const last = pz._history[pz._history.length - 1];
  pz.board = last ? [...last.board] : pzFenToBoard(pz.puzzle.fen);
  pz.lastMove = last ? last.lastMove : null;
  pz.selected = null;
  pz._historyIdx = -1;
  pz.playerTurn = pzBoardTurn(pz.puzzle.fen);
  const ml = document.getElementById('puzzle-moves-list');
  if (ml) ml.textContent = pz._history.filter(h => h.byPlayer).map(h => h.label).join(' ') || '—';
  const fb = document.getElementById('puzzle-feedback');
  if (fb) fb.style.display = 'none';
  pzComputeLegalDests();
  pzRender();
}

function openPuzzleSolve(puzzle, topic) {
  pz.puzzle=puzzle; pz.solved=false; pz.selected=null; pz.lastMove=null; pz.flipped=false; pz._moveIndex=0; pz._autoPlaying=false;
  pz._history=[]; pz._historyIdx=-1; pz._failed=false;
  pz.topic=topic;
  pz.board=pzFenToBoard(puzzle.fen);
  pz.playerTurn=pzBoardTurn(puzzle.fen);
  if (pz.playerTurn==='b') pz.flipped=true;
  pzComputeLegalDests();
  // F5-restore (issue, исправлено): задача жила только в памяти и умирала при
  // перезагрузке страницы — на /puzzle-solve оставалась пустая рамка доски.
  // Кэшируем задачу в sessionStorage, чтобы pages['puzzle-solve'] мог
  // восстановить её после F5.
  try { sessionStorage.setItem('ch_current_puzzle', JSON.stringify({ puzzle, topic: topic || null })); } catch (e) {}
  const topicEl=document.getElementById('puzzle-solve-topic');
  const titleEl=document.getElementById('puzzle-solve-title');
  const descEl=document.getElementById('puzzle-solve-desc');
  const diffEl=document.getElementById('puzzle-solve-diff');
  const turnEl=document.getElementById('puzzle-whose-turn');
  const mlEl=document.getElementById('puzzle-moves-list');
  if(topicEl) topicEl.textContent=topic?topic.icon+' '+topic.name:'';
  if(titleEl) titleEl.textContent=puzzle.title;
  if(descEl)  descEl.textContent=puzzle.description||chT('puzzles.find_best_move','Найди лучший ход');
  if(diffEl)  { diffEl.textContent=pzDiffLabel(puzzle.difficulty); diffEl.className='puzzle-diff-badge '+(puzzle.difficulty||''); }
  if(turnEl)  turnEl.textContent=chT('puzzles.turn_prefix','Ход:')+' '+(pz.playerTurn==='w'?chT('puzzles.turn_white','⬜ Белые'):chT('puzzles.turn_black','⬛ Чёрные'));
  if(mlEl)    mlEl.textContent='—';
  const fb=document.getElementById('puzzle-feedback'); if(fb) fb.style.display='none';
  const nb=document.getElementById('puzzle-nav-btns'); if(nb) nb.style.display='none';
  const rc=document.getElementById('puzzle-rating-change'); if(rc) rc.style.display='none';
  showPage('puzzle-solve');
  pz._startP = pzStartSession(puzzle);
  setTimeout(()=>pzRender(), 60);
}

function goBackFromPuzzle() {
  // F5-restore: ушли из задачи — кэш в sessionStorage больше не нужен
  try { sessionStorage.removeItem('ch_current_puzzle'); } catch (e) {}
  showPage(pz.topic ? 'puzzle-topic' : 'puzzles');
}

async function puzzleNext() {
  const next = pz.topicList[pz.idx + 1];
  if (next) {
    pz.idx++;
    openPuzzleSolve(next, pz.topic);
    return;
  }
  // Дошли до конца загруженного списка — грузим ещё автоматически
  try {
    const loadingFb = document.getElementById('puzzle-feedback');
    if (loadingFb) { loadingFb.style.display='block'; loadingFb.className='puzzle-feedback'; loadingFb.textContent=chT('puzzles.loading_more','⏳ Загружаем следующие задачи...'); }

    let url = `/puzzles?topic=${pz.topic.id}&limit=15&offset=${pz.offset}`;
    if (pz.difficulty) url += '&difficulty=' + pz.difficulty;
    const newPuzzles = await apiGet(url);

    if (loadingFb) loadingFb.style.display = 'none';

    if (!newPuzzles || !newPuzzles.length) {
      toast(chT('puzzles.toast_topic_empty','Задачи в этой теме закончились!'), 'info');
      return;
    }

    // Добавляем в список и обновляем offset
    pz.topicList.push(...newPuzzles);
    pz.offset += newPuzzles.length;

    // Обновляем список задач на странице темы (если вернёмся туда)
    const listEl = document.getElementById('puzzle-list');
    if (listEl) {
      const base = pz.topicList.length - newPuzzles.length;
      newPuzzles.forEach((p, i) => {
        const gi = base + i;
        const item = document.createElement('div');
        const st = p.userStatus;
        item.className = 'puzzle-list-item' + (st==='solved'?' solved':st==='attempted'?' attempted':'');
        item.innerHTML = `<div class="puzzle-list-num">${gi+1}</div>
          <div class="puzzle-list-info">
            <div class="puzzle-list-title">${escapeHtml(p.title)}</div>
            <div class="puzzle-list-meta">
              <span class="puzzle-diff-badge ${p.difficulty}">${pzDiffLabel(p.difficulty)}</span>
              ${p.playCount?`<span>${chT('puzzles.solved_count','Решено: {count}').replace('{count}', p.correctCount+'/'+p.playCount)}</span>`:''}
            </div>
          </div>
          <div style="font-size:18px">${st==='solved'?'✅':st==='attempted'?'❌':'⬜'}</div>`;
        item.addEventListener('click', () => { pz.idx=gi; openPuzzleSolve(p, pz.topic); });
        listEl.appendChild(item);
      });
      // Прячем кнопку "загрузить ещё" если задач меньше 15 (значит это конец)
      const moreEl = document.getElementById('puzzle-load-more');
      if (moreEl) moreEl.style.display = newPuzzles.length === 15 ? 'block' : 'none';
    }

    // Открываем следующую задачу
    pz.idx++;
    openPuzzleSolve(pz.topicList[pz.idx], pz.topic);

  } catch(e) {
    console.error('[puzzleNext auto-load]', e);
    toast(chT('puzzles.toast_load_error','Ошибка загрузки следующих задач'), 'error');
  }
}

// Пометка у ников, чей рейтинг набран по старой системе и ещё не сброшен.
function pzOldSystemBadge(u) {
  if (!u || !u.oldSystem) return '';
  return '<span title="' + escapeHtml(chT('puzzles.lb_old_system_hint', 'Рейтинг набран по старой системе подсчёта и несопоставим с новым')) + '" ' +
    'style="margin-left:6px;font-size:10px;font-weight:700;padding:2px 7px;border-radius:999px;white-space:nowrap;' +
    'background:rgba(231,76,60,.14);color:#e74c3c;border:1px solid rgba(231,76,60,.35);vertical-align:middle">' +
    escapeHtml(chT('puzzles.lb_old_system', 'OLD Rating System')) + '</span>';
}

// Баннер с кнопкой сброса — показывается только тем, кто ещё на старой системе.
async function pzRenderRatingResetBox(listEl) {
  const panel = listEl && listEl.parentElement;
  if (!panel || !panel.parentElement) return;
  const old = document.getElementById('puzzle-rating-reset-box');
  if (old) old.remove();
  if (!currentUser) return;
  let st;
  try { st = await apiGet('/puzzles/rating/status'); } catch (e) { return; }
  if (!st || !st.canReset) return;

  const box = document.createElement('div');
  box.id = 'puzzle-rating-reset-box';
  box.style.cssText = 'display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:14px;padding:14px 16px;border-radius:14px;border:1px solid rgba(201,168,76,.35);background:linear-gradient(120deg,rgba(201,168,76,.12),rgba(201,168,76,.03))';
  box.innerHTML =
    '<div style="min-width:220px;flex:1;font-size:13px;line-height:1.5;color:var(--text-secondary)">' +
      '<div style="font-weight:700;color:var(--text-primary);margin-bottom:2px">' + escapeHtml(chT('puzzles.reset_title', 'Новая система рейтинга (Glicko-2)')) + '</div>' +
      escapeHtml(chT('puzzles.reset_text', 'Твой рейтинг набран по старой системе. Сбрось его, чтобы начать с нуля по новой.')) +
    '</div>';
  const btn = document.createElement('button');
  btn.className = 'btn btn-primary btn-sm';
  btn.textContent = chT('puzzles.reset_btn', 'Сбросить старый рейтинг');
  btn.addEventListener('click', () => pzResetOldRating(btn));
  box.appendChild(btn);
  panel.parentElement.insertBefore(box, panel);
}

async function pzResetOldRating(btn) {
  const ok = confirm(chT('puzzles.reset_confirm', 'Сбросить старый рейтинг задач и начать с 1200 по новой системе? Это действие необратимо. Решённые задачи останутся.'));
  if (!ok) return;
  if (btn) btn.disabled = true;
  try {
    const r = await apiPost('/puzzles/rating/reset', {});
    if (currentUser) currentUser.puzzle_rating = r && r.rating != null ? r.rating : 1200;
    toast(chT('puzzles.reset_done', 'Рейтинг сброшен — начинаем с 1200 по новой системе'), 'success');
    const box = document.getElementById('puzzle-rating-reset-box');
    if (box) box.remove();
    loadPuzzleLeaderboardFull();
  } catch (e) {
    if (btn) btn.disabled = false;
  }
}

async function loadPuzzleLeaderboardFull() {
  const el=document.getElementById('puzzle-leaderboard-full');
  if (!el) return;
  try {
    const lb=await apiGet('/puzzles/leaderboard');
    if (!lb.length) { el.innerHTML='<div style="padding:20px;text-align:center;color:var(--text-muted)">'+chT('puzzles.lb_empty_full','Нет данных')+'</div>'; return; }
    el.innerHTML='';
    const header=document.createElement('div');
    header.style.cssText='display:grid;grid-template-columns:44px 1fr 80px 80px 60px;padding:10px 16px;border-bottom:1px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted);font-weight:700';
    header.innerHTML='<div>#</div><div>'+chT('puzzles.lb_player','Игрок')+'</div><div style="text-align:right">'+chT('puzzles.lb_rating','Рейтинг')+'</div><div style="text-align:right">'+chT('puzzles.lb_solved','Решено')+'</div><div style="text-align:right">%</div>';
    el.appendChild(header);
    lb.forEach((u,i)=>{
      const row=document.createElement('div');
      row.style.cssText='display:grid;grid-template-columns:44px 1fr 80px 80px 60px;padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .12s;align-items:center';
      row.onmouseenter=()=>{ row.style.background='rgba(255,255,255,0.04)'; };
      row.onmouseleave=()=>{ row.style.background=''; };
      row.innerHTML=`<div style="font-weight:800;font-size:13px">${i<3?['🥇','🥈','🥉'][i]:u.rank}</div>
        <div style="font-weight:600;font-size:14px">${escapeHtml(u.username)}${pzOldSystemBadge(u)}</div>
        <div style="text-align:right;font-weight:700;color:var(--accent)">${u.puzzleRating}</div>
        <div style="text-align:right;font-size:13px;color:var(--text-secondary)">${u.puzzleSolved}</div>
        <div style="text-align:right;font-size:13px;color:var(--text-muted)">${u.accuracy}%</div>`;
      row.addEventListener('click',()=>openUserProfile(u.username));
      el.appendChild(row);
    });
    pzRenderRatingResetBox(el);
  } catch(e) { el.innerHTML='<div style="padding:20px;text-align:center;color:var(--red)">'+chT('puzzles.lb_error','Ошибка загрузки')+'</div>'; }
}

// ─── DM УВЕДОМЛЕНИЕ НА САЙТЕ (показывается на всех страницах) ──
