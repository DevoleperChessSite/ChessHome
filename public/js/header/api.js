// ═══════════════════════════════════════════════════════════
//  header/api.js — публичный API (window.CH), баннер документов, авто-запуск
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного header.js. Подключается ПОСЛЕДНИМ:
//  здесь auto-init и загрузчик sig.js.

(function () {
  'use strict';

  const INT = window.CH._int;
  const { t, esc, _s, _ensureI18nReady, _connectDmSocket, _playNotifSound,
    _mount, _renderHeaderRight, _buildDrawerLinks } = INT;

  // ─── PUBLIC API ────────────────────────────────────────────────────────────
  const CH = Object.assign(window.CH, {

    async initHeader(options = {}) {
      if (options?.activePage) _s.activePage = options.activePage;
      await _ensureI18nReady();
      _mount();
      _renderHeaderRight();
      CH.fetchOnlineCount();

      // Токен теперь в HttpOnly-cookie — восстанавливать юзера через
      if (!_s.currentUser) {
        fetch('/api/me', { credentials: 'same-origin' })
          .then(res => res.ok ? res.json() : null)
          .then(user => { if (user) CH.setCurrentUser(user); })
          .catch(() => {});
      } else {
        CH.fetchUnreadCount();
        _connectDmSocket();
        if (!_s.unreadPollTimer) {
          _s.unreadPollTimer = setInterval(() => { if (!document.hidden) CH.fetchUnreadCount(); }, 7000);
        }
      }
      return CH;
    },

    setCurrentUser(user) {
      _s.currentUser = user;
      // ch_user — просто кэш для мгновенной перерисовки хедера между
      // страницами, не источник авторизации (та живёт в HttpOnly-cookie).
      if (user) localStorage.setItem('ch_user', JSON.stringify(user));
      else localStorage.removeItem('ch_user');
      _renderHeaderRight();
      const dl = document.getElementById('ch-drawer-links');
      if (dl) dl.innerHTML = _buildDrawerLinks();
      if (user) {
        CH.fetchUnreadCount();
        _connectDmSocket();
        if (!_s.unreadPollTimer) {
          _s.unreadPollTimer = setInterval(() => { if (!document.hidden) CH.fetchUnreadCount(); }, 7000);
        }
      } else if (_s.unreadPollTimer) {
        clearInterval(_s.unreadPollTimer);
        _s.unreadPollTimer = null;
      }
    },

    // Вызывается со страницы /inbox: сообщает хедеру, какой диалог сейчас открыт,
    // чтобы не пиликать и не накручивать счётчик по уже открытому собеседнику
    setActiveDmPartner(partner) {
      _s.activeDmPartner = partner || null;
    },

    setActivePage(pageId) {
      _s.activePage = pageId;
      document.querySelectorAll('#ch-nav .ch-drop a').forEach(a => {
        const href = a.getAttribute('href');
        a.classList.toggle('active', href === '/' + pageId);
      });
      document.querySelectorAll('#ch-drawer-links .ch-dl-item').forEach(a => {
        const href = a.getAttribute('href');
        a.classList.toggle('active', href === '/' + pageId);
      });
      document.querySelectorAll('#ch-bottom-nav .ch-bn-item').forEach(btn => {
        btn.classList.toggle('active', btn.id === 'ch-bn-' + pageId);
      });
    },

    setOnlineCount(n) {
      _s.onlineCount = n;
      const a = document.getElementById('ch-online-count');
      const b = document.getElementById('ch-drawer-online-count');
      if (a) a.textContent = n;
      if (b) b.textContent = n;
      const leg = document.getElementById('online-count');
      if (leg && !leg.closest('#ch-root')) leg.textContent = n;
    },

    setUnreadCount(n) {
      const prev = _s.unreadCount;
      _s.unreadCount = n;

      // Золотой счётчик рядом с ником
      const nameEl = document.querySelector('#ch-user-btn .ch-user-name');
      if (nameEl) {
        let countEl = document.getElementById('ch-msg-count');
        if (n > 0) {
          if (!countEl) {
            countEl = document.createElement('span');
            countEl.id = 'ch-msg-count';
            countEl.className = 'ch-msg-count';
            nameEl.appendChild(countEl);
          }
          countEl.textContent = n > 99 ? '99+' : n;
        } else if (countEl) {
          countEl.remove();
        }
      }

      // Счётчик в выпадающем меню рядом с "Сообщения"
      const link = document.querySelector('#ch-udrop a[href="/inbox"]');
      if (link) {
        let badge = document.getElementById('ch-unread-badge');
        if (n > 0) {
          if (!badge) {
            badge = document.createElement('span');
            badge.id = 'ch-unread-badge';
            badge.className = 'ch-di-badge';
            link.appendChild(badge);
          }
          badge.textContent = n > 99 ? '99+' : n;
        } else if (badge) {
          badge.remove();
        }
      }

      // Если непрочитанных стало больше — проигрываем звук нового сообщения
      if (n > prev) _playNotifSound();
    },

    playNotifSound() { _playNotifSound(); },

    async fetchOnlineCount() {
      try {
        const r = await fetch('/api/online');
        if (r.ok) { const d = await r.json(); CH.setOnlineCount(d.count ?? d.online ?? 0); }
      } catch (e) {}
    },

    async fetchUnreadCount() {
      if (!_s.currentUser) return;
      try {
        // Считаем сумму непрочитанных по всем диалогам через уже существующий эндпоинт
        const r = await fetch('/api/dm/conversations', {
          credentials: 'same-origin'
        });
        if (r.ok) {
          const d = await r.json();
          const total = Array.isArray(d) ? d.reduce((sum, c) => sum + (c.unread || 0), 0) : 0;
          CH.setUnreadCount(total);
        }
      } catch (e) {}
    },

    openMobileNav() {
      const drawer  = document.getElementById('ch-drawer');
      const overlay = document.getElementById('ch-drawer-overlay');
      const burger  = document.getElementById('ch-hamburger');
      if (!drawer || !overlay) return;
      overlay.style.display = 'block';
      requestAnimationFrame(() => {
        overlay.classList.add('visible');
        drawer.classList.add('open');
        if (burger) burger.classList.add('open');
      });
      document.body.style.overflow = 'hidden';
    },

    closeMobileNav() {
      const drawer  = document.getElementById('ch-drawer');
      const overlay = document.getElementById('ch-drawer-overlay');
      const burger  = document.getElementById('ch-hamburger');
      if (!drawer || !overlay) return;
      drawer.classList.remove('open');
      overlay.classList.remove('visible');
      if (burger) burger.classList.remove('open');
      document.body.style.overflow = '';
      setTimeout(() => {
        if (!overlay.classList.contains('visible')) overlay.style.display = 'none';
      }, 280);
    },

    openAuthModal(mode = 'login') {
      // На странице может не быть своей модалки авторизации (profile/forum
      // удалили локальные дубли — DRY). Открываем её, если она есть,
      // иначе ведём на главную, где живёт каноничная форма.
      const el = document.getElementById('modal-' + mode);
      if (el) {
        if (typeof window.openModal === 'function') { window.openModal('modal-' + mode); return; }
        el.classList.add('open');
        return;
      }
      window.location = '/#' + mode;
    },

    async logout() {
      try { await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }); } catch (e) {}
      localStorage.removeItem('ch_user');
      _s.currentUser = null;
      if (_s.unreadPollTimer) { clearInterval(_s.unreadPollTimer); _s.unreadPollTimer = null; }
      _s.unreadCount = 0;
      if (typeof window.onCHLogout === 'function') window.onCHLogout();
      else if (typeof window.logout === 'function' && window.logout !== CH.logout) window.logout();
      else window.location = '/';
    },
  });

  // Алиасы — app.js вызывает эти глобально
  window.toggleMobileNav = () => CH.openMobileNav();
  window.openMobileNav   = () => CH.openMobileNav();
  window.closeMobileNav  = () => CH.closeMobileNav();
  window.CH = CH;

  // ── Баннер обновления документов (4.5) ───────────────────────────────────
  const POLICY_VERSION = 'v1.1-2025-06-12';
  window.dismissPolicyBanner = function () {
    try { localStorage.setItem('ch_policy_seen', POLICY_VERSION); } catch {}
    const b = document.getElementById('policy-banner');
    if (b) { b.style.transition = 'opacity 0.3s'; b.style.opacity = '0'; setTimeout(() => b.remove(), 300); }
  };
  function injectPolicyBanner() {
    if (document.getElementById('policy-banner')) return;
    try {
      if (localStorage.getItem('ch_policy_seen') === POLICY_VERSION) return;
    } catch {}
    const el = document.createElement('div');
    el.id = 'policy-banner';
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:9999;background:#1a2a3a;border:1px solid #3a5a7a;border-radius:12px;padding:16px 24px;max-width:480px;width:calc(100% - 48px);box-shadow:0 8px 32px rgba(0,0,0,0.5);display:flex;flex-direction:column;gap:10px';
    el.innerHTML =
      '<div style="display:flex;align-items:flex-start;gap:12px">' +
        '<span style="font-size:22px;flex-shrink:0">📋</span>' +
        '<div>' +
          '<div style="font-weight:700;color:#e0e0e0;margin-bottom:4px" data-i18n="home.policy_banner_title">' + esc(t('home.policy_banner_title')) + '</div>' +
          '<div style="color:#a0b8c8;font-size:13px;line-height:1.5" data-i18n="home.policy_banner_text">' + esc(t('home.policy_banner_text')) + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end">' +
        '<a href="/terms.html" style="font-size:13px;color:#7c9cbf;text-decoration:none;padding:6px 12px;border:1px solid #3a5a7a;border-radius:6px" data-i18n="home.policy_banner_read">' + esc(t('home.policy_banner_read')) + '</a>' +
        '<button onclick="dismissPolicyBanner()" style="font-size:13px;background:#3a6a9a;color:#fff;border:none;border-radius:6px;padding:6px 16px;cursor:pointer" data-i18n="home.policy_banner_ok">' + esc(t('home.policy_banner_ok')) + '</button>' +
      '</div>';
    document.body.appendChild(el);
  }

  // Авто-запуск
  // Баннер — после загрузки i18n-словаря (иначе t() вернёт сырые ключи).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { CH.initHeader(); _ensureI18nReady().then(injectPolicyBanner); });
  } else {
    CH.initHeader();
    _ensureI18nReady().then(injectPolicyBanner);
  }

  // При смене языка (кнопка в настройках) хедер не отслеживает data-i18n —
  // его текст собирается через innerHTML-шаблоны, поэтому проще и надёжнее
  // просто пересобрать шапку/меню/бургер целиком с уже новым словарём.
  document.addEventListener('ch-lang-changed', () => {
    if (!document.getElementById('ch-root')) return; // хедер ещё не смонтирован
    _mount();
    _renderHeaderRight();
  });

})();

// ── Сбор признаков окружения для защиты от мультиаккаунтов (см. /js/sig.js, privacy.html 2.4) ──
// Грузим один раз на любой странице, где подключён хедер. Защита от двойной загрузки внутри sig.js.
(function () {
  if (window.__chSig || document.querySelector('script[src="/js/sig.js"]')) return;
  var s = document.createElement('script');
  s.src = '/js/sig.js';
  s.defer = true;
  document.head.appendChild(s);
})();