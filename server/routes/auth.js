// ═══════════════════════════════════════════════════════════════
//  routes/auth.js — регистрация, вход, аккаунт
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  bcrypt,
  jwt,
  uuidv4,
  db,
  withTransaction,
  nickHasBadWord,
  normForSimilarity,
  app,
  AUTH_COOKIE_OPTS,
  limiterAuth,
  limiterRegStrict,
  bannedDevices,
  usersCache,
  rowToUser,
  getUser,
  saveUser,
  JWT_SECRET,
  RESERVED,
  onlineUsers,
  ipBanMiddleware,
  getIP,
  isLocalIP,
  isVpnOrProxy,
  rateLimit,
  loginFailStreaks,
  getLoginFailStreak,
  getUsernameLockUntil,
  bumpLoginFailStreak,
  clearLoginFailStreak,
  removeUserChatMessages,
  authMiddleware,
  sanitizeUser,
  findSocketByUsername,
} = require('../core');

const twins = require('../twins');   // оценка «один человек» по сигналам устройства/сети

module.exports = function register(app) {
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  AUTH & USER API
// ══════════════════════════════════════════════════════════════

app.post('/api/register', 
  rateLimit(limiterRegStrict, 'Слишком много регистраций с вашего IP. Попробуйте позже.'), // 1. Проверяем лимиты по IP
  ipBanMiddleware,                                                                       // 2. Проверяем черный список IP
  async (req, res) => {                                                                  
    const ip = getIP(req);
    const { username, password, _hp } = req.body;
    const deviceId = req.deviceId; // из HttpOnly-cookie, а не от клиента — нельзя подделать/сменить через JS

    if (_hp && String(_hp).trim() !== '') {
      return res.json({ ok: true, message: 'Аккаунт создан.' });
    }
    if (deviceId && bannedDevices.has(deviceId))
      return res.status(403).json({ error: 'Ваше устройство заблокировано.' });

    if (!isLocalIP(ip)) {
      const vpn = await isVpnOrProxy(ip);
      if (vpn) {
        return res.status(403).json({ error: 'Регистрация через VPN, прокси или Tor запрещена. Отключите VPN и попробуйте снова.' });
      }
    }

    if (!username || !password)           return res.status(400).json({ error: 'Заполните все поля' });
    if (username.length < 3)              return res.status(400).json({ error: 'Ник минимум 3 символа' });
    if (username.length > 20)             return res.status(400).json({ error: 'Ник максимум 20 символов' });
    if (password.length < 6)             return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) return res.status(400).json({ error: 'Только буквы, цифры, _ и -' });
    if (RESERVED.includes(username.toLowerCase())) return res.status(400).json({ error: 'Ник зарезервирован' });
    if (nickHasBadWord(username)) return res.status(400).json({ error: 'Ник содержит запрещённые слова' });

    try {
      const existCheck = await db('SELECT id FROM users WHERE username_low = $1', [username.toLowerCase()]);
      if (existCheck.rows.length > 0) return res.status(400).json({ error: 'Пользователь уже существует' });

      const deletedCheck = await db('SELECT username_low FROM deleted_usernames WHERE username_low = $1', [username.toLowerCase()]);
      if (deletedCheck.rows.length > 0) return res.status(400).json({ error: 'Этот ник недоступен для регистрации' });

      const normNew = normForSimilarity(username);
      const clash = await db(
        `SELECT username FROM users
          WHERE translate(regexp_replace(username_low, '[-_.]', '', 'g'), 'іаеорсхв013', 'iaepcxboie') = $1
          LIMIT 1`,
        [normNew]
      );
      if (clash.rows.length > 0) return res.status(400).json({ error: 'Ник слишком похож на уже существующий' });

      if (!isLocalIP(ip)) {
        const ipCount = await db('SELECT COUNT(*) FROM users WHERE created_from_ip = $1', [ip]);
        if (Number(ipCount.rows[0].count) >= 2)
          return res.status(429).json({ error: 'С вашего IP уже зарегистрированы аккаунты. Если вы считаете, что произошла ошибка — обратитесь в поддержку.' });
      }

      if (deviceId && !bannedDevices.has(deviceId)) {
        const devCount = await db('SELECT COUNT(*) FROM users WHERE created_device_id = $1', [deviceId]);
        if (Number(devCount.rows[0].count) >= 4)
          return res.status(429).json({ error: 'С этого устройства уже зарегистрирован аккаунт. Создание нескольких аккаунтов с одного устройства запрещено.' });
      }

      const hash = await bcrypt.hash(password, 10);
      const userData = {
        id: uuidv4(), username, email: null, passwordHash: hash,
        createdAt: Date.now(), createdFromIP: ip, createdDeviceId: deviceId || null,
        rating: 1200, gamesPlayed: 0, wins: 0, losses: 0, draws: 0,
        avatar: null, role: 'user', banned: false,
      };

      // Аккаунт создаётся сразу, без email-подтверждения. Защиту от
      // мультиаккаунтинга обеспечивают проверки выше: бан IP/устройства,
      // VPN/прокси-фильтр, лимит аккаунтов на IP и на устройство,
      // а также проверка на похожие ники.
      await saveUser(userData);
      twins.recordLogin(userData.username, ip, deviceId);   // не блокирует, ошибки глотает

      const token = jwt.sign({ userId: userData.id, username: userData.username }, JWT_SECRET, { expiresIn: '7d' });
      // Токен больше не возвращается в теле ответа — только в HttpOnly cookie,
      // недоступной для чтения из JS (защита от кражи токена через XSS).
      res.cookie('ch_token', token, AUTH_COOKIE_OPTS);
      res.json({ user: sanitizeUser(userData, true) });
    } catch (err) {
      console.error('[Register]', err.message);
      return res.status(500).json({ error: 'Не удалось создать аккаунт: ' + err.message });
    }
  }
);


app.post('/api/login',
  rateLimit(limiterAuth, 'Слишком много попыток входа с вашего IP. Подождите минуту.'),
  ipBanMiddleware,
  async (req, res) => {
  try {
    const { username, password } = req.body;
    const usernameLow = (username || '').toLowerCase().trim();
    if (!usernameLow || typeof password !== 'string') return res.status(400).json({ error: 'Укажите имя и пароль' });

    const loginIP = getIP(req);
    const streak = getLoginFailStreak(usernameLow, loginIP);
    if (streak >= 5) {
      const waitMin = Math.ceil((loginFailStreaks.get(usernameLow + '|' + loginIP).resetAt - Date.now()) / 60000);
      return res.status(429).json({ error: `Слишком много неудачных попыток. Попробуйте через ${Math.max(waitMin, 1)} мин.` });
    }
    // Анти-распределённый брутфорс: суммарно 30 неудач с разных IP за 15 минут
    // лочат ник целиком (bcrypt делает такой перебор бессмысленным).
    const lockUntil = getUsernameLockUntil(usernameLow);
    if (lockUntil > Date.now()) {
      const waitMin = Math.ceil((lockUntil - Date.now()) / 60000);
      return res.status(429).json({ error: `Аккаунт временно защищён: слишком много неудачных попыток входа. Попробуйте через ${Math.max(waitMin, 1)} мин.` });
    }

    const user = await getUser(usernameLow);
    if (!user) { bumpLoginFailStreak(usernameLow, loginIP); return res.status(401).json({ error: 'Неверное имя или пароль' }); }
    if (user.banned) return res.status(403).json({ error: `Заблокирован: ${user.banReason || ''}` });
    if (!await bcrypt.compare(password, user.passwordHash)) {
      bumpLoginFailStreak(usernameLow, loginIP);
      return res.status(401).json({ error: 'Неверное имя или пароль' });
    }
    clearLoginFailStreak(usernameLow, loginIP);
    twins.recordLogin(user.username, loginIP, req.deviceId);

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('ch_token', token, AUTH_COOKIE_OPTS);
    res.json({ user: sanitizeUser(user, true) });
  } catch (err) {
    console.error('[Login]', err.message);
    res.status(500).json({ error: 'Внутренняя ошибка сервера при входе. Попробуйте ещё раз.' });
  }
});


app.post('/api/logout', (req, res) => {
  res.clearCookie('ch_token', { ...AUTH_COOKIE_OPTS, maxAge: undefined });
  res.json({ ok: true });
});


app.get('/api/users/search', async (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (q.length < 1) return res.json([]);
  const r = await db('SELECT * FROM users WHERE username_low LIKE $1 LIMIT 10', [q + '%']);
  res.json(r.rows.map(row => ({ ...sanitizeUser(rowToUser(row)), online: onlineUsers.has(rowToUser(row).username) })));
});


app.get('/api/me', authMiddleware, async (req, res) => {
  const me = await getUser(req.user.username.toLowerCase());
  if (!me) return res.status(401).json({ error: 'Не найден' });
  res.json(sanitizeUser(me, true));
});


// ── Смена пароля ─────────────────────────────────────────────
// Нужен текущий пароль. Неверные попытки считаются тем же счётчиком, что и
// при входе (после 5 неудач подряд — временная блокировка).
app.post('/api/account/password', authMiddleware, rateLimit(limiterAuth, 'Слишком много попыток. Подождите минуту.'), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || !currentPassword || !newPassword)
      return res.status(400).json({ error: 'Заполните все поля' });
    if (newPassword.length < 6)
      return res.status(400).json({ error: 'Пароль минимум 6 символов' });
    if (Buffer.byteLength(newPassword, 'utf8') > 72)
      return res.status(400).json({ error: 'Пароль слишком длинный (максимум 72 байта)' });
    if (newPassword === currentPassword)
      return res.status(400).json({ error: 'Новый пароль совпадает с текущим' });

    const user = await getUser(req.user.username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const key = user.username.toLowerCase();
    const ip  = getIP(req);
    if (getLoginFailStreak(key, ip) >= 5)
      return res.status(429).json({ error: 'Слишком много неудачных попыток. Попробуйте через несколько минут.' });
    if (!await bcrypt.compare(currentPassword, user.passwordHash)) {
      bumpLoginFailStreak(key, ip);
      return res.status(401).json({ error: 'Неверный текущий пароль' });
    }
    clearLoginFailStreak(key, ip);

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await saveUser(user);

    // Обновляем cookie текущей сессии (новый срок 7 дней)
    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
    res.cookie('ch_token', token, AUTH_COOKIE_OPTS);
    console.log(`[Account] ${user.username} сменил пароль`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ChangePassword]', err.message);
    res.status(500).json({ error: 'Не удалось сменить пароль. Попробуйте ещё раз.' });
  }
});


// ── Удаление аккаунта ────────────────────────────────────────
app.post('/api/account/delete', authMiddleware, rateLimit(limiterAuth, 'Слишком много попыток.'), async (req, res) => {
  const { password } = req.body;
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Укажите пароль для подтверждения' });
  }

  const user = await getUser(req.user.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.role === 'admin') return res.status(403).json({ error: 'Нельзя удалить аккаунт администратора' });
  if (!await bcrypt.compare(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Неверный пароль' });
  }

  try {
    await db(`
      CREATE TABLE IF NOT EXISTS deleted_usernames (
        username_low TEXT PRIMARY KEY,
        deleted_at   BIGINT NOT NULL
      )
    `);
    await db('INSERT INTO deleted_usernames (username_low, deleted_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.username.toLowerCase(), Date.now()]);
    await twins.forgetUser(user.username);   // удаляем признаки устройства удалённого аккаунта (privacy.html, 2.4)

    await withTransaction(async (client) => {
      const tableExists = async (name) => {
        const r = await client.query('SELECT to_regclass($1) AS t', [`public.${name}`]);
        return !!r.rows[0]?.t;
      };
      await client.query('DELETE FROM users WHERE id = $1', [user.id]);
      if (await tableExists('dm_messages')) {
        await client.query('DELETE FROM dm_messages WHERE from_user = $1 OR to_user = $1', [user.username]);
      }
      if (await tableExists('dm_blocks')) {
        await client.query('DELETE FROM dm_blocks WHERE blocker = $1 OR blocked = $1', [user.username]);
      }
      if (await tableExists('follows')) {
        await client.query('DELETE FROM follows WHERE follower = $1 OR following = $1', [user.username]);
      }
      if (await tableExists('puzzle_attempts')) {
        // Колонки username в puzzle_attempts нет (только user_id) — старый
        // код с "WHERE username" абортит транзакцию после первого же запуска.
        await client.query('DELETE FROM puzzle_attempts WHERE user_id = $1', [user.id]);
      }
      if (await tableExists('reports')) {
        await client.query('DELETE FROM reports WHERE reporter = $1', [user.username]);
      }
      if (await tableExists('appeals')) {
        await client.query('DELETE FROM appeals WHERE username = $1', [user.username]);
      }
      if (await tableExists('club_members')) {
        await client.query('DELETE FROM club_members WHERE username = $1', [user.username]);
      }
    });

    // Чат-история — вне транзакции (функции core, у них свои запросы)
    await removeUserChatMessages(user.username).catch(() => {});
    usersCache.delete(user.username.toLowerCase());

    const sock = findSocketByUsername(user.username);
    if (sock) { sock.emit('account_deleted'); sock.disconnect(); }

    console.log(`[DeleteAccount] Аккаунт удалён: ${user.username}`);
    res.json({ ok: true, message: 'Аккаунт удалён' });
  } catch (err) {
    console.error('[DeleteAccount]', err.message);
    res.status(500).json({ error: 'Ошибка при удалении: ' + err.message });
  }
});


};
