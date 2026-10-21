// ═══════════════════════════════════════════════════════════
//  app/dm.js — уведомления о личных сообщениях
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

function showDmNotification(fromUsername, preview) {
  const id = 'dm-notif-' + fromUsername;
  const existing = document.getElementById(id);
  if (existing) existing.remove();

  if (!document.getElementById('dm-notif-style')) {
    const s = document.createElement('style');
    s.id = 'dm-notif-style';
    s.textContent = `
      @keyframes dmSlideIn {
        from { opacity:0; transform:translateX(30px) scale(0.95); }
        to   { opacity:1; transform:translateX(0) scale(1); }
      }
      .dm-site-notif {
        position:fixed; top:74px; right:20px; z-index:99999;
        background:var(--bg-card);
        border:1px solid var(--accent);
        border-radius:14px; padding:13px 16px;
        display:flex; align-items:center; gap:11px;
        box-shadow:0 8px 32px rgba(0,0,0,0.55), 0 0 0 1px rgba(201,168,76,0.1);
        max-width:300px; cursor:pointer;
        animation:dmSlideIn 0.35s cubic-bezier(0.34,1.56,0.64,1);
        transition:opacity 0.3s, transform 0.3s;
        font-family:var(--font-body);
      }
      .dm-site-notif:hover { border-color:var(--accent-light); }
      .dm-notif-av {
        width:36px; height:36px; border-radius:50%;
        background:linear-gradient(135deg,var(--accent),var(--accent-dark));
        display:flex; align-items:center; justify-content:center;
        font-size:15px; font-weight:700; color:#000; flex-shrink:0;
      }
      .dm-notif-body { flex:1; min-width:0; }
      .dm-notif-title { font-weight:700; font-size:13px; color:var(--text-primary); }
      .dm-notif-preview { font-size:11px; color:var(--text-muted); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .dm-notif-x { color:var(--text-muted); font-size:15px; cursor:pointer; flex-shrink:0; padding:2px; line-height:1; }
      .dm-notif-x:hover { color:var(--text-primary); }
    `;
    document.head.appendChild(s);
  }

  const el = document.createElement('div');
  el.className = 'dm-site-notif';
  el.id = id;
  el.innerHTML = `
    <div class="dm-notif-av">${escapeHtml(fromUsername[0].toUpperCase())}</div>
    <div class="dm-notif-body">
      <div class="dm-notif-title">&#x1F4AC; Новое сообщение от ${escapeHtml(fromUsername)}</div>
      <div class="dm-notif-preview">${escapeHtml(preview)}</div>
    </div>
    <div class="dm-notif-x" id="dm-notif-x-${escapeHtml(fromUsername)}">&#x2715;</div>
  `;

  el.addEventListener('click', function(e) {
    if (e.target.id === 'dm-notif-x-' + fromUsername) { el.remove(); return; }
    el.remove();
    window.location = '/inbox/' + encodeURIComponent(fromUsername);
  });


  document.body.appendChild(el);

  setTimeout(function() {
    if (el.isConnected) {
      el.style.opacity = '0';
      el.style.transform = 'translateX(30px)';
      setTimeout(function() { el.remove(); }, 300);
    }
  }, 6000);
}
