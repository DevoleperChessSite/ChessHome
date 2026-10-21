// ═══════════════════════════════════════════════════════════════
//  http/versioned-html.js — cache-busting для /js/*.js внутри HTML
// ═══════════════════════════════════════════════════════════════
const fs = require('fs');

// ── Cache-busting для /js/*.js внутри HTML ─────────────────────
// Проблема, которую это решает: браузер кэширует /js/app.js на 1 час
// (см. maxAge статики ниже). HTML при этом всегда отдаётся свежим
// (no-store), но <script src="/js/app.js"> — это один и тот же URL,
// поэтому после деплоя пользователи до часа могли получать старый
// app.js, хотя страница уже новая (отсюда "ReferenceError: X is not
// defined" после обновления кода).
//
// BUILD_VERSION генерируется один раз при старте процесса. Деплой =
// перезапуск сервера => новая версия => во всех отдающихся HTML
// автоматически подставляется новый ?v=..., браузер воспринимает это
// как новый URL и гарантированно скачивает свежий файл, игнорируя
// старый закэшированный. Уже открытые у пользователей вкладки этим не
// затронуты (их не заставить перезагрузиться), но любая новая загрузка/
// обновление страницы получает актуальный код.
const BUILD_VERSION = Date.now();

const JS_SRC_RE = /(<script\b[^>]*\bsrc=["'])(\/js\/[^"']+\.js)(["'])/g;


function sendVersionedHtml(res, filePath) {
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return res.status(404).end();
    const versioned = html.replace(JS_SRC_RE, `$1$2?v=${BUILD_VERSION}$3`);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(versioned);
  });
}

module.exports = { BUILD_VERSION, JS_SRC_RE, sendVersionedHtml };
