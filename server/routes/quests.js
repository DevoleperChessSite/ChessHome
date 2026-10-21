// ═══════════════════════════════════════════════════════════════
//  routes/quests.js — сезонные квесты
// ═══════════════════════════════════════════════════════════════
//  Вынесено из монолитного routes.js в рамках рефакторинга.
//  Код маршрутов не изменён — только обёртка-регистратор.

const {
  db,
  withTransaction,
  app,
  limiterQuests,
  authMiddleware,
} = require('../core');

module.exports = function register(app) {
app.get('/api/quests/list', authMiddleware, async (req, res) => {
    try {
        const userId = req.user.userId;
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(20, parseInt(req.query.limit) || 20);
        const offset = (page - 1) * limit;
        const currentDay = getCurrentSeasonDay();

        const questsQuery = await db(`
            SELECT q.id, q.day, q.title, q.reward_crystals, q.is_mega, q.type,
                   CASE WHEN uq.quest_id IS NOT NULL THEN true ELSE false END as completed,
                   CASE WHEN q.day <= $1 THEN true ELSE false END as unlocked_by_date
            FROM quests q
            LEFT JOIN user_quests uq ON q.id = uq.quest_id AND uq.user_id = $2
            ORDER BY q.day
            LIMIT $3 OFFSET $4
        `, [currentDay, userId, limit, offset]);

        const totalCount = await db('SELECT COUNT(*) as total FROM quests');
        const total = parseInt(totalCount.rows[0].total);

        const userStats = await db('SELECT total_crystals, total_crystals_updated_at FROM users WHERE id = $1', [userId]);
        const totalCrystals = userStats.rows[0]?.total_crystals || 0;
        const lastUpdated = userStats.rows[0]?.total_crystals_updated_at || 0;
        const todayStart = new Date().setHours(0, 0, 0, 0);
        const canDoToday = lastUpdated < todayStart;

        const firstIncomplete = await db(`
            SELECT q.id, q.day
            FROM quests q
            WHERE q.day <= $1
              AND NOT EXISTS (SELECT 1 FROM user_quests uq WHERE uq.quest_id = q.id AND uq.user_id = $2)
            ORDER BY q.day
            LIMIT 1
        `, [currentDay, userId]);
        const availableQuestId = firstIncomplete.rows[0]?.id || null;

        res.json({
            quests: questsQuery.rows,
            pagination: { page, limit, total },
            currentDay,
            canDoToday,
            availableQuestId,
            totalCrystals
        });
    } catch (err) {
        console.error('[Quests list]', err);
        res.status(500).json({ error: 'Ошибка загрузки квестов' });
    }
});


app.post('/api/quests/complete', authMiddleware, async (req, res) => {
    const userId = req.user.userId;
    const limCheck = limiterQuests.check(userId);
    if (!limCheck.allowed) {
        return res.status(429).json({ error: 'Слишком много попыток. Подождите немного.' });
    }

    try {
        const { confirmed } = req.body;
        const currentDay = getCurrentSeasonDay();
        const now = Date.now();
        const todayStart = new Date().setHours(0, 0, 0, 0);

        const result = await withTransaction(async (client) => {
            // FOR UPDATE — блокирует строку пользователя до конца транзакции,
            // так что два конкурентных запроса от одного юзера не смогут оба
            // пройти проверку "квест ещё не выполнен сегодня" одновременно.
            const user = await client.query(
                'SELECT total_crystals_updated_at FROM users WHERE id = $1 FOR UPDATE',
                [userId]
            );
            const lastUpdated = user.rows[0]?.total_crystals_updated_at || 0;
            if (lastUpdated >= todayStart) {
                return { error: 'Сегодня вы уже выполнили квест', status: 400 };
            }

            const firstQuest = await client.query(`
                SELECT q.id, q.day, q.type, q.reward_crystals
                FROM quests q
                LEFT JOIN user_quests uq ON q.id = uq.quest_id AND uq.user_id = $1
                WHERE q.day <= $2
                  AND uq.quest_id IS NULL
                  AND q.type IN ('manual', 'confirm')
                ORDER BY q.day
                LIMIT 1
            `, [userId, currentDay]);

            if (firstQuest.rows.length === 0) {
                return { error: 'Нет доступных квестов', status: 400 };
            }

            const quest = firstQuest.rows[0];
            if (quest.type === 'confirm' && !confirmed) {
                return { error: 'Нужно подтверждение', status: 400 };
            }

            // ON CONFLICT — вторая защита от гонки на случай, если тот же квест
            // уже был вставлен параллельным запросом до FOR UPDATE.
            const inserted = await client.query(
                `INSERT INTO user_quests (user_id, quest_id, completed_at, progress, target)
                 VALUES ($1, $2, $3, 0, 0)
                 ON CONFLICT (user_id, quest_id) DO NOTHING
                 RETURNING quest_id`,
                [userId, quest.id, now]
            );
            if (inserted.rows.length === 0) {
                return { error: 'Квест уже выполнен', status: 400 };
            }

            const updated = await client.query(
                `UPDATE users SET total_crystals = total_crystals + $1, total_crystals_updated_at = $2
                 WHERE id = $3 RETURNING total_crystals`,
                [quest.reward_crystals, now, userId]
            );

            return {
                success: true,
                added: quest.reward_crystals,
                totalCrystals: updated.rows[0].total_crystals,
                canDoToday: false,
                completedQuestId: quest.id
            };
        });

        if (result.error) return res.status(result.status).json({ error: result.error });
        res.json(result);
    } catch (err) {
        console.error('[Quests complete]', err);
        res.status(500).json({ error: 'Ошибка при выполнении квеста' });
    }
});

app.get('/api/quests/leaderboard', async (req, res) => {
    try {
        const limit = Math.min(50, parseInt(req.query.limit) || 10);
        const rows = await db(`
            SELECT username, total_crystals, total_crystals_updated_at
            FROM users
            WHERE total_crystals > 0
            ORDER BY total_crystals DESC, total_crystals_updated_at ASC
            LIMIT $1
        `, [limit]);
        res.json(rows.rows);
    } catch (err) {
        console.error('[Quests leaderboard]', err);
        res.status(500).json({ error: 'Ошибка загрузки лидерборда' });
    }
});


// ── Квесты (Сезон 2) ─────────────────────────────────────────
const SEASON_NUMBER = 2;
// Старт сезона задаётся переменной окружения SEASON_START (ISO-дата);
// по умолчанию — 1 сентября 2026 UTC.
const SEASON_START = process.env.SEASON_START
  ? new Date(process.env.SEASON_START).getTime()
  : Date.UTC(2026, 8, 1);

function getCurrentSeasonDay() {
  const day = Math.floor((Date.now() - SEASON_START) / 86_400_000) + 1;
  return Math.max(1, day);
}
};
