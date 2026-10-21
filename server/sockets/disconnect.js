// ═══════════════════════════════════════════════════════════════
//  sockets/disconnect.js — обработка отключения сокета (сессии, онлайн, турнирная пауза)
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного sockets.js в рамках рефакторинга.
//  Код обработчиков не изменён.

const {
  tournaments,
  io,
  sessions,
  usernameToSocketId,
  onlineUsers,
} = require('../core');

module.exports = function registerDisconnect(socket) {
  socket.on('disconnect', () => {
    const sess = sessions.get(socket.id);
    if (sess) {
      sessions.delete(socket.id);
      // Multi-socket: убираем только ЭТОТ сокет из набора юзера; онлайн-счётчик
      // уменьшаем, лишь когда у юзера не осталось ни одного сокета.
      const low = sess.username.toLowerCase();
      const ids = usernameToSocketId.get(low);
      if (ids) {
        ids.delete(socket.id);
        if (ids.size === 0) {
          usernameToSocketId.delete(low);
          onlineUsers.delete(sess.username);
        }
      } else {
        onlineUsers.delete(sess.username);
      }
      // Турнирную паузу/возврат в очередь делаем ТОЛЬКО если у юзера не
      // осталось других живых сокетов (multi-socket): отключение DM-сокета
      // header.js не должно снимать игрока с очереди поиска партии.
      const userStillOnline = usernameToSocketId.has(sess.username.toLowerCase());
      if (!userStillOnline) {
        io.emit('online_count', onlineUsers.size);
        for (const t of tournaments) {
        const p = t.participants.find(p => p.username === sess.username);
        if (p && p.waiting && !p.left && !p.anticheatBanned && !p.currentGameId) {
          p._resumeOnReconnect = true;
        }
        if (p) p.waiting = false;
      }
      }
    }
  });
}
