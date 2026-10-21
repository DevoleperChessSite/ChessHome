// ═══════════════════════════════════════════════════════════════
//  security/secrets.js — constant-time сравнение строковых секретов
// ═══════════════════════════════════════════════════════════════
const crypto = require('crypto');

// Проверка секретного ключа скрипта (НЕ обычная сессия пользователя).
// Constant-time сравнение строк-секретов: обычное 'a !== b'short-circuit'ит
// на первом несовпадающем байте, что теоретически позволяет вычислять секрет
// побайтово по времени ответа. Хэшируем обе стороны SHA-256 — длины выравниваются,
// сравнение через timingSafeEqual становится безопасным.
function safeSecretEqual(a, b) {
  try {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  } catch (e) { return false; }
}

module.exports = { safeSecretEqual };
