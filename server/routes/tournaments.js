// ═══════════════════════════════════════════════════════════════
//  routes/tournaments.js — турниры (включая межклубные)
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  jwt,
  uuidv4,
  app,
  getAuthToken,
  limiterStrict,
  usersCache,
  getUser,
  tournaments,
  saveTournament,
  clubs,
  isSiteAdmin,
  isClubModerator,
  MAX_INTERCLUB_TEAMS,
  resolveInterclubTeams,
  requireTournamentManager,
  TOURNAMENT_CHAT_MAX,
  getTournamentChat,
  getTournamentChatMutes,
  isTournamentChatOpen,
  canModerateTournamentChat,
  saveTournamentChatMsg,
  wipeTournamentChatMsgsByUser,
  io,
  JWT_SECRET,
  activeGames,
  tournamentGames,
  rateLimit,
  authMiddleware,
  getInterclubTeamsInfo,
  computeTeamStandings,
  sanitizeTournament,
  getTournamentStatus,
  findSocketByUsername,
  tryPairTournamentPlayers,
  finishTournamentGame,
  anticheatBan,
} = require('../core');

const {
  parseTimeControl,
} = require('./_shared');

const moderation = require('../moderation');

module.exports = function register(app) {
app.get('/api/tournaments', async (req, res) => {
  const now = Date.now();
  const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
  let list = tournaments
    .filter(t => {
      if (getTournamentStatus(t, now) === 'finished' && t.endsAt < oneYearAgo) return false;
      return true;
    })
    .map(t => ({
      ...t, participantsCount: (t.participants || []).filter(p => !p.anticheatBanned).length,
      status: getTournamentStatus(t, now), participants: undefined, games: undefined, blacklist: undefined,
      createdByIsAdmin: usersCache.get((t.createdBy || '').toLowerCase())?.role === 'admin',
      teams: getInterclubTeamsInfo(t),
    }));
  if (req.query.status) list = list.filter(t => t.status === req.query.status);
  if (req.query.clubId) list = list.filter(t => t.clubId === req.query.clubId);
  // ?isInterclub=true — только межклубные турниры (для отдельной страницы),
  // ?isInterclub=false — только обычные (скрыть межклубные из общего списка турниров).
  if (req.query.isInterclub === 'true') list = list.filter(t => t.isInterclub);
  if (req.query.isInterclub === 'false') list = list.filter(t => !t.isInterclub);
  list.sort((a, b) => a.startsAt - b.startsAt);
  res.json(list);
});


app.get('/api/tournaments/:id', (req, res) => {
  const t = tournaments.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Не найден' });
  const now = Date.now();
  const sorted = [...(t.participants || [])].filter(p => !p.anticheatBanned).sort((a, b) => b.score - a.score || b.wins - a.wins);
  let isAdmin = false;
  const authToken_ = getAuthToken(req);
  if (authToken_) {
    try { const d = jwt.verify(authToken_, JWT_SECRET); const u = usersCache.get(d.username.toLowerCase()); isAdmin = u?.role === 'admin'; } catch {}
  }
  res.json({ ...t, participants: sorted, status: getTournamentStatus(t, now), serverNow: now, isArchive: t.endsAt < now - 365*24*60*60*1000, blacklist: isAdmin ? (t.blacklist || []) : undefined, createdByIsAdmin: usersCache.get((t.createdBy || '').toLowerCase())?.role === 'admin', teams: getInterclubTeamsInfo(t), teamStandings: computeTeamStandings(t) });
});


app.post('/api/tournaments', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Нет доступа' });
  const user = await getUser(req.user.username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Нет доступа' });

  const isAdmin = user.role === 'admin';
  const { name, description, timeControl, durationMinutes, startsAt, maxParticipants, minRating, maxRating, blacklist, clubId, clubOnly } = req.body;
  if (!name || !timeControl || !durationMinutes || !startsAt) return res.status(400).json({ error: 'Заполните обязательные поля' });

  // Клубный турнир — привязка турнира к клубу разрешена только его администраторам
  // (защита от спама: обычный участник клуба не может создать «клубный» турнир от его имени).
  let finalClubId = null, finalClubOnly = false;
  if (clubId) {
    const club = clubs.find(c => c.id === clubId);
    if (!club) return res.status(404).json({ error: 'Клуб не найден' });
    if (!isClubModerator(club, user.username)) return res.status(403).json({ error: 'Только администраторы клуба могут создавать клубные турниры' });
    finalClubId = club.id;
    finalClubOnly = !!clubOnly;
  }

  const startTime = new Date(startsAt).getTime();
  if (isNaN(startTime)) return res.status(400).json({ error: 'Неверная дата' });

  const now = Date.now();

  // Нельзя создать турнир в прошлом
  if (startTime < now - 60000) return res.status(400).json({ error: 'Нельзя создать турнир в прошлом' });

  // Максимум — через год
  const oneYearFromNow = now + 365 * 24 * 60 * 60 * 1000;
  if (startTime > oneYearFromNow) return res.status(400).json({ error: 'Максимальная дата — через 1 год от сегодня' });

  // Обычным юзерам — не более 3 турниров в день
  if (!isAdmin) {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const todayTs = startOfDay.getTime();
    const createdToday = tournaments.filter(t => t.createdBy === user.username && t.createdAt >= todayTs).length;
    if (createdToday >= 3) return res.status(429).json({ error: 'Вы уже создали 3 турнира сегодня. Лимит: 3 в день' });
  }

  const bl = Array.isArray(blacklist) ? blacklist.map(s => String(s).toLowerCase().trim()).filter(Boolean).slice(0, 100) : [];

  const tc = parseTimeControl(timeControl);
  if (!tc) return res.status(400).json({ error: 'Неверный контроль времени (формат «10+0», «3+2»)' });

  let duration = parseInt(durationMinutes, 10);
  if (!Number.isFinite(duration)) return res.status(400).json({ error: 'Неверная длительность' });
  duration = Math.max(5, Math.min(duration, 7 * 24 * 60)); // 5 минут … 7 суток

  let maxP = parseInt(maxParticipants, 10);
  if (!Number.isFinite(maxP) || maxP < 0) maxP = 0;
  maxP = Math.min(maxP, 512);

  let minR = parseInt(minRating, 10); if (!Number.isFinite(minR) || minR < 0) minR = 0;
  let maxR = parseInt(maxRating, 10); if (!Number.isFinite(maxR) || maxR <= 0) maxR = 9999;
  if (minR > maxR) { const tmp = minR; minR = maxR; maxR = tmp; }

  const tournament = {
    id: uuidv4(), name: name.trim().slice(0, 60), description: (description || '').trim().slice(0, 1000),
    timeControl: tc.raw, durationMinutes: duration,
    startsAt: startTime, endsAt: startTime + duration * 60000,
    maxParticipants: maxP, minRating: minR, maxRating: maxR,
    blacklist: bl, createdBy: user.username, createdAt: now,
    participants: [], games: [], winner: null,
    clubId: finalClubId, clubOnly: finalClubOnly,
    isInterclub: false, teamIds: [],
  };
  tournaments.push(tournament);
  await saveTournament(tournament);
  io.emit('tournament_created', { id: tournament.id, name: tournament.name, timeControl: tournament.timeControl, startsAt: tournament.startsAt, durationMinutes: tournament.durationMinutes, clubId: tournament.clubId });
  res.json(tournament);
});


// ── Создание межклубного турнира — теперь доступно любому пользователю ──
app.post('/api/tournaments/interclub', authMiddleware, async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Нет доступа' });
  const user = await getUser(req.user.username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Нет доступа' });

  const isAdmin = user.role === 'admin';
  const { name, description, timeControl, durationMinutes, startsAt, minRating, maxRating, blacklist, teamLinks } = req.body;
  if (!name || !timeControl || !durationMinutes || !startsAt) return res.status(400).json({ error: 'Заполните обязательные поля' });

  if (Array.isArray(teamLinks) && teamLinks.length > 500) return res.status(400).json({ error: 'Слишком много ссылок на команды' });
  const { teamIds, notFound } = resolveInterclubTeams(teamLinks);
  if (teamIds.length < 2) return res.status(400).json({ error: 'Нужно указать ссылки минимум на 2 клуба-команды' });
  if (teamIds.length > MAX_INTERCLUB_TEAMS) return res.status(400).json({ error: `Максимум ${MAX_INTERCLUB_TEAMS} команд в межклубном турнире` });
  if (notFound.length) return res.status(400).json({ error: `Не найдены клубы по ссылкам: ${notFound.slice(0, 10).join(', ')}` });

  const startTime = new Date(startsAt).getTime();
  if (isNaN(startTime)) return res.status(400).json({ error: 'Неверная дата' });
  const now = Date.now();
  if (startTime < now - 60000) return res.status(400).json({ error: 'Нельзя создать турнир в прошлом' });
  const oneYearFromNow = now + 365 * 24 * 60 * 60 * 1000;
  if (startTime > oneYearFromNow) return res.status(400).json({ error: 'Максимальная дата — через 1 год от сегодня' });

  // Обычным юзерам — не более 3 турниров в день (общий лимит с обычными
  // турнирами — см. POST /api/tournaments — чтобы нельзя было обойти его,
  // просто создавая межклубники вместо обычных турниров).
  if (!isAdmin) {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const todayTs = startOfDay.getTime();
    const createdToday = tournaments.filter(t => t.createdBy === user.username && t.createdAt >= todayTs).length;
    if (createdToday >= 3) return res.status(429).json({ error: 'Вы уже создали 3 турнира сегодня. Лимит: 3 в день' });
  }

  const bl = Array.isArray(blacklist) ? blacklist.map(s => String(s).toLowerCase().trim()).filter(Boolean).slice(0, 100) : [];
  const tc = parseTimeControl(timeControl);
  if (!tc) return res.status(400).json({ error: 'Неверный контроль времени (формат «10+0», «3+2»)' });
  let duration = parseInt(durationMinutes, 10);
  if (!Number.isFinite(duration)) return res.status(400).json({ error: 'Неверная длительность' });
  duration = Math.max(5, Math.min(duration, 7 * 24 * 60));
  let minR = parseInt(minRating, 10); if (!Number.isFinite(minR) || minR < 0) minR = 0;
  let maxR = parseInt(maxRating, 10); if (!Number.isFinite(maxR) || maxR <= 0) maxR = 9999;
  if (minR > maxR) { const tmp = minR; minR = maxR; maxR = tmp; }
  const tournament = {
    id: uuidv4(), name: name.trim().slice(0, 60), description: (description || '').trim().slice(0, 1000),
    timeControl: tc.raw, durationMinutes: duration,
    startsAt: startTime, endsAt: startTime + duration * 60000,
    // У межклубных турниров нет общего лимита участников — он естественно
    // ограничен суммарным числом членов заявленных команд.
    maxParticipants: 0, minRating: minR, maxRating: maxR,
    blacklist: bl, createdBy: user.username, createdAt: now,
    participants: [], games: [], winner: null,
    clubId: null, clubOnly: false,
    isInterclub: true, teamIds,
  };
  tournaments.push(tournament);
  await saveTournament(tournament);
  io.emit('tournament_created', { id: tournament.id, name: tournament.name, timeControl: tournament.timeControl, startsAt: tournament.startsAt, durationMinutes: tournament.durationMinutes, isInterclub: true });
  res.json(tournament);
});

app.patch('/api/tournaments/:id', authMiddleware, handleEditTournament);

// Некоторые хостинги/прокси режут методы PATCH/DELETE (запрос не долетает до
// Express и в ответ прилетает HTML-страница ошибки вместо JSON — отсюда и
// "JSON.parse: unexpected character at line 1 column 1"). Даём POST-дублёры,
// как уже сделано для /api/blog, /api/admin/chat и /api/admin/puzzles.
app.post('/api/tournaments/:id/edit', authMiddleware, handleEditTournament);

app.delete('/api/tournaments/:id', authMiddleware, handleDeleteTournament);

app.post('/api/tournaments/:id/delete', authMiddleware, handleDeleteTournament);


app.post('/api/tournaments/:id/join', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const user = await getUser(req.user.username.toLowerCase());
  if (!user || user.banned) return res.status(403).json({ error: 'Нет доступа' });
  const t = tournaments.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Не найден' });
  const now = Date.now();
  if (getTournamentStatus(t, now) === 'finished') return res.status(400).json({ error: 'Турнир завершён' });
  if (t.endsAt && t.endsAt < now - 365*24*60*60*1000) return res.status(400).json({ error: 'Этому турниру больше года — запись недоступна' });
  if ((t.blacklist || []).includes(user.username.toLowerCase())) return res.status(403).json({ error: 'Вам закрыт доступ в этот турнир' });
  if (t.clubOnly && t.clubId) {
    const club = clubs.find(c => c.id === t.clubId);
    const inClub = club && (club.members || []).map(m => m.toLowerCase()).includes(user.username.toLowerCase());
    if (!inClub) return res.status(403).json({ error: `Турнир доступен только участникам клуба «${club ? club.name : ''}»` });
  }
  if (t.minRating && user.rating < t.minRating) return res.status(400).json({ error: `Минимальный рейтинг: ${t.minRating}` });
  if (t.maxRating && t.maxRating < 9999 && user.rating > t.maxRating) return res.status(400).json({ error: `Максимальный рейтинг: ${t.maxRating}` });
  if (t.maxParticipants && t.participants.length >= t.maxParticipants) return res.status(400).json({ error: 'Турнир заполнен' });
  const existing = t.participants.find(p => p.username === user.username);
  const isActive = getTournamentStatus(t, now) === 'active';

  // ── Межклубный турнир: обязательный выбор команды ─────────────
  // Играть можно только за клуб, который заявлен в этом турнире И
  // в котором пользователь реально состоит на момент вступления.
  let teamId = null;
  if (t.isInterclub) {
    const requestedTeamId = req.body && req.body.teamId;
    if (!requestedTeamId) return res.status(400).json({ error: 'Выберите команду, за которую хотите играть', needTeamSelection: true, teams: (t.teamIds || []).map(id => clubs.find(c => c.id === id)).filter(Boolean).filter(c => (c.members || []).map(m => m.toLowerCase()).includes(user.username.toLowerCase())).map(c => ({ id: c.id, name: c.name })) });
    if (!(t.teamIds || []).includes(requestedTeamId)) return res.status(400).json({ error: 'Эта команда не участвует в турнире' });
    const team = clubs.find(c => c.id === requestedTeamId);
    if (!team) return res.status(404).json({ error: 'Команда (клуб) не найдена' });
    const inTeam = (team.members || []).map(m => m.toLowerCase()).includes(user.username.toLowerCase());
    if (!inTeam) return res.status(403).json({ error: `Вы не состоите в клубе «${team.name}»` });
    // Если игрок уже сыграл партии за одну команду — не даём переметнуться к другой
    // (иначе можно было бы "сдать" очки не той команде, за которую реально играл).
    if (existing && existing.teamId && existing.gamesPlayed > 0 && existing.teamId !== requestedTeamId) {
      return res.status(400).json({ error: 'Вы уже играли в этом турнире за другую команду и не можете сменить её' });
    }
    teamId = requestedTeamId;
  }

if (existing) {
  if (existing.anticheatBanned) return res.status(403).json({ error: 'Вы заблокированы в этом турнире' });
  if (!existing.left) return res.status(400).json({ error: 'Уже участвуете' });
  existing.left = false;
  existing.paused = false;
  existing.currentGameId = null;
  existing.rating = user.rating;
  existing.waiting = isActive;   // Автоматически встаём в очередь, если турнир уже идёт
  if (t.isInterclub) existing.teamId = teamId;
} else {
  t.participants.push({
    username: user.username, rating: user.rating, score: 0, streak: 0, flame: false,
    berserkCount: 0, gamesPlayed: 0, wins: 0, losses: 0, draws: 0,
    joinedAt: now, lastGameAt: 0, waiting: isActive, currentGameId: null,
    left: false, anticheatBanned: false, _acHighAccGames: 0,
    teamId: teamId,
  });
}

await saveTournament(t);
io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));

// Если турнир активен — сразу пытаемся спарить
if (isActive) {
  tryPairTournamentPlayers(t);
}
  await saveTournament(t);
  io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
  res.json({ ok: true });
});


app.post('/api/tournaments/:id/leave', authMiddleware, async (req, res) => {
  const t = tournaments.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Не найден' });
  const p = t.participants.find(p => p.username === req.user.username);
  if (!p) return res.status(400).json({ error: 'Не участвуете' });
  p.waiting = false; p.left = true;
  await saveTournament(t);
  io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
  res.json({ ok: true });
});


// ── Партии конкретного турнира (для просмотра/проверки) ───────
app.get('/api/tournaments/:id/games', async (req, res) => {
  const t = tournaments.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Не найден' });
  const games = (t.games || []).map(g => ({
    id: g.id, white: g.white, black: g.black, result: g.result,
    reason: g.reason, timeControl: g.timeControl, endedAt: g.endedAt,
    anticheatBanned: !!g.anticheatBanned,
  }));
  res.json(games);
});


// ── Ручной античит-бан от администратора ─────────────────────
app.post('/api/tournaments/:id/anticheat-ban', authMiddleware, async (req, res) => {
  await requireTournamentManager(req, res, async (t) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Укажите username' });
    const p = t.participants.find(p => p.username.toLowerCase() === username.toLowerCase());
    if (!p) return res.status(404).json({ error: 'Участник не найден' });
    if (p.anticheatBanned) return res.status(400).json({ error: 'Уже забанен' });

    // Принудительно завершаем текущую игру если есть
    if (p.currentGameId) {
      const game = tournamentGames.get(p.currentGameId) || activeGames.get(p.currentGameId);
      if (game) {
        const oppColor = game.white === p.username ? 'black' : 'white';
        const oppName = oppColor === 'white' ? game.white : game.black;
        const payload = { gameId: p.currentGameId, result: oppColor, reason: 'anticheat_admin' };
        const ws = findSocketByUsername(game.white);
        const bs = findSocketByUsername(game.black);
        if (ws) ws.emit('game_ended', payload);
        if (bs) bs.emit('game_ended', payload);
        await finishTournamentGame(t, game, oppColor, 'anticheat_admin');
        tournamentGames.delete(p.currentGameId);
        activeGames.delete(p.currentGameId);
      }
    }

    anticheatBan(t, p.username);
    await saveTournament(t);
    io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
    io.to(`tournament_${t.id}`).emit('anticheat_ban', {
      username: p.username, tournamentId: t.id, tournamentName: t.name,
      message: `⚠️ ${p.username} забанен администратором за использование читов.`,
    });
    res.json({ ok: true, username: p.username });
  });
});


app.post('/api/tournaments/:id/blacklist', authMiddleware, async (req, res) => {
  await requireTournamentManager(req, res, async (t) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Укажите username' });
    if (!t.blacklist) t.blacklist = [];
    const uLow = username.toLowerCase();
    if (!t.blacklist.includes(uLow)) t.blacklist.push(uLow);
    const p = t.participants.find(p => p.username.toLowerCase() === uLow);
    if (p) { p.left = true; p.waiting = false; }
    await saveTournament(t);
    io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
    res.json({ ok: true, blacklist: t.blacklist });
  });
});

app.delete('/api/tournaments/:id/blacklist/:username', authMiddleware, handleUnblacklistTournament);

app.post('/api/tournaments/:id/blacklist/:username/delete', authMiddleware, handleUnblacklistTournament);


// ── Tournament Chat API ────────────────────────────────────────
app.get('/api/tournaments/:id/chat', authMiddleware, async (req, res) => {
  const t = tournaments.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Турнир не найден' });
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(401).json({ error: 'Нет доступа' });

  const now = Date.now();
  const msgs = getTournamentChat(t.id);
  const mutes = getTournamentChatMutes(t.id);
  const myMuteRaw = mutes.get(me.username.toLowerCase());
  const myMute = (myMuteRaw && myMuteRaw.until > now) ? myMuteRaw : null;

  res.json({
    messages: msgs.slice(-TOURNAMENT_CHAT_MAX),
    open: isTournamentChatOpen(t, now),
    myMute,
    canModerate: canModerateTournamentChat(me, t),
  });
});


app.post('/api/tournaments/:id/chat', authMiddleware, rateLimit(limiterStrict), async (req, res) => {
  const t = tournaments.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Турнир не найден' });
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(401).json({ error: 'Нет доступа' });
  if (me.banned) return res.status(403).json({ error: 'Ваш аккаунт заблокирован' });

  const now = Date.now();
  if (!isTournamentChatOpen(t, now)) {
    return res.status(403).json({ error: 'Чат турнира закрыт для сообщений — доступно только чтение' });
  }

  const mutes = getTournamentChatMutes(t.id);
  const myMute = mutes.get(me.username.toLowerCase());
  if (myMute) {
    if (myMute.until > now) return res.status(403).json({ error: 'Вы замучены в чате этого турнира', until: myMute.until });
    mutes.delete(me.username.toLowerCase());
  }

  const text = (req.body.message || '').toString().trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });

  moderation.record({ username: me.username, channel: 'tournament:' + t.id, text });
  const msg = { id: uuidv4(), username: me.username, role: me.role || 'user', message: text, timestamp: now };
  const chat = getTournamentChat(t.id);
  chat.push(msg);
  if (chat.length > TOURNAMENT_CHAT_MAX) chat.shift();
  saveTournamentChatMsg(t.id, msg);
  io.to(`tournament_${t.id}`).emit('tournament_chat_msg', { tournamentId: t.id, msg });
  res.json({ ok: true, msg });
});


app.post('/api/tournaments/:id/chat-mute', authMiddleware, async (req, res) => {
  const t = tournaments.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Турнир не найден' });
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(401).json({ error: 'Нет доступа' });
  if (!canModerateTournamentChat(me, t)) return res.status(403).json({ error: 'Нет прав' });

  const { username, minutes } = req.body;
  if (!username) return res.status(400).json({ error: 'Укажите username' });
  const target = username.toLowerCase();

  if (isSiteAdmin(target) && me.role !== 'admin') return res.status(403).json({ error: 'Нельзя замутить администратора' });
  if (t.createdBy && target === t.createdBy.toLowerCase() && me.role !== 'admin' && me.username.toLowerCase() !== target) {
    return res.status(403).json({ error: 'Нельзя замутить создателя турнира' });
  }

  const dur = Math.min(Math.max(parseInt(minutes) || 15, 1), 24 * 60); // от 1 минуты до 24 часов
  const until = Date.now() + dur * 60 * 1000;
  getTournamentChatMutes(t.id).set(target, { until });

  const mutedIds = await wipeTournamentChatMsgsByUser(t.id, target);

  const sysMsg = { id: uuidv4(), username: 'system', role: 'system', message: `🔇 ${username} замучен в чате турнира на ${dur} мин.`, timestamp: Date.now(), system: true };
  const chat = getTournamentChat(t.id);
  chat.push(sysMsg);
  if (chat.length > TOURNAMENT_CHAT_MAX) chat.shift();
  saveTournamentChatMsg(t.id, sysMsg);

  io.to(`tournament_${t.id}`).emit('tournament_chat_user_muted', { tournamentId: t.id, username, until, mutedIds, sysMsg });
  res.json({ ok: true, until });
});


app.post('/api/tournaments/:id/chat-unmute', authMiddleware, async (req, res) => {
  const t = tournaments.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Турнир не найден' });
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(401).json({ error: 'Нет доступа' });
  if (!canModerateTournamentChat(me, t)) return res.status(403).json({ error: 'Нет прав' });

  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Укажите username' });
  getTournamentChatMutes(t.id).delete(username.toLowerCase());
  io.to(`tournament_${t.id}`).emit('tournament_chat_user_unmuted', { tournamentId: t.id, username });
  res.json({ ok: true });
});



async function handleEditTournament(req, res) {
  await requireTournamentManager(req, res, async (t) => {
    if (getTournamentStatus(t, Date.now()) === 'finished') return res.status(400).json({ error: 'Турнир завершён' });
    const b = req.body || {};
    const upd = {};
    if (b.name !== undefined) {
      const n = String(b.name).trim().slice(0, 60);
      if (!n) return res.status(400).json({ error: 'Название не может быть пустым' });
      upd.name = n;
    }
    if (b.description !== undefined) upd.description = String(b.description || '').trim().slice(0, 1000);
    if (b.timeControl !== undefined) {
      if (typeof b.timeControl !== 'string' || !/^\d{1,3}(\.\d)?\+\d{1,2}(s)?$/.test(b.timeControl)) {
        return res.status(400).json({ error: 'Неверный контроль времени (формат «10+0», «3+2»)' });
      }
      upd.timeControl = b.timeControl;
    }
    if (b.durationMinutes !== undefined) {
      const d = parseInt(b.durationMinutes, 10);
      if (!Number.isFinite(d)) return res.status(400).json({ error: 'Неверная длительность' });
      upd.durationMinutes = Math.max(5, Math.min(d, 7 * 24 * 60));
    }
    if (b.maxParticipants !== undefined) {
      let m = parseInt(b.maxParticipants, 10);
      if (!Number.isFinite(m) || m < 0) m = 0;
      upd.maxParticipants = Math.min(m, 512);
    }
    if (b.minRating !== undefined || b.maxRating !== undefined) {
      let lo = b.minRating !== undefined ? parseInt(b.minRating, 10) : t.minRating;
      let hi = b.maxRating !== undefined ? parseInt(b.maxRating, 10) : t.maxRating;
      if (!Number.isFinite(lo) || lo < 0) lo = 0;
      if (!Number.isFinite(hi) || hi <= 0) hi = 9999;
      if (lo > hi) { const tmp = lo; lo = hi; hi = tmp; }
      upd.minRating = lo; upd.maxRating = hi;
    }
    if (b.startsAt) {
      const st = new Date(b.startsAt).getTime();
      if (!Number.isFinite(st)) return res.status(400).json({ error: 'Неверная дата начала' });
      upd.startsAt = st;
    }
    if (Array.isArray(b.teamLinks) && b.teamLinks.length > 500) {
      return res.status(400).json({ error: 'Слишком много ссылок на команды' });
    }
    Object.assign(t, upd);
    // Старт перенесли в будущее — сбрасываем флаг «старт уже обработан», иначе при
    // новом старте участников не поставят в очередь и пары не создадутся.
    if (upd.startsAt !== undefined && upd.startsAt > Date.now()) delete t._startNotified;
    if (upd.startsAt !== undefined || upd.durationMinutes !== undefined) {
      t.endsAt = t.startsAt + t.durationMinutes * 60000;
    }
    if (Array.isArray(req.body.blacklist)) t.blacklist = req.body.blacklist.map(s => String(s).toLowerCase().trim()).filter(Boolean).slice(0, 100);
    // Редактирование списка команд межклубного турнира (только для isInterclub турниров,
    // requireTournamentManager уже гарантирует, что сюда попадёт только сайт-админ).
    if (t.isInterclub && Array.isArray(req.body.teamLinks)) {
      const { teamIds, notFound } = resolveInterclubTeams(req.body.teamLinks);
      if (teamIds.length < 2) return res.status(400).json({ error: 'Нужно указать ссылки минимум на 2 клуба-команды' });
      if (teamIds.length > MAX_INTERCLUB_TEAMS) return res.status(400).json({ error: `Максимум ${MAX_INTERCLUB_TEAMS} команд в межклубном турнире` });
      if (notFound.length) return res.status(400).json({ error: `Не найдены клубы по ссылкам: ${notFound.slice(0, 10).join(', ')}` });
      // Нельзя убрать команду, за которую уже кто-то реально играет в этом турнире.
      const usedTeamIds = new Set((t.participants || []).filter(p => !p.left && p.teamId).map(p => p.teamId));
      for (const used of usedTeamIds) {
        if (!teamIds.includes(used)) {
          const club = clubs.find(c => c.id === used);
          return res.status(400).json({ error: `Нельзя убрать команду «${club ? club.name : used}» — за неё уже играют участники` });
        }
      }
      t.teamIds = teamIds;
    }
    await saveTournament(t);
    io.emit('tournament_updated', { id: t.id, name: t.name, startsAt: t.startsAt });
    res.json(t);
  });
}


async function handleDeleteTournament(req, res) {
  await requireTournamentManager(req, res, async (t) => {
    const idx = tournaments.findIndex(x => x.id === t.id);
    if (idx === -1) return res.status(404).json({ error: 'Не найден' });
    tournaments.splice(idx, 1);
    await deleteTournamentFromDB(t.id);
    io.emit('tournament_deleted', t.id);
    res.json({ ok: true });
  });
}


async function handleUnblacklistTournament(req, res) {
  await requireTournamentManager(req, res, async (t) => {
    t.blacklist = (t.blacklist || []).filter(u => u !== req.params.username.toLowerCase());
    await saveTournament(t);
    res.json({ ok: true, blacklist: t.blacklist });
  });
}
};
