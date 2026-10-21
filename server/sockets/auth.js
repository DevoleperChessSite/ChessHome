// ═══════════════════════════════════════════════════════════════
//  sockets/auth.js — аутентификация сокета по HttpOnly-cookie
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного sockets.js в рамках рефакторинга.
//  Код обработчиков не изменён.

const {
  parseCookieHeader,
  bannedIPs,
  usersCache,
  getUser,
  tournaments,
  saveTournament,
  io,
  sessions,
  usernameToSocketId,
  onlineUsers,
  activeGames,
  sanitizeTournament,
  getTournamentStatus,
  verifyToken,
  tryPairTournamentPlayers,
  serverChess,
} = require('../core');

const twins = require('../twins');

module.exports = function registerAuth(socket, socketIP) {
  socket.on('auth', async (_clientSuppliedToken) => {
    // Токен читаем ТОЛЬКО из HttpOnly-cookie в заголовках handshake —
    // аргумент, присланный клиентом, больше не используется, т.к. JS
    // на странице не может (и не должен) знать значение httpOnly-токена.
    const handshakeCookies = parseCookieHeader(socket.handshake.headers.cookie);
    const token = handshakeCookies.ch_token;
    const p = token ? verifyToken(token) : null;
    if (!p) return socket.emit('auth_error', 'Неверный токен');
    if (bannedIPs.has(socketIP)) { socket.emit('auth_error', 'Ваш IP заблокирован'); socket.disconnect(); return; }

    const lower = p.username.toLowerCase();
    let ids = usernameToSocketId.get(lower);
    const isFirstSocket = !ids || ids.size === 0;
    if (!ids) { ids = new Set(); usernameToSocketId.set(lower, ids); }
    ids.add(socket.id);
    sessions.set(socket.id, { username: p.username });
    if (isFirstSocket) onlineUsers.add(p.username);
    socket.username = p.username;
    twins.recordLogin(p.username, socketIP, handshakeCookies.ch_device_id);

    const user = await getUser(p.username.toLowerCase());
    if (user?.banned) { socket.emit('auth_error', 'Аккаунт заблокирован: ' + (user.banReason || 'нарушение правил')); socket.disconnect(); return; }

    socket.emit('auth_ok', { username: p.username });
    io.emit('online_count', onlineUsers.size);
    // Автоматически возвращаем игрока в очередь поиска соперника после
    // короткого обрыва связи (см. пометку "_resumeOnReconnect" в disconnect-хендлере),
    // если он именно искал партию, а не поставил паузу сам руками.
    for (const t of tournaments) {
      const tp = t.participants.find(tp => tp.username === p.username);
      if (!tp) continue;
      if (tp._resumeOnReconnect) {
        tp._resumeOnReconnect = false;
        if (!tp.left && !tp.anticheatBanned && !tp.currentGameId && getTournamentStatus(t, Date.now()) === 'active') {
          tp.waiting = true;
          io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
          saveTournament(t).catch(() => {});
          tryPairTournamentPlayers(t);
        }
      }
    }
    for (const [gId, game] of activeGames.entries()) {
      if (game.white === p.username || game.black === p.username) {
        const color = game.white === p.username ? 'white' : 'black';
        const opponent = color === 'white' ? game.black : game.white;
        const oppRating = usersCache.get(opponent.toLowerCase())?.rating ?? '?';
        let rejoinWhiteTime = game.whiteTime, rejoinBlackTime = game.blackTime;
        if (game.lastMoveAt !== null && rejoinWhiteTime !== undefined) {
          const elapsedSince = (Date.now() - game.lastMoveAt) / 1000;
          if (game.turn === 'white') rejoinWhiteTime = Math.max(0, rejoinWhiteTime - elapsedSince);
          else                       rejoinBlackTime = Math.max(0, rejoinBlackTime - elapsedSince);
        }
        socket.emit('game_start', { gameId: gId, color, opponent, opponentRating: oppRating, timeControl: game.timeControl, moves: game.moves, whiteTime: rejoinWhiteTime, blackTime: rejoinBlackTime, lastMoveAt: game.lastMoveAt, chatMessages: game.chatMessages || [], ...(game.tournamentId ? { tournamentId: game.tournamentId, tournamentName: game.tournamentName, isInterclub: !!game.isInterclub, firstMoveDeadline: game.firstMoveDeadline } : {}) });
        if (!game._board) { game._board = serverChess.rebuildBoard(game.moves); }
        break;
      }
    }
  });
}
