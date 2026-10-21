// ═══════════════════════════════════════════════════════════
//  header/right.js — правая часть хедера (юзер-меню) и «Друзья онлайн»
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного header.js.

(function () {
  'use strict';

  const CH = window.CH;
  const INT = CH._int;
  const { t, esc, _s, isAdmin, vipBadgeHTML, avatarHTML } = INT;

  // ─── ФУНКЦИЯ ПОКАЗА ДРУЗЕЙ ОНЛАЙН ─────────────────────────────────────────
  async function showOnlineFriends() {
    if (!_s.currentUser) {
      if (typeof toast === 'function') toast(t('header.toast_login_to_see_friends'), 'info');
      else console.log(t('header.console_need_login'));
      return;
    }
    try {
      const res = await fetch('/api/follow/online-friends', {
        credentials: 'same-origin'
      });
      const data = await res.json();
      if (!data.length) {
        if (typeof toast === 'function') toast(t('header.toast_no_friends_online'), 'info');
        else console.log(t('header.toast_no_friends_online'));
        return;
      }
      let modal = document.getElementById('modal-online-friends');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-online-friends';
        modal.className = 'modal-overlay';
        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) modal.classList.remove('open'); });
      }
      modal.innerHTML = `
        <div class="modal" style="max-width:320px;text-align:center">
          <button class="modal-close" onclick="document.getElementById('modal-online-friends').classList.remove('open')">✕</button>
          <h2>👥 ${esc(t('header.friends_online_label'))}</h2>
          <div id="friends-list" style="max-height:300px;overflow-y:auto"></div>
        </div>`;
      const listDiv = modal.querySelector('#friends-list');
      listDiv.innerHTML = data.map(f => `
        <div style="display:flex;align-items:center;gap:10px;padding:8px;border-bottom:1px solid var(--border);cursor:pointer" onclick="window.location='/profile/${f.username}'">
          <div style="width:32px;height:32px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center">${f.username[0].toUpperCase()}</div>
          <div style="flex:1;text-align:left"><b>${f.username}</b><br><span style="font-size:11px">★ ${f.rating}</span></div>
          <div style="width:8px;height:8px;border-radius:50%;background:#2ecc71"></div>
        </div>
      `).join('');
      document.body.appendChild(modal);
      modal.classList.add('open');
    } catch(e) {
      if (typeof toast === 'function') toast(t('header.toast_error_loading_friends'), 'error');
      console.error(e);
    }
  }

  // ─── HEADER RIGHT ─────────────────────────────────────────────────────────
  function _renderHeaderRight() {
    const el = document.getElementById('ch-header-right');
    if (!el) return;
    const u = _s.currentUser;

    if (!u) {
      el.innerHTML = `<div class="ch-auth-buttons">
        <button class="ch-btn-ghost" onclick="CH.openAuthModal('login')">${esc(t('header.login'))}</button>
        <button class="ch-btn-primary" onclick="CH.openAuthModal('register')">${esc(t('header.register'))}</button>
      </div>`;
      const da = document.getElementById('ch-drawer-user-area');
      if (da) da.innerHTML = `<button class="ch-btn-primary" style="width:100%"
        onclick="CH.openAuthModal('login');CH.closeMobileNav()">${esc(t('header.login'))}</button>`;
      return;
    }

    const admin = isAdmin(u);
    el.innerHTML = `
      <div id="ch-user-wrap">
        <button class="ch-user-btn" id="ch-user-btn" aria-haspopup="true" aria-expanded="false">
          <div class="ch-ava">${avatarHTML(u)}</div>
          <span class="ch-user-name">${esc(u.username)}${vipBadgeHTML(u)}${_s.unreadCount > 0 ? `<span class="ch-msg-count" id="ch-msg-count">${_s.unreadCount > 99 ? '99+' : _s.unreadCount}</span>` : ''}</span>
          <span class="ch-rating">${u.rating || 1200}</span>
          ${admin ? `<span class="ch-admin-badge">ADMIN</span>` : ''}
          <span class="ch-caret">▾</span>
        </button>
        <div class="ch-udrop" id="ch-udrop">
          <div class="ch-udrop-head">
            <div class="ch-udrop-name">${esc(u.username)}${vipBadgeHTML(u)}</div>
            <div class="ch-udrop-stats">
              <div class="ch-udrop-stat"><strong>${u.rating || 1200}</strong>${esc(t('header.rating'))}</div>
              <div class="ch-udrop-stat"><strong>${u.wins || 0}</strong>${esc(t('header.wins'))}</div>
              <div class="ch-udrop-stat"><strong>${u.gamesPlayed || 0}</strong>${esc(t('header.games'))}</div>
            </div>
          </div>
          <a href="/profile" onclick="event.preventDefault();window._profileTarget=null;(window.showPage?showPage('profile'):location.href='/profile')">
            <span class="ch-di-icon">👤</span>${esc(t('header.my_profile'))}
          </a>
          <a href="/inbox" onclick="event.preventDefault();location.href='/inbox'">
            <span class="ch-di-icon">✉️</span>${esc(t('header.messages'))}
            ${_s.unreadCount > 0 ? `<span class="ch-di-badge" id="ch-unread-badge">${_s.unreadCount}</span>` : ''}
          </a>
          <a href="/settings.html">
            <span class="ch-di-icon">⚙️</span>${esc(t('header.nav_settings'))}
          </a>
          ${admin ? `<a href="/admin" onclick="event.preventDefault();(window.showPage?showPage('admin'):location.href='/admin')">
            <span class="ch-di-icon">🛡️</span>${esc(t('header.admin_panel'))}
          </a>` : ''}
          <div class="ch-udrop-sep"></div>
          <button class="ch-udrop-logout" id="ch-logout-btn">
            <span class="ch-di-icon">🚪</span>${esc(t('header.logout'))}
          </button>
        </div>
      </div>`;
    document.getElementById('ch-user-btn').addEventListener('click', e => {
      e.stopPropagation();
      const drop = document.getElementById('ch-udrop');
      const btn  = document.getElementById('ch-user-btn');
      const open = drop.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
    });
    document.getElementById('ch-logout-btn').addEventListener('click', CH.logout);

    const da = document.getElementById('ch-drawer-user-area');
    if (da) da.innerHTML = `<div style="font-size:12.5px;font-weight:600;color:rgba(210,208,202,0.4)">
      ${esc(u.username)} · ${u.rating || 1200}
    </div>`;
  }

  Object.assign(INT, { _renderHeaderRight, showOnlineFriends });
})();