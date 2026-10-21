// ═══════════════════════════════════════════════════════════
//  header/render.js — сборка и монтаж DOM хедера/дровер/нижней навигации
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного header.js.

(function () {
  'use strict';

  const CH = window.CH;
  const INT = CH._int;
  const { t, esc, _s, NAV, SUPPORT_LINK, BOTTOM_NAV, _injectStyles } = INT;

  // ─── СБОРКА NAV ───────────────────────────────────────────────────────────
  function _buildDesktopNav() {
    const sections = NAV.map(sec => {
      const links = sec.items.map(item => {
        const active = _s.activePage === item.id ? ' active' : '';
        return `<a href="${esc(item.href)}" class="${active}"
          onclick="event.preventDefault();(window.showPage&&${item.spa!==false}?showPage('${item.id}'):location.href='${esc(item.href)}')">
          <span class="ch-drop-icon">${item.icon}</span>${esc(t(item.i18nLabel))}
        </a>`;
      }).join('');
      return `<li class="ch-sec">
        <span class="ch-sec-btn">${esc(t(sec.i18nLabel))}<span class="ch-arr">▾</span></span>
        <div class="ch-drop">${links}</div>
      </li>`;
    }).join('');
    const supportLink = `<li class="ch-sec ch-sec-plain">
      <a href="${esc(SUPPORT_LINK.href)}" class="ch-support-link" target="_blank" rel="noopener">
        <span class="ch-support-icon">${SUPPORT_LINK.icon}</span>${esc(t(SUPPORT_LINK.i18nLabel))}
      </a>
    </li>`;
    return sections + supportLink;
  }
  function _buildDrawerLinks() {
    let h = '';
    NAV.forEach((sec, i) => {
      h += `<div class="ch-dr-section">${esc(t(sec.i18nLabel))}</div>`;
      sec.items.forEach(item => {
        const active = _s.activePage === item.id ? ' active' : '';
        h += `<a href="${esc(item.href)}" class="ch-dl-item${active}"
          onclick="event.preventDefault();(window.showPage&&${item.spa!==false}?showPage('${item.id}'):location.href='${esc(item.href)}');CH.closeMobileNav()">
          <span class="ch-dl-icon">${item.icon}</span>${esc(t(item.i18nLabel))}
        </a>`;
      });
      if (i < NAV.length - 1) h += `<div class="ch-dr-sep"></div>`;
    });
    h += `<div class="ch-dr-sep"></div>
      <a href="${esc(SUPPORT_LINK.href)}" class="ch-dl-item ch-support-link" target="_blank" rel="noopener">
        <span class="ch-dl-icon">${SUPPORT_LINK.icon}</span>${esc(t(SUPPORT_LINK.i18nLabel))}
      </a>`;
    h += `<div class="ch-dr-sep"></div>
      <a href="/settings" class="ch-dl-item"
        onclick="event.preventDefault();(window.showPage?showPage('settings'):location.href='/settings');CH.closeMobileNav()">
        <span class="ch-dl-icon">⚙️</span>${esc(t('header.nav_settings'))}
      </a>`;
    return h;
  }

  function _buildBottomNav() {
    return BOTTOM_NAV.map(item => {
      const active = _s.activePage === item.id ? ' active' : '';
      if (item.action === 'drawer') {
        return `<button class="ch-bn-item${active}" id="ch-bn-more" onclick="CH.openMobileNav()">
          <span class="ch-bn-icon">${item.icon}</span><span>${esc(t(item.i18nLabel))}</span>
        </button>`;
      }
      return `<a href="${esc(item.href)}" class="ch-bn-item${active}" id="ch-bn-${item.id}"
        onclick="event.preventDefault();(window.showPage&&${item.spa!==false}?showPage('${item.id}'):location.href='${esc(item.href)}')">
        <span class="ch-bn-icon">${item.icon}</span><span>${esc(t(item.i18nLabel))}</span>
      </a>`;
    }).join('');
  }

  // ─── МОНТИРОВАНИЕ ─────────────────────────────────────────────────────────
  function _mount() {
    _injectStyles();
    document.getElementById('ch-root')?.remove();
    document.getElementById('ch-header-root')?.remove();

    const root = document.createElement('div');
    root.id = 'ch-root';

    // Header
    const header = document.createElement('header');
    header.id = 'ch-header';
    header.innerHTML = `
      <a href="/" class="ch-logo"
        onclick="event.preventDefault();(window.showPage?showPage('home'):location.href='/')">
        <img src="/img/logo/logo.png" alt="" class="ch-logo-icon">
        <span class="ch-logo-text">Chess Home</span>
      </a>
      <ul id="ch-nav">${_buildDesktopNav()}</ul>
      <div id="ch-header-right"></div>
      <button id="ch-hamburger" aria-label="${esc(t('header.menu_aria'))}">
        <span></span><span></span><span></span>
      </button>
      <div id="ch-online-badge">
        <div class="ch-dot online-dot"></div>
        <span id="ch-online-count">${_s.onlineCount}</span>&nbsp;${esc(t('header.online_suffix'))}
      </div>
    `;

    // Overlay
    const overlay = document.createElement('div');
    overlay.id = 'ch-drawer-overlay';
    overlay.addEventListener('click', () => CH.closeMobileNav());

    // Drawer
    const drawer = document.createElement('div');
    drawer.id = 'ch-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.innerHTML = `
      <div class="ch-dr-head">
        <div class="ch-dr-logo"> <img src="/img/logo/logo.png" alt="ChessHome"> ChessHome </div>
        <button class="ch-dr-close" onclick="CH.closeMobileNav()">✕</button>
      </div>
      <div class="ch-dr-links" id="ch-drawer-links">${_buildDrawerLinks()}</div>
      <div class="ch-dr-foot">
        <div class="ch-dr-online">
          <div class="ch-dot"></div>
          <span id="ch-drawer-online-count">${_s.onlineCount}</span>&nbsp;${esc(t('header.players_online_suffix'))}
        </div>
        <div id="ch-drawer-user-area" style="margin-top:9px"></div>
      </div>
    `;

    // Свайп-закрытие
    let _sx = 0;
    drawer.addEventListener('touchstart', e => { _sx = e.touches[0].clientX; }, { passive: true });
    drawer.addEventListener('touchend', e => {
      if (e.changedTouches[0].clientX - _sx > 50) CH.closeMobileNav();
    }, { passive: true });

    // Bottom nav
    const bottomNav = document.createElement('nav');
    bottomNav.id = 'ch-bottom-nav';
    bottomNav.innerHTML = _buildBottomNav();

    root.appendChild(header);
    root.appendChild(overlay);
    root.appendChild(drawer);
    root.appendChild(bottomNav);

    // Плавающая кнопка "Друзья онлайн"
    const friendsFloat = document.createElement('div');
    friendsFloat.id = 'ch-friends-float';
    friendsFloat.innerHTML = '👥 ' + esc(t('header.friends_online_label'));
    friendsFloat.addEventListener('click', () => INT.showOnlineFriends && INT.showOnlineFriends());
    root.appendChild(friendsFloat);

    document.body.insertBefore(root, document.body.firstChild);
    document.body.style.paddingTop = '56px';

    // Events
    document.getElementById('ch-hamburger')
      .addEventListener('click', () => CH.openMobileNav());

    _bindGlobalListenersOnce();
  }

  // Глобальные обработчики (клик вне юзер-меню, Escape) должны быть навешаны
  // ровно один раз за всё время жизни страницы — иначе при пересборке хедера
  // (например, при смене языка) они бы задваивались.
  let _globalListenersBound = false;
  function _bindGlobalListenersOnce() {
    if (_globalListenersBound) return;
    _globalListenersBound = true;
    document.addEventListener('click', e => {
      if (!e.target.closest('#ch-user-wrap')) {
        document.getElementById('ch-udrop')?.classList.remove('open');
      }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        CH.closeMobileNav();
        document.getElementById('ch-udrop')?.classList.remove('open');
      }
    });
  }

  Object.assign(INT, { _buildDesktopNav, _buildDrawerLinks, _buildBottomNav,
    _mount, _bindGlobalListenersOnce });
})();