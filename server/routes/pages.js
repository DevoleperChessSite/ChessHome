// ═══════════════════════════════════════════════════════════════
//  routes/pages.js — HTML-страницы (статические маршруты)
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  path,
  app,
  tournaments,
  blogPosts,
  newsPosts,
  sendVersionedHtml,
  LICHESS_TOKEN,
} = require('../core');

module.exports = function register(app) {
// Корень "/" отдаём тем же путём (версия + no-store), а не через
// автоматический index.html из express.static — поэтому ниже у
// express.static выставлен index:false.
app.get('/', (req, res) => sendVersionedHtml(res, path.join(__dirname, '../../public/index.html')));
 // положите токен в .env

app.get('/api/opening-explorer', async (req, res) => {
  try {
    const fen = req.query.fen;
    if (!fen) return res.status(400).json({ error: 'fen обязателен' });

    const r = await fetch(`https://explorer.lichess.ovh/masters?fen=${encodeURIComponent(fen)}`, {
      headers: LICHESS_TOKEN ? { Authorization: `Bearer ${LICHESS_TOKEN}` } : {}
    });
    if (!r.ok) return res.status(r.status).json({ error: `Lichess API ${r.status}` });

    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: 'Ошибка проксирования запроса к Lichess' });
  }
});


app.get('/opening-database', (req, res) => res.sendFile(path.join(__dirname, '../../public/opening-database.html')));


app.get('/blog',    (req, res) => res.sendFile(path.join(__dirname, '../../public/blog.html')));
app.get('/vs-computer',    (req, res) => res.sendFile(path.join(__dirname, '../../public/vs-computer.html')));


app.get('/blog/:id',(req, res) => {
  const post = blogPosts.find(p => p.id === req.params.id);
  // Удалённой статьи не существует, а прикрытую никто не должен увидеть по прямой ссылке.
  if (!post || post.status === 'hidden') return res.redirect('/404.html');
  res.sendFile(path.join(__dirname, '../../public/blog.html'));
});


app.get('/news',    (req, res) => res.sendFile(path.join(__dirname, '../../public/news.html')));

app.get('/news/:id',(req, res) => {
  const post = newsPosts.find(p => p.id === req.params.id);
  // Удалённой новости не существует, а прикрытую никто не должен увидеть по прямой ссылке.
  if (!post || post.status === 'hidden') return res.redirect('/404.html');
  res.sendFile(path.join(__dirname, '../../public/news.html'));
});

app.get('/news/:id/comments', (req, res) => {
  const post = newsPosts.find(p => p.id === req.params.id);
  if (!post || post.status === 'hidden') return res.redirect('/404.html');
  res.sendFile(path.join(__dirname, '../../public/news.html'));
});


app.get('/followers/:username', (req, res) => res.sendFile(path.join(__dirname, '../../public/followers.html')));

// 4.3: /following/:username отдаёт тот же followers.html — страница умеет
app.get('/following/:username', (req, res) => res.sendFile(path.join(__dirname, '../../public/followers.html')));


app.get('/dev-diary', (req, res) => res.sendFile(path.join(__dirname, '../../public/dev-diary.html')));

app.get('/durka',    (req, res) => res.sendFile(path.join(__dirname, '../../public/durka.html')));

app.get('/ai', (req, res) => res.sendFile(path.join(__dirname, '../../public/ai.html')));

['privacy','terms','about','admin','tournaments','tournament','admin-tournament','report'].forEach(p => {
  app.get('/' + p, (req, res) => res.sendFile(path.join(__dirname, '../../public/' + p + '.html')));
});

// SPA-маршруты (клиентский роутер в index.html) — из core.js.
const SPA_ROUTES = ['/lobby', '/analysis', '/editor', '/leaderboard'];
SPA_ROUTES.forEach(r => { app.get(r, (req, res) => res.sendFile(path.join(__dirname, '../../public/index.html'))); });


};
