// ═══════════════════════════════════════════════════════════
//  header/core.js — ядро хедера: i18n, меню, состояние, звук, DM-сокет
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного header.js. Общие внутренности частей
//  хедера передаются через window.CH._int (приватный реестр, не API).
//  Порядок подключения: core → styles → render → right → api.

(function () {
  'use strict';

  window.CH = window.CH || {};
  const CH = window.CH;
  const INT = CH._int = CH._int || {};

  const ADMINS = ['chesshome', 'marina64'];

  // ─── i18n ─────────────────────────────────────────────────────────────────
  // header.js подключается на КАЖДОЙ странице сайта, поэтому сам гарантирует
  // наличие /js/i18n.js — странице не нужно помнить о нём отдельно. Если
  // i18n.js уже подключён (как в settings.html) — просто дожидаемся его.
  // Запасные подписи для ключей, которых ещё нет в словарях /js/i18n.js
  // (пока ключ не добавлен в словарь — показываем русский текст вместо «header.xxx»).
  const I18N_FALLBACK = {
    'header.nav_vs_computer': 'Игра с компьютером',
    'header.nav_changelog': 'Обновления',
    'header.nav_blind': 'Слепые задачи',
  };
  function t(key, vars) {
    const r = (window.CH_I18N && window.CH_I18N.t) ? window.CH_I18N.t(key, vars) : key;
    if ((!r || r === key) && I18N_FALLBACK[key]) return I18N_FALLBACK[key];
    return r;
  }
  function _ensureI18nReady() {
    return new Promise(resolve => {
      function whenReady() {
        if (window.CH_I18N && window.CH_I18N.onReady) window.CH_I18N.onReady(resolve);
        else resolve(); // не блокируем хедер, если i18n почему-то не загрузился
      }
      if (window.CH_I18N) { whenReady(); return; }
      const existing = document.querySelector('script[src="/js/i18n.js"]');
      if (existing) {
        existing.addEventListener('load', whenReady);
        existing.addEventListener('error', resolve);
        return;
      }
      const s = document.createElement('script');
      s.src = '/js/i18n.js';
      s.onload = whenReady;
      s.onerror = resolve;
      document.head.appendChild(s);
    });
  }

  // ─── МЕНЮ ─────────────────────────────────────────────────────────────────
  // label заменён на i18nLabel (ключ словаря) — сам текст подставляется
  // функцией t() в момент отрисовки, а не при загрузке скрипта.
  const NAV = [
    {
      i18nLabel: 'header.sec_play',
      items: [
        { id: 'lobby',       i18nLabel: 'header.nav_play',   icon: '⚔️',  href: '/lobby' },
        { id: 'vs-computer', i18nLabel: 'header.nav_vs_computer', icon: '🖥️', href: '/vs-computer.html', spa: false },
        { id: 'tournaments', i18nLabel: 'header.nav_tournaments',  icon: '🏆',  href: '/tournaments', spa: false },
        { id: 'club-tournaments', i18nLabel: 'header.nav_club_tournaments', icon: '🏰', href: '/interclub-tournaments.html', spa: false },
      ]
    },
    {
      i18nLabel: 'header.sec_puzzles',
      items: [
        { id: 'puzzles', i18nLabel: 'header.nav_puzzles',        icon: '🧩', href: '/puzzles' },
        { id: 'storm',   i18nLabel: 'header.nav_storm',  icon: '⚡', href: '/storm', spa: false },
        { id: 'blind-puzzle', i18nLabel: 'header.nav_blind', icon: '🙈', href: '/blind-puzzle', spa: false },
      ]
    },
    {
      i18nLabel: 'header.sec_community',
      items: [
        { id: 'clubs', i18nLabel: 'header.nav_clubs',   icon: '🛡️', href: '/clubs', spa: false },
        { id: 'blog',  i18nLabel: 'header.nav_blog',   icon: '📰', href: '/blog', spa: false },
        { id: 'news',  i18nLabel: 'header.nav_news', icon: '📢', href: '/news', spa: false },
        { id: 'forum', i18nLabel: 'header.nav_forum',  icon: '💬', href: '/forum', spa: false },
      ]
    },
    {
      i18nLabel: 'header.sec_tools',
      items: [
        { id: 'analysis', i18nLabel: 'header.nav_analysis',   icon: '🔍', href: '/analysis', spa: false },
        { id: 'editor',   i18nLabel: 'header.nav_editor', icon: '✏️', href: '/editor' },
        { id: 'ai',       i18nLabel: 'header.nav_ai',      icon: '🤖', href: '/ai', spa: false },
      ]
    },
    {
      i18nLabel: 'header.sec_other',
      items: [
        { id: 'stats',     i18nLabel: 'header.nav_stats', icon: '📊', href: '/stats', spa: false },
        { id: 'age',       i18nLabel: 'header.nav_age',    icon: '🎂', href: '/age', spa: false },
        { id: 'dev-diary', i18nLabel: 'header.nav_dev_diary', icon: '📔', href: '/dev-diary', spa: false },
        { id: 'changelog', i18nLabel: 'header.nav_changelog', icon: '🆕', href: '/changelog', spa: false },
        { id: 'report',    i18nLabel: 'header.nav_report',             icon: '🚩', href: '/report', spa: false}
      ]
    },
  ];

  // Отдельная ссылка "Поддержать проект" — идёт ПОСЛЕ разделов меню,
  // не является дропдауном (как DONATE у lichess.org)
  const SUPPORT_LINK = {
    i18nLabel: 'header.nav_support',
    icon: '❤',
    href: 'https://pay.cloudtips.ru/p/b0c3a0aa',
  };

  const BOTTOM_NAV = [
    { id: 'home',     i18nLabel: 'header.nav_home', icon: '♚', href: '/' },
    { id: 'lobby',    i18nLabel: 'header.nav_play',  icon: '⚔️', href: '/lobby' },
    { id: 'puzzles',  i18nLabel: 'header.nav_puzzles',  icon: '🧩', href: '/puzzles' },
    // Фикс: id должен совпадать с идентификатором страницы ('analysis'),
    // иначе подсветка активного пункта нижней навигации не срабатывает.
    { id: 'analysis', i18nLabel: 'header.nav_analysis',    icon: '🔍', href: '/analysis', spa: false },
    { id: 'more',     i18nLabel: 'header.nav_more',     icon: '☰',  href: null, action: 'drawer' },
  ];

  // Подсветка активного пункта меню по адресу страницы (для отдельных .html-страниц,
  // которые не вызывают CH.setActivePage сами). Сравниваем без «.html» и без слэша в конце.
  function _detectActivePage() {
    try {
      const norm = p => (p || '/').replace(/\/+$/, '').replace(/\.html$/, '') || '/';
      const cur = norm(location.pathname);
      for (const sec of NAV) for (const it of sec.items) if (it.href && norm(it.href) === cur) return it.id;
    } catch (e) {}
    return null;
  }

  // ─── STATE ────────────────────────────────────────────────────────────────
  const _s = {
    currentUser: null,
    activePage: _detectActivePage(),
    onlineCount: 0,
    unreadCount: 0,
    unreadPollTimer: null,
    dmSocket: null,
    seenMsgIds: new Set(),
    activeDmPartner: null, // если на /inbox открыт диалог с этим юзером — не считаем непрочитанным
  };

  // ─── ЗВУК НОВОГО СООБЩЕНИЯ ──────────────────────────────────────────────
  // Свой собственный весёлый звук (не "как у Telegram/Facebook") —
  // короткое восходящее трезвучие через Web Audio API, без внешних файлов.
  let _audioCtx = null;
  function _getAudioCtx() {
    if (!_audioCtx) {
      try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { _audioCtx = null; }
    }
    return _audioCtx;
  }
  // Разблокируем аудио по первому клику пользователя (обход автоплей-политик браузера)
  function _unlockAudio() {
    const ctx = _getAudioCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  document.addEventListener('click', _unlockAudio, { once: true });
  document.addEventListener('keydown', _unlockAudio, { once: true });

  function _playNotifSound() {
    const ctx = _getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); }
    const now = ctx.currentTime;
    // Тихий короткий "поп" — как у обычной лички (одна нота, мягкая атака и спад)
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(620, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.13, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.16);
  }

  // ─── МГНОВЕННОЕ УВЕДОМЛЕНИЕ О НОВОМ СООБЩЕНИИ (через сокет, без ожидания опроса) ─
  // Работает на любой странице сайта, где подключён socket.io-client (window.io).
  // Если io недоступен на странице — тихо откатываемся на опрос fetchUnreadCount().
  function _connectDmSocket() {
    if (_s.dmSocket || !_s.currentUser) return;
    if (typeof window.io !== 'function') return; // на этой странице нет socket.io-client
    try {
      const sock = window.io();
      _s.dmSocket = sock;
      // Токен теперь в HttpOnly-cookie: сервер сам читает JWT из cookie в
      sock.on('connect', () => sock.emit('auth'));
      sock.on('dm_message', msg => {
        if (!msg || !_s.currentUser) return;
        if (msg.to !== _s.currentUser.username) return;   // не входящее мне
        if (msg.from === _s.currentUser.username) return; // моё же сообщение
        if (_s.seenMsgIds.has(msg.id)) return;             // уже обработали (например, на /inbox)
        _s.seenMsgIds.add(msg.id);
        if (_s.activeDmPartner === msg.from) return;        // диалог с ним уже открыт — не считаем непрочитанным
        CH.setUnreadCount(_s.unreadCount + 1);
      });
    } catch (e) {}
  }

  // ─── ХЕЛПЕРЫ ──────────────────────────────────────────────────────────────
  // esc — псевдоним общей escapeHtml из /js/utils.js (2Б, унификация):
  // локальная копия с ручными replace удалена. utils.js подключён на всех
  // страницах перед header.js.
  const esc = window.escapeHtml;
  function isAdmin(u) { return !!u && (u.role === 'admin' || ADMINS.includes(u.username)); }
  // Значок VIP приходит с сервера уже посчитанным (u.vip) — сам гаснет через месяц,
  // здесь просто рисуем картинку, если он активен.
  function vipBadgeHTML(u) {
    return (u && u.vip) ? `<img src="/img/vip.png" class="ch-vip-badge" alt="VIP" title="${esc(t('header.vip_player'))}">` : '';
  }
  function avatarHTML(u) {
    if (u.avatar) return `<img src="${esc(u.avatar)}" alt="">`;
    return esc((u.username || '?')[0].toUpperCase());
  }
  function goPage(id, href) {
    if (window.showPage) window.showPage(id);
    else window.location.href = href;
  }

  // ── Экспорт в общий реестр частей хедера ──
  Object.assign(INT, { ADMINS, I18N_FALLBACK, t, _ensureI18nReady, NAV, SUPPORT_LINK,
    BOTTOM_NAV, _detectActivePage, _s,
    _getAudioCtx, _unlockAudio, _playNotifSound, _connectDmSocket,
    esc, isAdmin, vipBadgeHTML, avatarHTML, goPage });
})();