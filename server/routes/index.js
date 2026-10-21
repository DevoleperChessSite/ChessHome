// ═══════════════════════════════════════════════════════════════
//  routes/index.js — агрегатор HTTP-роутов (Express)
// ═══════════════════════════════════════════════════════════════
//  Раньше это был монолитный routes.js на ~4600 строк. Теперь каждый
//  домен живёт в своём файле (server/routes/*.js) и экспортирует
//  функцию register(app), регистрирующую свои маршруты.
//
//  КРИТИЧНО: порядок подключений ниже повторяет исходный порядок
//  регистрации маршрутов в routes.js — Express.match идёт по порядку,
//  поэтому переставлять блоки нельзя. В конце — универсальный
//  app.get('*') и error-хендлер, они обязаны оставаться последними.

const { app, path, sendVersionedHtml } = require('../core');

// ── Побочные require (как в оригинальном routes.js, ДО async-обёртки) ──
// botmoderator и changelog регистрируют СВОИ маршруты в момент require —
// поэтому подключаются до всех доменных модулей (и до app.get('*')).
require('../botmoderator');
require('../changelog');
// _shared создаёт таблицу deleted_usernames и отдаёт общие хелперы доменам.
require('./_shared');

// ── Async-изоляция роутов (D6) ────────────────────────────────
// Express 4 НЕ ловит rejected-промисы в async-хендлерах: любой throw/отказ
// в ~40 async-роутах оставлял запрос висеть навсегда и создавал
// unhandledRejection (в Node >= 15 — падение процесса). Вместо ручных
// try/catch в каждом роуте — оборачиваем все регистрируемые хендлеры
// разово: app.get/post/patch/delete/put вызываются через обёртку, которая
// транслирует ошибки в next(err), а финальный error-хендлер в конце файла
// отвечает клиенту 500.
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'];
for (const method of HTTP_METHODS) {
  const original = app[method].bind(app);
  app[method] = function (routePath, ...handlers) {
    const wrapped = handlers.map(h => {
      if (typeof h !== 'function') return h;
      // Пропускаем express-промежуточные слои с 4+ аргументами (error-хендлеры)
      if (h.length >= 4) return h;
      return function (req, res, next) {
        try {
          const r = h(req, res, next);
          if (r && typeof r.catch === 'function') r.catch(next);
          return r;
        } catch (e) { next(e); }
      };
    });
    return original(routePath, ...wrapped);
  };
}

// ── Доменные роуты (порядок = исходный порядок routes.js) ─────
require('./pages')(app);              // HTML-страницы
require('./auth')(app);               // регистрация/вход/аккаунт
require('./users')(app);              // профили/поиск/эмодзи
require('./games')(app);              // API партий
require('./misc')(app);               // лидерборд/онлайн/пинг/вызовы/чат GET
require('./quests')(app);             // квесты
require('./admin')(app);              // админ-панель
require('./reports')(app);            // жалобы
require('./appeals')(app);            // апелляции
require('./tournaments')(app);        // турниры
require('./dm')(app);                 // личные сообщения
require('./admin-diagnostics')(app);  // системные сообщения/аудит ЛС/логи/дашборд
require('./forum')(app);              // форум
require('./follow')(app);             // подписки
require('./blog')(app);               // блог
require('./news')(app);               // новости
require('./clubs')(app);              // клубы
require('./puzzles')(app);            // задачи
require('./durka')(app);              // «дурка» (внешние турниры)
require('./storm')(app);              // Puzzle Storm
require('./pages-late')(app);         // HTML-страницы (вторая группа)
require('./stats')(app);              // статистика
require('./dev-diary')(app);          // дневник разработки
require('./game-page')(app);          // страница партии /game/:gameId

// ── Финальные fallback-маршруты (обязаны быть последними) ─────

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Не найдено' });
  if (/\.[a-z0-9]+$/i.test(req.path)) { return res.status(404).sendFile(path.join(__dirname, '../public/404.html')); }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});


// Любой /api/* запрос с методом, для которого нет отдельного маршрута выше
// (POST/PATCH/PUT/DELETE на несуществующий или опечатанный путь), должен
// получить JSON, а не дефолтную HTML-страницу Express вида
// "Cannot DELETE /api/...". Именно из-за такой HTML-страницы фронтенд падал
// с "JSON.parse: unexpected character at line 1 column 1" — он пытался
// распарсить HTML как JSON.
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Эндпоинт не найден' });
});

// ── Обработчик ошибок — ДОЛЖЕН быть зарегистрирован последним ──


// Финальный обработчик ошибок — гарантирует, что клиент ВСЕГДА получит JSON,
// а не HTML-страницу с трейсом, даже если где-то в коде забыли try/catch.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Слишком большой запрос' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Некорректный JSON в запросе' });
  }
  console.error('[Unhandled error]', err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});
