// ═══════════════════════════════════════════════════════════════
//  routes/clubs.js — клубы (вступление, чат, модерация)
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  uuidv4,
  path,
  app,
  limiterStrict,
  usersCache,
  getUser,
  clubs,
  saveClub,
  deleteClubFromDB,
  CLUB_CHAT_MAX,
  getClubChat,
  getClubChatBans,
  saveClubChatMsg,
  deleteClubChatMsgsByUser,
  isSiteAdmin,
  isClubModerator,
  canWriteInClubChat,
  io,
  sessions,
  rateLimit,
  authMiddleware,
  findSocketByUsername,
} = require('../core');

const moderation = require('../moderation');

module.exports = function register(app) {
app.get('/clubs',      (req, res) => res.sendFile(path.join(__dirname, '../public/clubs.html')));

app.get('/clubs/:id',  (req, res) => res.sendFile(path.join(__dirname, '../public/clubs.html')));


app.get('/api/clubs', (req, res) => {
  res.json([...clubs].sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0)).map(c => ({
    id: c.id, name: c.name, description: c.description, memberCount: c.memberCount || 0,
    admins: c.admins || [], members: c.members || [], createdBy: c.createdBy, createdAt: c.createdAt, official: !!c.official,
  })));
});


app.get('/api/clubs/:id', (req, res) => {
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  res.json(club);
});


app.post('/api/clubs', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(404).json({ error: 'Пользователь не найден' });
  if (me.banned) return res.status(403).json({ error: 'Вы заблокированы' });
  const { name, description } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Укажите название' });
  const trimmedName = name.trim();
  if (trimmedName.length < 2 || trimmedName.length > 40) return res.status(400).json({ error: 'Название: 2–40 символов' });
  const normName = trimmedName.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
  if (normName.includes('chesshome')) return res.status(400).json({ error: 'Название клуба не может содержать "ChessHome"' });
  const createdByMe = clubs.filter(c => c.createdBy.toLowerCase() === me.username.toLowerCase()).length;
  if (createdByMe >= 5) return res.status(400).json({ error: 'Нельзя создавать более 5 клубов' });
  const memberOf = clubs.filter(c => (c.members || []).map(m => m.toLowerCase()).includes(me.username.toLowerCase())).length;
  if (memberOf >= 10) return res.status(400).json({ error: 'Вы уже состоите в 10 клубах (максимум)' });
  if (clubs.find(c => c.name.toLowerCase() === trimmedName.toLowerCase())) return res.status(400).json({ error: 'Клуб с таким названием уже существует' });
  const id = uuidv4();
  const club = { id, name: trimmedName, description: (description || '').toString().trim().slice(0, 500), createdAt: Date.now(), createdBy: me.username, admins: [me.username], members: [me.username], memberCount: 1, official: false };
  clubs.push(club);
  await saveClub(club);
  res.json(club);
});


app.post('/api/clubs/:id/join', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const me = await getUser(req.user.username.toLowerCase());
  if (!me || me.banned) return res.status(403).json({ error: 'Нет доступа' });
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  const lname = me.username.toLowerCase();
  if ((club.members || []).map(m => m.toLowerCase()).includes(lname)) return res.status(400).json({ error: 'Вы уже в этом клубе' });
  const memberOf = clubs.filter(c => (c.members || []).map(m => m.toLowerCase()).includes(lname)).length;
  if (memberOf >= 10) return res.status(400).json({ error: 'Вы уже в 10 клубах (максимум)' });
  club.members = club.members || []; club.members.push(me.username); club.memberCount = club.members.length;
  // Если вступает создатель клуба, а он ранее выпал из admins (например, после
  // выхода/повторного входа) — возвращаем ему права администратора клуба.
  if ((club.createdBy || '').toLowerCase() === lname) {
    club.admins = club.admins || [];
    if (!club.admins.map(a => a.toLowerCase()).includes(lname)) club.admins.push(me.username);
  }
  await saveClub(club);
  res.json({ ok: true, memberCount: club.memberCount });
});


// ──────────────────────────────────────────────────────────────
//  User Emoji
// ──────────────────────────────────────────────────────────────


app.post('/api/clubs/:id/leave', authMiddleware, async (req, res) => {
  const me = await getUser(req.user.username.toLowerCase());
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  const lname = me.username.toLowerCase();
  const idx = (club.members || []).findIndex(m => m.toLowerCase() === lname);
  if (idx === -1) return res.status(400).json({ error: 'Вы не в этом клубе' });
  if (club.official && club.createdBy.toLowerCase() === lname) return res.status(403).json({ error: 'Создатель официального клуба не может выйти' });
  club.members.splice(idx, 1);
  const aidx = (club.admins || []).findIndex(a => a.toLowerCase() === lname);
  if (aidx !== -1) club.admins.splice(aidx, 1);
  club.memberCount = club.members.length;
  if (club.memberCount === 0 && !club.official && (club.createdBy || '').toLowerCase() !== 'tester') {
    const ci = clubs.findIndex(c => c.id === club.id);
    if (ci !== -1) { clubs.splice(ci, 1); await deleteClubFromDB(club.id); return res.json({ ok: true }); }
  }
  await saveClub(club);
  res.json({ ok: true });
});

app.patch('/api/clubs/:id', authMiddleware, handleEditClub);

// POST-дублёр на случай хостингов/прокси, которые режут метод PATCH
// (см. аналогичный комментарий у /api/tournaments/:id/edit выше).
app.post('/api/clubs/:id/edit', authMiddleware, handleEditClub);


app.post('/api/clubs/:id/kick', authMiddleware, async (req, res) => {
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(404).json({ error: 'Не найден' });
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  const isClubAdmin = (club.admins || []).map(a => a.toLowerCase()).includes(me.username.toLowerCase());
  const isSuperAdmin = me.username.toLowerCase() === 'chesshome' || me.role === 'admin';
  if (!isClubAdmin && !isSuperAdmin) return res.status(403).json({ error: 'Нет прав' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Укажите username' });
  const target = username.toLowerCase();
  if (club.official && club.createdBy.toLowerCase() === target) return res.status(403).json({ error: 'Нельзя кикнуть создателя официального клуба' });
  const idx = (club.members || []).findIndex(m => m.toLowerCase() === target);
  if (idx === -1) return res.status(400).json({ error: 'Пользователь не в клубе' });
  const targetIsAdmin = (club.admins || []).map(a => a.toLowerCase()).includes(target);
  if (targetIsAdmin && !isSuperAdmin) return res.status(403).json({ error: 'Нельзя кикнуть администратора клуба' });
  club.members.splice(idx, 1);
  const aidx = (club.admins || []).findIndex(a => a.toLowerCase() === target);
  if (aidx !== -1) club.admins.splice(aidx, 1);
  club.memberCount = club.members.length;
  if (club.memberCount === 0 && !club.official && (club.createdBy || '').toLowerCase() !== 'tester') {
    clubs.splice(clubs.findIndex(c => c.id === club.id), 1); await deleteClubFromDB(club.id); return res.json({ ok: true });
  }
  await saveClub(club);
  res.json({ ok: true });
});


app.post('/api/clubs/:id/promote', authMiddleware, async (req, res) => {
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(404).json({ error: 'Не найден' });
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  const isCreator = club.createdBy.toLowerCase() === me.username.toLowerCase();
  const isSuperAdmin = me.username.toLowerCase() === 'chesshome' || me.role === 'admin';
  if (!isCreator && !isSuperAdmin) return res.status(403).json({ error: 'Только создатель может назначать администраторов' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Укажите username' });
  const targetUser = await getUser(username.toLowerCase());
  if (!targetUser) return res.status(404).json({ error: 'Пользователь не найден' });
  if (targetUser.banned) return res.status(403).json({ error: 'Нельзя назначить забаненного администратором' });
  if (!(club.members || []).map(m => m.toLowerCase()).includes(username.toLowerCase())) return res.status(400).json({ error: 'Пользователь не в клубе' });
  if ((club.admins || []).map(a => a.toLowerCase()).includes(username.toLowerCase())) return res.status(400).json({ error: 'Уже является администратором' });
  if ((club.admins || []).length >= 3) return res.status(400).json({ error: 'Максимум 3 администратора на клуб' });
  club.admins = club.admins || []; club.admins.push(targetUser.username);
  await saveClub(club); res.json({ ok: true });
});


app.post('/api/clubs/:id/demote', authMiddleware, async (req, res) => {
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(404).json({ error: 'Не найден' });
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  const isCreator = club.createdBy.toLowerCase() === me.username.toLowerCase();
  const isSuperAdmin = me.username.toLowerCase() === 'chesshome' || me.role === 'admin';
  if (!isCreator && !isSuperAdmin) return res.status(403).json({ error: 'Нет прав' });
  const target = (req.body.username || '').toLowerCase();
  if (club.createdBy.toLowerCase() === target) return res.status(403).json({ error: 'Нельзя снять создателя' });
  const aidx = (club.admins || []).findIndex(a => a.toLowerCase() === target);
  if (aidx === -1) return res.status(400).json({ error: 'Пользователь не является администратором' });
  club.admins.splice(aidx, 1); await saveClub(club); res.json({ ok: true });
});

app.delete('/api/clubs/:id', authMiddleware, handleDeleteClub);

app.post('/api/clubs/:id/delete', authMiddleware, handleDeleteClub);


// ── Club Chat API ──────────────────────────────────────────────
app.get('/api/clubs/:id/chat', authMiddleware, (req, res) => {
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  const me = req.user;
  if (!canWriteInClubChat(club, me.username) && !isClubModerator(club, me.username)) {
    return res.status(403).json({ error: 'Только участники клуба могут читать чат' });
  }
  const msgs = getClubChat(club.id);
  const bans = getClubChatBans(club.id);
  const myBan = bans.get(me.username.toLowerCase());
  res.json({ messages: msgs.slice(-CLUB_CHAT_MAX), myBan: myBan || null });
});


app.post('/api/clubs/:id/chat', authMiddleware, rateLimit(limiterStrict), (req, res) => {
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  const me = req.user;
  if (!canWriteInClubChat(club, me.username)) return res.status(403).json({ error: 'Только участники клуба могут писать в чат' });
  const bans = getClubChatBans(club.id);
  const myBan = bans.get(me.username.toLowerCase());
  if (myBan) {
    if (myBan.permanent) return res.status(403).json({ error: 'Вы заблокированы в чате этого клуба' });
    if (myBan.until > Date.now()) return res.status(403).json({ error: 'Вы временно заблокированы', until: myBan.until });
    bans.delete(me.username.toLowerCase());
  }
  const text = (req.body.message || '').toString().trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  moderation.record({ username: me.username, channel: 'club:' + club.id, text });
  const msg = { id: require('crypto').randomUUID(), username: me.username, role: me.role || 'user', message: text, timestamp: Date.now() };
  const chat = getClubChat(club.id);
  chat.push(msg);
  if (chat.length > CLUB_CHAT_MAX) chat.shift();
  saveClubChatMsg(club.id, msg);
  io.to('club_' + club.id).emit('club_chat_msg', { clubId: club.id, msg });
  res.json({ ok: true, msg });
});


app.post('/api/clubs/:id/chat-ban', authMiddleware, async (req, res) => {
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  const me = req.user;
  if (!isClubModerator(club, me.username)) return res.status(403).json({ error: 'Нет прав' });
  const { username, type } = req.body;
  if (!username) return res.status(400).json({ error: 'Нет имени пользователя' });
  const target = username.toLowerCase();
  if (isSiteAdmin(target)) return res.status(403).json({ error: 'Нельзя заблокировать администратора' });
  const targetIsClubAdmin = (club.admins || []).map(a => a.toLowerCase()).includes(target);
  if (targetIsClubAdmin && !isSiteAdmin(me.username)) return res.status(403).json({ error: 'Нельзя заблокировать администратора клуба' });

  const bans = getClubChatBans(club.id);
  const chat = getClubChat(club.id);

  if (type === 'mute') {
    bans.set(target, { until: Date.now() + 15 * 60 * 1000, permanent: false });
    for (let i = chat.length - 1; i >= 0; i--) {
      if ((chat[i].username || '').toLowerCase() === target) chat.splice(i, 1);
    }
    deleteClubChatMsgsByUser(club.id, target);
    const sysMsg = { id: require('crypto').randomUUID(), username: 'system', role: 'system', message: `Администратор заглушил ${username} на 15 минут. Смотрите правила клуба.`, timestamp: Date.now(), system: true };
    chat.push(sysMsg); if (chat.length > CLUB_CHAT_MAX) chat.shift();
    saveClubChatMsg(club.id, sysMsg);
    io.to('club_' + club.id).emit('club_chat_user_banned', { clubId: club.id, username, sysMsg });
    return res.json({ ok: true });
  }

  bans.set(target, { until: Infinity, permanent: true });
  for (let i = chat.length - 1; i >= 0; i--) {
    if ((chat[i].username || '').toLowerCase() === target) chat.splice(i, 1);
  }
  deleteClubChatMsgsByUser(club.id, target);
  const sysMsg = { id: require('crypto').randomUUID(), username: 'system', role: 'system', message: `Администратор заблокировал ${username}. Смотрите правила клуба.`, timestamp: Date.now(), system: true };
  chat.push(sysMsg); if (chat.length > CLUB_CHAT_MAX) chat.shift();
  saveClubChatMsg(club.id, sysMsg);
  io.to('club_' + club.id).emit('club_chat_user_banned', { clubId: club.id, username, sysMsg });
  res.json({ ok: true });
});


app.post('/api/clubs/:id/chat-unban', authMiddleware, (req, res) => {
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  const me = req.user;
  if (!isClubModerator(club, me.username)) return res.status(403).json({ error: 'Нет прав' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Нет имени' });
  getClubChatBans(club.id).delete(username.toLowerCase());
  res.json({ ok: true });
});


app.post('/api/clubs/:id/chat-report', authMiddleware, (req, res) => {
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  const me = req.user;
  const { msgId, reason } = req.body;
  for (const [, sess] of sessions) {
    const u = usersCache.get(sess.username.toLowerCase());
    if (u?.role === 'admin' || isClubModerator(club, sess.username)) {
      const s = findSocketByUsername(sess.username);
      if (s) s.emit('club_chat_report', { clubId: club.id, clubName: club.name, msgId, from: me.username, reason: reason || '' });
    }
  }
  res.json({ ok: true });
});



async function handleEditClub(req, res) {
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(404).json({ error: 'Не найден' });
  const club = clubs.find(c => c.id === req.params.id);
  if (!club) return res.status(404).json({ error: 'Клуб не найден' });
  const isClubAdmin = (club.admins || []).map(a => a.toLowerCase()).includes(me.username.toLowerCase());
  const isSuperAdmin = me.username.toLowerCase() === 'chesshome' || me.role === 'admin';
  if (!isClubAdmin && !isSuperAdmin) return res.status(403).json({ error: 'Нет прав' });
  if (req.body.description !== undefined) club.description = req.body.description.toString().trim().slice(0, 500);
  await saveClub(club);
  res.json({ ok: true, club });
}


async function handleDeleteClub(req, res) {
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(404).json({ error: 'Не найден' });
  const idx = clubs.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Клуб не найден' });
  const club = clubs[idx];
  const isCreator = club.createdBy.toLowerCase() === me.username.toLowerCase();
  const isSuperAdmin = me.username.toLowerCase() === 'chesshome' || me.role === 'admin';
  if (!isCreator && !isSuperAdmin) return res.status(403).json({ error: 'Нет прав' });
  if (club.official && !isSuperAdmin) return res.status(403).json({ error: 'Нельзя удалить официальный клуб' });
  clubs.splice(idx, 1); await deleteClubFromDB(club.id); res.json({ ok: true });
}
};
