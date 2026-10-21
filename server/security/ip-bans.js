// ═══════════════════════════════════════════════════════════════
//  security/ip-bans.js — IP/Device баны (хранилище + middleware)
// ═══════════════════════════════════════════════════════════════
//  Списки банов в памяти + загрузка/сохранение в БД + middleware
//  для защиты регистрации (раньше жили в core.js).

const { db } = require('../db');
const { getIP, isLocalIP } = require('../http/client-ip');

// ── IP-БАН ────────────────────────────────────────────────────
const bannedIPs     = new Set();

const bannedDevices = new Set();


async function loadBansFromDB() {
  try {
    const ips  = await db('SELECT ip FROM ip_bans');
    const devs = await db('SELECT device_id FROM device_bans');
    for (const r of ips.rows)  if (!isLocalIP(r.ip)) bannedIPs.add(r.ip);
    for (const r of devs.rows) bannedDevices.add(r.device_id);
    console.log(`[Bans] Загружено: ${bannedIPs.size} IP, ${bannedDevices.size} устройств`);
  } catch (e) {
    console.error('[Bans] load error:', e.message);
    if (/relation .* does not exist/i.test(e.message || '')) {
      console.error('[Bans] КРИТИЧНО: таблицы ip_bans/device_bans не существуют. ' +
        'Примените базовую схему: node migrations/migrate.js (см. migrations/001_base_schema.sql). ' +
        'Сервер продолжит работу с ПУСТЫМ списком банов!');
    }
  }
}


async function saveBanToDB(ip, deviceId) {
  try {
    if (ip && !isLocalIP(ip))  await db('INSERT INTO ip_bans (ip) VALUES ($1) ON CONFLICT DO NOTHING', [ip]);
    if (deviceId)              await db('INSERT INTO device_bans (device_id) VALUES ($1) ON CONFLICT DO NOTHING', [deviceId]);
  } catch (e) {}
}

async function removeBanFromDB(ip, deviceId) {
  try {
    if (ip)       await db('DELETE FROM ip_bans WHERE ip = $1', [ip]);
    if (deviceId) await db('DELETE FROM device_bans WHERE device_id = $1', [deviceId]);
  } catch (e) {}
}


// ── IP-БАН middleware ─────────────────────────────────────────
function ipBanMiddleware(req, res, next) {
  const ip = getIP(req);
  const deviceId = req.deviceId; // сервер сам выдаёт и хранит device id в HttpOnly-cookie
  const p = req.path;

  if (p.includes('/register') || p.includes('/verify-email')) {
    if (bannedIPs.has(ip))
      return res.status(403).json({ error: 'Регистрация с вашего IP временно ограничена.' });
    if (deviceId && bannedDevices.has(deviceId))
      return res.status(403).json({ error: 'Это устройство заблокировано. Создание новых аккаунтов запрещено.' });
  }

  next();
}

// ipBanMiddleware подключается ТОЛЬКО в цепочках маршрутов /api/register


module.exports = {
  bannedIPs, bannedDevices,
  loadBansFromDB, saveBanToDB, removeBanFromDB,
  ipBanMiddleware,
};
