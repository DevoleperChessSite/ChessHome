// ═══════════════════════════════════════════════════════════════
//  security/login-throttle.js — анти-брутфорс логина
// ═══════════════════════════════════════════════════════════════
const LICHESS_TOKEN = process.env.LICHESS_API_TOKEN;


const loginFailStreaks = new Map();
 // 'username_low|ip' -> { count, resetAt }
const USERNAME_FAIL_WINDOW_MS = 15 * 60 * 1000;
const USERNAME_FAIL_TOTAL_MAX = 30;
const usernameFailTotals = new Map();
 // username_low -> { count, resetAt }
function pruneFailWindow(map, now) {
  for (const [k, v] of map.entries()) if (now > v.resetAt) map.delete(k);
}
setInterval(() => {
  const now = Date.now();
  pruneFailWindow(loginFailStreaks, now);
  pruneFailWindow(usernameFailTotals, now);
}, 10 * 60 * 1000).unref();

// Сколько неудач уже у этой пары (ник, IP)
function getLoginFailStreak(usernameLow, ip) {
  const now = Date.now();
  const entry = loginFailStreaks.get(usernameLow + '|' + (ip || 'unknown'));
  if (!entry || now > entry.resetAt) return 0;
  return entry.count;
}

// Сколько суммарно неудач у ника со всех IP (для анти-распределённого брутфорса)
function getUsernameFailTotal(usernameLow) {
  const now = Date.now();
  const entry = usernameFailTotals.get(usernameLow);
  if (!entry || now > entry.resetAt) return 0;
  return entry.count;
}

// До какого значения (мс) лочен ник целиком, либо 0
function getUsernameLockUntil(usernameLow) {
  const now = Date.now();
  const entry = usernameFailTotals.get(usernameLow);
  if (!entry || now > entry.resetAt) return 0;
  return entry.count >= USERNAME_FAIL_TOTAL_MAX ? entry.resetAt : 0;
}

function bumpLoginFailStreak(usernameLow, ip) {
  const now = Date.now();
  const key = usernameLow + '|' + (ip || 'unknown');
  const entry = loginFailStreaks.get(key);
  if (!entry || now > entry.resetAt) {
    loginFailStreaks.set(key, { count: 1, resetAt: now + USERNAME_FAIL_WINDOW_MS });
  } else {
    entry.count++;
  }
  const total = usernameFailTotals.get(usernameLow);
  if (!total || now > total.resetAt) {
    usernameFailTotals.set(usernameLow, { count: 1, resetAt: now + USERNAME_FAIL_WINDOW_MS });
  } else {
    total.count++;
  }
}

function clearLoginFailStreak(usernameLow, ip) {
  loginFailStreaks.delete(usernameLow + '|' + (ip || 'unknown'));
  // Общий счётчик ника при УСПЕШНОМ входе сбрасываем только если он не лочен —
  // иначе 29 неудач + 1 успех обнуляли бы прогресс анти-брутфорса.
  const total = usernameFailTotals.get(usernameLow);
  if (total && total.count < USERNAME_FAIL_TOTAL_MAX) usernameFailTotals.delete(usernameLow);
}

module.exports = {
  loginFailStreaks, usernameFailTotals,
  USERNAME_FAIL_WINDOW_MS, USERNAME_FAIL_TOTAL_MAX,
  getLoginFailStreak, getUsernameFailTotal, getUsernameLockUntil,
  bumpLoginFailStreak, clearLoginFailStreak,
};
