    const { Pool } = require("pg");

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });

    pool.on("error", (err) => {
        console.error("❌ Error inesperado en PostgreSQL:", err);
    });

    async function ensureOAuthColumns() {
        await pool.query(`
            ALTER TABLE streamer_sessions
            ADD COLUMN IF NOT EXISTS oauth_state TEXT
        `);

        await pool.query(`
            ALTER TABLE streamer_sessions
            ADD COLUMN IF NOT EXISTS oauth_state_created_at TIMESTAMPTZ
        `);

        await pool.query(`
            ALTER TABLE streamer_sessions
            ADD COLUMN IF NOT EXISTS oauth_return_url TEXT
        `);

        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_streamer_sessions_oauth_state
            ON streamer_sessions(oauth_state)
            WHERE oauth_state IS NOT NULL
        `);

        // Índice para poder localizar al streamer por su identidad permanente de Twitch.
        // No es UNIQUE para permitir migraciones seguras si una base antigua contiene
        // registros duplicados; el servidor reutiliza el primero encontrado.
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_twitch_accounts_twitch_user_id
            ON twitch_accounts(twitch_user_id)
            WHERE twitch_user_id IS NOT NULL
        `);
    }

    async function testDatabaseConnection() {
        await ensureOAuthColumns();

        const client = await pool.connect();

        try {
            const result = await client.query("SELECT NOW() AS now");

            console.log("✅ PostgreSQL conectado correctamente");
            console.log("🕐 Hora de PostgreSQL:", result.rows[0].now);

            return true;
        } finally {
            client.release();
        }
    }

    async function initializeSession(session) {
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            await client.query(
                `INSERT INTO streamer_sessions (session_id, created_at, last_activity)
                 VALUES ($1, NOW(), NOW())
                 ON CONFLICT (session_id)
                 DO UPDATE SET last_activity = NOW()`,
                [session.id]
            );

            await client.query(
                `INSERT INTO squat_counters (session_id, squat_counter)
                 VALUES ($1, 0)
                 ON CONFLICT (session_id) DO NOTHING`,
                [session.id]
            );

            await client.query(
                `INSERT INTO twitch_bits_config (session_id, bits_per_block, squats_per_block)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (session_id) DO NOTHING`,
                [session.id, session.bitsPerBlock, session.squatsPerBlock]
            );

            const sessionResult = await client.query(
                `SELECT oauth_state, oauth_state_created_at, oauth_return_url
                 FROM streamer_sessions
                 WHERE session_id = $1`,
                [session.id]
            );

            if (sessionResult.rows.length) {
                const row = sessionResult.rows[0];
                session.oauthState = row.oauth_state || null;
                session.oauthStateCreatedAt = row.oauth_state_created_at || null;
                session.oauthReturnUrl = row.oauth_return_url || null;
            }

            const counterResult = await client.query(
                `SELECT squat_counter
                 FROM squat_counters
                 WHERE session_id = $1`,
                [session.id]
            );

            if (counterResult.rows.length) {
                session.squatCounter = counterResult.rows[0].squat_counter;
            }

            const bitsResult = await client.query(
                `SELECT bits_per_block, squats_per_block
                 FROM twitch_bits_config
                 WHERE session_id = $1`,
                [session.id]
            );

            if (bitsResult.rows.length) {
                session.bitsPerBlock = bitsResult.rows[0].bits_per_block;
                session.squatsPerBlock = bitsResult.rows[0].squats_per_block;
            }

            const twitchResult = await client.query(
                `SELECT client_id, client_secret, access_token, refresh_token,
                        twitch_user_id, twitch_login, twitch_display_name
                 FROM twitch_accounts
                 WHERE session_id = $1`,
                [session.id]
            );

            if (twitchResult.rows.length) {
                const row = twitchResult.rows[0];

                session.twitchClientId = row.client_id || null;
                session.twitchClientSecret = row.client_secret || null;
                session.twitchAccessToken = row.access_token || null;
                session.twitchRefreshToken = row.refresh_token || null;

                if (row.twitch_user_id) {
                    session.twitchUser = {
                        id: row.twitch_user_id,
                        login: row.twitch_login || "",
                        display_name: row.twitch_display_name || row.twitch_login || ""
                    };
                }
            }

            const rewardsResult = await client.query(
                `SELECT reward_id, squats
                 FROM twitch_rewards
                 WHERE session_id = $1`,
                [session.id]
            );

            session.rewardMappings = {};
            for (const row of rewardsResult.rows) {
                session.rewardMappings[row.reward_id] = row.squats;
            }

            await client.query("COMMIT");
            return session;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async function touchSession(sessionId) {
        await pool.query(
            `UPDATE streamer_sessions
             SET last_activity = NOW()
             WHERE session_id = $1`,
            [sessionId]
        );
    }

    async function saveOAuthState(sessionId, oauthState, returnUrl) {
        await pool.query(
            `UPDATE streamer_sessions
             SET oauth_state = $2,
                 oauth_state_created_at = NOW(),
                 oauth_return_url = $3,
                 last_activity = NOW()
             WHERE session_id = $1`,
            [sessionId, oauthState, returnUrl || null]
        );
    }

    async function findSessionByOAuthState(oauthState) {
        const result = await pool.query(
            `SELECT
                 session_id,
                 oauth_state,
                 oauth_state_created_at,
                 oauth_return_url
             FROM streamer_sessions
             WHERE oauth_state = $1
               AND oauth_state_created_at IS NOT NULL
               AND oauth_state_created_at > NOW() - INTERVAL '15 minutes'
             LIMIT 1`,
            [oauthState]
        );

        return result.rows[0] || null;
    }

    async function clearOAuthState(sessionId) {
        await pool.query(
            `UPDATE streamer_sessions
             SET oauth_state = NULL,
                 oauth_state_created_at = NULL,
                 oauth_return_url = NULL,
                 last_activity = NOW()
             WHERE session_id = $1`,
            [sessionId]
        );
    }

    async function setSquatCounter(sessionId, value) {
        const result = await pool.query(
            `INSERT INTO squat_counters (session_id, squat_counter)
             VALUES ($1, $2)
             ON CONFLICT (session_id)
             DO UPDATE SET
                 squat_counter = EXCLUDED.squat_counter,
                 updated_at = NOW()
             RETURNING squat_counter`,
            [sessionId, Math.max(0, Math.floor(Number(value) || 0))]
        );

        await touchSession(sessionId);
        return result.rows[0].squat_counter;
    }

    async function changeSquatCounter(sessionId, amount) {
        const change = Math.trunc(Number(amount));

        if (!Number.isFinite(change) || change === 0) {
            const result = await pool.query(
                `SELECT squat_counter
                 FROM squat_counters
                 WHERE session_id = $1`,
                [sessionId]
            );

            return result.rows[0]?.squat_counter ?? 0;
        }

        const result = await pool.query(
            `INSERT INTO squat_counters (session_id, squat_counter)
             VALUES ($1, GREATEST(0, $2))
             ON CONFLICT (session_id)
             DO UPDATE SET
                 squat_counter = GREATEST(0, squat_counters.squat_counter + $2),
                 updated_at = NOW()
             RETURNING squat_counter`,
            [sessionId, change]
        );

        await touchSession(sessionId);
        return result.rows[0].squat_counter;
    }

    async function saveTwitchCredentials(session) {
        await pool.query(
            `INSERT INTO twitch_accounts
                (session_id, client_id, client_secret)
             VALUES ($1, $2, $3)
             ON CONFLICT (session_id)
             DO UPDATE SET
                client_id = EXCLUDED.client_id,
                client_secret = EXCLUDED.client_secret,
                updated_at = NOW()`,
            [session.id, session.twitchClientId, session.twitchClientSecret]
        );

        await touchSession(session.id);
    }

    async function saveTwitchTokens(session) {
        await pool.query(
            `INSERT INTO twitch_accounts
                (session_id, client_id, client_secret, access_token, refresh_token,
                 twitch_user_id, twitch_login, twitch_display_name)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (session_id)
             DO UPDATE SET
                client_id = COALESCE(EXCLUDED.client_id, twitch_accounts.client_id),
                client_secret = COALESCE(EXCLUDED.client_secret, twitch_accounts.client_secret),
                access_token = EXCLUDED.access_token,
                refresh_token = EXCLUDED.refresh_token,
                twitch_user_id = EXCLUDED.twitch_user_id,
                twitch_login = EXCLUDED.twitch_login,
                twitch_display_name = EXCLUDED.twitch_display_name,
                updated_at = NOW()`,
            [
                session.id,
                session.twitchClientId,
                session.twitchClientSecret,
                session.twitchAccessToken,
                session.twitchRefreshToken,
                session.twitchUser?.id || null,
                session.twitchUser?.login || null,
                session.twitchUser?.display_name || null
            ]
        );

        await touchSession(session.id);
    }

    async function findSessionByTwitchUserId(twitchUserId) {
        const result = await pool.query(
            `SELECT session_id, client_id, client_secret, access_token, refresh_token,
                    twitch_user_id, twitch_login, twitch_display_name
             FROM twitch_accounts
             WHERE twitch_user_id = $1
             ORDER BY updated_at DESC NULLS LAST
             LIMIT 1`,
            [String(twitchUserId || "").trim()]
        );

        return result.rows[0] || null;
    }

    async function clearTwitchTokens(sessionId) {
        await pool.query(
            `UPDATE twitch_accounts
             SET access_token = NULL,
                 refresh_token = NULL,
                 twitch_user_id = NULL,
                 twitch_login = NULL,
                 twitch_display_name = NULL,
                 updated_at = NOW()
             WHERE session_id = $1`,
            [sessionId]
        );

        await touchSession(sessionId);
    }

    async function saveBitsConfig(session) {
        await pool.query(
            `INSERT INTO twitch_bits_config
                (session_id, bits_per_block, squats_per_block)
             VALUES ($1, $2, $3)
             ON CONFLICT (session_id)
             DO UPDATE SET
                bits_per_block = EXCLUDED.bits_per_block,
                squats_per_block = EXCLUDED.squats_per_block,
                updated_at = NOW()`,
            [session.id, session.bitsPerBlock, session.squatsPerBlock]
        );

        await touchSession(session.id);
    }

    async function saveRewardMappings(session) {
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            await client.query(
                `DELETE FROM twitch_rewards
                 WHERE session_id = $1`,
                [session.id]
            );

            for (const [rewardId, squats] of Object.entries(session.rewardMappings || {})) {
                await client.query(
                    `INSERT INTO twitch_rewards
                        (session_id, reward_id, reward_name, squats)
                     VALUES ($1, $2, $3, $4)`,
                    [session.id, rewardId, null, Math.max(0, Math.floor(Number(squats) || 0))]
                );
            }

            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }

        await touchSession(session.id);
    }

    async function markEventAsProcessed(sessionId, eventId) {
        const result = await pool.query(
            `INSERT INTO twitch_processed_events (session_id, event_id)
             VALUES ($1, $2)
             ON CONFLICT (session_id, event_id) DO NOTHING
             RETURNING event_id`,
            [sessionId, eventId]
        );

        await touchSession(sessionId);
        return result.rowCount === 1;
    }

    module.exports = {
        pool,
        testDatabaseConnection,
        ensureOAuthColumns,
        initializeSession,
        touchSession,
        setSquatCounter,
        changeSquatCounter,
        saveTwitchCredentials,
        saveTwitchTokens,
        clearTwitchTokens,
        saveBitsConfig,
        saveRewardMappings,
        markEventAsProcessed,
        saveOAuthState,
        findSessionByOAuthState,
        clearOAuthState,
        findSessionByTwitchUserId
    };
