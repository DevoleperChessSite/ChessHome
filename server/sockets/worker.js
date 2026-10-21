// ═══════════════════════════════════════════════════════════════
//  sockets/worker.js — домашние worker-ы анализа (Stockfish) и воркер-сокеты
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного sockets.js в рамках рефакторинга.
//  Код обработчиков не изменён.

const {
  uuidv4,
  io,
  workers,
  analyzeJobs,
  pickIdleWorker,
  safeSecretEqual,
} = require('../core');

const workerAuthFails = new Map(); // ip -> { count, resetAt }
const WORKER_AUTH_MAX_FAILS = 5;
const WORKER_AUTH_WINDOW_MS = 10 * 60 * 1000;
function isWorkerAuthBlocked(ip) {
  const d = workerAuthFails.get(ip);
  if (!d) return false;
  if (Date.now() > d.resetAt) { workerAuthFails.delete(ip); return false; }
  return d.count >= WORKER_AUTH_MAX_FAILS;
}
function registerWorkerAuthFail(ip) {
  const now = Date.now();
  let d = workerAuthFails.get(ip);
  if (!d || now > d.resetAt) {
    if (workerAuthFails.size > 10000) workerAuthFails.clear(); // защита памяти
    d = { count: 0, resetAt: now + WORKER_AUTH_WINDOW_MS };
    workerAuthFails.set(ip, d);
  }
  d.count++;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, d] of workerAuthFails) if (now > d.resetAt) workerAuthFails.delete(ip);
}, 60 * 1000).unref();
// Строка от воркера — только вывод UCI-движка («info …» / «bestmove …»): ASCII,
// без угловых скобок и кавычек, не длиннее 1000 символов.
function sanitizeUciLine(line) {
  if (typeof line !== 'string' || line.length > 1000) return null;
  return /^(info|bestmove)[A-Za-z0-9 .\-_:=+\/()]*$/.test(line) ? line : null;
}
if (process.env.WORKER_SECRET && process.env.WORKER_SECRET.length < 24) {
  console.warn('⚠️  WORKER_SECRET короче 24 символов — задайте длинный случайный секрет: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"');
}

module.exports = function registerWorker(socket, socketIP) {
  // ── ДОМАШНИЙ WORKER: аутентификация по секретному токену ──────
  // Если задан WORKER_SECRET в .env — принимаем воркер-подключения.
  // Если не задан вообще — фича просто выключена, ничего не ломается.
  socket.on('worker_auth', (payload) => {
    if (isWorkerAuthBlocked(socketIP)) {
      socket.emit('worker_auth_error', 'Слишком много попыток, подождите');
      socket.disconnect(true);
      return;
    }
    const secret = typeof payload === 'string' ? payload : payload?.secret;
    if (!process.env.WORKER_SECRET || typeof secret !== 'string' || !safeSecretEqual(secret, process.env.WORKER_SECRET)) {
      registerWorkerAuthFail(socketIP);
      socket.emit('worker_auth_error', 'Неверный секрет');
      socket.disconnect(true);
      return;
    }
    const threads = (typeof payload === 'object' && Number.isInteger(payload?.threads))
      ? Math.max(1, Math.min(payload.threads, 64)) : 1;
    workers.set(socket.id, { socket, threads, busy: false, lastSeen: Date.now() });
    socket.isWorker = true;
    socket.emit('worker_auth_ok');
    console.log(`[Worker] Подключился (${threads} поток(а/ов)). Всего воркеров онлайн: ${workers.size}`);
  });
  socket.on('worker_heartbeat', () => {
    const w = workers.get(socket.id);
    if (w) w.lastSeen = Date.now();
  });
  // Воркер прислал промежуточную строку анализа ("info depth ...") —
  // пересылаем её как есть тому браузеру, который заказал анализ.
  // Формат строки — родной UCI-вывод Stockfish, парсер на клиенте
  // (stockfish-ui.js) уже умеет такие строки читать — не важно,
  // пришли они от локального движка в браузере или от воркера.
  // Принимаем только от аутентифицированного воркера, которому задача выдана,
  socket.on('worker_job_progress', (msg) => {
    if (!socket.isWorker || !msg || typeof msg !== 'object') return;
    const job = analyzeJobs.get(msg.jobId);
    if (!job || job.workerSocketId !== socket.id) return;
    const line = sanitizeUciLine(msg.line);
    if (!line) return;
    const requester = io.sockets.sockets.get(job.requesterSocketId);
    if (requester) requester.emit('analyze_line', line);
  });
  socket.on('worker_job_done', (msg) => {
    if (!socket.isWorker || !msg || typeof msg !== 'object') return;
    const job = analyzeJobs.get(msg.jobId);
    if (!job || job.workerSocketId !== socket.id) return;
    const line = sanitizeUciLine(msg.line);
    const requester = io.sockets.sockets.get(job.requesterSocketId);
    if (requester && line) requester.emit('analyze_line', line);
    const w = workers.get(job.workerSocketId);
    if (w) w.busy = false;
    analyzeJobs.delete(msg.jobId);
  });

  // ── Запрос анализа от обычного посетителя (страница «Анализ») ──
  socket.on('analyze_request', ({ fen, depth }) => {
    if (typeof fen !== 'string' || fen.length > 100) return;
    const safeDepth = Number.isInteger(depth) ? Math.max(1, Math.min(depth, 30)) : 18;
    const w = pickIdleWorker();
    if (!w) { socket.emit('analyze_unavailable'); return; } // клиент сам уйдёт на локальный анализ в браузере
    const jobId = uuidv4();
    w.busy = true;
    analyzeJobs.set(jobId, { requesterSocketId: socket.id, workerSocketId: w.socket.id });
    w.socket.emit('worker_job', { jobId, fen, depth: safeDepth });
  });
  socket.on('analyze_cancel', () => {
    for (const [jobId, job] of analyzeJobs.entries()) {
      if (job.requesterSocketId === socket.id) {
        const w = workers.get(job.workerSocketId);
        if (w) { w.socket.emit('worker_job_cancel', { jobId }); w.busy = false; }
        analyzeJobs.delete(jobId);
      }
    }
  });
  socket.on('disconnect', () => {
    if (socket.isWorker && workers.has(socket.id)) {
      workers.delete(socket.id);
      // Если у этого воркера была незавершённая задача — сообщаем
      // заказчику, чтобы он не завис в ожидании, а ушёл на локальный
      // анализ в браузере.
      for (const [jobId, job] of analyzeJobs.entries()) {
        if (job.workerSocketId === socket.id) {
          const requester = io.sockets.sockets.get(job.requesterSocketId);
          if (requester) requester.emit('analyze_unavailable');
          analyzeJobs.delete(jobId);
        }
      }
      console.log(`[Worker] Отключился. Воркеров онлайн: ${workers.size}`);
    }
  });
}
