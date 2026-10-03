

    const express = require("express");

    const path = require("path");

    const crypto = require("crypto");

    const http = require("http");

    const WebSocket = require("ws");

    require("dotenv").config();

    const {
        testDatabaseConnection,
        initializeSession,
        touchSession,
        setSquatCounter: dbSetSquatCounter,
        changeSquatCounter: dbChangeSquatCounter,
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
    } = require("./database");

    // ============================================================

    // SQUAT TWITCH - SERVIDOR MULTIUSUARIO

    // Cada navegador/streamer tiene su propia sesión.

    // ============================================================

    const app = express();

    const server = http.createServer(app);

    const PORT = Number(process.env.PORT || 3000);

    const HOST = "0.0.0.0";

    const TWITCH_REDIRECT_URI = String(
        process.env.TWITCH_REDIRECT_URI || ""
    ).trim();

    function getRedirectUri() {
        if (!TWITCH_REDIRECT_URI) {
            throw new Error("Falta TWITCH_REDIRECT_URI en las variables de entorno.");
        }
        return TWITCH_REDIRECT_URI;
    }

    // ============================================================

    // SESIONES

    // ============================================================

    const sessions = new Map();

    const SESSION_COOKIE = "squat_session";

    function createSession(existingId = null) {

        const id = existingId || crypto.randomBytes(32).toString("hex");

        const session = {

            id,

            createdAt: Date.now(),

            lastActivity: Date.now(),

            dbReady: null,

            // Twitch de ESTA sesión. La identidad permanente es twitchUser.id.

            twitchClientId: null,

            twitchClientSecret: null,

            twitchAccessToken: null,

            twitchRefreshToken: null,

            twitchUser: null,

            oauthState: null,
            oauthReturnUrl: null,

            // EventSub de ESTA sesión

            eventSubSocket: null,

            eventSubConnecting: false,

            eventSubReconnectTimer: null,

            // Configuración de ESTA sesión

            bitsPerBlock: 100,

            squatsPerBlock: 10,

            rewardMappings: {},

            // Contador de ESTA sesión

            squatCounter: 0,

            // Navegadores/OBS pertenecientes a ESTA sesión

            browserClients: new Set()

        };

        sessions.set(id, session);

        // La sesión queda disponible inmediatamente, pero ninguna operación

        // de PostgreSQL se ejecuta hasta que esta promesa termine.

        session.dbReady = initializeSession(session)

            .then(async () => {

                if (session.twitchAccessToken && session.twitchUser) {

                    setTimeout(() => {

                        if (session.twitchAccessToken && session.twitchUser) {

                            startEventSub(session).catch(error => {

                                console.error(`❌ No se pudo restaurar EventSub de ${session.id.slice(0, 8)}:`, error.message);

                            });

                        }

                    }, 100);

                }

                return session;

            })

            .catch(error => {

                console.error(`❌ No se pudo inicializar la sesión ${id.slice(0, 8)} en PostgreSQL:`, error);

                sessions.delete(id);

                throw error;

            });

        console.log(`🆕 Sesión creada/cargada: ${id}`);

        return session;

    }

    function isValidSessionId(value) {

        return /^[a-f0-9]{64}$/i.test(String(value || ""));

    }

    function getSessionIdFromCookie(req) {

        const header = String(req.headers.cookie || "");

        for (const part of header.split(";")) {

            const [key, ...rest] = part.trim().split("=");

            if (key === SESSION_COOKIE) {

                const value = rest.join("=");

                if (isValidSessionId(value)) return value;

            }

        }

        return null;

    }

    function setSessionCookie(res, sessionId) {

        const secure = process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);

        res.setHeader(

            "Set-Cookie",

            `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`

        );

    }

    function getSession(req, res, create = true) {

        // La sesión explícita de la URL tiene prioridad.

        // Esto permite que varias pestañas/dispositivos trabajen en Render

        // sin que una cookie de otro usuario cambie de sesión.

        const querySession = req.query?.session;

        if (isValidSessionId(querySession)) {

            const session = sessions.get(querySession) || createSession(querySession);

            session.lastActivity = Date.now();

            setSessionCookie(res, querySession);

            touchSession(querySession).catch(() => {});

            return session;

        }

        // ?new=1 fuerza una sesión NUEVA aunque el navegador ya tenga cookie.

        if (String(req.query?.new || "") === "1") {

            const session = createSession();

            setSessionCookie(res, session.id);

            return session;

        }

        const cookieSession = getSessionIdFromCookie(req);

        if (cookieSession) {

            const session = sessions.get(cookieSession) || createSession(cookieSession);

            session.lastActivity = Date.now();

            touchSession(cookieSession).catch(() => {});

            return session;

        }

        if (!create) return null;

        const session = createSession();

        setSessionCookie(res, session.id);

        return session;

    }

    function getSessionFromUpgrade(request) {

        const url = new URL(request.url, "http://localhost");

        const querySession = url.searchParams.get("session");

        if (isValidSessionId(querySession)) {

            return sessions.get(querySession) || createSession(querySession);

        }

        const cookieSession = getSessionIdFromCookie(request);

        if (cookieSession) {

            return sessions.get(cookieSession) || createSession(cookieSession);

        }

        return null;

    }

    // ============================================================

    // EXPRESS

    // ============================================================

    app.use(express.json());

    app.use((req, res, next) => {

        res.setHeader("Permissions-Policy", "camera=(self), microphone=()");

        next();

    });

    app.use((req, res, next) => {

        res.setHeader("Access-Control-Allow-Origin", "*");

        res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") return res.sendStatus(204);

        next();

    });

    // Si OBS abre /obs.html?session=XXXX, guardamos esa sesión como cookie

    // antes de entregar el HTML. Así el WebSocket de OBS queda ligado al streamer.

    app.use((req, res, next) => {

        if ((req.path === "/obs.html" || req.path === "/controles.html") && req.query.session) {

            if (isValidSessionId(req.query.session) && sessions.has(req.query.session)) {

                setSessionCookie(res, req.query.session);

            }

        }

        next();

    });

    app.use(express.static(__dirname));

    app.use(express.static(path.join(__dirname, "public")));

    // ============================================================

    // SESIÓN DEL NAVEGADOR

    // ============================================================

    app.get("/api/session", (req, res) => {

        const session = getSession(req, res);

        const publicUrl = String(

            process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`

        ).replace(/\/$/, "");

        res.json({

            ok: true,

            sessionId: session.id,

            obsUrl: `${publicUrl}/obs.html?session=${session.id}`,

            controlsUrl: `${publicUrl}/controles.html?session=${session.id}`

        });

    });

    // ============================================================

    // PÁGINAS

    // ============================================================

    app.get("/", (req, res) => {

        getSession(req, res);

        res.sendFile(path.join(__dirname, "index.html"));

    });

    app.get("/prueba", (req, res) => {

        getSession(req, res);

        res.type("text").send(`OK - Squat Twitch funcionando en ${PORT}`);

    });

    // ============================================================

    // CONTADOR

    // ============================================================

    function getCounterData(session) {

        return {

            pendingSquats: session.squatCounter

        };

    }

    function sendCounterToSocket(socket, session) {

        if (!socket || socket.readyState !== WebSocket.OPEN) return;

        socket.send(JSON.stringify({

            type: "counter:update",

            data: getCounterData(session)

        }));

    }

    function broadcastCounter(session) {

        const message = JSON.stringify({

            type: "counter:update",

            data: getCounterData(session)

        });

        for (const socket of session.browserClients) {

            if (socket.readyState === WebSocket.OPEN) {

                try {

                    socket.send(message);

                } catch {

                    session.browserClients.delete(socket);

                }

            } else {

                session.browserClients.delete(socket);

            }

        }

    }

    async function setSquatCounter(session, value) {

        const number = Number(value);

        if (!Number.isFinite(number)) return false;

        const safeValue = Math.max(0, Math.floor(number));

        session.squatCounter = await dbSetSquatCounter(session.id, safeValue);

        broadcastCounter(session);

        return true;

    }

    async function changeSquatCounter(session, amount, source = "manual") {

        const number = Number(amount);

        if (!Number.isFinite(number) || number === 0) return false;

        session.squatCounter = await dbChangeSquatCounter(

            session.id,

            Math.floor(number)

        );

        broadcastCounter(session);

        console.log(

            `🔢 [${session.twitchUser?.display_name || session.id.slice(0, 8)}] ${number > 0 ? "+" : ""}${Math.floor(number)} | ${source} | total: ${session.squatCounter}`

        );

        return true;

    }

    async function addSquats(session, amount, source = "Twitch") {

        const number = Number(amount);

        if (!Number.isFinite(number) || number <= 0) return false;

        session.squatCounter = await dbChangeSquatCounter(

            session.id,

            Math.floor(number)

        );

        broadcastCounter(session);

        console.log(

            `➕ [${session.twitchUser?.display_name || session.id.slice(0, 8)}] +${Math.floor(number)} | ${source} | total: ${session.squatCounter}`

        );

        return true;

    }

    app.get("/api/squats", async (req, res) => {

        const session = getSession(req, res);

        try {

            await session.dbReady;

            res.json({ ok: true, ...getCounterData(session) });

        } catch (error) {

            console.error("❌ Error leyendo contador:", error);

            res.status(500).json({ ok: false, error: "No se pudo leer PostgreSQL." });

        }

    });

    app.post("/api/squats/change", async (req, res) => {

        const session = getSession(req, res);

        const amount = Number(req.body?.amount);

        if (!Number.isFinite(amount) || amount === 0) {

            return res.status(400).json({ ok: false, error: "Cantidad inválida" });

        }

        try {

            await session.dbReady;

            await changeSquatCounter(session, amount, "sentadilla detectada");

            res.json({ ok: true, ...getCounterData(session) });

        } catch (error) {

            console.error("❌ Error cambiando contador:", error);

            res.status(500).json({ ok: false, error: "No se pudo guardar en PostgreSQL." });

        }

    });

    app.post("/api/squats/add", async (req, res) => {

        const session = getSession(req, res);

        const amount = Number(req.body?.amount);

        if (!Number.isFinite(amount) || amount <= 0) {

            return res.status(400).json({ ok: false, error: "Cantidad inválida" });

        }

        try {

            await session.dbReady;

            await addSquats(session, amount, "manual");

            res.json({ ok: true, ...getCounterData(session) });

        } catch (error) {

            console.error("❌ Error sumando sentadillas:", error);

            res.status(500).json({ ok: false, error: "No se pudo guardar en PostgreSQL." });

        }

    });

    app.post("/api/squats/set", async (req, res) => {

        const session = getSession(req, res);

        const value = Number(req.body?.value);

        if (!Number.isFinite(value)) {

            return res.status(400).json({ ok: false, error: "Valor inválido" });

        }

        try {

            await session.dbReady;

            await setSquatCounter(session, value);

            res.json({ ok: true, ...getCounterData(session) });

        } catch (error) {

            console.error("❌ Error estableciendo contador:", error);

            res.status(500).json({ ok: false, error: "No se pudo guardar en PostgreSQL." });

        }

    });

    app.post("/api/squats/reset", async (req, res) => {

        const session = getSession(req, res);

        try {

            await session.dbReady;

            await setSquatCounter(session, 0);

            console.log(`🔄 [${session.id.slice(0, 8)}] Contador reiniciado`);

            res.json({ ok: true, ...getCounterData(session) });

        } catch (error) {

            console.error("❌ Error reiniciando contador:", error);

            res.status(500).json({ ok: false, error: "No se pudo guardar en PostgreSQL." });

        }

    });

    // ============================================================

    // TWITCH CONFIGURACIÓN

    // ============================================================

    app.get("/api/twitch/config", async (req, res) => {

        const session = getSession(req, res);

        await session.dbReady;

        res.json({

            ok: true,

            clientId: session.twitchClientId || "",

            credentialsConfigured: Boolean(session.twitchClientId && session.twitchClientSecret),

            credentialsSource: "session",

            bitsPerBlock: session.bitsPerBlock,

            squatsPerBlock: session.squatsPerBlock

        });

    });

    app.post("/api/twitch/credentials", async (req, res) => {

        const session = getSession(req, res);

        const clientId = String(req.body?.clientId || "").trim();

        const clientSecret = String(req.body?.clientSecret || "").trim();

        if (!clientId) {

            return res.status(400).json({

                ok: false,

                error: "Introduce el Client ID de Twitch."

            });

        }

        if (!clientSecret) {

            return res.status(400).json({

                ok: false,

                error: "Introduce el Client Secret de Twitch."

            });

        }

        try {

            await session.dbReady;

            session.twitchClientId = clientId;

            session.twitchClientSecret = clientSecret;

            await saveTwitchCredentials(session);

        } catch (error) {

            console.error("❌ Error guardando credenciales de Twitch:", error);

            return res.status(500).json({ ok: false, error: "No se pudieron guardar las credenciales en PostgreSQL." });

        }

        res.json({

            ok: true,

            clientId: session.twitchClientId,

            credentialsConfigured: true

        });

    });

    app.post("/api/twitch/bits-config", async (req, res) => {

        const session = getSession(req, res);

        const bitsPerBlock = Math.max(

            1,

            Math.floor(Number(req.body?.bitsPerBlock) || 0)

        );

        const squatsPerBlock = Math.max(

            1,

            Math.floor(Number(req.body?.squatsPerBlock) || 0)

        );

        try {

            await session.dbReady;

            session.bitsPerBlock = bitsPerBlock;

            session.squatsPerBlock = squatsPerBlock;

            await saveBitsConfig(session);

        } catch (error) {

            console.error("❌ Error guardando configuración de Bits:", error);

            return res.status(500).json({ ok: false, error: "No se pudo guardar la configuración en PostgreSQL." });

        }

        res.json({ ok: true, bitsPerBlock, squatsPerBlock });

    });

    // ============================================================

    // ESTADO TWITCH

    // ============================================================

    app.get("/api/status", async (req, res) => {

        const session = getSession(req, res);

        await session.dbReady;

        res.json({

            ok: true,

            sessionId: session.id,

            twitch: {

                connected: Boolean(session.twitchAccessToken),

                eventSub: Boolean(session.eventSubSocket),

                user: session.twitchUser

                    ? {

                        id: session.twitchUser.id,

                        login: session.twitchUser.login,

                        display_name: session.twitchUser.display_name

                    }

                    : null

            },

            squats: {

                pending: session.squatCounter

            }

        });

    });

    // ============================================================

    // RECOMPENSAS

    // ============================================================

    async function getTwitchRewards(session) {

        if (!session.twitchAccessToken || !session.twitchUser) {

            throw new Error("Twitch no está conectado.");

        }

        const url = new URL(

            "https://api.twitch.tv/helix/channel_points/custom_rewards"

        );

        url.searchParams.set("broadcaster_id", session.twitchUser.id);

        const response = await fetch(url, {

            headers: {

                "Client-Id": session.twitchClientId,

                Authorization: `Bearer ${session.twitchAccessToken}`

            }

        });

        const data = await response.json();

        if (!response.ok) {

            throw new Error(

                data.message || "Twitch no permitió obtener las recompensas."

            );

        }

        return data.data || [];

    }

    app.get("/api/twitch/rewards", async (req, res) => {

        const session = getSession(req, res);

        try {

            await session.dbReady;

            const rewards = await getTwitchRewards(session);

            res.json({

                ok: true,

                rewards: rewards.map(reward => ({

                    id: reward.id,

                    title: reward.title,

                    cost: reward.cost,

                    is_enabled: reward.is_enabled,

                    is_paused: reward.is_paused

                })),

                mappings: session.rewardMappings

            });

        } catch (error) {

            console.error("❌ Error obteniendo recompensas:", error);

            res.status(500).json({ ok: false, error: error.message });

        }

    });

    app.post("/api/twitch/reward-mappings", async (req, res) => {

        const session = getSession(req, res);

        const mappings = req.body?.mappings;

        if (!Array.isArray(mappings)) {

            return res.status(400).json({

                ok: false,

                error: "Formato inválido."

            });

        }

        const newMappings = {};

        for (const mapping of mappings) {

            const rewardId = String(mapping.rewardId || "").trim();

            const squats = Math.max(

                0,

                Math.floor(Number(mapping.squats) || 0)

            );

            if (rewardId) {

                newMappings[rewardId] = squats;

            }

        }

        try {

            await session.dbReady;

            session.rewardMappings = newMappings;

            await saveRewardMappings(session);

        } catch (error) {

            console.error("❌ Error guardando mapeos de recompensas:", error);

            return res.status(500).json({ ok: false, error: "No se pudieron guardar los mapeos en PostgreSQL." });

        }

        console.log(

            `🎁 [${session.twitchUser?.display_name || session.id.slice(0, 8)}] Mapeos actualizados.`

        );

        res.json({

            ok: true,

            mappings: session.rewardMappings

        });

    });

    // ============================================================

    // OAUTH TWITCH

    // ============================================================

    function getOAuthReturnUrl(req) {
        const allowedOrigins = [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "https://contador-sentadillas.onrender.com"
        ];

        const candidates = [
            req.headers.origin,
            req.headers.referer
        ];

        for (const candidate of candidates) {
            if (!candidate) continue;

            try {
                const url = new URL(candidate);
                if (allowedOrigins.includes(url.origin)) {
                    return url.origin;
                }
            } catch {}
        }

        const configured = String(process.env.PUBLIC_URL || "").trim();

        if (configured) {
            try {
                const url = new URL(configured);
                if (allowedOrigins.includes(url.origin)) {
                    return url.origin;
                }
            } catch {}
        }

        return "http://localhost:3000";
    }

    async function createTwitchAuthorizationUrl(session, returnUrl) {
        if (!session.twitchClientId) {
            throw new Error("Falta el Client ID de Twitch. Introdúcelo en la configuración.");
        }

        if (!session.twitchClientSecret) {
            throw new Error("Falta el Client Secret de Twitch. Introdúcelo en la configuración.");
        }

        const oauthState = crypto.randomBytes(32).toString("hex");
        const safeReturnUrl = returnUrl || "http://localhost:3000";

        session.oauthState = oauthState;
        session.oauthReturnUrl = safeReturnUrl;

        await saveOAuthState(session.id, oauthState, safeReturnUrl);

        const scopes = [
            "channel:read:redemptions",
            "bits:read"
        ];

        const twitchURL = new URL("https://id.twitch.tv/oauth2/authorize");

        twitchURL.searchParams.set("client_id", session.twitchClientId);
        twitchURL.searchParams.set("redirect_uri", getRedirectUri());
        twitchURL.searchParams.set("response_type", "code");
        twitchURL.searchParams.set("scope", scopes.join(" "));
        twitchURL.searchParams.set("state", oauthState);

        return twitchURL.toString();
    }

    app.get("/api/twitch/login-url", async (req, res) => {
        const session = getSession(req, res);

        try {
            await session.dbReady;

            const returnUrl = getOAuthReturnUrl(req);
            const url = await createTwitchAuthorizationUrl(session, returnUrl);

            res.json({
                ok: true,
                url
            });

        } catch (error) {
            res.status(500).json({
                ok: false,
                error: error.message
            });
        }
    });

    app.get("/auth/twitch", async (req, res) => {
        const session = getSession(req, res);

        try {
            await session.dbReady;

            const returnUrl = getOAuthReturnUrl(req);
            const url = await createTwitchAuthorizationUrl(session, returnUrl);

            console.log(`🔵 [${session.id.slice(0, 8)}] Iniciando Twitch...`);

            res.redirect(url);

        } catch (error) {
            res.status(500).send(`
                <h1>Error de configuración</h1>
                <p>${escapeHtml(error.message)}</p>
            `);
        }
    });

    app.get("/auth/twitch/callback", async (req, res) => {
        const {
            code,
            state,
            error,
            error_description
        } = req.query;

        const oauthState = String(state || "").trim();

        if (!oauthState) {
            return res.status(400).send(connectionPage(
                false,
                "Sesión no encontrada",
                "Twitch no devolvió el identificador de autorización.",
                "http://localhost:3000"
            ));
        }

        // El callback puede llegar a Render aunque el login haya comenzado
        // desde localhost. Por eso la sesión OAuth se busca primero en PostgreSQL.
        let oauthRecord = null;

        try {
            oauthRecord = await findSessionByOAuthState(oauthState);
        } catch (lookupError) {
            console.error("❌ Error buscando OAuth state en PostgreSQL:", lookupError);
            return res.status(500).send(connectionPage(
                false,
                "Error de sesión",
                "No se pudo recuperar la sesión de Twitch desde PostgreSQL.",
                "http://localhost:3000"
            ));
        }

        if (!oauthRecord) {
            return res.status(400).send(connectionPage(
                false,
                "Sesión no encontrada",
                "La autorización de Twitch ha caducado o la sesión ya no existe. Vuelve a iniciar la conexión desde la aplicación.",
                "http://localhost:3000"
            ));
        }

        const sessionId = oauthRecord.session_id;
        const returnUrl = oauthRecord.oauth_return_url || "http://localhost:3000";

        // Si Render no tiene la sesión en memoria, la reconstruimos desde PostgreSQL.
        let session = sessions.get(sessionId);

        if (!session) {
            try {
                session = createSession(sessionId);
            } catch (createError) {
                console.error("❌ Error reconstruyendo sesión:", createError);
                return res.status(500).send(connectionPage(
                    false,
                    "Error de sesión",
                    "No se pudo reconstruir la sesión del streamer.",
                    returnUrl
                ));
            }
        }

        session.lastActivity = Date.now();

        try {
            await session.dbReady;
        } catch (dbError) {
            console.error("❌ Error inicializando sesión desde PostgreSQL:", dbError);
            return res.status(500).send(connectionPage(
                false,
                "Error de sesión",
                "No se pudo cargar la sesión desde PostgreSQL.",
                returnUrl
            ));
        }

        if (error) {
            await clearOAuthState(session.id).catch(() => {});
            session.oauthState = null;
            session.oauthReturnUrl = null;

            return res.status(400).send(connectionPage(
                false,
                "Conexión cancelada",
                `${error}: ${error_description || ""}`,
                returnUrl
            ));
        }

        if (oauthState !== String(session.oauthState || "")) {
            return res.status(400).send(connectionPage(
                false,
                "Error de seguridad",
                "El estado de autorización no coincide con esta sesión.",
                returnUrl
            ));
        }

        // El state es de un solo uso.
        session.oauthState = null;
        session.oauthReturnUrl = null;
        await clearOAuthState(session.id);

        if (!code) {
            return res.status(400).send(connectionPage(
                false,
                "No se recibió código",
                "Twitch no devolvió el código de autorización.",
                returnUrl
            ));
        }

        try {
            const tokenResponse = await fetch(
                "https://id.twitch.tv/oauth2/token",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded"
                    },
                    body: new URLSearchParams({
                        client_id: session.twitchClientId,
                        client_secret: session.twitchClientSecret,
                        code: String(code),
                        grant_type: "authorization_code",
                        redirect_uri: getRedirectUri()
                    })
                }
            );

            const tokenData = await tokenResponse.json();

            if (!tokenResponse.ok) {
                throw new Error(
                    tokenData.message || "Error obteniendo token de Twitch."
                );
            }

            session.twitchAccessToken = tokenData.access_token;
            session.twitchRefreshToken = tokenData.refresh_token || null;

            const userResponse = await fetch(
                "https://api.twitch.tv/helix/users",
                {
                    headers: {
                        Authorization: `Bearer ${session.twitchAccessToken}`,
                        "Client-Id": session.twitchClientId
                    }
                }
            );

            const userData = await userResponse.json();

            if (!userResponse.ok || !userData.data?.length) {
                throw new Error("No se pudo obtener el usuario de Twitch.");
            }

            const authenticatedTwitchUser = userData.data[0];

            // ========================================================
            // IDENTIDAD PERMANENTE DE TWITCH
            // ========================================================
            // El session_id puede cambiar; el twitch_user_id no.
            // Si este streamer ya existe en PostgreSQL, reutilizamos
            // su sesión canónica y, por tanto, toda su configuración.
            let canonicalSession = session;

            try {
                const existingAccount = await findSessionByTwitchUserId(
                    authenticatedTwitchUser.id
                );

                if (existingAccount && existingAccount.session_id !== session.id) {
                    console.log(
                        `♻️ Twitch ${authenticatedTwitchUser.display_name} ya existe. Reutilizando sesión permanente ${existingAccount.session_id.slice(0, 8)}.`
                    );

                    canonicalSession = sessions.get(existingAccount.session_id);

                    if (!canonicalSession) {
                        canonicalSession = createSession(existingAccount.session_id);
                    }

                    await canonicalSession.dbReady;
                }
            } catch (identityError) {
                console.error("⚠️ No se pudo localizar la identidad permanente de Twitch:", identityError);
                canonicalSession = session;
            }

            canonicalSession.twitchClientId = session.twitchClientId || canonicalSession.twitchClientId;
            canonicalSession.twitchClientSecret = session.twitchClientSecret || canonicalSession.twitchClientSecret;
            canonicalSession.twitchAccessToken = session.twitchAccessToken;
            canonicalSession.twitchRefreshToken = session.twitchRefreshToken;
            canonicalSession.twitchUser = authenticatedTwitchUser;
            canonicalSession.lastActivity = Date.now();

            await saveTwitchTokens(canonicalSession);

            // La cookie pasa a apuntar a la identidad permanente.
            setSessionCookie(res, canonicalSession.id);

            console.log("==============================================");
            console.log("✅ TWITCH CONECTADO");
            console.log("Usuario:", canonicalSession.twitchUser.display_name);
            console.log("Twitch User ID:", canonicalSession.twitchUser.id);
            console.log("Sesión permanente:", canonicalSession.id.slice(0, 8));
            console.log("==============================================");

            await startEventSub(canonicalSession);

            return res.send(connectionPage(
                true,
                "¡Twitch conectado!",
                canonicalSession.twitchUser.display_name,
                returnUrl,
                canonicalSession.id
            ));

        } catch (error) {
            console.error("❌ ERROR EN CALLBACK:", error);

            session.twitchAccessToken = null;
            session.twitchRefreshToken = null;
            session.twitchUser = null;

            await clearTwitchTokens(session.id).catch(() => {});

            return res.status(500).send(connectionPage(
                false,
                "Error conectando Twitch",
                error.message,
                returnUrl
            ));
        }
    });

    function connectionPage(success, title, message, returnUrl = "http://localhost:3000", sessionId = "") {
        const color = success ? "#9147ff" : "#a91f1f";
        const icon = success ? "✅" : "❌";

        const allowedOrigins = [
            "http://localhost:3000",
            "http://127.0.0.1:3000",
            "https://contador-sentadillas.onrender.com"
        ];

        let safeReturnUrl = "http://localhost:3000";

        try {
            const parsed = new URL(returnUrl);
            if (allowedOrigins.includes(parsed.origin)) {
                safeReturnUrl = parsed.origin;
            }
        } catch {}

        const returnUrlJs = JSON.stringify(safeReturnUrl);
        const sessionIdJs = JSON.stringify(String(sessionId || ""));

        return `<!DOCTYPE html>
    <html lang="es">
    <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111827;color:white;font-family:Arial,sans-serif}
    .box{width:90%;max-width:500px;background:#1f2937;padding:40px;border-radius:20px;text-align:center;box-sizing:border-box}
    .icon{font-size:70px}.user{color:#a970ff;font-size:22px;font-weight:bold;margin:20px 0}button{border:none;border-radius:10px;padding:14px 25px;background:${color};color:white;font-size:16px;font-weight:bold;cursor:pointer}
    </style>
    </head>
    <body>
    <div class="box">
    <div class="icon">${icon}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <button onclick="closeAndReturn()">Cerrar ventana</button>
    </div>
    <script>
    function closeAndReturn() {
        const returnUrl = ${returnUrlJs};
        const sessionId = ${sessionIdJs};

        if (sessionId) {
            try {
                localStorage.setItem("squat_session_id", sessionId);
            } catch {}
        }

        try {
            if (window.opener && !window.opener.closed) {
                window.opener.location.href = returnUrl;
                window.close();
                return;
            }
        } catch {}

        window.location.href = returnUrl;
    }

    setTimeout(closeAndReturn, 1200);
    </script>
    </body>
    </html>`;
    }

    // ============================================================

    // EVENTSUB POR SESIÓN
    // ============================================================

    // ============================================================

    // EVENTSUB POR SESIÓN

    // ============================================================

    async function startEventSub(session, customUrl = null) {

        if (!session.twitchAccessToken || !session.twitchUser) return;

        if (session.eventSubConnecting) return;

        session.eventSubConnecting = true;

        try {

            if (session.eventSubSocket) {

                try {

                    session.eventSubSocket.close();

                } catch {}

                session.eventSubSocket = null;

            }

            const url = customUrl || "wss://eventsub.wss.twitch.tv/ws";

            const socket = new WebSocket(url);

            session.eventSubSocket = socket;

            socket.on("open", () => {

                console.log(

                    `🟢 [${session.twitchUser?.display_name || session.id.slice(0, 8)}] EventSub conectado`

                );

            });

            socket.on("message", async raw => {

                try {

                    const message = JSON.parse(raw.toString());

                    await handleEventSubMessage(session, message, socket);

                } catch (error) {

                    console.error("❌ Error procesando EventSub:", error);

                }

            });

            socket.on("close", () => {

                if (session.eventSubSocket === socket) {

                    session.eventSubSocket = null;

                }

                session.eventSubConnecting = false;

                if (

                    session.twitchAccessToken &&

                    session.twitchUser &&

                    !session.eventSubReconnectTimer

                ) {

                    session.eventSubReconnectTimer = setTimeout(() => {

                        session.eventSubReconnectTimer = null;

                        if (!session.eventSubSocket) {

                            startEventSub(session).catch(() => {});

                        }

                    }, 5000);

                }

            });

            socket.on("error", error => {

                console.error(

                    `❌ [${session.id.slice(0, 8)}] Error EventSub:`,

                    error.message

                );

            });

        } catch (error) {

            console.error("❌ No se pudo iniciar EventSub:", error);

        }

        session.eventSubConnecting = false;

    }

    async function handleEventSubMessage(session, message, socket) {

        const type = message?.metadata?.message_type;

        if (type === "session_welcome") {

            const sessionId = message.payload.session.id;

            console.log(

                `👋 [${session.id.slice(0, 8)}] EventSub Welcome: ${sessionId}`

            );

            await createEventSubSubscriptions(session, sessionId);

            return;

        }

        if (type === "session_reconnect") {

            const reconnectUrl = message.payload.session.reconnect_url;

            if (reconnectUrl) {

                try {

                    socket.close();

                } catch {}

                setTimeout(() => {

                    startEventSub(session, reconnectUrl).catch(() => {});

                }, 100);

            }

            return;

        }

        if (type === "session_keepalive") return;

        if (type === "revocation") {

            console.warn(

                `⚠️ [${session.twitchUser?.display_name || session.id.slice(0, 8)}] Twitch revocó EventSub.`

            );

            return;

        }

        if (type !== "notification") return;

        const messageId = String(message.metadata?.message_id || "");

        if (!messageId) return;

        // PostgreSQL es la fuente definitiva para evitar duplicados,

        // incluso si el servidor se reinicia.

        const wasInserted = await markEventAsProcessed(session.id, messageId);

        if (!wasInserted) {

            console.log(`♻️ Evento Twitch duplicado ignorado: ${messageId}`);

            return;

        }

        const subscriptionType = message.payload?.subscription?.type;

        const event = message.payload?.event || {};

        // ---------------- CHANNEL POINTS ----------------

        if (

            subscriptionType ===

            "channel.channel_points_custom_reward_redemption.add"

        ) {

            const rewardId = String(event.reward?.id || "");

            const rewardTitle = String(event.reward?.title || "Recompensa");

            const amount = Math.max(

                0,

                Math.floor(Number(session.rewardMappings[rewardId]) || 0)

            );

            console.log(

                `🎁 [${session.twitchUser?.display_name}] ${rewardTitle} -> ${amount} sentadillas`

            );

            if (amount > 0) {

                await addSquats(session, amount, `Twitch: ${rewardTitle}`);

            }

            return;

        }

        // ---------------- BITS ----------------

        if (subscriptionType === "channel.cheer") {

            const bits = Number(event.bits || 0);

            if (!Number.isFinite(bits) || bits <= 0) return;

            const bitsPerBlock = Math.max(

                1,

                Math.floor(Number(session.bitsPerBlock) || 1)

            );

            const squatsPerBlock = Math.max(

                1,

                Math.floor(Number(session.squatsPerBlock) || 1)

            );

            const blocks = Math.floor(bits / bitsPerBlock);

            const amount = blocks * squatsPerBlock;

            console.log(

                `💎 [${session.twitchUser?.display_name}] ${bits} Bits -> ${amount} sentadillas`

            );

            if (amount > 0) {

                await addSquats(session, amount, "Twitch Bits");

            }

        }

    }

    async function createEventSubSubscriptions(session, sessionId) {

        if (!session.twitchAccessToken || !session.twitchUser) return;

        const subscriptions = [

            {

                type: "channel.channel_points_custom_reward_redemption.add",

                version: "1",

                condition: {

                    broadcaster_user_id: session.twitchUser.id

                }

            },

            {

                type: "channel.cheer",

                version: "1",

                condition: {

                    broadcaster_user_id: session.twitchUser.id

                }

            }

        ];

        for (const subscription of subscriptions) {

            try {

                const response = await fetch(

                    "https://api.twitch.tv/helix/eventsub/subscriptions",

                    {

                        method: "POST",

                        headers: {

                            "Client-Id": session.twitchClientId,

                            Authorization: `Bearer ${session.twitchAccessToken}`,

                            "Content-Type": "application/json"

                        },

                        body: JSON.stringify({

                            ...subscription,

                            transport: {

                                method: "websocket",

                                session_id: sessionId

                            }

                        })

                    }

                );

                const data = await response.json();

                if (response.ok) {

                    console.log(

                        `✅ [${session.twitchUser.display_name}] EventSub: ${subscription.type}`

                    );

                } else {

                    console.error(

                        `❌ [${session.twitchUser.display_name}] EventSub ${subscription.type}:`,

                        JSON.stringify(data)

                    );

                }

            } catch (error) {

                console.error("❌ Error creando EventSub:", error);

            }

        }

    }

    // ============================================================

    // REFRESH DE TOKENS POR SESIÓN

    // ============================================================

    async function refreshTwitchToken(session) {

        if (!session.twitchRefreshToken) return false;

        try {

            const response = await fetch(

                "https://id.twitch.tv/oauth2/token",

                {

                    method: "POST",

                    headers: {

                        "Content-Type": "application/x-www-form-urlencoded"

                    },

                    body: new URLSearchParams({

                        grant_type: "refresh_token",

                        refresh_token: session.twitchRefreshToken,

                        client_id: session.twitchClientId,

                        client_secret: session.twitchClientSecret

                    })

                }

            );

            const data = await response.json();

            if (!response.ok) {

                console.error(

                    `❌ [${session.id.slice(0, 8)}] No se pudo renovar token:`,

                    data

                );

                return false;

            }

            session.twitchAccessToken = data.access_token;

            if (data.refresh_token) {

                session.twitchRefreshToken = data.refresh_token;

            }

            await saveTwitchTokens(session);

            console.log(

                `✅ [${session.twitchUser?.display_name || session.id.slice(0, 8)}] Token renovado.`

            );

            return true;

        } catch (error) {

            console.error("❌ Error renovando token:", error);

            return false;

        }

    }

    setInterval(async () => {

        for (const session of sessions.values()) {

            if (!session.twitchAccessToken || !session.twitchRefreshToken) continue;

            const success = await refreshTwitchToken(session);

            if (success) {

                if (session.eventSubSocket) {

                    try {

                        session.eventSubSocket.close();

                    } catch {}

                }

                setTimeout(() => {

                    if (session.twitchAccessToken && session.twitchUser) {

                        startEventSub(session).catch(() => {});

                    }

                }, 1000);

            }

        }

    }, 50 * 60 * 1000);

    // ============================================================

    // LOGOUT - SOLO LA SESIÓN ACTUAL

    // ============================================================

    app.post("/auth/twitch/logout", async (req, res) => {

        const session = getSession(req, res);
        await session.dbReady;

        // "Cerrar sesión" ya no elimina la identidad permanente.
        // Conservamos tokens y twitch_user_id para que el streamer pueda
        // volver a entrar y ser reconocido inmediatamente.
        if (session.eventSubSocket) {
            try { session.eventSubSocket.close(); } catch {}
        }

        session.eventSubSocket = null;
        session.eventSubConnecting = false;

        res.json({
            ok: true,
            persistent: true,
            user: session.twitchUser || null
        });
    });

    // Desvinculación real: revoca el token y elimina la asociación de Twitch.
    app.post("/auth/twitch/disconnect", async (req, res) => {
        const session = getSession(req, res);
        await session.dbReady;

        try {
            if (session.twitchAccessToken && session.twitchClientId) {
                await fetch(
                    "https://id.twitch.tv/oauth2/revoke" +
                    `?client_id=${encodeURIComponent(session.twitchClientId)}` +
                    `&token=${encodeURIComponent(session.twitchAccessToken)}`,
                    { method: "POST" }
                );
            }
        } catch (error) {
            console.warn("⚠️ Twitch no pudo revocar el token:", error.message);
        }

        if (session.eventSubSocket) {
            try { session.eventSubSocket.close(); } catch {}
        }

        session.twitchAccessToken = null;
        session.twitchRefreshToken = null;
        session.twitchUser = null;
        session.oauthState = null;
        session.oauthReturnUrl = null;
        session.eventSubSocket = null;
        session.eventSubConnecting = false;

        await clearOAuthState(session.id);
        await clearTwitchTokens(session.id);

        res.json({ ok: true, persistent: false });
    });

    // ============================================================

    // WEBSOCKET DEL CONTADOR

    // ============================================================

    const browserWS = new WebSocket.Server({ noServer: true });

    server.on("upgrade", (request, socket, head) => {

        const url = new URL(request.url, "http://localhost");

        if (url.pathname !== "/ws") {

            socket.destroy();

            return;

        }

        const session = getSessionFromUpgrade(request);

        // Para OBS se exige ?session=... o una cookie válida.

        if (!session) {

            socket.destroy();

            return;

        }

        browserWS.handleUpgrade(request, socket, head, ws => {

            browserWS.emit("connection", ws, request, session);

        });

    });

    browserWS.on("connection", async (socket, request, session) => {

        try {

            await session.dbReady;

        } catch (error) {

            socket.close();

            return;

        }

        console.log(

            `🖥️ Cliente conectado a sesión ${session.id.slice(0, 8)}`

        );

        session.browserClients.add(socket);

        sendCounterToSocket(socket, session);

        socket.on("close", () => {

            session.browserClients.delete(socket);

        });

        socket.on("error", () => {

            session.browserClients.delete(socket);

        });

    });

    // ============================================================

    // LIMPIEZA DE SESIONES ABANDONADAS

    // Las sesiones activas de Twitch o con WebSocket se conservan.

    // ============================================================

    const SESSION_MAX_IDLE_MS = 24 * 60 * 60 * 1000;

    setInterval(() => {

        const now = Date.now();

        for (const [id, session] of sessions.entries()) {

            const hasLiveConnection =

                Boolean(session.twitchAccessToken) ||

                Boolean(session.eventSubSocket) ||

                session.browserClients.size > 0;

            if (!hasLiveConnection && now - session.lastActivity > SESSION_MAX_IDLE_MS) {

                sessions.delete(id);

                console.log(`🧹 Sesión inactiva eliminada: ${id.slice(0, 8)}`);

            }

        }

    }, 60 * 60 * 1000);

    // ============================================================

    // HTML ESCAPE

    // ============================================================

    function escapeHtml(value) {

        return String(value)

            .replaceAll("&", "&amp;")

            .replaceAll("<", "&lt;")

            .replaceAll(">", "&gt;")

            .replaceAll('"', "&quot;")

            .replaceAll("'", "&#039;");

    }

    // ============================================================

    // INICIO

    // ============================================================

    async function startServer() {

        try {

            await testDatabaseConnection();

            server.listen(PORT, HOST, () => {

                console.log("");

                console.log("==============================================");

                console.log("🏋️ SQUAT TWITCH - MULTIUSUARIO");

                console.log("==============================================");

                const publicUrl = String(

                    process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`

                ).replace(/\/$/, "");

                console.log(`🌐 Aplicación: ${publicUrl}`);

                console.log(`🧪 Prueba:     ${publicUrl}/prueba`);

                console.log(`📺 Sesión:     ${publicUrl}/api/session`);

                console.log(`🔐 Twitch:     ${getRedirectUri()}`);

                console.log("----------------------------------------------");

                console.log(

                    "🔐 Credenciales Twitch: se introducen desde la configuración de cada sesión."

                );

                console.log(`🔁 Redirect URI fija: ${TWITCH_REDIRECT_URI}`);

                console.log("🟢 Servidor listo.");

                console.log("==============================================");

                console.log("");

            });

        } catch (error) {

            console.error("❌ No se pudo conectar a PostgreSQL.");

            console.error(error);

            process.exit(1);

        }

    }

    startServer();





    function shutdownServer() {

        console.log("🛑 Cerrando Squat Twitch...");

        for (const session of sessions.values()) {

            if (session.eventSubSocket) {

                try {

                    session.eventSubSocket.close();

                } catch {}

            }

            for (const socket of session.browserClients) {

                try {

                    socket.close();

                } catch {}

            }

        }

        server.close(() => {

            console.log("✅ Servidor cerrado correctamente.");

            process.exit(0);

        });

    }

    process.on("SIGINT", shutdownServer);

    process.on("SIGTERM", shutdownServer);
