// ═══════════════════════════════════════════════════════════
//  app/settings.js — настройки интерфейса и эмодзи-пикер
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

function getSettings() {
  const defaults = { sounds: true, hints: true, coords: true, animation: true, boardLight: '#f0d9b5', boardDark: '#b58863' };
  try { return { ...defaults, ...JSON.parse(localStorage.getItem('ch_settings') || '{}') }; } catch { return defaults; }
}

function saveSetting(key, value) {
  const s = getSettings(); s[key] = value;
  localStorage.setItem('ch_settings', JSON.stringify(s));
  applySettings();
  // Перерисовываем доску если изменились визуальные настройки
  if (['coords','hints','animation'].includes(key)) {
    if (typeof chessBoard !== 'undefined') chessBoard.render();
  }
}

function applySettings() {
  const s = getSettings();
  document.documentElement.style.setProperty('--board-light', s.boardLight || '#f0d9b5');
  document.documentElement.style.setProperty('--board-dark',  s.boardDark  || '#b58863');
}


// ──────────────────────────────────────────────────────────────
//  Emoji picker (настройки)
// ──────────────────────────────────────────────────────────────

// Массив EMOJIS вынесен в общий /js/emojis.js (4.2); в index.html он

function openEmojiPicker() {
  const grid = document.getElementById('emoji-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const em of EMOJIS) {
    const div = document.createElement('div');
    div.textContent = em;
    div.style.cssText = 'cursor:pointer; font-size:28px; padding:4px; transition:transform 0.1s';
    div.onmouseenter = () => div.style.transform = 'scale(1.1)';
    div.onmouseleave = () => div.style.transform = 'scale(1)';
    div.onclick = () => selectEmoji(em);
    grid.appendChild(div);
  }
  openModal('modal-emoji');
}

async function selectEmoji(emoji) {
  if (!currentUser) {
    toast('Войдите, чтобы сменить эмодзи', 'info');
    return;
  }
  try {
    const res = await fetch('/api/user/emoji', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji })
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Ошибка');
    }
    const data = await res.json();
    // Обновляем текущего пользователя
    if (currentUser) currentUser.emoji = emoji;
    // Обновляем шапку (если есть CH)
    if (window.CH) CH.setCurrentUser(currentUser);
    // Обновляем отображение в настройках
    const preview = document.getElementById('current-emoji-preview');
    if (preview) preview.textContent = emoji || '';
    // Обновляем эмодзи в профиле, если он открыт
    const profileEmoji = document.getElementById('profile-emoji');
    if (profileEmoji) profileEmoji.textContent = emoji || '';
    // Перезагружаем чаты (чтобы обновились эмодзи)
    if (typeof reloadGlobalChat === 'function') reloadGlobalChat();
    else if (typeof initGlobalChat === 'function') initGlobalChat();
    closeModal('modal-emoji');
    toast('Эмодзи сохранён!', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}


pages['profile'] = () => {
  if (currentUser && currentUser.username) {
    window.location.href = '/profile/' + encodeURIComponent(currentUser.username);
  } else {
    window.location.href = '/profile';
  }
};

// ─── ИГРОВАЯ СТРАНИЦА ─────────────────────────────────────────
pages['game'] = () => {
  if (!chessBoard.gameId) chessBoard.newLocalGame();
};

// ─── ГЛАВНАЯ ──────────────────────────────────────────────────
pages['home'] = () => {
  initGlobalChat();
};

// ─── АНАЛИЗ ───────────────────────────────────────────────────
