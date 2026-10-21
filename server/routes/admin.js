// ═══════════════════════════════════════════════════════════════
//  routes/admin.js — админ-панель: роли, баны, VIP, значки, чат
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  db,
  app,
  bannedIPs,
  bannedDevices,
  saveBanToDB,
  removeBanFromDB,
  rowToUser,
  isVip,
  USER_BADGES,
  getUserBadges,
  getUser,
  saveUser,
  globalChat,
  io,
  isLocalIP,
  removeUserChatMessages,
  logAdminAction,
  authMiddleware,
  requireAdmin,
  requireVipGranter,
  adminSanitizeUser,
  findSocketByUsername,
  deleteChatMsg,
} = require('../core');

const {
  isSiteOwner,
  requireOwner,
} = require('./_shared');

const moderation = require('../moderation');

module.exports = function register(app) {
app.get('/api/admin/users', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const r = await db('SELECT * FROM users ORDER BY rating DESC');
    res.json(r.rows.map(row => adminSanitizeUser(rowToUser(row))));
  });
});


app.post('/api/admin/role', authMiddleware, async (req, res) => {
  await requireOwner(req, res, async () => {
    try {
      const target = await getUser(String(req.body.username || '').toLowerCase());
      if (!target) return res.status(404).json({ error: 'Не найден' });
      if (target.username.toLowerCase() === String(req.user.username).toLowerCase())
        return res.status(400).json({ error: 'Нельзя изменить собственную роль' });
      if (isSiteOwner(target)) return res.status(403).json({ error: 'Роль владельца изменять нельзя' });

      const grant = !!req.body.grant;
      if (grant) {
        if (target.role === 'admin') return res.json({ ok: true, role: 'admin' });
        target.role = 'admin';
        await saveUser(target);
        console.log(`[Admin] ${req.user.username} выдал роль администратора: ${target.username}`);
      } else {
        if (target.role !== 'admin') return res.json({ ok: true, role: target.role || 'user' });
        target.role = 'user';
        await saveUser(target);
        console.log(`[Admin] ${req.user.username} снял роль администратора: ${target.username}`);
      }
      await logAdminAction(req.user.username, grant ? 'role_grant' : 'role_revoke', target.username, {});
      res.json({ ok: true, role: target.role });
    } catch (e) {
      console.error('[AdminRole]', e);
      res.status(500).json({ error: 'Ошибка смены роли: ' + e.message });
    }
  });
});


app.post('/api/admin/ban', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const target = await getUser((req.body.username || '').toLowerCase());
      if (!target) return res.status(404).json({ error: 'Не найден' });
      if (target.role === 'admin') return res.status(403).json({ error: 'Нельзя забанить администратора' });

      const reason = req.body.reason || 'Нарушение правил';
      // Бан аккаунта + мультиаккаунтов с того же устройства + каскад:
      // выход из клубов и турниров, чистка клубных/турнирных чатов (см. moderation.js).
      const out = await moderation.banUserFully(req.user.username, target, reason);
      res.json({ ok: true, accountsBanned: out.accountsBanned, cascade: out.cascade });
    } catch (e) {
      console.error('[Ban]', e);
      res.status(500).json({ error: 'Ошибка бана: ' + e.message });
    }
  });
});


app.post('/api/admin/unban', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const target = await getUser((req.body.username || '').toLowerCase());
      if (!target) return res.status(404).json({ error: 'Не найден' });
      target.banned = false; target.banReason = null;
      if (target.createdDeviceId) { bannedDevices.delete(target.createdDeviceId); await removeBanFromDB(null, target.createdDeviceId); }
      if (req.body.unbanIP && target.createdFromIP) { bannedIPs.delete(target.createdFromIP); await removeBanFromDB(target.createdFromIP, null); }
      await saveUser(target);
      await logAdminAction(req.user.username, 'unban', target.username, { unbanIP: !!req.body.unbanIP });
      res.json({ ok: true });
    } catch (e) {
      console.error('[Unban]', e);
      res.status(500).json({ error: 'Ошибка разбана: ' + e.message });
    }
  });
});


// ── Теневой бан ─────────────────────────────────────────────────
// В отличие от /admin/ban: ничего не блокирует и не рвёт соединение —
// цель продолжает пользоваться сайтом как обычно и не должна ничего
// заподозрить. Единственный эффект — его сообщения (публичный чат и
// ЛС, см. sockets.js и /api/dm/send) реально доходят только до него
// самого и до админов. Независимо от обычного banned — можно включить
// одно, оба или ни одного.
app.post('/api/admin/shadowban', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const target = await getUser((req.body.username || '').toLowerCase());
      if (!target) return res.status(404).json({ error: 'Не найден' });
      if (target.role === 'admin') return res.status(403).json({ error: 'Нельзя применить к администратору' });
      target.shadowBanned = true;
      target.shadowBanReason = req.body.reason || 'Нарушение правил';
      await saveUser(target);
      await logAdminAction(req.user.username, 'shadowban', target.username, { reason: target.shadowBanReason });
      res.json({ ok: true });
    } catch (e) {
      console.error('[ShadowBan]', e);
      res.status(500).json({ error: 'Ошибка теневого бана: ' + e.message });
    }
  });
});


app.post('/api/admin/unshadowban', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const target = await getUser((req.body.username || '').toLowerCase());
      if (!target) return res.status(404).json({ error: 'Не найден' });
      target.shadowBanned = false; target.shadowBanReason = null;
      await saveUser(target);
      await logAdminAction(req.user.username, 'unshadowban', target.username, {});
      res.json({ ok: true });
    } catch (e) {
      console.error('[UnShadowBan]', e);
      res.status(500).json({ error: 'Ошибка снятия теневого бана: ' + e.message });
    }
  });
});


// ── VIP-значок ──────────────────────────────────────────────────
// Выдают/снимают сайт-админы (requireVipGranter: роль 'admin' в БД либо
// legacy-ники bootstrap — см. isVipGranter).
app.post('/api/admin/vip/grant', authMiddleware, async (req, res) => {
  await requireVipGranter(req, res, async () => {
    try {
      const target = await getUser((req.body.username || '').toLowerCase());
      if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
      const days = Math.min(365, Math.max(1, parseInt(req.body.days) || 30));
      // Если значок уже активен — продлеваем от текущей даты окончания, а не от "сейчас".
      const base = isVip(target) ? target.vipUntil : Date.now();
      target.vipUntil = base + days * 24 * 60 * 60 * 1000;
      await saveUser(target);
      await logAdminAction(req.user.username, 'vip_grant', target.username, { days, vipUntil: target.vipUntil });
      const sock = findSocketByUsername(target.username);
      if (sock) sock.emit('vip_updated', { vip: true, vipUntil: target.vipUntil });
      res.json({ ok: true, username: target.username, vipUntil: target.vipUntil });
    } catch (e) {
      console.error('[VIP grant]', e);
      res.status(500).json({ error: 'Ошибка выдачи значка: ' + e.message });
    }
  });
});


app.post('/api/admin/vip/revoke', authMiddleware, async (req, res) => {
  await requireVipGranter(req, res, async () => {
    try {
      const target = await getUser((req.body.username || '').toLowerCase());
      if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
      target.vipUntil = null;
      await saveUser(target);
      await logAdminAction(req.user.username, 'vip_revoke', target.username, {});
      const sock = findSocketByUsername(target.username);
      if (sock) sock.emit('vip_updated', { vip: false, vipUntil: null });
      res.json({ ok: true });
    } catch (e) {
      console.error('[VIP revoke]', e);
      res.status(500).json({ error: 'Ошибка снятия значка: ' + e.message });
    }
  });
});


// ── Значки профиля (победитель сезона и т.п.) ─────────────────
// Каталог значков лежит в core.js (USER_BADGES). Здесь только выдача/снятие.
// Права — любой admin. Если нужно, как у VIP, только chesshome/Marina64 —
// замените requireAdmin на requireVipGranter.
app.get('/api/admin/badges/catalog', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    res.json(Object.entries(USER_BADGES).map(([id, b]) => ({ id, title: b.title, img: b.img })));
  });
});


app.post('/api/admin/badges/grant', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const badge = String(req.body.badge || '');
      if (!USER_BADGES[badge]) return res.status(400).json({ error: 'Неизвестный значок' });
      const target = await getUser((req.body.username || '').toLowerCase());
      if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
      const list = Array.isArray(target.badges) ? target.badges : [];
      if (!list.includes(badge)) list.push(badge);
      target.badges = list;
      await saveUser(target);
      await logAdminAction(req.user.username, 'badge_grant', target.username, { badge });
      res.json({ ok: true, badges: getUserBadges(target) });
    } catch (e) {
      console.error('[Badge grant]', e);
      res.status(500).json({ error: 'Ошибка выдачи значка: ' + e.message });
    }
  });
});


app.post('/api/admin/badges/revoke', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const badge = String(req.body.badge || '');
      const target = await getUser((req.body.username || '').toLowerCase());
      if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
      target.badges = (Array.isArray(target.badges) ? target.badges : []).filter(b => b !== badge);
      await saveUser(target);
      await logAdminAction(req.user.username, 'badge_revoke', target.username, { badge });
      res.json({ ok: true, badges: getUserBadges(target) });
    } catch (e) {
      console.error('[Badge revoke]', e);
      res.status(500).json({ error: 'Ошибка снятия значка: ' + e.message });
    }
  });
});


app.get('/api/admin/vip/list', authMiddleware, async (req, res) => {
  await requireVipGranter(req, res, async () => {
    const r = await db('SELECT username, vip_until FROM users WHERE vip_until IS NOT NULL AND vip_until > $1 ORDER BY vip_until ASC', [Date.now()]);
    res.json(r.rows.map(row => ({ username: row.username, vipUntil: Number(row.vip_until) })));
  });
});


app.get('/api/admin/ipbans', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    res.json({ ips: [...bannedIPs], devices: [...bannedDevices], total: bannedIPs.size });
  });
});


app.post('/api/admin/ipban', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const target = await getUser((req.body.username || '').toLowerCase());
    if (!target) return res.status(404).json({ error: 'Не найден' });
    if (target.role === 'admin') return res.status(403).json({ error: 'Нельзя' });
    const ip = target.createdFromIP;
    if (!ip) return res.status(400).json({ error: 'IP не сохранён' });
    if (isLocalIP(ip)) return res.status(400).json({ error: 'Нельзя забанить локальный IP' });
    bannedIPs.add(ip); await saveBanToDB(ip, target.createdDeviceId || null);
    if (target.createdDeviceId) bannedDevices.add(target.createdDeviceId);

    const r = await db('SELECT * FROM users WHERE created_device_id = $1 AND role != $2', [target.createdDeviceId || '__none__', 'admin']);
    let count = 0;
    for (const row of r.rows) {
      const u = rowToUser(row);
      if (!u.banned) {
        u.banned = true; u.banReason = 'IP-бан администратором';
        await saveUser(u);
        const sock = findSocketByUsername(u.username);
        if (sock) { sock.emit('error', 'Аккаунт заблокирован'); sock.disconnect(); }
        count++;
      }
    }
    await logAdminAction(req.user.username, 'ip_ban', ip, { viaUser: target.username, accountsBanned: count });
    res.json({ ok: true, ip, accountsBanned: count });
  });
});


app.post('/api/admin/ipunban', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const ip = req.body.ip;
    if (!ip) return res.status(400).json({ error: 'Укажите IP' });
    bannedIPs.delete(ip); await removeBanFromDB(ip, null);
    await logAdminAction(req.user.username, 'ip_unban', ip, {});
    res.json({ ok: true });
  });
});


app.post('/api/admin/unban-device', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const deviceId = req.body.deviceId;
    if (!deviceId) return res.status(400).json({ error: 'Укажите deviceId' });
    bannedDevices.delete(deviceId); await removeBanFromDB(null, deviceId);
    await logAdminAction(req.user.username, 'device_unban', deviceId, {});
    res.json({ ok: true });
  });
});


app.post('/api/admin/unban-full', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const target = await getUser((req.body.username || '').toLowerCase());
    if (!target) return res.status(404).json({ error: 'Не найден' });
    target.banned = false; target.banReason = null;
    if (target.createdDeviceId) { bannedDevices.delete(target.createdDeviceId); await removeBanFromDB(null, target.createdDeviceId); }
    if (target.createdFromIP)   { bannedIPs.delete(target.createdFromIP); await removeBanFromDB(target.createdFromIP, null); }
    await saveUser(target);
    await logAdminAction(req.user.username, 'unban_full', target.username, {});
    res.json({ ok: true });
  });
});

app.delete('/api/admin/chat/:msgId', authMiddleware, handleDeleteChatMsg);

app.post('/api/admin/chat/:msgId/delete', authMiddleware, handleDeleteChatMsg);


app.delete('/api/admin/chat/user/:username', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    const removed = await removeUserChatMessages(req.params.username);
    await logAdminAction(req.user.username, 'chat_clear_user', req.params.username, { removed });
    res.json({ ok: true, removed });
  });
});


app.post('/api/admin/chat-ban', authMiddleware, async (req, res) => {
  await requireAdmin(req, res, async () => {
    try {
      const { username, durationMinutes } = req.body;
      if (!username || !durationMinutes) return res.status(400).json({ error: 'Нет параметров' });
      const dur = Math.max(1, Math.min(1440, parseInt(durationMinutes) || 15));
      const unbanAt = Date.now() + dur * 60 * 1000;

      if (!global.chatBans) global.chatBans = new Map();
      global.chatBans.set(username.toLowerCase(), unbanAt);

      // Чистим уже отправленные сообщения — мут не должен оставлять
      // спам/реклама/XSS-попытки висеть в чате до истечения таймера.
      await removeUserChatMessages(username).catch(e => console.error('[ChatBan] chat cleanup:', e.message));

      let durText;
      if (dur < 60) durText = dur + ' минут';
      else if (dur === 60) durText = '1 час';
      else if (dur < 1440) durText = Math.round(dur / 60) + ' часа';
      else durText = '24 часа';

      const sysMsg = `${username} заблокирован в чате на ${durText}. Соблюдайте правила платформы.`;

      const sysChatMsg = { id: require('crypto').randomUUID(), username: 'system', message: sysMsg, role: 'system', timestamp: Date.now(), system: true };
      globalChat.push(sysChatMsg);
      if (globalChat.length > 500) globalChat.shift();

      io.emit('chat_system_msg', sysMsg);

      await logAdminAction(req.user.username, 'chat_ban', username, { durationMinutes: dur, unbanAt });
      res.json({ ok: true, unbanAt });
    } catch (e) {
      console.error('[ChatBan]', e);
      res.status(500).json({ error: 'Ошибка чат-бана: ' + e.message });
    }
  });
});


async function handleDeleteChatMsg(req, res) {
  await requireAdmin(req, res, async () => {
    const idx = globalChat.findIndex(m => m.id === req.params.msgId);
    const removed = idx !== -1 ? globalChat[idx] : null;
    if (idx !== -1) globalChat.splice(idx, 1);
    let r = null;
    try { r = await deleteChatMsg(req.params.msgId); }
    catch (e) {
      console.error('[DeleteChatMsg] SQL:', e.message);
      if (idx === -1) return res.status(500).json({ error: 'Ошибка удаления' });
    }
    // 404 — только если сообщения нет НИ в кэше, НИ в БД.
    if (idx === -1 && (!r || r.rowCount === 0)) {
      return res.status(404).json({ error: 'Не найдено' });
    }
    await logAdminAction(req.user.username, 'chat_delete', removed?.username || null, { msgId: req.params.msgId, text: (removed?.message || '').slice(0, 200) });
    io.emit('chat_msg_deleted', req.params.msgId);
    res.json({ ok: true });
  });
}
};