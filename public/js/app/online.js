// ═══════════════════════════════════════════════════════════
//  app/online.js — страница «Кто онлайн»
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

async function openOnlineUsersPage() {
  window.location.href = '/online';
}

async function renderOnlineUsersList() {
  const listEl    = document.getElementById('online-users-list');
  const subtitleEl = document.getElementById('online-modal-subtitle');
  if (!listEl) return;
  try {
    const users = await apiGet('/online/users');
    if (subtitleEl) subtitleEl.textContent = users.length + ' ' + (users.length === 1 ? 'игрок' : users.length < 5 ? 'игрока' : 'игроков');
    if (!users.length) {
      listEl.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:32px 0;font-size:14px">Никого нет онлайн</div>';
      return;
    }
    listEl.innerHTML = '';
    users.forEach(u => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 8px;border-radius:8px;cursor:pointer;transition:background 0.15s';
      row.onmouseenter = () => { row.style.background = 'var(--bg-hover)'; };
      row.onmouseleave = () => { row.style.background = ''; };
      row.addEventListener('click', () => {
        document.getElementById('modal-online-users').style.display = 'none';
        openUserProfile(u.username);
      });

      // Аватар
      const av = document.createElement('div');
      av.className = 'player-avatar';
      av.style.cssText = 'width:38px;height:38px;font-size:16px;flex-shrink:0';
      av.textContent = u.username[0].toUpperCase();
      row.appendChild(av);

      // Имя + рейтинг
      const info = document.createElement('div');
      info.style.flex = '1';
      const nameEl = document.createElement('div');
      nameEl.style.cssText = 'font-weight:600;font-size:14px;display:flex;align-items:center;gap:6px';
      nameEl.textContent = u.username;
      if (u.role === 'admin') {
        const badge = document.createElement('span');
        badge.style.cssText = 'background:rgba(201,168,76,0.15);color:var(--accent);font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px';
        badge.textContent = 'ADMIN';
        nameEl.appendChild(badge);
      }
      const ratingEl = document.createElement('div');
      ratingEl.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:2px';
      ratingEl.textContent = '★ ' + (u.rating || '—');
      info.appendChild(nameEl);
      info.appendChild(ratingEl);
      row.appendChild(info);

      // Онлайн-индикатор
      const dot = document.createElement('div');
      dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#2ecc71;box-shadow:0 0 6px #2ecc71';
      row.appendChild(dot);

      listEl.appendChild(row);
    });
  } catch {
    if (listEl) listEl.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:32px 0">Не удалось загрузить список</div>';
  }
}

// ─── QUESTS: мёртвые слушатели УДАЛЕНЫ (3.2) ─────────────────
// Обработчики #quests-prev-page, #quests-next-page, #quests-claim-btn
// слушали элементы, которых нет в index.html, и ссылались на
// неопределённые loadQuests/claimQuest. Сами переменные блока
// (currentQuestsPage и др.) больше нигде не использовались.

// ─── INIT ──────────────────────────────────────────────────────
