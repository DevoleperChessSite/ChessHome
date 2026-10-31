// ═══════════════════════════════════════════════════════════════
//  core.js — общее состояние сервера
// ═══════════════════════════════════════════════════════════════
// Системные синглтоны (app, io, server, env), общие кэши и хелперы.
// Доменная логика вынесена в сервисные модули:
//   server/db.js                          — пул PostgreSQL, db(), транзакции
//   server/services/game.service.js       — партии, часы, финалы, рейтинг
//   server/services/tournament.service.js — турниры, жеребьёвка, тик
//   server/services/chat.service.js       — история чатов (глобал/клубы/турниры)
//   server/utils.js                       — серверные хелперы (escapeHtml)
//
// routes.js и sockets.js делают:
//   const { app, io, db, ... } = require('./core');
// и используют эти же самые объекты — состояние по-настоящему общее,
// это НЕ копии. Экспорт внизу файла дополняет module.exports
// через Object.assign — ссылки у всех общие.
// ═══════════════════════════════════════════════════════════════

const express = require('express');

const http    = require('http');

const { Server } = require('socket.io');

// npm install compression — жмёт HTTP-ответы (JSON/HTML/JS/CSS) gzip'ом.
// На 1 ядре это дешёвая по CPU операция (сжатие лёгкое, express.json уже
// режет тела до 50kb), а трафика и времени ответа на медленных сетях
// экономит заметно, особенно под 100 одновременных клиентов.
const compression = require('compression');

// Нативный bcrypt считает хеш в пуле потоков libuv и НЕ блокирует event loop.
// bcryptjs — чистый JS: каждый hash/compare занимает единственный поток на десятки мс
// (часы партий и сокеты в это время стоят). Если bcrypt не установлен — работаем на bcryptjs.
let bcrypt;
try {
  bcrypt = require('bcrypt');
} catch (_) {
  bcrypt = require('bcryptjs');
  console.warn('⚠️  Пакет bcrypt не установлен — используется bcryptjs (блокирует event loop). Установите: npm i bcrypt');
}

const jwt     = require('jsonwebtoken');

const { v4: uuidv4 } = require('uuid');

const path    = require('path');

const fs      = require('fs');

const cors    = require('cors');

// ── PostgreSQL: пул и хелперы запросов — в server/db.js ────────
const { pool, db, withTransaction } = require('./db');

// ── Сервисные модули (см. шапку файла) ────────────────────────
const chatService       = require('./services/chat.service');
const gameService       = require('./services/game.service');
const tournamentService = require('./services/tournament.service');

const {
  globalChat,
  loadChat,
  saveChatMsg,
  deleteChatMsg,
  CLUB_CHAT_MAX,
  clubChats,
  clubChatBans,
  getClubChat,
  getClubChatBans,
  loadClubChats,
  saveClubChatMsg,
  deleteClubChatMsgsByUser,
  TOURNAMENT_CHAT_MAX,
  TOURNAMENT_CHAT_READONLY_AFTER_MS,
  tournamentChats,
  tournamentChatMutes,
  getTournamentChat,
  getTournamentChatMutes,
  isTournamentChatOpen,
  loadTournamentChats,
  saveTournamentChatMsg,
  wipeTournamentChatMsgsByUser,
  removeUserChatMessages,
} = chatService;

const {
  activeGames,
  tournamentGames,
  liveClock,
  hasFullMove,
  endGameAuthoritative,
  recordGame,
  updateStats,
  startGame,
  serverChess,
} = gameService;

const {
  tournaments,
  loadTournaments,
  saveTournament,
  deleteTournamentFromDB,
  MAX_INTERCLUB_TEAMS,
  extractClubIdFromLink,
  resolveInterclubTeams,
  getTournamentStatus,
  getInterclubTeamsInfo,
  computeTeamStandings,
  sanitizeTournament,
  REMATCH_GRACE_PERIOD,
  tryPairTournamentPlayers,
  FIRST_MOVE_TIMEOUT,
  startTournamentGame,
  finishTournamentGame,
  anticheatBan,
} = tournamentService;

require('dotenv').config();

// ── Извлечённые модули (чистые слои без состояния сервера) ─────
const {
  BAD_NICK_WORDS, normNick, nickHasBadWord, normForSimilarity,
} = require('./validation/nicknames');
const { PROFILE_EMOJIS } = require('./validation/profile-emojis');
const {
  parseCookieHeader, getAuthToken, isProd, AUTH_COOKIE_OPTS, DEVICE_COOKIE_OPTS,
} = require('./http/cookies');
const { isTrustedProxyPeer, cleanIpHeader, getIP, isLocalIP } = require('./http/client-ip');
const { BUILD_VERSION, JS_SRC_RE, sendVersionedHtml } = require('./http/versioned-html');
const {
  RateLimiter, limiterGeneral, limiterAuth, limiterStrict, socketLimiter,
  limiterRegStrict, limiterQuests, rateLimit,
} = require('./security/rate-limiter');
const { safeSecretEqual } = require('./security/secrets');
const {
  loginFailStreaks, getLoginFailStreak, getUsernameFailTotal, getUsernameLockUntil,
  bumpLoginFailStreak, clearLoginFailStreak,
} = require('./security/login-throttle');
const {
  bannedIPs, bannedDevices, loadBansFromDB, saveBanToDB, removeBanFromDB, ipBanMiddleware,
} = require('./security/ip-bans');
const { vpnCheckCache, VPN_CACHE_TTL, isVpnOrProxy } = require('./security/vpn-check');


const app = express();

app.use((req, res, next) => { req.cookies = parseCookieHeader(req.headers.cookie); next(); });



// ── Device ID выдаётся и хранится ТОЛЬКО сервером (HttpOnly) ──
app.use((req, res, next) => {
  let deviceId = req.cookies.ch_device_id;
  if (!deviceId) {
    deviceId = 'dev_' + uuidv4();
    res.cookie('ch_device_id', deviceId, DEVICE_COOKIE_OPTS);
  }
  req.deviceId = deviceId;
  next();
});


// ── Доверие к прокси (Nginx + Cloudflare) ────────────────────
// ВАЖНО: должно быть ДО любых middleware и роутов.
// Значение 2 означает: доверяем двум уровням прокси —
//   1-й hop: Cloudflare → ваш сервер
//   2-й hop: Nginx → Node.js
// После этого req.ip будет автоматически содержать реальный IP клиента.
app.set('trust proxy', 2);


// ── PUZZLE STORM: серверный трекинг забегов ─────────────────────
const STORM_DURATION_MS   = 180_000;
        // должно совпадать со STORM_DURATION в storm.html
const STORM_MAX_TIME_MS   = STORM_DURATION_MS * 1.5 + 20_000;
 // +50% от бонусов стрика, +20с запас на сеть/рендер
const STORM_MIN_MS_PER_PUZZLE = 350;
        // быстрее физически не решить и не увидеть следующую задачу
const stormRuns = new Map();
 // runId -> { userId, startedAt }
setInterval(() => {
  const cutoff = Date.now() - STORM_MAX_TIME_MS - 60_000;
  for (const [id, run] of stormRuns) if (run.startedAt < cutoff) stormRuns.delete(id);
}, 5 * 60_000);


// ── Кэш пользователей ─────────────────────────────────────────
const usersCache = new Map();

const USERS_CACHE_MAX = 100_000;

function cacheUser(u) {
  if (!u) return;
  const key = u.username_low || u.username.toLowerCase();
  // Перезапись существующего ключа не растит Map — обновим позицию вставки,
  // чтобы «горячие» пользователи не вытеснялись первыми.
  if (usersCache.has(key)) usersCache.delete(key);
  else if (usersCache.size >= USERS_CACHE_MAX) {
    const oldest = usersCache.keys().next().value;
    if (oldest !== undefined) usersCache.delete(oldest);
  }
  usersCache.set(key, u);
}


function rowToUser(row) {
  if (!row) return null;
  return {
    id:               row.id,
    username:         row.username,
    email:            row.email,
    passwordHash:     row.password_hash,
    rating:           row.rating,
    gamesPlayed:      row.games_played,
    wins:             row.wins,
    losses:           row.losses,
    draws:            row.draws,
    avatar:           row.avatar,
    role:             row.role,
    banned:           row.banned,
    banReason:        row.ban_reason,
    shadowBanned:     row.shadow_banned || false,
    shadowBanReason:  row.shadow_ban_reason || null,
    createdAt:        Number(row.created_at),
    createdFromIP:    row.created_from_ip,
    createdDeviceId:  row.created_device_id,
    puzzle_rating:    row.puzzle_rating,
    puzzle_solved:    row.puzzle_solved,
    puzzle_attempted: row.puzzle_attempted,
    storm_best:       row.storm_best   || 0,
    storm_runs:       row.storm_runs   || 0,
    emoji:            row.emoji        || '',
    bio:              row.bio         || '',
    fshrRating:       row.fshr_rating != null ? row.fshr_rating : null,
    fideRating:       row.fide_rating != null ? row.fide_rating : null,
    vipUntil:         row.vip_until != null ? Number(row.vip_until) : null,
    badges:           Array.isArray(row.badges) ? row.badges : [],
  };
}


// ── VIP-значок ───────────────────────────────────────────────
// Значок временный: активен, пока vipUntil в будущем. Никакой
// отдельной чистки не требуется — как только время истекло,
// isVip() везде начинает возвращать false сам по себе.
function isVip(u) { return !!(u && u.vipUntil && u.vipUntil > Date.now()); }

// Выдавать/снимать VIP-значок могут сайт-админы (роль 'admin' в БД или
// legacy-ники bootstrap — см. isSiteAdmin).
function isVipGranter(username) { return isSiteAdmin(username); }


// ── Значки в профиле (сезоны и т.п.) ─────────────────────────
// В БД у игрока хранится только массив id значков (users.badges), а
// картинки/названия живут здесь. Чтобы добавить новый значок — положите
// картинку в public/img/seasons/ и допишите строку в каталог ниже.
// Удалённый из каталога значок просто перестанет показываться (id в БД
// останется и вернётся, если строку вернуть).
const USER_BADGES = {
  winner: { title: 'Победитель сезона', img: '/img/seasons/winner.png' },
  // winner_s3: { title: 'Победитель 3 сезона', img: '/img/seasons/winner_s3.png' },
};

function getUserBadges(u) {
  return ((u && u.badges) || [])
    .filter(id => USER_BADGES[id])
    .map(id => ({ id, title: USER_BADGES[id].title, img: USER_BADGES[id].img }));
}


async function getUser(usernameLow) {
  if (usersCache.has(usernameLow)) return usersCache.get(usernameLow);
  const r = await db('SELECT * FROM users WHERE username_low = $1', [usernameLow]);
  const u = rowToUser(r.rows[0]);
  if (u) cacheUser(u);
  return u;
}


async function saveUser(u) {
  await db(`
    INSERT INTO users (id, username, username_low, email, password_hash, rating,
      games_played, wins, losses, draws, avatar, role, banned, ban_reason,
      created_at, created_from_ip, created_device_id, emoji, bio, fshr_rating, fide_rating,
      vip_until, shadow_banned, shadow_ban_reason, badges)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
    ON CONFLICT (id) DO UPDATE SET
      password_hash=$5, rating=$6, games_played=$7, wins=$8, losses=$9, draws=$10,
      avatar=$11, role=$12, banned=$13, ban_reason=$14, emoji=$18,
      bio=$19, fshr_rating=$20, fide_rating=$21, vip_until=$22,
      shadow_banned=$23, shadow_ban_reason=$24, badges=$25
  `, [u.id, u.username, u.username.toLowerCase(), u.email || null,
      u.passwordHash, u.rating, u.gamesPlayed, u.wins, u.losses, u.draws,
      u.avatar || null, u.role || 'user', u.banned || false, u.banReason || null,
      u.createdAt, u.createdFromIP || null, u.createdDeviceId || null, u.emoji || '',
      u.bio || '', u.fshrRating ?? null, u.fideRating ?? null,
      u.vipUntil ?? null, u.shadowBanned || false, u.shadowBanReason || null,
      JSON.stringify(u.badges || [])]);

  // ── Бан должен действовать СРАЗУ ──
  // 1) кэш пользователей синхронизируем с тем, что только что записали в БД,
  //    иначе проверки getUser() продолжат видеть старый banned=false;
  // 2) у забаненного рвём все открытые сокеты (иначе он продолжает писать в чат).
  try {
    cacheUser(u);
    if (u.banned) {
      const sock = findSocketByUsername(u.username);
      if (sock) {
        sock.emit('banned', { reason: u.banReason || 'Нарушение правил' });
        sock.disconnect();
      }
    }
  } catch (e) { console.error('[saveUser ban-kick]', e.message); }
}


// ── Кэш глобального чата, турниры и их чаты — в services/ ─────
// chat.service.js: globalChat/loadChat/saveChatMsg/deleteChatMsg,
//                  клубные и турнирные чаты (кэши + БД)
// tournament.service.js: tournaments/loadTournaments/saveTournament
// game.service.js: activeGames, часы, финалы партий


// ── Клубы ─────────────────────────────────────────────────────
const clubs = [];

async function loadClubs() {
  const r = await db('SELECT * FROM clubs ORDER BY member_count DESC');
  for (const row of r.rows) {
    clubs.push({
      id: row.id, name: row.name, description: row.description,
      createdAt: row.created_at, createdBy: row.created_by,
      admins: row.admins, members: row.members,
      memberCount: row.member_count, official: row.official,
    });
  }
}

async function saveClub(c) {
  await db(`
    INSERT INTO clubs (id, name, description, created_at, created_by, admins, members, member_count, official)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET
      name=$2, description=$3, admins=$6, members=$7, member_count=$8
  `, [c.id, c.name, c.description || null, c.createdAt, c.createdBy,
      JSON.stringify(c.admins || []), JSON.stringify(c.members || []),
      c.memberCount || 0, c.official || false]);
}

async function deleteClubFromDB(id) {
  await db('DELETE FROM clubs WHERE id = $1', [id]);
}


// ── Чаты клубов: права и модерация ────────────────────────────

// Сайт-админ: источник истины — роль 'admin' в БД (users.role). Она:
//  1) подтверждается на старте для legacy-ников bootstrap (см. main()),
function isSiteAdmin(username) {
  if (!username) return false;
  const low = String(username).toLowerCase();
  const u = usersCache.get(low);
  if (u) return u.role === 'admin';
  return ['chesshome', 'marina64'].includes(low);
}

function isClubModerator(club, username) {
  if (!username) return false;
  if (isSiteAdmin(username)) return true;
  const lname = username.toLowerCase();
  // Создатель клуба всегда сохраняет права модератора, даже если технически
  // выпал из club.admins (например, вышел из клуба и зашёл снова).
  if ((club.createdBy || '').toLowerCase() === lname) return true;
  return (club.admins || []).map(a => a.toLowerCase()).includes(lname);
}

// Может ли пользователь управлять турниром: сайт-админ ИЛИ администратор клуба,
// к которому привязан этот турнир (создатель клуба всегда входит в club.admins).
function canManageTournament(user, t) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  // Межклубные турниры (t.isInterclub) не привязаны к одному клубу (t.clubId === null),
  // поэтому этот блок для них не срабатывает — управлять ими может ТОЛЬКО сайт-админ.
  if (t.clubId) {
    const club = clubs.find(c => c.id === t.clubId);
    if (club && isClubModerator(club, user.username)) return true;
  }
  return false;
}


// Аналог requireAdmin, но также пускает администраторов клуба для турниров их клуба.
async function requireTournamentManager(req, res, cb) {
  try {
    const me = await getUser(req.user.username.toLowerCase());
    if (!me) return res.status(403).json({ error: 'Нет прав' });
    const t = tournaments.find(t => t.id === req.params.id);
    if (!t) return res.status(404).json({ error: 'Не найден' });
    if (!canManageTournament(me, t)) return res.status(403).json({ error: 'Нет прав' });
    await cb(t, me);
  } catch (e) {
    console.error('[requireTournamentManager]', e);
    if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}

function canWriteInClubChat(club, username) {
  if (!username) return false;
  if (isSiteAdmin(username)) return true;
  return (club.members || []).map(m => m.toLowerCase()).includes(username.toLowerCase());
}


// ── Чат турниров: права модерации ────────────────────────────
// Модератор чата турнира: сайт-админ, админ клуба (если турнир клубный)
// ИЛИ создатель конкретно этого турнира. Само хранилище чатов —
// в services/chat.service.js.
function canModerateTournamentChat(user, t) {
  if (!user) return false;
  if (canManageTournament(user, t)) return true;
  return !!(t.createdBy && user.username.toLowerCase() === t.createdBy.toLowerCase());
}


// ── Форум ─────────────────────────────────────────────────────
const forumThreads = [];

const forumReplies = [];

async function loadForum() {
  const thr = await db('SELECT * FROM forum_threads ORDER BY last_activity_at DESC');
  for (const row of thr.rows) {
    forumThreads.push({
      id: row.id, slug: row.slug, author: row.author, authorId: row.author_id,
      title: row.title, body: row.body,
      createdAt: Number(row.created_at), lastActivityAt: Number(row.last_activity_at),
      replyCount: row.reply_count, views: row.views,
    });
  }
  const rep = await db('SELECT * FROM forum_replies ORDER BY created_at ASC');
  for (const row of rep.rows) {
    forumReplies.push({
      id: row.id, threadId: row.thread_id, author: row.author, authorId: row.author_id,
      body: row.body, createdAt: Number(row.created_at),
    });
  }
}

async function saveForumThread(t) {
  await db(`
    INSERT INTO forum_threads (id, slug, author, author_id, title, body, created_at, last_activity_at, reply_count, views)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET
      last_activity_at=$8, reply_count=$9, views=$10
  `, [t.id, t.slug, t.author, t.authorId || null, t.title, t.body,
      t.createdAt, t.lastActivityAt, t.replyCount, t.views]);
}

async function deleteForumThread(id) {
  await db('DELETE FROM forum_threads WHERE id = $1', [id]);
}

async function saveForumReply(r) {
  await db(`
    INSERT INTO forum_replies (id, thread_id, author, author_id, body, created_at)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING
  `, [r.id, r.threadId, r.author, r.authorId || null, r.body, r.createdAt]);
}

async function deleteForumReply(id) {
  await db('DELETE FROM forum_replies WHERE id = $1', [id]);
}


// ── Блог ──────────────────────────────────────────────────────
const blogPosts = [];

async function loadBlog() {
  const r = await db('SELECT * FROM blog_posts ORDER BY created_at DESC');
  for (const row of r.rows) {
    blogPosts.push({
      id: row.id, title: row.title, body: row.body, author: row.author,
      status: row.status, views: row.views, likes: row.likes,
      likedBy: row.liked_by || [],
      community: row.community || false,
      createdAt: Number(row.created_at), updatedAt: row.updated_at ? Number(row.updated_at) : null,
    });
  }
}

async function saveBlogPost(p) {
  // Просмотры/лайки сохраняются с задержкой (см. _viewTimer/_lstTimer ниже) —
  // если статью удалили, пока такой отложенный таймер ещё не сработал, он
  // всё равно вызовет saveBlogPost() через 5 секунд ПОСЛЕ удаления. Из-за
  // ON CONFLICT DO UPDATE это превращается в обычный INSERT (строки-то уже
  // нет), и удалённая статья "воскресает" в БД — а после рестарта сервера
  // снова появляется на сайте через loadBlog(). Флаг _deleted это глушит.
  if (p._deleted) return;
  await db(`
    INSERT INTO blog_posts (id, title, body, author, status, views, likes, liked_by, created_at, updated_at, community)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET
      title=$2, body=$3, status=$5, views=$6, likes=$7, liked_by=$8, updated_at=$10, community=$11
  `, [p.id, p.title, p.body, p.author, p.status,
      p.views || 0, p.likes || 0, JSON.stringify(p.likedBy || []),
      p.createdAt, p.updatedAt || null, p.community || false]);
}

async function deleteBlogPost(id) {
  await db('DELETE FROM blog_posts WHERE id = $1', [id]);
}


// ── Новости (News) ───────────────────────────────────────────
// В отличие от блога (открыт любому зарегистрированному юзеру, макс
// 1 статья/день), новости пишут только авторы, назначенные владельцем
// (username 'chesshome'). См. также newsAuthors ниже и API-контракт в
// комментарии наверху public/news.html.
const newsPosts = [];

async function loadNews() {
  const r = await db('SELECT * FROM news_posts ORDER BY created_at DESC');
  for (const row of r.rows) {
    newsPosts.push({
      id: row.id, title: row.title, body: row.body, author: row.author,
      status: row.status, views: row.views, likes: row.likes, dislikes: row.dislikes,
      cover: row.cover || '',
      createdAt: Number(row.created_at), updatedAt: row.updated_at ? Number(row.updated_at) : null,
    });
  }
}

async function saveNewsPost(p) {
  // См. аналогичный комментарий в saveBlogPost — тот же паттерн отложенного
  // сохранения просмотров/лайков и защиты от "воскрешения" удалённой статьи.
  if (p._deleted) return;
  await db(`
    INSERT INTO news_posts (id, title, body, author, status, views, likes, dislikes, cover, created_at, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET
      title=$2, body=$3, status=$5, views=$6, likes=$7, dislikes=$8, cover=$9, updated_at=$11
  `, [p.id, p.title, p.body, p.author, p.status,
      p.views || 0, p.likes || 0, p.dislikes || 0, p.cover || '',
      p.createdAt, p.updatedAt || null]);
}

async function deleteNewsPost(id) {
  await db('DELETE FROM news_posts WHERE id = $1', [id]);
}


// Список авторов новостей: username в исходном регистре, назначаются/снимаются
// владельцем (chesshome). Держим в памяти, синхронизируем с news_authors.
const newsAuthors = [];

async function loadNewsAuthors() {
  const r = await db('SELECT username FROM news_authors ORDER BY created_at ASC');
  newsAuthors.length = 0;
  newsAuthors.push(...r.rows.map(row => row.username));
}


const server = http.createServer(app);

const io     = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (!origin || origin === SITE_URL) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET','POST','DELETE','PATCH'],
    credentials: true,
  },
  // perMessageDeflate жмёт каждый пакет на CPU отправителя и получателя.
  // На 1 ядре с частыми событиями (тиканье часов раз в секунду и т.п.)
  // это ощутимая CPU-нагрузка ради экономии небольшого трафика — отключаем.
  perMessageDeflate: false,
  maxHttpBufferSize: 64 * 1024,
});


const PORT       = process.env.PORT || 10000;

const JWT_SECRET = process.env.JWT_SECRET;

// Базовый URL сайта: используется для whitelist CORS/Socket.IO origin.
const SITE_URL   = process.env.SITE_URL || 'https://chesshome.pro';

const RESERVED   = ['chesshome', 'admin', 'moderator', 'system', 'система'];


// ── Системные сообщения ─────────────────────────────────────────
// Отправитель для широковещательных/точечных сообщений от админа.
// Это не настоящий аккаунт (ник зарезервирован в RESERVED выше) —
// "системность" сообщения определяется только по полю from_user.
const SYSTEM_SENDER = 'Система';

function isSystemSender(name) { return !!name && name.toLowerCase() === SYSTEM_SENDER.toLowerCase(); }


const sessions          = new Map();

// username(lowercase) -> socket.id — быстрый O(1) поиск сокета по нику.
const usernameToSocketId = new Map();

const onlineUsers       = new Set();

const pendingChallenges = [];

// activeGames / tournamentGames — в services/game.service.js


// ── ПУЛ ДОМАШНИХ WORKER'ОВ (ваши ПК) ────────────────────────────
// Каждый воркер — обычное исходящее socket.io-подключение с вашего ПК
// (не нужно открывать порты/иметь белый IP), аутентифицируется секретом
// из .env. Поддерживается СРАЗУ НЕСКОЛЬКО воркеров одновременно —
// у каждого подключения свой socket.id, так что просто запускайте
// скрипт на нескольких машинах с одним и тем же WORKER_SECRET.
// Каждый воркер сообщает, сколько потоков он готов использовать
// (настраивается в .env самого воркера, см. worker-client/.env.example).
// Работоспособность сайта никогда не зависит от воркеров: если все
// выключены, анализ просто идёт локально в браузере посетителя, как
const workers = new Map();
      // socket.id -> { socket, threads, busy, lastSeen }
const analyzeJobs = new Map();
  // jobId -> { requesterSocketId, workerSocketId }

function pickIdleWorker() {
  for (const w of workers.values()) { if (!w.busy) return w; }
  return null;
}


// ── Безопасность заголовков ───────────────────────────────────
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://mc.yandex.ru; " +
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
    "font-src 'self' data: https://fonts.gstatic.com; " +
    "img-src 'self' data: blob: https:; " +
    "connect-src 'self' wss: ws: https://mc.yandex.ru; " +
    "worker-src 'self' blob:; " +
    "frame-ancestors 'self'; " +
    "base-uri 'self'; form-action 'self'");
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin === SITE_URL) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));

app.use(compression());

// Лимит поднят с 50kb: статьи блога разрешены до 100 000 символов
// (см. проверку body.length в POST /api/blog), а это уже само по себе
// 100-400кб в зависимости от алфавита. При старом лимите body-parser
// рубил запрос ДО того, как код успевал вернуть свою красивую ошибку
// "Текст слишком длинный", и в некоторых окружениях (за прокси без
// финального error-хендлера) это отдавало клиенту HTML вместо JSON —
// отсюда "JSON.parse: unexpected character at line 1 column 1".
app.use(express.json({ limit: '2mb' }));

app.use(express.urlencoded({ extended: false, limit: '2mb' }));

app.use((req, res, next) => {
    if (req.path.match(/\.(css|js|svg|png|ico|woff|woff2|map)$/)) return next();
    if (!limiterGeneral.check(getIP(req)).allowed)
      return res.status(429).json({ error: 'Слишком много запросов. Подождите немного.' });
  next();
});


app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/' || !req.path.includes('.')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});


// Подменяем res.sendFile для .html-ответов на версию с подстановкой ?v=,
// чтобы не переписывать вручную каждый из ~40 app.get(...).sendFile(...)
// ниже по файлу — они продолжают работать как есть.
app.use((req, res, next) => {
  const originalSendFile = res.sendFile.bind(res);
  res.sendFile = function (filePath, ...args) {
    if (typeof filePath === 'string' && filePath.endsWith('.html')) {
      return sendVersionedHtml(res, filePath);
    }
    return originalSendFile(filePath, ...args);
  };
  next();
});

app.use(require('./sitemap')({ db: pool }));


app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: '1h',
  etag: true,
  index: false,
}));


const LICHESS_TOKEN = process.env.LICHESS_API_TOKEN;


// Общий лог действий админов — вызывается из всех модерационных
// эндпоинтов ниже (бан, IP-бан, VIP, задачи, чат, жалобы, обращения,
// системные сообщения и т.п.). details — произвольный объект,
// сохраняется как JSON-строка.
async function logAdminAction(admin, action, target, details) {
  try {
    await db('INSERT INTO admin_action_log (id, admin, action, target, details, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [uuidv4(), admin, action, target || null, details ? JSON.stringify(details) : null, Date.now()]);
  } catch (e) { console.error('[AdminLog]', e.message); }
}


// ── Blog API ──────────────────────────────────────────────────
function isBlogAdmin(username) { return isSiteAdmin(username); }


// ══════════════════════════════════════════════════════════════
//  NEWS API
//  Контракт см. в комментарии наверху public/news.html.
//  В отличие от блога, публиковать новости может не любой юзер, а
//  только авторы, назначенные владельцем (username 'chesshome').
// ══════════════════════════════════════════════════════════════
const NEWS_OWNER_USERNAME = 'chesshome';

function isNewsOwner(username) { return !!username && username.toLowerCase() === NEWS_OWNER_USERNAME; }

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

const BANNED_ALLOWED_PATHS = [
  /^\/api\/me$/,
  /^\/api\/appeals(\/|$)/,
  /^\/api\/dev-diary\/[^/]+\/comments$/,
];
async function authMiddleware(req, res, next) {
  const auth = getAuthToken(req);
  if (!auth) return res.status(401).json({ error: 'Не авторизован' });
  let decoded;
  try { decoded = jwt.verify(auth, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Неверный токен' }); }
  req.user = decoded;
  try {
    const u = await getUser(String(decoded.username || '').toLowerCase());
    if (!u) return res.status(401).json({ error: 'Аккаунт не найден' });
    if (u.banned) {
      const p = String(req.originalUrl || req.url || '').split('?')[0];
      if (!BANNED_ALLOWED_PATHS.some(rx => rx.test(p))) {
        return res.status(403).json({ error: 'Аккаунт заблокирован' + (u.banReason ? ': ' + u.banReason : '') });
      }
    }
  } catch (e) {
    // БД недоступна: проверить бан/удаление аккаунта мы не можем. Чтение (GET/HEAD)
    // пропускаем, чтобы сайт не «падал» целиком, а ИЗМЕНЯЮЩИЕ запросы закрываем:
    // иначе забаненный пользователь с ещё живым JWT пишет в чат/ЛС/турниры
    console.error('[authMiddleware] БД недоступна:', e && e.message);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return res.status(503).json({ error: 'Сервис временно недоступен, попробуйте через минуту' });
    }
  }
  next();
}


async function requireAdmin(req, res, cb) {
  try {
    const me = await getUser(req.user.username.toLowerCase());
    if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Нет прав' });
    await cb();
  } catch (e) {
    console.error('[requireAdmin]', e);
    if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}


// VIP-проверка завязана на сайт-админов (см. isVipGranter выше):
// роль 'admin' в БД либо legacy-ники bootstrap. Роль выдаётся через
async function requireVipGranter(req, res, cb) {
  try {
    const me = await getUser(req.user.username.toLowerCase());
    if (!me || !isVipGranter(me.username)) return res.status(403).json({ error: 'Нет прав на выдачу VIP-значка' });
    await cb(me);
  } catch (e) {
    console.error('[requireVipGranter]', e);
    if (!res.headersSent) res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}


// viewerIsSelf: если true — перед нами сам владелец профиля, и статус
// теневого бана от него скрывается (banned=false), как будто ничего не
// произошло. Всем остальным (viewerIsSelf=false/не передан) теневой бан
// показывается точно так же, как обычный banned — с той же меткой "БАН"
// в интерфейсе — потому что для окружающих разницы нет.
function sanitizeUser(u, viewerIsSelf = false) {
  const shadowVisible = !!u.shadowBanned && !viewerIsSelf;
  return {
    id: u.id, username: u.username, rating: u.rating,
    gamesPlayed: u.gamesPlayed, wins: u.wins, losses: u.losses, draws: u.draws,
    createdAt: u.createdAt, avatar: u.avatar, role: u.role || 'user',
    banned: (u.banned || shadowVisible) || false,
    banReason: (u.banned ? u.banReason : (shadowVisible ? (u.shadowBanReason || 'Нарушение правил') : null)) || null,
    puzzle_rating: u.puzzle_rating ?? 1200, puzzle_solved: u.puzzle_solved ?? 0,
    puzzle_attempted: u.puzzle_attempted ?? 0, emoji: u.emoji || '',
    bio: u.bio || '', fshrRating: u.fshrRating ?? null, fideRating: u.fideRating ?? null,
    vip: isVip(u), vipUntil: isVip(u) ? u.vipUntil : null,
    badges: getUserBadges(u),
  };
}


function adminSanitizeUser(u) {
  return { ...sanitizeUser(u, false), email: u.email || null, createdFromIP: u.createdFromIP || null, createdDeviceId: u.createdDeviceId || null, vipUntil: u.vipUntil ?? null, shadowBanned: u.shadowBanned || false, shadowBanReason: u.shadowBanReason || null };
}


// getInterclubTeamsInfo / computeTeamStandings / sanitizeTournament /
// getTournamentStatus — в services/tournament.service.js


function verifyToken(t) { try { return jwt.verify(t, JWT_SECRET); } catch { return null; } }


function findSocketByUsername(username) {
  // Было: линейный перебор всей карты sessions на каждый вызов (O(n)).
  // Стало: прямой доступ по индексу usernameToSocketId (O(1)).
  //
  // Multi-socket: у юзера может быть несколько легитимных сокетов одновременно
  // (основной app.js + DM-сокет header.js). Возвращаем fanout-эмиттер: emit()
  // доставляет событие ВСЕМ сокетам юзера, disconnect() отключает все. Все
  // существующие вызовы вида s?.emit(...) / if (sock) sock.emit(...) работают
  // без изменений — но больше не зависят от того, какой из сокетов юзера
  const low = String(username).toLowerCase();
  const ids = usernameToSocketId.get(low);
  if (!ids || ids.size === 0) return null;
  const sockets = [];
  for (const id of ids) {
    const s = io.sockets.sockets.get(id);
    if (s) sockets.push(s);
  }
  if (!sockets.length) { usernameToSocketId.delete(low); return null; }
  return {
    emit(event, ...args) { for (const s of sockets) s.emit(event, ...args); },
    disconnect()         { for (const s of sockets) s.disconnect(true); },
    get size()           { return sockets.length; },
  };
}


// ── Приватные события только для админов ──────────────────────
async function emitToAdmins(event, payload) {
  // Multi-socket: у одного админа может быть несколько сокетов/сессий —
  // дедуплицируем по нику, чтобы каждый админ получил событие один раз.
  const seen = new Set();
  for (const [, sess] of sessions.entries()) {
    const low = sess.username.toLowerCase();
    if (seen.has(low)) continue;
    const u = usersCache.get(low);
    if (u?.role !== 'admin') continue;
    seen.add(low);
    const sock = findSocketByUsername(sess.username);
    if (sock) sock.emit(event, payload);
  }
}


const limiterSocketConnect = new RateLimiter(60_000, 200);


// ── Мониторинг: задержка event loop и очередь на соединение с БД ──────────
// Пишет в лог ТОЛЬКО при проблеме: p99 задержки цикла > 50 мс или запросы ждут
// свободного соединения из пула.
const { monitorEventLoopDelay } = require('perf_hooks');
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
setInterval(() => {
  const p99 = loopDelay.percentile(99) / 1e6;
  const max = loopDelay.max / 1e6;
  if (p99 > 50 || pool.waitingCount > 0) {
    console.warn(`[perf] event loop p99=${p99.toFixed(0)}ms max=${max.toFixed(0)}ms | pool total=${pool.totalCount} idle=${pool.idleCount} waiting=${pool.waitingCount}`);
  }
  loopDelay.reset();
}, 30000).unref();


async function main() {
  if (!JWT_SECRET || typeof JWT_SECRET !== 'string' || JWT_SECRET.length < 32 || /change_me|changeme|secret$/i.test(JWT_SECRET)) {
    console.error('❌ FATAL: JWT_SECRET не задан/слишком короткий/дефолтный. Сгенерируйте сильный секрет и укажите его в .env:');
    console.error("   node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"");
    process.exit(1);
  }

  console.log('🐘 Подключение к PostgreSQL...');
  await pool.query('SELECT 1');
  console.log('✅ PostgreSQL подключён');

  // Индексы под частые запросы (профиль/история партий, статистика, проверка регистраций).
  // IF NOT EXISTS — безопасно при повторных запусках. Если подобный индекс уже есть
  // под другим именем, получится лишний, но безвредный дубликат.
  for (const sql of [
    'CREATE INDEX IF NOT EXISTS idx_games_white_ended ON games (white, ended_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_games_black_ended ON games (black, ended_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_games_ended_at ON games (ended_at)',
    'CREATE INDEX IF NOT EXISTS idx_users_created_ip ON users (created_from_ip)',
    'CREATE INDEX IF NOT EXISTS idx_users_created_device ON users (created_device_id)',
  ]) {
    await pool.query(sql).catch(e => console.warn('[index]', e.message));
  }

  await loadBansFromDB();
  await loadChat();
  await loadTournaments();
  await loadTournamentChats();
  await loadClubs();
  await loadClubChats();
  await loadForum();
  await loadBlog();
  await loadNewsAuthors();
  await loadNews();

  if (!clubs.find(c => c.id === 'chesshome-official')) {
    const offClub = { id: 'chesshome-official', name: 'ChessHome', description: 'Официальный клуб шахматной платформы Chess Home.', createdAt: Date.now(), createdBy: 'ChessHome', admins: ['ChessHome'], members: ['ChessHome'], memberCount: 1, official: true };
    clubs.push(offClub); await saveClub(offClub);
  }
  for (const adminName of ['chesshome', 'marina64']) {
    const u = await getUser(adminName);
    if (u && u.role !== 'admin') { u.role = 'admin'; await saveUser(u); console.log(`[Admin] Подтверждён администратор: ${u.username}`); }
  }
  server.listen(PORT, () => {
    console.log(`♟️  Chess Home: http://localhost:${PORT}`);

    process.on('SIGINT',  () => { pool.end(); console.log('\nЗавершение работы...'); process.exit(0); });
    process.on('SIGTERM', () => { pool.end(); process.exit(0); });
  });
}

// ── Экспорт всего, что нужно routes.js и sockets.js ────────────
Object.assign(module.exports, {
  express,
  http,
  Server,
  compression,
  bcrypt,
  jwt,
  uuidv4,
  path,
  fs,
  cors,
  pool,
  db,
  withTransaction,
  BAD_NICK_WORDS,
  normNick,
  nickHasBadWord,
  PROFILE_EMOJIS,
  normForSimilarity,
  app,
  parseCookieHeader,
  isProd,
  AUTH_COOKIE_OPTS,
  DEVICE_COOKIE_OPTS,
  getAuthToken,
  RateLimiter,
  limiterGeneral,
  limiterAuth,
  limiterStrict,
  socketLimiter,
  limiterRegStrict,
  STORM_DURATION_MS,
  STORM_MAX_TIME_MS,
  STORM_MIN_MS_PER_PUZZLE,
  stormRuns,
  bannedIPs,
  bannedDevices,
  loadBansFromDB,
  saveBanToDB,
  removeBanFromDB,
  usersCache,
  cacheUser,
  rowToUser,
  isVip,
  isVipGranter,
  USER_BADGES,
  getUserBadges,
  getUser,
  saveUser,
  globalChat,
  loadChat,
  saveChatMsg,
  deleteChatMsg,
  tournaments,
  loadTournaments,
  saveTournament,
  deleteTournamentFromDB,
  clubs,
  loadClubs,
  saveClub,
  deleteClubFromDB,
  CLUB_CHAT_MAX,
  clubChats,
  clubChatBans,
  getClubChat,
  getClubChatBans,
  loadClubChats,
  saveClubChatMsg,
  deleteClubChatMsgsByUser,
  isSiteAdmin,
  isClubModerator,
  canManageTournament,
  MAX_INTERCLUB_TEAMS,
  extractClubIdFromLink,
  resolveInterclubTeams,
  requireTournamentManager,
  canWriteInClubChat,
  TOURNAMENT_CHAT_MAX,
  TOURNAMENT_CHAT_READONLY_AFTER_MS,
  tournamentChats,
  tournamentChatMutes,
  getTournamentChat,
  getTournamentChatMutes,
  isTournamentChatOpen,
  canModerateTournamentChat,
  loadTournamentChats,
  saveTournamentChatMsg,
  wipeTournamentChatMsgsByUser,
  forumThreads,
  forumReplies,
  loadForum,
  saveForumThread,
  deleteForumThread,
  saveForumReply,
  deleteForumReply,
  blogPosts,
  loadBlog,
  saveBlogPost,
  deleteBlogPost,
  newsPosts,
  loadNews,
  saveNewsPost,
  deleteNewsPost,
  newsAuthors,
  loadNewsAuthors,
  server,
  io,
  PORT,
  JWT_SECRET,
  RESERVED,
  SYSTEM_SENDER,
  isSystemSender,
  sessions,
  usernameToSocketId,
  onlineUsers,
  pendingChallenges,
  activeGames,
  tournamentGames,
  workers,
  analyzeJobs,
  pickIdleWorker,
  ipBanMiddleware,
  getIP,
  isLocalIP,
  isTrustedProxyPeer,
  cleanIpHeader,
  vpnCheckCache,
  VPN_CACHE_TTL,
  isVpnOrProxy,
  rateLimit,
  BUILD_VERSION,
  JS_SRC_RE,
  sendVersionedHtml,
  LICHESS_TOKEN,
  SITE_URL,
  loginFailStreaks,
  getLoginFailStreak,
  getUsernameFailTotal,
  getUsernameLockUntil,
  bumpLoginFailStreak,
  clearLoginFailStreak,
  limiterQuests,
  removeUserChatMessages,
  logAdminAction,
  isBlogAdmin,
  NEWS_OWNER_USERNAME,
  isNewsOwner,
  safeSecretEqual,
  authMiddleware,
  requireAdmin,
  requireVipGranter,
  sanitizeUser,
  adminSanitizeUser,
  getInterclubTeamsInfo,
  computeTeamStandings,
  sanitizeTournament,
  getTournamentStatus,
  verifyToken,
  liveClock,
  hasFullMove,
  endGameAuthoritative,
  findSocketByUsername,
  emitToAdmins,
  recordGame,
  updateStats,
  REMATCH_GRACE_PERIOD,
  tryPairTournamentPlayers,
  FIRST_MOVE_TIMEOUT,
  startTournamentGame,
  finishTournamentGame,
  anticheatBan,
  startGame,
  serverChess,
  limiterSocketConnect,
  main,
});
