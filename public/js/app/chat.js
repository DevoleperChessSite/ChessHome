// ═══════════════════════════════════════════════════════════
//  app/chat.js — глобальный чат: сообщения, упоминания, бан-модалка
// ═══════════════════════════════════════════════════════════
//  Вынесено из монолитного app.js в рамках рефакторинга.
//  Код не изменён. Файл — классический скрипт в глобальной области,
//  подключается после /js/app/core.js в исходном порядке следования.

function appendChatMsg(name, message, isMine = false) {
  const chat = document.getElementById('chat-messages');
  if (!chat) return;
  const div = document.createElement('div');
  div.className = 'chat-msg';
  div.style.cssText = isMine ? 'text-align:right;margin-bottom:6px' : 'text-align:left;margin-bottom:6px';
  div.innerHTML = `<span class="chat-msg-name" style="color:${isMine ? 'var(--blue)' : 'var(--accent)'}">${escapeHtml(name)}:</span> <span class="chat-msg-text">${escapeHtml(message)}</span>`;
  chat.appendChild(div);
  requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
  // Сохраняем в sessionStorage для восстановления после реджойна
  // (_restoringChat флаг ставится в board.js чтобы не дублировать при восстановлении)
  if (!chat._restoringChat && typeof chessBoard !== 'undefined' && chessBoard.gameId) {
    try {
      const key = 'ch_game_chat_' + chessBoard.gameId;
      const msgs = JSON.parse(sessionStorage.getItem(key) || '[]');
      msgs.push({ from: name, message, isMine });
      if (msgs.length > 100) msgs.shift();
      sessionStorage.setItem(key, JSON.stringify(msgs));
    } catch {}
  }
}

function sendChatMsg() {
  const input = document.getElementById('chat-input');
  let msg = input?.value.trim();

  if (!msg || !chessBoard.gameId) return;
  if (!socket) { toast('Нет соединения. Войдите заново.', 'error'); return; }
  if (currentUser.banned) { toast('Ваш аккаунт заблокирован', 'error'); return; }
  if (window._chatBannedUntil && Date.now() < window._chatBannedUntil) {
    toast('Вы забанены в чате ещё на ' + Math.ceil((window._chatBannedUntil - Date.now()) / 60000) + ' мин.', 'error');
    return;
  }

  if (containsBadWords(msg)) {
    toast('Сообщение содержит запрещённые слова', 'error');
    return;
  }

  // Socket.IO сам буферизует emit во время короткого переподключения и
  // отправит сообщение, как только связь восстановится — поэтому здесь
  emitGameplayEvent('game_chat', { gameId: chessBoard.gameId, message: msg });
  appendChatMsg(currentUser.username, msg, true);

  input.value = '';
  input.focus();
}


// ─── ГЛОБАЛЬНЫЙ ЧАТ ──────────────────────────────────────────
async function initGlobalChat() {
  const el = document.getElementById('global-chat-messages');
  if (!el) return;

  // Показываем/скрываем инпут в зависимости от авторизации
  const inputEl   = document.getElementById('global-chat-input');
  const sendBtn   = document.getElementById('chat-send-btn');
  const notLogged = document.getElementById('chat-not-logged');
  if (currentUser) {
    if (inputEl)   inputEl.style.display   = '';
    if (sendBtn)   sendBtn.style.display   = '';
    if (notLogged) notLogged.style.display = 'none';
  } else {
    if (inputEl)   inputEl.style.display   = 'none';
    if (sendBtn)   sendBtn.style.display   = 'none';
    if (notLogged) notLogged.style.display = '';
  }

  // Подписываемся на удаление сообщений
  if (socket) {
    socket.off('chat_msg_deleted');
    socket.on('chat_msg_deleted', (msgId) => {
      const msgEl = document.getElementById('chatmsg-' + msgId);
      if (msgEl) msgEl.remove();
    });

    socket.off('chat_msgs_user_deleted');
    socket.on('chat_msgs_user_deleted', (username) => {
      document.querySelectorAll('#global-chat-messages [data-username]').forEach(el => {
        if (el.dataset.username === username) el.remove();
      });
    });

    socket.off('chat_system_msg');
    socket.on('chat_system_msg', (msg) => {
      appendGlobalChatMsg({ system: true, message: msg, timestamp: Date.now() }, true);
    });

    socket.off('global_chat');
    socket.on('global_chat', (msg) => {
      appendGlobalChatMsg(msg, true);
    });
  }

  // Инициализируем автодополнение @упоминаний
  setTimeout(initMentionAutocomplete, 100);

  try {
    const msgs = await apiGet('/chat?limit=200');
    el.innerHTML = '';
    msgs.forEach(m => appendGlobalChatMsg(m, false));
    el.scrollTop = el.scrollHeight;

    // «Бесконечная» прокрутка вверх: всё, что старше загруженного, подгружаем из БД
    el._chatOldest  = msgs.length ? { ts: msgs[0].timestamp, id: msgs[0].id } : null;
    el._chatHasMore = msgs.length > 0;
    el._chatLoading = false;
    if (!el._chatScrollBound) {
      el._chatScrollBound = true;
      el.addEventListener('scroll', () => { if (el.scrollTop < 150) loadOlderGlobalChat(); }, { passive: true });
    }
  } catch {}
}

// ── История общего чата: при прокрутке к началу подгружаем более старые сообщения ──
async function loadOlderGlobalChat() {
  const el = document.getElementById('global-chat-messages');
  if (!el || el._chatLoading || el._chatHasMore === false || !el._chatOldest) return;
  if (el._chatRetryAt && Date.now() < el._chatRetryAt) return;   // после ошибки — небольшая пауза
  el._chatLoading = true;

  const note = document.createElement('div');
  note.style.cssText = 'text-align:center;padding:6px;font-size:12px;color:var(--text-muted)';
  note.textContent = 'Загрузка истории…';
  el.insertBefore(note, el.firstChild);

  try {
    const { ts, id } = el._chatOldest;
    const data = await apiGet('/chat/history?before=' + encodeURIComponent(ts) +
                              '&beforeId=' + encodeURIComponent(id) + '&limit=50');
    const msgs = (data && data.messages) || [];
    note.remove();

    if (msgs.length) {
      const prevHeight = el.scrollHeight, prevTop = el.scrollTop;
      const frag = document.createDocumentFragment();
      msgs.forEach(m => { if (!document.getElementById('chatmsg-' + m.id)) appendGlobalChatMsg(m, false, frag); });
      el.insertBefore(frag, el.firstChild);
      el.scrollTop = prevTop + (el.scrollHeight - prevHeight);   // экран не «прыгает»
      el._chatOldest = { ts: msgs[0].timestamp, id: msgs[0].id };
    }

    if (!data || !data.hasMore) {
      el._chatHasMore = false;
      const start = document.createElement('div');
      start.style.cssText = 'text-align:center;padding:10px 6px;font-size:12px;color:var(--text-muted)';
      start.textContent = '— начало истории чата —';
      el.insertBefore(start, el.firstChild);
    }
  } catch (e) {
    note.remove();
    el._chatRetryAt = Date.now() + 5000;
  } finally {
    el._chatLoading = false;
  }
}
function appendGlobalChatMsg(msg, scroll = true, target = null) {
  const el = document.getElementById('global-chat-messages');
  if (!el) return;

  // Системное сообщение (бан, анонс)
  if (msg.system) {
    const sys = document.createElement('div');
    sys.style.cssText = 'text-align:center;padding:6px 12px;margin:4px 0;font-size:12px;color:#e67e22;background:rgba(230,126,34,0.1);border-radius:8px;border:1px solid rgba(230,126,34,0.25);font-weight:600';
    sys.textContent = '⚠️ ' + msg.message;
    const sysNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
    el.appendChild(sys);
    if (scroll && sysNearBottom) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    return;
  }

  const isAdmin    = msg.role === 'admin';
  const isMe       = msg.username === currentUser?.username;
  const isStreamer = STREAMERS.includes(msg.username);
  const canDelete  = currentUser?.role === 'admin';

  // Проверяем упоминание текущего пользователя
  const isMentioned = (() => {
    if (!currentUser || !msg.message) return false;
    const myName = currentUser.username.toLowerCase();
    const escaped = myName.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    // Тот же класс символов ников, что и в formatChatMessage: [\w\u0400-\u04FF-]
    const regex = new RegExp('@' + escaped + '(?=[^\\w\\u0400-\\u04FF-]|$)', 'i');
    return regex.test(msg.message);
  })();

  const when = new Date(msg.timestamp);
  const hhmm = when.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  const time = when.toDateString() === new Date().toDateString()
    ? hhmm
    : when.toLocaleDateString('ru', { day: 'numeric', month: 'short' }) + ', ' + hhmm;

  const row = document.createElement('div');
  row.id = 'chatmsg-' + msg.id;
  row.dataset.username = msg.username; // для бана
  let rowBg = isMentioned ? 'rgba(46,204,113,0.12)' : '';
  row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:5px 8px;border-radius:8px;transition:background 0.15s' + (isMentioned ? ';background:' + rowBg + ';border-left:3px solid #2ecc71' : '');
  row.onmouseenter = () => { row.style.background = isMentioned ? 'rgba(46,204,113,0.2)' : 'var(--bg-hover)'; };
  row.onmouseleave = () => { row.style.background = isMentioned ? rowBg : ''; };

  // Аватар

  // Контент
  const body = document.createElement('div');
  body.style.flex = '1';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:2px';

  // ИМЯ
  const nameEl = document.createElement('span');
  nameEl.style.cssText = 'font-weight:700;font-size:13px;cursor:pointer;color:' + (
    isAdmin ? 'var(--accent)' :
    isStreamer ? '#2ecc71' :
    isMe ? 'var(--blue)' :
    'var(--text-primary)'
  );
  nameEl.textContent = (isAdmin ? '👑 ' : '') + msg.username;
  nameEl.onclick = () => openUserProfile(msg.username);
  header.appendChild(nameEl);

  // ─── VIP-значок сразу после ника ─────────────────────────────
  if (msg.vip) {
    const vipImg = document.createElement('img');
    vipImg.src = '/img/vip.png';
    vipImg.alt = 'VIP';
    vipImg.title = 'VIP-игрок';
    vipImg.style.cssText = 'height:15px;width:auto;vertical-align:middle;flex-shrink:0';
    header.appendChild(vipImg);
  }

  // ─── ЭМОДЗИ после ника (только если есть) ──────────────────
  const emoji = msg.emoji || '';
  if (emoji) {
    const emojiSpan = document.createElement('span');
    emojiSpan.textContent = emoji;
    emojiSpan.style.cssText = 'font-size:16px; cursor:pointer; line-height:1';
    emojiSpan.title = 'Нажмите, чтобы выбрать свой эмодзи';
    emojiSpan.onclick = (e) => {
      e.stopPropagation();
      window.location = '/settings';
    };
    header.appendChild(emojiSpan);
  }

  // Кнопка @ обращения (только если не свои сообщения)
  if (currentUser && !isMe) {
    const mentionBtn = document.createElement('button');
    mentionBtn.title = 'Обратиться к ' + msg.username;
    mentionBtn.style.cssText = 'background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:11px;padding:1px 4px;opacity:0.5;transition:opacity 0.15s;border-radius:4px;font-weight:700';
    mentionBtn.textContent = '@';
    mentionBtn.onmouseenter = () => { mentionBtn.style.opacity = '1'; mentionBtn.style.color = '#2ecc71'; mentionBtn.style.background = 'rgba(46,204,113,0.12)'; };
    mentionBtn.onmouseleave = () => { mentionBtn.style.opacity = '0.5'; mentionBtn.style.color = 'var(--text-muted)'; mentionBtn.style.background = 'none'; };
    mentionBtn.onclick = (e) => {
      e.stopPropagation();
      insertMention(msg.username);
    };
    header.appendChild(mentionBtn);
  }

  // ADMIN бейдж
  if (isAdmin) {
    const av = document.createElement('img');
    av.src = '/img/moder.png'
    av.style.cssText = 'width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent-dark));display:flex; align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#000;flex-shrink:0;cursor:pointer;margin-top:2px';
    av.textContent = msg.username[0].toUpperCase();
    av.onclick = () => openUserProfile(msg.username);
    row.appendChild(av);
    const badge = document.createElement('span');
    badge.style.cssText = 'background:rgba(201,168,76,0.15);color:var(--accent);font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px';
    badge.textContent = 'ADMIN';
    header.appendChild(badge);
  }

  // STREAMER бейдж 🔥
  if (isStreamer) {
    // const streamer = document.getElementById('profile-avatar')
    // streamer.innerHTML `
    // <img src="/img/streamer.png" width="51px">
    // `
    const av = document.createElement('img');
    av.src = '/img/streamer.png'
    av.style.cssText = 'width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent-dark));display:flex; align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#000;flex-shrink:0;cursor:pointer;margin-top:2px';
    av.textContent = msg.username[0].toUpperCase();
    av.onclick = () => openUserProfile(msg.username);
    row.appendChild(av);
    // const badge = document.createElement('span');
    // badge.style.cssText = 'background:rgba(46,204,113,0.15);color:#2ecc71;font-size:10px;font-weight:700;padding:1px 5px;border-radius:3px';
    // badge.textContent = 'STREAMER';
    // header.appendChild(badge);
  }

  // Время
  const timeEl = document.createElement('span');
  timeEl.style.cssText = 'font-size:11px;color:var(--text-muted);margin-left:auto';
  timeEl.textContent = time;
  timeEl.title = when.toLocaleString('ru');
  header.appendChild(timeEl);

  // Кнопка удаления (только для админа)
  if (canDelete) {
    const delBtn = document.createElement('button');
    delBtn.style.cssText = 'background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:12px;padding:0 2px;opacity:0.6;transition:opacity 0.15s';
    delBtn.textContent = '🗑';
    delBtn.title = 'Удалить сообщение и забанить';
    delBtn.onmouseenter = () => { delBtn.style.opacity = '1'; delBtn.style.color = 'var(--red)'; };
    delBtn.onmouseleave = () => { delBtn.style.opacity = '0.6'; delBtn.style.color = 'var(--text-muted)'; };
    delBtn.onclick = () => deleteChatMsg(msg.id, row);
    header.appendChild(delBtn);
  }
  if (!isStreamer && !isAdmin){
    const av = document.createElement('div');
  av.style.cssText = 'width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent-dark));display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#000;flex-shrink:0;cursor:pointer;margin-top:2px';
  av.textContent = msg.username[0].toUpperCase();
  av.onclick = () => openUserProfile(msg.username);
  row.appendChild(av);
  }
  body.appendChild(header);

  // Текст сообщения — подсвечиваем @mentions
  const text = document.createElement('div');
  text.style.cssText = 'font-size:14px;color:var(--text-secondary);line-height:1.4;word-break:break-word';
  text.innerHTML = formatChatMessage(msg.message);
  body.appendChild(text);

  row.appendChild(body);
  // Считаем ДО вставки: после неё scrollHeight уже вырастет
  const nearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 120;
  (target || el).appendChild(row);

  // Не «выдёргиваем» вниз того, кто листает историю; своё сообщение — всегда вниз
  if (scroll && (nearBottom || isMe)) {
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
  
} 


async function deleteChatMsg(msgId, rowEl) {
  // Определяем username из строки сообщения
  const username = rowEl.dataset.username;

  // Показываем попап выбора бана
  showChatBanModal(msgId, rowEl, username);
}

function showChatBanModal(msgId, rowEl, username) {
  // Удаляем старый модал если есть
  document.getElementById('modal-chat-ban')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'modal-chat-ban';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';

  const box = document.createElement('div');
  box.style.cssText = 'background:var(--bg-card);border:1px solid var(--border);border-radius:16px;padding:28px;max-width:380px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5)';

  box.innerHTML = `
    <h3 style="margin:0 0 6px;font-size:18px;font-family:var(--font-display)">🚫 Удалить сообщение</h3>
    <p style="color:var(--text-muted);font-size:13px;margin:0 0 20px">Пользователь: <b style="color:var(--text-primary)">${escapeHtml(username || '?')}</b></p>
    <div style="margin-bottom:16px">
      <div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:10px">Забанить пользователя в чате?</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px" id="chat-ban-options">
        <button class="chat-ban-opt" data-dur="0"   style="padding:10px;border-radius:10px;border:2px solid var(--border);background:var(--bg-secondary);cursor:pointer;font-size:13px;transition:all 0.15s">
          🗑 Только удалить<br><span style="font-size:11px;color:var(--text-muted)">без бана</span>
        </button>
        <button class="chat-ban-opt" data-dur="5"   style="padding:10px;border-radius:10px;border:2px solid var(--border);background:var(--bg-secondary);cursor:pointer;font-size:13px;transition:all 0.15s">
          ⏱ 5 минут<br><span style="font-size:11px;color:var(--text-muted)">мини-бан</span>
        </button>
        <button class="chat-ban-opt" data-dur="15"  style="padding:10px;border-radius:10px;border:2px solid var(--border);background:var(--bg-secondary);cursor:pointer;font-size:13px;transition:all 0.15s">
          🔇 15 минут<br><span style="font-size:11px;color:var(--text-muted)">стандарт</span>
        </button>
        <button class="chat-ban-opt" data-dur="30"  style="padding:10px;border-radius:10px;border:2px solid var(--border);background:var(--bg-secondary);cursor:pointer;font-size:13px;transition:all 0.15s">
          ⛔ 30 минут<br><span style="font-size:11px;color:var(--text-muted)">серьёзно</span>
        </button>
        <button class="chat-ban-opt" data-dur="60"  style="padding:10px;border-radius:10px;border:2px solid var(--border);background:var(--bg-secondary);cursor:pointer;font-size:13px;transition:all 0.15s">
          🚫 1 час<br><span style="font-size:11px;color:var(--text-muted)">жёстко</span>
        </button>
        <button class="chat-ban-opt" data-dur="1440" style="padding:10px;border-radius:10px;border:2px solid var(--border);background:var(--bg-secondary);cursor:pointer;font-size:13px;transition:all 0.15s">
          💀 24 часа<br><span style="font-size:11px;color:var(--text-muted)">максимум</span>
        </button>
      </div>
    </div>
    <button id="chat-ban-cancel" style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);background:none;color:var(--text-muted);cursor:pointer;font-size:13px">Отмена</button>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // Hover эффекты
  box.querySelectorAll('.chat-ban-opt').forEach(btn => {
    btn.onmouseenter = () => { btn.style.borderColor = 'var(--accent)'; btn.style.background = 'rgba(201,168,76,0.1)'; };
    btn.onmouseleave = () => { btn.style.borderColor = 'var(--border)'; btn.style.background = 'var(--bg-secondary)'; };
    btn.onclick = () => {
      const dur = parseInt(btn.dataset.dur);
      overlay.remove();
      executeChatBan(msgId, rowEl, username, dur);
    };
  });

  box.querySelector('#chat-ban-cancel').onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
}

async function executeChatBan(msgId, rowEl, username, durationMinutes) {
  try {
    // 1. Удаляем сообщения пользователя
    const r1 = await fetch('/api/admin/chat/user/' + encodeURIComponent(username), {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }
    });
    if (!r1.ok) throw new Error('Не удалось удалить сообщения (' + r1.status + ')');

    // 2. Если выбран бан — отправляем запрос бана
    if (durationMinutes > 0) {
      const r2 = await fetch('/api/admin/chat-ban', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, durationMinutes })
      });
      if (!r2.ok) {
        let m = ''; try { m = (await r2.json()).error || ''; } catch {}
        throw new Error('Чат-бан НЕ применён (' + r2.status + ')' + (m ? ': ' + m : ''));
      }
      toast(`${username} забанен в чате на ${durationMinutes} мин.`, 'success');
    } else {
      toast(`Сообщения ${username} удалены`, 'success');
    }
  } catch(e) { toast('Ошибка: ' + e.message, 'error'); }
}

function sendGlobalChatMsg() {
  const input = document.getElementById('global-chat-input');
  let msg = input?.value.trim().slice(0, 300);

  if (!msg) return;
  if (!currentUser) { toast('Войдите чтобы писать в чат', 'info'); return; }
  if (!socket) { toast('Нет соединения. Войдите заново.', 'error'); return; }

  if (containsBadWords(msg)) {
    toast('Сообщение содержит запрещённые слова', 'error');
    return;
  }

  input.value = '';
  input.focus();
  // Закрываем автодополнение
  closeMentionSuggestions();

  // Как и в игровом чате — не блокируем отправку по socket.connected:
  // Socket.IO сам поставит сообщение в очередь на долю секунды обрыва
  if (!_socketAuthed) {
    _pendingGlobalMsgs.push(msg);
    return;
  }
  socket.emit('global_chat', { message: msg });
}

function flushPendingGlobalMsgs() {
  if (!socket || !_pendingGlobalMsgs.length) return;
  while (_pendingGlobalMsgs.length) {
    socket.emit('global_chat', { message: _pendingGlobalMsgs.shift() });
  }
}

// ─── @MENTION HELPERS ─────────────────────────────────────────
function formatChatMessage(text) {
  if (!text) return '';
  // Экранируем HTML сначала
  let safe = String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Подсвечиваем @упоминания (ники с дефисом тоже поддерживаем)
  safe = safe.replace(/@([\w\u0400-\u04FF][\w\u0400-\u04FF\-]*)/g, (match, name) => {
    const nameLow = name.toLowerCase();
    if (nameLow === 'everyone') {
      return `<span class="chat-mention" style="color:#e74c3c;font-weight:700;background:rgba(231,76,60,0.15);border-radius:3px;padding:0 4px">@everyone</span>`;
    }
    const isMe = currentUser && nameLow === currentUser.username.toLowerCase();
    const style = isMe
      ? 'color:#2ecc71;font-weight:700;background:rgba(46,204,113,0.15);border-radius:3px;padding:0 2px;cursor:pointer'
      : 'color:#5dade2;font-weight:700;cursor:pointer';
    return `<span class="chat-mention" style="${style}" data-user="${name}">@${name}</span>`;
  });
  return safe;
}

function insertMention(username) {
  const input = document.getElementById('global-chat-input');
  if (!input) return;
  const val = input.value;
  const cur = input.selectionStart;
  // Вставляем @username в позицию курсора
  const before = val.slice(0, cur);
  const after = val.slice(cur);
  const sep = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
  input.value = before + sep + '@' + username + ' ' + after;
  input.focus();
  const newPos = (before + sep + '@' + username + ' ').length;
  input.setSelectionRange(newPos, newPos);
  closeMentionSuggestions();
}

// Автодополнение @ при наборе
function initMentionAutocomplete() {
  const input = document.getElementById('global-chat-input');
  if (!input || input._mentionInitialized) return;
  input._mentionInitialized = true;

  input.addEventListener('input', () => {
    const val = input.value;
    const cur = input.selectionStart;
    // Ищем @ перед курсором
    const textBefore = val.slice(0, cur);
    const atMatch = textBefore.match(/@([\w\u0400-\u04FF]*)$/);
    if (!atMatch) { closeMentionSuggestions(); return; }
    const query = atMatch[1].toLowerCase();
    showMentionSuggestions(query, atMatch[0].length);
  });

  input.addEventListener('keydown', (e) => {
    const sugg = document.getElementById('mention-suggestions');
    if (!sugg || sugg.style.display === 'none') return;
    const items = sugg.querySelectorAll('.mention-item');
    const active = sugg.querySelector('.mention-item.active');
    let idx = Array.from(items).indexOf(active);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      idx = (idx + 1) % items.length;
      items.forEach((it, i) => it.classList.toggle('active', i === idx));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      idx = (idx - 1 + items.length) % items.length;
      items.forEach((it, i) => it.classList.toggle('active', i === idx));
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      const act = sugg.querySelector('.mention-item.active');
      if (act) { e.preventDefault(); act.click(); }
    } else if (e.key === 'Escape') {
      closeMentionSuggestions();
    }
  });

  input.addEventListener('blur', () => setTimeout(closeMentionSuggestions, 150));
}

function showMentionSuggestions(query, atLen) {
  // Собираем уникальные имена из видимых сообщений
  const names = new Set();
  document.querySelectorAll('#global-chat-messages [data-username]').forEach(el => {
    const u = el.dataset.username;
    if (u && u !== currentUser?.username) names.add(u);
  });

  const filtered = [...names].filter(n => n.toLowerCase().startsWith(query)).slice(0, 5);

  let sugg = document.getElementById('mention-suggestions');
  if (!sugg) {
    sugg = document.createElement('div');
    sugg.id = 'mention-suggestions';
    sugg.style.cssText = 'position:absolute;bottom:calc(100% + 4px);left:0;right:0;background:var(--bg-card);border:1px solid var(--border);border-radius:10px;overflow:hidden;z-index:999;box-shadow:0 8px 24px rgba(0,0,0,0.4)';
    const inputWrap = document.getElementById('global-chat-input')?.parentElement;
    if (inputWrap) { inputWrap.style.position = 'relative'; inputWrap.appendChild(sugg); }
    else { document.body.appendChild(sugg); }
  }

  if (!filtered.length) { sugg.style.display = 'none'; return; }
  sugg.style.display = 'block';
  sugg.innerHTML = '';

  filtered.forEach((name, i) => {
    const item = document.createElement('div');
    item.className = 'mention-item' + (i === 0 ? ' active' : '');
    item.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;transition:background 0.12s';
    item.onmouseenter = () => { sugg.querySelectorAll('.mention-item').forEach(x => x.classList.remove('active')); item.classList.add('active'); };
    item.style.background = i === 0 ? 'var(--bg-hover)' : '';
    const av = document.createElement('div');
    av.style.cssText = 'width:24px;height:24px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent-dark));display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#000;flex-shrink:0';
    av.textContent = name[0].toUpperCase();
    const nm = document.createElement('span');
    nm.style.cssText = 'font-size:13px;font-weight:600';
    nm.textContent = '@' + name;
    item.appendChild(av); item.appendChild(nm);
    item.onclick = () => {
      // Заменяем @query на @name в инпуте
      const input = document.getElementById('global-chat-input');
      const val = input.value;
      const cur = input.selectionStart;
      const before = val.slice(0, cur - atLen);
      const after = val.slice(cur);
      input.value = before + '@' + name + ' ' + after;
      input.focus();
      closeMentionSuggestions();
    };
    sugg.appendChild(item);
  });
}

function closeMentionSuggestions() {
  const sugg = document.getElementById('mention-suggestions');
  if (sugg) sugg.style.display = 'none';
}

// Делегирование кликов по @упоминаниям в чате
document.addEventListener('click', (e) => {
  const mention = e.target.closest('.chat-mention');
  if (mention) {
    const user = mention.dataset.user;
    if (user) insertMention(user);
  }
});

// ─── НАСТРОЙКИ ────────────────────────────────────────────────
pages['settings'] = () => {
  const s = getSettings();
  const sounds = document.getElementById('set-sounds');
  const hints  = document.getElementById('set-hints');
  const coords = document.getElementById('set-coords');
  const anim   = document.getElementById('set-animation');
  if (sounds) sounds.checked = s.sounds;
  if (hints)  hints.checked  = s.hints;
  if (coords) coords.checked = s.coords;
  if (anim)   anim.checked   = s.animation;

  const infoEl = document.getElementById('account-info-text');
  if (infoEl) {
    if (currentUser) {
      infoEl.innerHTML = `
        <div style="font-weight:600">${escapeHtml(currentUser.username)}</div>
        <div style="color:var(--text-muted);font-size:12px">Рейтинг: ${currentUser.rating} · Партий: ${currentUser.gamesPlayed}</div>
        ${currentUser.email ? `<div style="color:var(--text-muted);font-size:12px">${escapeHtml(currentUser.email)}</div>` : ''}`;
    } else {
      infoEl.textContent = 'Войдите в аккаунт для управления профилем';
    }
  }
};
