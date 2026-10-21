// ═══════════════════════════════════════════════════════════════
//  validation/nicknames.js — фильтр ников и защита от похожих ников
// ═══════════════════════════════════════════════════════════════
//  Чистые функции без состояния и зависимостей (раньше жили в core.js).

// ── Фильтр матерных ников ─────────────────────────────────────
const BAD_NICK_WORDS = [
  'хуй','хуе','хер','пизд','бляд','блять','ебал','ебан','еблан',
  'fuck','bitch','dick','shit','ass','cunt','nigger','nigga',
  'сука','мразь','шлюх','гандон','мудак','урод','дебил',
];

function normNick(s) {
  return s.toLowerCase()
    .replace(/[0]/g,'o').replace(/[1!]/g,'i').replace(/[3]/g,'e')
    .replace(/[4]/g,'a').replace(/[@]/g,'a').replace(/[5]/g,'s')
    .replace(/[_\-\.]/g,'');
}

function nickHasBadWord(username) {
  const n = normNick(username);
  return BAD_NICK_WORDS.some(w => n.includes(normNick(w)));
}


// ── Защита от похожих ников ───────────────────────────────────
function normForSimilarity(name) {
  return name.toLowerCase()
    .replace(/[іі]/g,'i').replace(/[аА]/g,'a').replace(/[еЕ]/g,'e')
    .replace(/[оО]/g,'o').replace(/[рР]/g,'p').replace(/[сС]/g,'c')
    .replace(/[хХ]/g,'x').replace(/[вВ]/g,'b').replace(/[_\-\.]/g,'')
    .replace(/0/g,'o').replace(/1/g,'i').replace(/3/g,'e');
}


module.exports = { BAD_NICK_WORDS, normNick, nickHasBadWord, normForSimilarity };
