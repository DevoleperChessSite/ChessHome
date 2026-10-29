// ══════════════════════════════════════════════════════════════
//  Chess Home — Модуль анализа Stockfish
// ══════════════════════════════════════════════════════════════

const StockfishAnalyzer = (() => {
  const KEY = 'ch_sf_cfg';
  const DEF = { enabled: true, depth: 18, multipv: 2, threads: 1, hash: 32, remote: true, arrow: true };
  let cfg = { ...DEF };
  try { cfg = { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch (e) {}
  let sf = null, ready = false, busy = false, queued = false, dirty = true, cur = null, lines = [];
  let opts = {}, usingRemote = false, remoteTimer = null, waiter = null, reviewing = false, raf = 0;
  const $ = id => document.getElementById(id);
  const emit = (n, d) => document.dispatchEvent(new CustomEvent(n, { detail: d }));
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (e) {} };

  // ── жизненный цикл ──────────────────────────────────────
  function init() {
    if (!cfg.enabled) { setStatus('off'); return false; }
    if (sf) return true;
    setStatus('loading');
    try {
      sf = new Worker('/js/stockfish.js');
      sf.onmessage = e => handle(e.data || e);
      sf.onerror = () => { setStatus('error'); sf = null; ready = false; };
      sf.postMessage('uci');
      return true;
    } catch (e) { setStatus('error'); return false; }
  }
  function applyOpts() {
    const set = (n, v) => opts[n] && sf.postMessage(`setoption name ${n} value ${v}`);
    set('Threads', cfg.threads); set('Hash', cfg.hash);
    sf.postMessage(`setoption name MultiPV value ${cfg.multipv}`);
  }
  function setEnabled(on) {
    cfg.enabled = on; save();
    if (!on) {
      stop(); reviewing = false;
      if (sf) { sf.terminate(); sf = null; }
      ready = busy = queued = false; lines = [];
      setStatus('off');
    } else { init(); if (cur) analyze(cur.fen, cfg.depth, true); else setStatus(ready ? 'ready' : 'loading'); }
    render(); emit('sf:toggle', on);
  }
  function set(p) {
    Object.assign(cfg, p); save();
    if ('multipv' in p || 'threads' in p || 'hash' in p) dirty = true;
    if (cur && cfg.enabled) analyze(cur.fen, cfg.depth, true);
  }
  function stop() {
    if (usingRemote) { if (typeof socket !== 'undefined' && socket) socket.emit('analyze_cancel'); usingRemote = false; clearTimeout(remoteTimer); }
    if (sf && busy) sf.postMessage('stop');
  }

  // ── запросы ─────────────────────────────────────────────
  function analyze(fen, depth, force) {
    depth = depth || cfg.depth;
    if (!force && cur && cur.fen === fen && cur.depth === depth && (busy || usingRemote || lines.length)) return;
    if (usingRemote) { try { socket.emit('analyze_cancel'); } catch (e) {} usingRemote = false; }
    cur = { fen, turn: fen.split(' ')[1] || 'w', depth };
    lines = []; schedule();
    if (!cfg.enabled) return;
    const canRemote = cfg.remote && cfg.multipv === 1 && !reviewing && typeof socket !== 'undefined' && socket && socket.connected;
    if (canRemote) {
      usingRemote = true; setStatus('thinking');
      socket.emit('analyze_request', { fen, depth });
      clearTimeout(remoteTimer);
      remoteTimer = setTimeout(() => { if (usingRemote) { usingRemote = false; local(); } }, 1500);
      return;
    }
    local();
  }
  function local() {
    if (!sf) { init(); return; }          // запустится по readyok
    if (!ready) return;
    if (busy) { queued = true; sf.postMessage('stop'); return; }
    start();
  }
  function start() {
    if (dirty) { applyOpts(); dirty = false; }
    busy = true; queued = false; setStatus('thinking');
    sf.postMessage('position fen ' + cur.fen);
    sf.postMessage('go depth ' + cur.depth);
  }

  // ── разбор вывода UCI ───────────────────────────────────
  function handle(line) {
    if (typeof line !== 'string') return;
    if (line.startsWith('option name ')) { const m = line.match(/^option name (\S+)/); if (m) opts[m[1]] = 1; }
    else if (line === 'uciok') { applyOpts(); dirty = false; sf.postMessage('isready'); }
    else if (line === 'readyok') { if (!ready) { ready = true; setStatus('ready'); emit('sf:ready', opts); if (cur) local(); } }
    else if (line.startsWith('info') && line.includes(' pv ')) info(line);
    else if (line.startsWith('bestmove')) done();
  }
  function info(line) {
    if (queued || !cur) return;
    const t = line.split(' '), g = k => { const i = t.indexOf(k); return i < 0 ? null : t[i + 1]; };
    const mate = g('mate'), cp = g('cp');
    if (mate === null && cp === null) return;
    const sign = cur.turn === 'b' ? -1 : 1, p = t.indexOf('pv');
    lines[(+g('multipv') || 1) - 1] = {
      depth: +g('depth'), cp: mate !== null ? null : sign * +cp,
      mate: mate !== null ? sign * +mate : null, pv: t.slice(p + 1, p + 13)
    };
    schedule();
  }
  function done() {
    busy = false;
    if (queued) { start(); return; }
    setStatus('ready');
    const l = lines[0];
    if (waiter) { const w = waiter; waiter = null; w(l ? pawns(l) : 0); }
    else if (l && !reviewing && typeof AICommentator !== 'undefined') AICommentator.onBestMove(pawns(l), l.mate !== null);
    emit('sf:done', { fen: cur.fen, line: l, ev: l ? pawns(l) : null });
  }
  function handleRemoteMessage(line) {
    clearTimeout(remoteTimer);
    handle(line);
    if (typeof line === 'string' && line.startsWith('bestmove')) usingRemote = false;
  }
  function handleRemoteUnavailable() { clearTimeout(remoteTimer); if (usingRemote) { usingRemote = false; local(); } }

  // ── разбор всей партии (быстрый проход по позициям) ─────
  const once = (fen, depth) => new Promise(res => { waiter = res; analyze(fen, depth, true); });
  async function review(fens, depth, onStep) {
    if (!cfg.enabled) return null;
    reviewing = true; const ev = [];
    try { for (let i = 0; i < fens.length && reviewing; i++) { ev[i] = await once(fens[i], depth); onStep(i, ev[i], fens.length); } }
    finally { reviewing = false; waiter = null; }
    return ev;
  }

  // ── отображение ─────────────────────────────────────────
  const pawns = l => l.mate !== null ? (l.mate > 0 ? 99 : -99) : l.cp / 100;
  const fmt = l => l.mate !== null ? (l.mate < 0 ? '-' : '') + 'M' + Math.abs(l.mate)
    : (l.cp > 0 ? '+' : '') + (l.cp / 100).toFixed(2);
  function sans(pv) {
    const out = [];
    try {
      let st = ChessEngine.parseFEN(cur.fen);
      for (const u of pv) {
        const f = u.charCodeAt(0) - 97 + (u.charCodeAt(1) - 49) * 8, t = u.charCodeAt(2) - 97 + (u.charCodeAt(3) - 49) * 8;
        const c = ChessEngine.allLegalMoves(st).filter(m => m.from === f && m.to === t);
        const m = c.find(x => String(x.promotion || '').toLowerCase() === (u[4] || '')) || c[0];
        if (!m) break;
        out.push(ChessEngine.toSAN(st, m)); st = ChessEngine.applyMove(st, m);
      }
    } catch (e) {}
    return out.length ? out : pv;
  }
  function pvText(pv) {
    const p = (cur.fen.split(' ')), s = sans(pv);
    let n = +p[5] || 1, white = p[1] !== 'b', txt = '';
    s.forEach((m, i) => {
      if (white) txt += n + '. '; else if (i === 0) txt += n + '… ';
      txt += m + ' '; if (!white) n++; white = !white;
    });
    return txt.trim();
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
  function render() {
    const l = lines[0], txt = (id, v) => { const e = $(id); if (e) e.textContent = v; };
    const ev = $('eval-score');
    if (ev) { ev.textContent = !cfg.enabled ? 'OFF' : l ? fmt(l) : '—'; ev.className = 'eval-score' + (l && pawns(l) < 0 ? ' negative' : ''); }
    txt('eval-depth', l ? 'Глубина: ' + l.depth : 'Глубина: —');
    txt('best-move-uci', l && cur ? (sans(l.pv.slice(0, 1))[0] || '—') : '—');
    const bar = $('eval-bar-fill');
    if (bar) bar.style.height = (l ? 100 / (1 + Math.exp(-0.45 * pawns(l))) : 50) + '%';
    const box = $('engine-lines'); if (!box) return;
    box.innerHTML = !cfg.enabled ? '<div class="eng-empty">Движок выключен — нажмите кнопку выше, чтобы включить</div>'
      : lines.filter(Boolean).map(x => `<div class="eng-line"><b class="eng-ev${pawns(x) < 0 ? ' neg' : ''}">${fmt(x)}</b><span class="eng-pv">${pvText(x.pv)}</span></div>`).join('')
        || '<div class="eng-empty">Думаю…</div>';
    emit('sf:lines');
  }
  function setStatus(s) {
    const dot = $('engine-dot'), text = $('engine-status-text'), tg = $('engine-toggle');
    if (dot) dot.className = 'engine-dot ' + s;
    if (text) text.textContent = { ready: 'Готов', thinking: 'Анализирует…', error: 'Ошибка загрузки (нужен /js/stockfish.js)', loading: 'Загрузка…', off: 'Выключен' }[s] || s;
    if (tg) tg.textContent = cfg.enabled ? '⏸ Движок включён' : '▶ Движок выключен';
  }

  return {
    init, analyze, stop, setEnabled, set, review, handleRemoteMessage, handleRemoteUnavailable,
    cancelReview: () => { reviewing = false; },
    cfg: () => ({ ...cfg }), hasOpt: n => !!opts[n], isReady: () => ready,
    get reviewing() { return reviewing; }, pawns,
    snapshot: () => ({ fen: cur && cur.fen, lines: lines.filter(Boolean) })
  };
})();

// Анализируем ПРОСМАТРИВАЕМУЮ позицию (а не последнюю в партии)
function requestAnalysis() {
  if (StockfishAnalyzer.reviewing) return;
  StockfishAnalyzer.analyze(chessBoard.getViewFEN ? chessBoard.getViewFEN() : chessBoard.getFEN());
}

// ══════════════════════════════════════════════════════════════
const AICommentator = (() => {
  let lastEval = null;      // последняя финальная оценка (перспектива белых)
  let lastPhraseAt = 0;     // антиспам: не чаще раза в 2.5 секунды
  const MIN_INTERVAL = 2500;

  function t(key, fallback) {
    try {
      const v = window.CH_I18N ? window.CH_I18N.t(key) : undefined;
      if (v && v !== key) return v;
    } catch (e) { /* i18n недоступен */ }
    return fallback;
  }

  function rand(n) { return 1 + Math.floor(Math.random() * n); }

  function say(text) {
    const box = document.getElementById('ai-commentary');
    if (!box || !text) return;
    box.textContent = text;
    // Перезапускаем анимацию появления фразы
    box.classList.remove('ai-say');
    void box.offsetWidth;
    box.classList.add('ai-say');
  }

  // Вызывается после bestmove: evalNum — оценка в перспективе белых,
  // isMate — движок нашёл мат в текущей позиции.
  function onBestMove(evalNum, isMate) {
    if (typeof evalNum !== 'number' || !isFinite(evalNum)) return;
    const now = Date.now();
    if (now - lastPhraseAt < MIN_INTERVAL) { lastEval = evalNum; return; }

    const prev = lastEval;
    lastEval = evalNum;

    // Первая позиция сессии — иногда здороваемся
    if (prev === null) {
      if (Math.random() < 0.5) { lastPhraseAt = now; say(t('ai.phrase_greeting_' + rand(3), null)); }
      return;
    }

    if (isMate) {
      lastPhraseAt = now;
      say(t('ai.phrase_mate_' + rand(3), null));
      return;
    }

    const delta = evalNum - prev;
    const absDelta = Math.abs(delta);

    if (absDelta >= 3) {
      lastPhraseAt = now;
      say(t((delta > 0 ? 'ai.phrase_blunder_white_' : 'ai.phrase_blunder_black_') + rand(3), null));
      return;
    }
    if (absDelta >= 1.5) {
      lastPhraseAt = now;
      say(t((delta > 0 ? 'ai.phrase_swing_white_' : 'ai.phrase_swing_black_') + rand(3), null));
      return;
    }
    if (absDelta >= 0.7 && Math.random() < 0.6) {
      lastPhraseAt = now;
      say(t('ai.phrase_small_' + rand(3), null));
      return;
    }
    // Позиция почти не изменилась — изредка вставляем нейтральную реплику
    if (Math.random() < 0.1) {
      lastPhraseAt = now;
      say(t('ai.phrase_quiet_' + rand(4), null));
    }
  }

  // Кнопка 🎲 — выдать фразу по запросу
  function manual() {
    const pool = Math.random();
    let key;
    if (pool < 0.4)      key = 'ai.phrase_quiet_' + rand(4);
    else if (pool < 0.7) key = 'ai.phrase_greeting_' + rand(3);
    else if (pool < 0.85) key = 'ai.phrase_small_' + rand(3);
    else                 key = 'ai.phrase_idle_' + rand(3);
    say(t(key, null));
  }

  function reset() { lastEval = null; }

  return { onBestMove, manual, reset };
})();

// Кнопка «Ещё фразу» на странице анализа
function nextAiPhrase() {
  if (typeof AICommentator !== 'undefined') AICommentator.manual();
}

// Инициализацию страницы анализа выполняет единственный хук pages['analysis']