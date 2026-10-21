// ═══════════════════════════════════════════════════════════════
//  sockets/index.js — Socket.IO: точка входа реалтайм-событий
// ═══════════════════════════════════════════════════════════════
//  Раньше это был монолитный sockets.js (~850 строк). Теперь обработчики
//  сгруппированы по доменам: worker, auth, tournaments, challenges,
//  games, clubs, chat, disconnect — каждый в своём файле.
//
//  ВАЖЕН ПОРЯДОК регистрации обработчиков внутри connection:
//    1) worker-обработчики — ДО rate-limit обёртки (как в оригинале:
//       воркеры не проходят общий socket-лимитер);
//    2) затем обёртка socket.on (rate-limit + изоляция ошибок);
//    3) затем все остальные домены.

const {
  io,
  bannedIPs,
  limiterSocketConnect,
  socketLimiter,
  isTrustedProxyPeer,
  cleanIpHeader,
} = require('../core');

const registerWorker      = require('./worker');
const registerAuth        = require('./auth');
const registerTournaments = require('./tournaments');
const registerChallenges  = require('./challenges');
const registerGames       = require('./games');
const registerClubs       = require('./clubs');
const registerChat        = require('./chat');
const registerDisconnect  = require('./disconnect');

io.on('connection', (socket) => {
  // Socket.io не использует req.ip — читаем заголовок напрямую из handshake.
  const peerAddr = socket.handshake.address;
  const socketIP = (
    (isTrustedProxyPeer(peerAddr) ? cleanIpHeader(socket.handshake.headers['x-real-ip']) : null)
    || peerAddr
    || 'unknown'
  );

  if (bannedIPs.has(socketIP)) {
    const banCheckTimer = setTimeout(() => { if (!socket.username) socket.disconnect(true); }, 3000);
    socket.once('auth', () => clearTimeout(banCheckTimer));
  }

  if (!limiterSocketConnect.check(socketIP).allowed) { socket.disconnect(true); return; }

  // ── Домашние worker-ы: аутентификация и джобы анализа ────────
  // (до обёртки socket.on — воркеры не лимитируются общим лимитером)
  registerWorker(socket, socketIP);

  // Обёртка над socket.on: rate-limit + изоляция ошибок.
  const origOn = socket.on.bind(socket);
  socket.on = function(event, handler) {
    if (event === 'connect' || event === 'disconnect' || event === 'error') return origOn(event, handler);
    return origOn(event, (...args) => {
      if (!socketLimiter.check(socket.id + '_' + event).allowed) { socket.emit('error', 'Слишком много запросов. Притормози!'); return; }
      try {
        const r = handler(...args);
        if (r && typeof r.catch === 'function') {
          r.catch(e => { console.error(`[SocketHandler] ${event}:`, e); socket.emit('error', 'Внутренняя ошибка сервера'); });
        }
      } catch (e) {
        console.error(`[SocketHandler] ${event}:`, e);
        socket.emit('error', 'Внутренняя ошибка сервера');
      }
    });
  };

  // ── Домены (порядок регистрации = исходный порядок sockets.js) ──
  registerAuth(socket, socketIP);
  registerTournaments(socket);
  registerChallenges(socket);
  registerGames(socket);
  registerClubs(socket);
  registerChat(socket, socketIP);
  registerDisconnect(socket);
});
