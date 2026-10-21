// ═══════════════════════════════════════════════════════════════
//  routes/pages-late.js — HTML-страницы (вторая группа — позиция как в оригинале)
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  path,
  app,
  tournaments,
} = require('../core');

module.exports = function register(app) {
app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, '../../public/profile.html')));

app.get('/settings', (req, res) => res.sendFile(path.join(__dirname, '../../public/settings.html')));

// /tournaments/active, /tournaments/upcoming, /tournaments/finished — прямые ссылки на вкладки,
// отдаём ту же страницу, фильтрацию по вкладке делает клиентский JS (см. tournaments.html)
app.get('/tournaments/*', (req, res) => res.sendFile(path.join(__dirname, '../../public/tournaments.html')));

app.get('/profile/:username', (req, res) => res.sendFile(path.join(__dirname, '../../public/profile.html')));

app.get('/user/:username',    (req, res) => res.sendFile(path.join(__dirname, '../../public/profile.html')));

app.get('/tournament/:id',    (req, res) => res.sendFile(path.join(__dirname, '../../public/tournament.html')));

// Межклубные турниры — отдельная страница карточки турнира (со своей вёрсткой:
// командный зачёт, состав команд и т.п.), НЕ путать с /tournament/:id выше —
// та отдаёт общий шаблон одиночного турнира без командной статистики.
// Регистрируем ПОСЛЕ /tournament/:id намеренно — не важно, т.к. паттерны разной
// длины ("/tournament/interclub/xxx" — 2 сегмента, не матчится /tournament/:id).
app.get('/tournament/interclub/:id', (req, res) => res.sendFile(path.join(__dirname, '../../public/interclub-tournament.html')));

// Чистый URL без .html для списка межклубных турниров (сам список — public/interclub-tournaments.html).
app.get('/interclub-tournaments', (req, res) => res.sendFile(path.join(__dirname, '../../public/interclub-tournaments.html')));

app.get('/inbox',             (req, res) => res.sendFile(path.join(__dirname, '../../public/inbox.html')));

app.get('/inbox/:partner',    (req, res) => res.sendFile(path.join(__dirname, '../../public/inbox.html')));

app.get('/forum',             (req, res) => res.sendFile(path.join(__dirname, '../../public/forum.html')));

app.get('/forum/*',           (req, res) => res.sendFile(path.join(__dirname, '../../public/forum.html')));

app.get('/puzzles',           (req, res) => res.sendFile(path.join(__dirname, '../../public/index.html')));

app.get('/puzzles/*',         (req, res) => res.sendFile(path.join(__dirname, '../../public/index.html')));

app.get('/stats',             (req, res) => res.sendFile(path.join(__dirname, '../../public/stats.html')));

app.get('/storm',             (req, res) => res.sendFile(path.join(__dirname, '../../public/storm.html')));

app.get('/storm/*',           (req, res) => res.sendFile(path.join(__dirname, '../../public/storm.html')));

app.get('/age', (req, res) => { res.sendFile(path.join(__dirname, '../../public', 'age.html')); });

app.get('/online', (req, res) => res.sendFile(path.join(__dirname, '../../public/online.html')));


// ── /api/stats: тяжёлая выборка (24 запроса к БД) — кэшируем на 60 секунд ──
// Без кэша каждый заход на /stats (в том числе ботов) занимал почти весь пул
// соединений (30), и остальные запросы сайта ждали или падали по таймауту.
const STATS_TTL_MS = 60_000;
let statsCache = { ts: 0, data: null, pending: null };

};
