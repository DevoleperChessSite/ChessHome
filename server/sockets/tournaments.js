// ═══════════════════════════════════════════════════════════════
//  sockets/tournaments.js — сокет-события турниров (комнаты, очередь, берсерк)
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного sockets.js в рамках рефакторинга.
//  Код обработчиков не изменён.

const {
  usersCache,
  tournaments,
  saveTournament,
  io,
  activeGames,
  tournamentGames,
  sanitizeTournament,
  getTournamentStatus,
  findSocketByUsername,
  tryPairTournamentPlayers,
} = require('../core');

module.exports = function registerTournaments(socket) {
  socket.on('join_tournament_room',  (tid) => { socket.join(`tournament_${tid}`); const t = tournaments.find(t => t.id === tid); if (t) socket.emit('tournament_update', sanitizeTournament(t)); });
  socket.on('leave_tournament_room', (tid) => socket.leave(`tournament_${tid}`));

  socket.on('tournament_seek', (tournamentId) => {
    if (!socket.username) return;
    const t = tournaments.find(t => t.id === tournamentId);
    if (!t || getTournamentStatus(t, Date.now()) !== 'active') return socket.emit('error', 'Турнир не активен');
    const p = t.participants.find(p => p.username === socket.username);
    if (!p) return socket.emit('error', 'Вы не участвуете');
    if (p.currentGameId) return;
    if (p.waiting && !p.paused) return;
    // 2) Троттлинг: не чаще раза в секунду на сокет.
    const nowTs = Date.now();
    if (socket._lastSeekAt && nowTs - socket._lastSeekAt < 1000) return;
    socket._lastSeekAt = nowTs;
    p.waiting = true;
    p.paused = false;
    p.nextEligibleAt = 0; // явный клик "Играть" — грейс-период не нужен
    saveTournament(t).catch(() => {});
    io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
    tryPairTournamentPlayers(t);
  });

  socket.on('tournament_unseek', (tournamentId) => {
    if (!socket.username) return;
    const t = tournaments.find(t => t.id === tournamentId);
    if (!t) return;
    const p = t.participants.find(p => p.username === socket.username);
    if (p) { p.waiting = false; p.paused = true; saveTournament(t).catch(() => {}); io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t)); }
  });

  socket.on('tournament_rejoin', ({ tournamentId, gameId }) => {
    if (!socket.username) return;
    const t = tournaments.find(t => t.id === tournamentId);
    if (!t) return;
    const p = t.participants.find(p => p.username === socket.username);
    if (!p || p.currentGameId !== gameId) return;
    const game = activeGames.get(gameId);
    if (!game) return;
    const color = game.white === socket.username ? 'white' : 'black';
    const opponent = color === 'white' ? game.black : game.white;
    const oppRating = usersCache.get(opponent.toLowerCase())?.rating ?? '?';
    let rejoinWhiteTime = game.whiteTime, rejoinBlackTime = game.blackTime;
    if (game.lastMoveAt !== null && rejoinWhiteTime !== undefined) {
      const elapsedSince = (Date.now() - game.lastMoveAt) / 1000;
      if (game.turn === 'white') rejoinWhiteTime = Math.max(0, rejoinWhiteTime - elapsedSince);
      else                       rejoinBlackTime = Math.max(0, rejoinBlackTime - elapsedSince);
    }
    socket.emit('game_start', { gameId, color, opponent, opponentRating: oppRating, timeControl: game.timeControl, moves: game.moves, whiteTime: rejoinWhiteTime, blackTime: rejoinBlackTime, lastMoveAt: game.lastMoveAt, chatMessages: game.chatMessages || [], ...(game.tournamentId ? { tournamentId: game.tournamentId, tournamentName: game.tournamentName, isInterclub: !!game.isInterclub, firstMoveDeadline: game.firstMoveDeadline } : {}) });
  });

  socket.on('tournament_waiting', ({ tournamentId }) => {
    const t = tournaments.find(t => t.id === tournamentId);
    if (!t || !socket.username) return;
    const p = t.participants.find(p => p.username === socket.username);
    if (!p || p.left || p.anticheatBanned || p.currentGameId) return;
    if (getTournamentStatus(t, Date.now()) !== 'active') return;
    if (p.waiting && !p.paused) return;
    const nowTs = Date.now();
    if (socket._lastSeekAt && nowTs - socket._lastSeekAt < 1000) return;
    socket._lastSeekAt = nowTs;
    p.waiting = true;
    p.paused = false;
    p.nextEligibleAt = 0; // явный клик "Играть" — грейс-период не нужен
    saveTournament(t).catch(() => {});
    io.to(`tournament_${t.id}`).emit('tournament_update', sanitizeTournament(t));
    tryPairTournamentPlayers(t);
    // Повторная попытка спаривания через 1.5 сек — на случай если второй игрок ещё не вошёл в очередь
    setTimeout(() => tryPairTournamentPlayers(t), 1500);
  });

  socket.on('tournament_berserk', ({ gameId }) => {
    if (!socket.username) return;
    const game = tournamentGames.get(gameId); if (!game) return;
    // Безопасность: берсерк может включить ТОЛЬКО участник партии и только
    if (game.white !== socket.username && game.black !== socket.username) return;
    const color = game.white === socket.username ? 'white' : 'black';
    if (game.berserk[color] || game.moveCounts[color] > 0) return;
    game.berserk[color] = true;
    if (color === 'white') {
      game.whiteTime = Math.floor((game.whiteTime || 0) / 2);
    } else {
      game.blackTime = Math.floor((game.blackTime || 0) / 2);
    }
    game.tcIncrement = 0;
    game.lastMoveAt = game.lastMoveAt || Date.now();
    const payload = { gameId, color, berserk: game.berserk, whiteTime: game.whiteTime, blackTime: game.blackTime };
    [findSocketByUsername(game.white), findSocketByUsername(game.black)].forEach(s => s?.emit('berserk_activated', payload));
  });
}
