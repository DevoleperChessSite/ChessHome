// ═══════════════════════════════════════════════════════════════
//  sockets/chat.js — глобальный чат: анти-спам, фильтры, автобаны
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного sockets.js в рамках рефакторинга.
//  Код обработчиков не изменён.

const {
  uuidv4,
  parseCookieHeader,
  bannedIPs,
  bannedDevices,
  saveBanToDB,
  usersCache,
  isVip,
  getUser,
  saveUser,
  globalChat,
  saveChatMsg,
  io,
  removeUserChatMessages,
  findSocketByUsername,
  db,
  emitToAdmins,
} = require('../core');

const moderation = require('../moderation');

module.exports = function registerChat(socket, socketIP) {
// ── Фильтр глобального чата ─────────────────────────────────────
// Та же логика, что уже используется на клиенте (app.js:containsBadWords).
const MAT_WORDS_CHAT = [
  'блять','блядь','бля','пиздец','пизда','пизду','пизды',
  'сука','сучка','хуй','хуе','хер',
  'ебать','ебал','ебан','ебаный','ебло','еблан','ебуч','заеб','выеб',
  'нахуй','нахер','похуй','похер',
  'гандон','долбоеб','долбоёб','далбаеб','далбоеб','далбоёб','мудак',
  'шлюха','шлюх','шалава','проститутка',
  'соси','сосать','отсоси','сраный','обосранный','пздц',
  'fuck','fucking','bitch','asshole','dick','shit',
];
// Спам/казино/ссылки — тут по-прежнему ищем максимально агрессивно (в
// одну сплошную строку без пробелов). Заодно почистил два "мёртвых"
// слова из старого списка — "договорноймatch" и "легкиеdeньги" — там
// была опечатка вперемешку кириллицы с латиницей, из-за которой они
// физически не могли ни с чем совпасть.
const SPAM_WORDS_CHAT = [
  'казино','casino','ставки','ставка','bet','букмекер',
  '1xbet','melbet','parimatch','fonbet','aviator',
  'выигрыш','джекпот','бонус','промокод','депозит','фриспины','free spin',
  'прогноз','договорной матч','легкие деньги',
];
function normalizeChatWord(text) {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[@]/g, 'a').replace(/[0]/g, 'o')
    .replace(/[3]/g, 'e').replace(/[1!]/g, 'i').replace(/9/g, 'я').replace(/6/g, 'б').replace(/4/g, 'ч');
}
function normalizeChatCollapsed(text) {
  return normalizeChatWord(text).replace(/\s+/g, '').replace(/[^a-zа-я0-9]/gi, '');
}
function chatMessageHasBadWords(text) {
  const collapsed = normalizeChatCollapsed(text);
  if (SPAM_WORDS_CHAT.some(w => collapsed.includes(normalizeChatCollapsed(w)))) return true;
  // Короткие корни (3 буквы и меньше, типа "бля","хер") ловим ТОЛЬКО как
  // начало слова — иначе поймаем "рубля","сабля","херсон" и подобные ни
  // при чём не виноватые слова. Более длинные однозначные корни ищем
  // где угодно внутри слова — это по-прежнему ловит приставочные формы.
  const tokens = normalizeChatWord(text).replace(/[^a-zа-я0-9\s]/gi, '').split(/\s+/).filter(Boolean);
  return MAT_WORDS_CHAT.some(rawWord => {
    const word = normalizeChatWord(rawWord).replace(/[^a-zа-я0-9]/gi, '');
    if (!word) return false;
    // "хер" отдельно — только точное совпадение слова целиком, иначе
    // ловит "Херсон", "херувим" и подобные ни при чём не виноватые слова.
    if (word === 'хер') return tokens.includes(word);
    if (word.length <= 3) return tokens.some(t => t.startsWith(word));
    return tokens.some(t => t.includes(word));
  });
}

  socket.on('global_chat', async ({ message }) => {
    if (!socket.username) return;
    const text = (typeof message === 'string' ? message : '').trim().slice(0, 300); if (!text) return;
    const now = Date.now();

    // ── Анти-спам-счётчики проверяем СИНХРОННО и ДО await getUser.
    if (!socket._chatMsgs) socket._chatMsgs = [];
    socket._chatMsgs = socket._chatMsgs.filter(t => now - t < 10000); socket._chatMsgs.push(now);
    if (socket._chatMsgs.length > 10) { socket.emit('error', 'Вы временно отключены за спам в чате'); socket.disconnect(); return; }
    if (socket._chatMsgs.length > 5) { socket.emit('error', 'Слишком много сообщений. Притормози!'); return; }
    if (socket._lastChatAt && now - socket._lastChatAt < 1500) { socket.emit('error', 'Не так быстро!'); return; }
    socket._lastChatAt = now;

    const _lowName = socket.username.toLowerCase();
    let user = await getUser(_lowName);

    // Источник истины по бану — БД, а не кэш: если бан выставили в обход кэша
    // (прямой UPDATE / другой объект), кэш ещё хранит banned=false.
    try {
      const fr = await db('SELECT banned, ban_reason, shadow_banned FROM users WHERE username_low = $1', [_lowName]);
      const row = fr.rows[0];
      if (!row) user = null;
      else if (user) {
        user.banned = !!row.banned;
        user.banReason = row.ban_reason || null;
        user.shadowBanned = !!row.shadow_banned;
      }
    } catch (e) { console.error('[global_chat ban recheck]', e.message); }

    const _devId = parseCookieHeader(socket.handshake.headers.cookie).ch_device_id;
    if (!user || user.banned || bannedIPs.has(socketIP) || (_devId && bannedDevices.has(_devId))) {
      socket.emit('banned', { reason: user?.banReason || 'Аккаунт заблокирован' });
      const _all = findSocketByUsername(socket.username);
      if (_all) _all.disconnect(); else socket.disconnect(true);
      return;
    }

    // Чат-бан на время (хранится в global.chatBans: username_low -> timestamp окончания)
    if (!global.chatBans) global.chatBans = new Map();
    {
      const unbanAt = global.chatBans.get(_lowName);
      if (unbanAt && unbanAt > now) {
        const minsLeft = Math.ceil((unbanAt - now) / 60000);
        socket.emit('chat_banned', { until: unbanAt });
        socket.emit('error', `Вы забанены в чате ещё ${minsLeft} мин. Читайте правила платформы.`);
        return;
      } else if (unbanAt) { global.chatBans.delete(_lowName); }
    }

    const chatHardBan = async (reason) => {
      console.warn(`[ChatHardBan] ${socket.username} — ${reason}`);
      try {
        if (user.createdDeviceId) { bannedDevices.add(user.createdDeviceId); await saveBanToDB(null, user.createdDeviceId); }
        user.banned = true; user.banReason = reason; await saveUser(user);
        await removeUserChatMessages(socket.username);
      } catch (e) {
        // Даже если БД недоступна — блокируем сокет и помечаем юзера в памяти:
        // бан не должен «отменяться» из-за сбоя хранилища.
        console.error('[ChatHardBan] DB error:', e.message);
        usersCache.set(socket.username.toLowerCase(), user);
      }
      socket.emit('error', 'Заблокирован навсегда: ' + reason); socket.disconnect();
    };

    const textLow = text.toLowerCase().replace(/[:/.\-\s]/g, '');
    const LINK_TRIGGERS = ['http','https','www','tme','discordgg','vkcom','instagramcom','tiktokcom'];
    if (LINK_TRIGGERS.some(t => textLow.includes(t))) { await chatHardBan('Реклама/ссылки в чате'); return; }

    if (chatMessageHasBadWords(text)) { await chatHardBan('Нарушение правил чата (запрещённые слова)'); return; }

    if (socket._lastChatMsg === text) {
      socket._dupCount = (socket._dupCount || 0) + 1;
      if (socket._dupCount >= 3) { await chatHardBan('Автобан: флуд (дублирование)'); return; }
      socket.emit('error', 'Не повторяйся'); return;
    }
    socket._lastChatMsg = text; socket._dupCount = 0;
    moderation.record({ username: socket.username, channel: 'global-chat', text });

    const msg = { id: uuidv4(), username: socket.username, message: text, role: user?.role === 'admin' ? 'admin' : 'user', timestamp: now, emoji: user.emoji || '', vip: isVip(user) };

    if (user.shadowBanned) {
      msg.shadowHidden = true;
      globalChat.push(msg); if (globalChat.length > 500) globalChat.shift();
      socket.emit('global_chat', msg);
      emitToAdmins('global_chat', msg).catch(() => {});
      try { await saveChatMsg(msg); } catch (e) { console.error('[Chat save]', e.message); }
      return;
    }

    globalChat.push(msg); if (globalChat.length > 500) globalChat.shift();
    io.emit('global_chat', msg);
    // Сообщение сохраняем в БД ДО/параллельно с рассылкой и await'им: иначе при
    // падении БД сообщение уже разошлось в реальном времени, но в историю не
    // попало — после рестарта сервера «исчезает» из загруженной истории.
    try { await saveChatMsg(msg); } catch (e) { console.error('[Chat save]', e.message); }
  });
}
