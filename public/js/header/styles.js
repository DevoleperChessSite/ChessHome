// ═══════════════════════════════════════════════════════════
//  header/styles.js — CSS хедера (инжектится тегом <style>)
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного header.js (~490 строк CSS-шаблона).

(function () {
  'use strict';

  const CH = window.CH;
  const INT = CH._int;

  // ─── СТИЛИ ────────────────────────────────────────────────────────────────
  function _injectStyles() {
    if (document.getElementById('ch-styles')) return;
    const s = document.createElement('style');
    s.id = 'ch-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ─── CSS ──────────────────────────────────────────────────────────────────
  const CSS = `
    #ch-root *, #ch-root *::before, #ch-root *::after { box-sizing: border-box; }
    #ch-root { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }

    /* HEADER */
    #ch-header {
      position: fixed;
      top: 0; left: 0; right: 0;
      z-index: 1000;
      height: 56px;
      display: flex;
      align-items: center;
      padding: 0 0px;
      background: #0e0f13;
      border-bottom: 1px solid rgba(255,255,255,0.07);
    }

    /* LOGO */
    .ch-logo { display: flex; align-items: center; gap: 0px; text-decoration: none; color: #505050; font-size: 16px; font-weight: 800; font-family: Georgia, serif; white-space: nowrap; flex-shrink: 0; margin-right: 24px; transition: opacity 0.13s; } .ch-logo:hover { opacity: 0.75; }.ch-logo-icon {
  width: 96px;
  height: 96px;
  object-fit: contain;
  display: block;
  flex-shrink: 0;
} .ch-logo-text { line-height: 1;   margin-left: -23px;}
    .ch-logo:hover { opacity: 0.75; }

    /* НОВАЯ ССЫЛКА S2 (КВЕСТЫ) */
    .ch-quests-link {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 34px;
      padding: 0 14px;
      margin-right: 20px;
      border-radius: 40px;
      background: rgba(201,168,76,0.12);
      border: 1px solid rgba(201,168,76,0.35);
      color: #ffd966;
      font-weight: 800;
      font-size: 15px;
      letter-spacing: 0.5px;
      text-decoration: none;
      transition: all 0.13s ease;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .ch-quests-link:hover {
      background: rgba(201,168,76,0.22);
      border-color: #c9a84c;
      color: #fff1b5;
      transform: scale(1.02);
    }

    /* DESKTOP NAV */
    #ch-nav {
      display: flex;
      align-items: stretch;
      height: 56px;
      list-style: none;
      margin: 0; padding: 0;
      flex: 1;
      gap: 2px;
    }

    /* NAV SECTION */
    .ch-sec {
      position: relative;
      display: flex;
      align-items: center;
    }
    .ch-sec-btn {
      display: flex;
      align-items: center;
      gap: 5px;
      padding: 0 15px;
      height: 56px;
      color: rgba(210,208,202,0.5);
      font-size: 15px;
      font-weight: 600;
      font-family: inherit;
      white-space: nowrap;
      cursor: default;
      border: none;
      background: none;
      transition: color 0.13s;
      user-select: none;
      letter-spacing: 0.01em;
    }
    .ch-arr {
      font-size: 7px;
      opacity: 0.4;
      transition: transform 0.15s;
    }
    .ch-sec:hover > .ch-sec-btn {
      color: #e8e6e0;
    }
    .ch-sec:hover > .ch-sec-btn .ch-arr {
      transform: rotate(180deg);
    }

    /* ПОДДЕРЖАТЬ ПРОЕКТ — отдельный пункт после разделов меню (как DONATE у lichess) */
    .ch-sec-plain { padding: 0 15px; }
    .ch-support-link {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 56px;
      color: #ff9500;
      font-size: 15px;
      font-weight: 700;
      font-family: inherit;
      text-decoration: none;
      white-space: nowrap;
      letter-spacing: 0.01em;
      transition: color 0.13s, opacity 0.13s;
    }
    .ch-support-link:hover { color: #ffb144; opacity: 0.9; }
    .ch-support-icon { font-size: 15px; }

    /* DROPDOWN */
    .ch-drop {
      position: absolute;
      top: 100%;
      left: 0;
      min-width: 172px;
      padding: 6px;
      background: #141420;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      transform: translateY(6px);
      transition: opacity 0.15s, transform 0.15s, visibility 0s linear 0.15s;
      z-index: 1001;
    }
    /* Мостик — dropdown не закрывается при движении мыши вниз */
    .ch-drop::before {
      content: '';
      position: absolute;
      top: -8px; left: 0; right: 0;
      height: 8px;
    }
    .ch-sec:hover > .ch-drop {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      transform: translateY(0);
      transition: opacity 0.15s, transform 0.15s;
    }
    .ch-drop a {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 9px 12px;
      border-radius: 6px;
      text-decoration: none;
      color: rgba(210,208,202,0.6);
      font-size: 13.5px;
      font-weight: 500;
      white-space: nowrap;
      transition: background 0.11s, color 0.11s;
    }
    .ch-drop a:hover {
      background: rgba(255,255,255,0.05);
      color: #e8e6e0;
    }
    .ch-drop a.active { color: #c9a84c; }
    .ch-drop-icon {
      font-size: 14px;
      width: 18px;
      text-align: center;
      flex-shrink: 0;
    }

    /* HEADER RIGHT */
    #ch-header-right {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
      flex-shrink: 0;
    }

    /* ONLINE */
    #ch-online-badge {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
      color: rgba(210,208,202,0.32);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
      transition: color 0.13s;
      white-space: nowrap;
      margin-left: 12px;
    }
    #ch-online-badge:hover { color: rgba(210,208,202,0.6); }
    .ch-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #3cb371;
      flex-shrink: 0;
    }

    /* AUTH */
    .ch-auth-buttons { display: flex; gap: 7px; align-items: center; }
    .ch-btn-ghost {
      background: none;
      border: 1px solid rgba(255,255,255,0.11);
      border-radius: 7px;
      color: rgba(210,208,202,0.65);
      font-size: 14px; font-weight: 600;
      font-family: inherit;
      padding: 7px 15px;
      cursor: pointer;
      transition: border-color 0.13s, color 0.13s;
    }
    .ch-btn-ghost:hover { border-color: rgba(255,255,255,0.22); color: #e8e6e0; }
    .ch-btn-primary {
      background: #c9a84c;
      border: none; border-radius: 7px;
      color: #0e0f13;
      font-size: 14px; font-weight: 700;
      font-family: inherit;
      padding: 7px 16px;
      cursor: pointer;
      transition: opacity 0.13s;
    }
    .ch-btn-primary:hover { opacity: 0.85; }

    /* USER MENU */
    #ch-user-wrap { position: relative; }
    .ch-user-btn {
      display: flex; align-items: center; gap: 7px;
      background: none;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      color: #e8e6e0;
      font-size: 14px; font-weight: 600;
      font-family: inherit;
      padding: 6px 12px;
      cursor: pointer;
      transition: border-color 0.13s;
    }
    .ch-user-btn:hover { border-color: rgba(255,255,255,0.18); }
    .ch-ava {
      width: 26px; height: 26px; border-radius: 50%;
      background: #c9a84c;
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 800; color: #0e0f13;
      overflow: hidden; flex-shrink: 0;
    }
    .ch-ava img { width: 100%; height: 100%; object-fit: cover; }
    .ch-rating { font-size: 11px; color: rgba(210,208,202,0.38); font-family: monospace; }
    .ch-admin-badge {
      font-size: 9px; background: rgba(201,168,76,0.12);
      color: #c9a84c; border: 1px solid rgba(201,168,76,0.22);
      border-radius: 3px; padding: 1px 4px;
    }
    .ch-notif-dot { width: 7px; height: 7px; border-radius: 50%; background: #e74c3c; }
    .ch-caret { font-size: 8px; opacity: 0.38; }
    .ch-vip-badge { height: 15px; width: auto; vertical-align: -3px; margin-left: 3px; flex-shrink: 0; }
    .ch-udrop-name .ch-vip-badge { height: 17px; width: auto; vertical-align: -3px; }

    /* НЕПРОЧИТАННЫЕ СООБЩЕНИЯ — золотой счётчик рядом с ником */
    .ch-msg-count {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 17px;
      height: 17px;
      margin-left: 6px;
      padding: 0 5px;
      border-radius: 999px;
      background: linear-gradient(135deg, #ffe27a, #c9a84c);
      color: #2a1e00;
      font-size: 10.5px;
      font-weight: 800;
      line-height: 1;
      box-shadow: 0 0 6px rgba(201,168,76,0.65);
      vertical-align: middle;
      animation: chMsgCountPop 0.35s ease;
    }
    @keyframes chMsgCountPop {
      0%   { transform: scale(0.3); opacity: 0; }
      65%  { transform: scale(1.2); opacity: 1; }
      100% { transform: scale(1); }
    }

    /* USER DROPDOWN */
    .ch-udrop {
      position: absolute;
      top: calc(100% + 6px); right: 0;
      min-width: 200px;
      background: #141420;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 5px;
      opacity: 0; visibility: hidden;
      transform: translateY(5px);
      transition: opacity 0.14s, transform 0.14s, visibility 0s linear 0.14s;
      pointer-events: none; z-index: 1002;
    }
    .ch-udrop.open {
      opacity: 1; visibility: visible;
      transform: translateY(0); pointer-events: auto;
      transition: opacity 0.14s, transform 0.14s;
    }
    .ch-udrop-head {
      padding: 10px 12px 9px;
      border-bottom: 1px solid rgba(255,255,255,0.06);
      margin-bottom: 4px;
    }
    .ch-udrop-name { font-weight: 700; font-size: 13.5px; margin-bottom: 6px; }
    .ch-udrop-stats { display: flex; gap: 14px; }
    .ch-udrop-stat { font-size: 11px; color: rgba(210,208,202,0.38); text-align: center; }
    .ch-udrop-stat strong { display: block; font-size: 14px; color: #c9a84c; }
    .ch-udrop a, .ch-udrop-logout {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 11px; border-radius: 6px;
      text-decoration: none;
      color: rgba(210,208,202,0.62);
      font-size: 13px; font-weight: 500;
      cursor: pointer;
      transition: background 0.11s, color 0.11s;
      background: none; border: none; width: 100%; text-align: left;
    }
    .ch-udrop a:hover { background: rgba(255,255,255,0.05); color: #e8e6e0; }
    .ch-udrop-logout:hover { background: rgba(231,76,60,0.07); color: #e74c3c; }
    .ch-udrop-sep { height: 1px; background: rgba(255,255,255,0.06); margin: 4px 6px; }
    .ch-di-icon { width: 17px; text-align: center; flex-shrink: 0; font-size: 14px; }
    .ch-di-badge {
      margin-left: auto; background: #e74c3c; color: #fff;
      font-size: 10px; font-weight: 700; border-radius: 10px; padding: 1px 5px;
    }

    /* HAMBURGER */
    #ch-hamburger {
      display: none;
      flex-direction: column; justify-content: center; gap: 5px;
      width: 36px; height: 36px;
      background: none; border: none; cursor: pointer;
      padding: 5px; border-radius: 7px;
      transition: background 0.13s; flex-shrink: 0; margin-left: 6px;
    }
    #ch-hamburger:hover { background: rgba(255,255,255,0.06); }
    #ch-hamburger span {
      display: block; width: 18px; height: 2px;
      background: rgba(210,208,202,0.6); border-radius: 2px;
      transition: transform 0.22s, opacity 0.18s;
    }
    #ch-hamburger.open span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
    #ch-hamburger.open span:nth-child(2) { opacity: 0; }
    #ch-hamburger.open span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }

    /* OVERLAY */
    #ch-drawer-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.45);
      z-index: 1010; opacity: 0;
      transition: opacity 0.22s;
    }
    #ch-drawer-overlay.visible { opacity: 1; }

    /* DRAWER */
    #ch-drawer {
      position: fixed; top: 0; right: 0;
      width: min(285px, 83vw); height: 100dvh;
      background: #0e0f13;
      border-left: 1px solid rgba(255,255,255,0.07);
      z-index: 1020;
      display: flex; flex-direction: column;
      transform: translateX(110%);
      transition: transform 0.26s cubic-bezier(0.32,0,0.15,1);
    }
    #ch-drawer.open { transform: translateX(0); }
    .ch-dr-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 16px 13px;
      border-bottom: 1px solid rgba(255,255,255,0.07);
      flex-shrink: 0;
    }
    .ch-dr-logo { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 800; color: #c9a84c; font-family: Georgia, serif; } .ch-dr-logo img { width: 22px; height: 22px; object-fit: contain; display: block; }
    .ch-dr-close {
      background: none; border: none; color: rgba(210,208,202,0.32);
      font-size: 16px; cursor: pointer; padding: 3px 7px; border-radius: 5px;
      transition: color 0.12s, background 0.12s;
    }
    .ch-dr-close:hover { color: #e8e6e0; background: rgba(255,255,255,0.06); }
    .ch-dr-links { flex: 1; overflow-y: auto; padding: 8px 8px; }
    .ch-dr-section {
      font-size: 9.5px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.09em; color: rgba(201,168,76,0.48);
      padding: 10px 8px 4px;
    }
    .ch-dl-item {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 10px; border-radius: 7px;
      text-decoration: none;
      color: rgba(210,208,202,0.62);
      font-size: 14px; font-weight: 500;
      transition: background 0.11s, color 0.11s;
      cursor: pointer; background: none; border: none;
      width: 100%; text-align: left;
    }
    .ch-dl-item:hover { background: rgba(255,255,255,0.05); color: #e8e6e0; }
    .ch-dl-item.active { color: #c9a84c; }
    .ch-dl-item.ch-support-link { color: #ff9500; font-weight: 700; }
    .ch-dl-item.ch-support-link:hover { background: rgba(255,149,0,0.12); color: #ffb144; }
    .ch-dl-icon { font-size: 15px; width: 20px; text-align: center; flex-shrink: 0; }
    .ch-dr-sep { height: 1px; background: rgba(255,255,255,0.06); margin: 5px 8px; }
    .ch-dr-foot {
      border-top: 1px solid rgba(255,255,255,0.07);
      padding: 13px 16px; flex-shrink: 0;
    }
    .ch-dr-online {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; color: rgba(210,208,202,0.32);
    }

    /* BOTTOM NAV */
    #ch-bottom-nav {
      display: none;
      position: fixed; bottom: 0; left: 0; right: 0;
      height: 54px;
      background: #0e0f13;
      border-top: 1px solid rgba(255,255,255,0.07);
      z-index: 100;
      align-items: stretch; justify-content: space-around;
      padding-bottom: env(safe-area-inset-bottom, 0);
    }
    .ch-bn-item {
      display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 2px;
      flex: 1; background: none; border: none; cursor: pointer;
      color: rgba(210,208,202,0.32);
      font-size: 9.5px; font-weight: 600;
      padding: 5px 2px; text-decoration: none;
      transition: color 0.12s;
      text-transform: uppercase; letter-spacing: 0.03em;
    }
    .ch-bn-icon { font-size: 18px; line-height: 1; }
    .ch-bn-item.active { color: #c9a84c; }

    /* FLOATING FRIENDS BUTTON (левый нижний угол) */
    #ch-friends-float {
      position: fixed;
      bottom: 20px;
      left: 20px;
      z-index: 1000;
      background: #1e2028;
      border: 1px solid #2e3040;
      border-radius: 40px;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 600;
      color: #e8e9f0;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      backdrop-filter: blur(8px);
      box-shadow: 0 2px 12px rgba(0,0,0,0.3);
      transition: background 0.15s, transform 0.1s;
    }
    #ch-friends-float:hover {
      background: #2a2e3a;
    }

    /* АДАПТИВ */
    @media (max-width: 820px) {
      #ch-nav { display: none !important; }
      #ch-hamburger { display: flex !important; }
      #ch-bottom-nav { display: flex !important; }
      body { padding-bottom: 54px; }
      .ch-user-name, .ch-rating, .ch-admin-badge, .ch-caret { display: none !important; }
      .ch-user-btn { padding: 4px 6px; gap: 0; border-color: transparent; }
      #ch-online-badge { font-size: 12px; padding: 3px 6px; margin-left: 4px; }
      #ch-friends-float { display: none; }
      .ch-quests-link { margin-right: 12px; padding: 0 10px; font-size: 13px; }
    }
    @media (max-width: 400px) {
      .ch-logo-text { display: none; }
      #ch-header { padding: 0 10px; }
    }
  `;

  Object.assign(INT, { CSS, _injectStyles });
})();
