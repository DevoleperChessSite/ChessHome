// ═══════════════════════════════════════════════════════════════
//  security/rate-limiter.js — DDoS / rate limiting
// ═══════════════════════════════════════════════════════════════
//  Класс RateLimiter, готовые инстансы лимитеров и express-middleware
//  rateLimit() (раньше жили в core.js).

const { getIP } = require('../http/client-ip');

// ── DDoS / Rate limiting ──────────────────────────────────────
class RateLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs; this.max = max; this.store = new Map();
    this.maxEntries = 200_000;
    setInterval(() => {
      const now = Date.now();
      for (const [ip, data] of this.store.entries()) {
        if (now > data.resetAt) this.store.delete(ip);
      }
    }, 60000).unref();
  }
  check(ip) {
    const now = Date.now();
    let data = this.store.get(ip);
    if (!data || now > data.resetAt) {
      // Вытеснение при переполнении — ДО вставки новой записи.
      if (!data && this.store.size >= this.maxEntries) {
        const oldest = this.store.keys().next().value;
        if (oldest !== undefined) this.store.delete(oldest);
      }
      data = { count: 0, resetAt: now + this.windowMs };
      this.store.set(ip, data);
    }
    data.count++;
    return { allowed: data.count <= this.max, count: data.count, max: this.max };
  }
}


const limiterGeneral   = new RateLimiter(60_000,  10000);

const limiterAuth      = new RateLimiter(60_000,    20);

const limiterStrict    = new RateLimiter(60_000,    900);

const socketLimiter    = new RateLimiter(10_000,   1000);

const limiterRegStrict = new RateLimiter(3_600_000, 1000);

// per-user (не per-IP) лимит: не больше 5 попыток в минуту на аккаунт —
// внутри транзакции всё равно защищено FOR UPDATE + total_crystals_updated_at,
// но это не даёт одному аккаунту засыпать пул запросами.
const limiterQuests    = new RateLimiter(60_000, 5);


function rateLimit(limiter, message = 'Слишком много запросов. Подождите немного.') {
  return (req, res, next) => {
    const ip = getIP(req);
    const result = limiter.check(ip);
    res.set('X-RateLimit-Limit', result.max);
    res.set('X-RateLimit-Remaining', Math.max(0, result.max - result.count));
    if (!result.allowed) {
      console.warn(`[RateLimit] ${ip} blocked (${result.count}/${result.max})`);
      return res.status(429).json({ error: message });
    }
    next();
  };
}


module.exports = {
  RateLimiter,
  limiterGeneral, limiterAuth, limiterStrict, socketLimiter, limiterRegStrict, limiterQuests,
  rateLimit,
};
