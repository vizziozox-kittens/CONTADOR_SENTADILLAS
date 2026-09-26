
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const WebSocket = require("ws");
require("dotenv").config();

// ============================================================
// SQUAT TWITCH - SERVIDOR MULTIUSUARIO
// Cada navegador/streamer tiene su propia sesión.
// ============================================================

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";

const CLIENT_ID = String(process.env.TWITCH_CLIENT_ID || "").trim();
const CLIENT_SECRET = String(process.env.TWITCH_CLIENT_SECRET || "").trim();

function getRedirectUri() {
    if (process.env.TWITCH_REDIRECT_URI) {
        return process.env.TWITCH_REDIRECT_URI.trim();
    }

    const publicUrl = String(process.env.PUBLIC_URL || "")
        .trim()
        .replace(/\/$/, "");

    if (publicUrl) {
        return `${publicUrl}/auth/twitch/callback`;
    }

    return `http://localhost:${PORT}/auth/twitch/callback`;
}

// ============================================================
// SESIONES
// ============================================================

const sessions = new Map();
const SESSION_COOKIE = "squat_session";

function createSession() {
    const id = crypto.randomBytes(32).toString("hex");

    const session = {
        id,

        // Twitch de ESTA sesión
        twitchAccessToken: null,
        twitchRefreshToken: null,
        twitchUser: null,
        oauthState: null,

        // EventSub de ESTA sesión
        eventSubSocket: null,
        eventSubConnecting: false,
        eventSubReconnectTimer: null,

        // Evitar eventos duplicados por sesión
        processedEventIds: new Set(),

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
    console.log(`🆕 Nueva sesión creada: ${id}`);
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
    // Permite usar ?session=... para OBS.
    const querySession = req.query?.session;

    if (isValidSessionId(querySession) && sessions.has(querySession)) {
        setSessionCookie(res, querySession);
        return sessions.get(querySession);
    }

    const cookieSession = getSessionIdFromCookie(req);

    if (cookieSession && sessions.has(cookieSession)) {
        return sessions.get(cookieSession);
    }

    if (!create) return null;

    const session = createSession();
    setSessionCookie(res, session.id);
    return session;
}

function getSessionFromUpgrade(request) {
    const url = new URL(request.url, "http://localhost");
    const querySession = url.searchParams.get("session");

    if (isValidSessionId(querySession) && sessions.has(querySession)) {
        return sessions.get(querySession);
    }

    const cookieSession = getSessionIdFromCookie(request);

    if (cookieSession && sessions.has(cookieSession)) {
        return sessions.get(cookieSession);
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

function setSquatCounter(session, value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return false;

    session.squatCounter = Math.max(0, Math.floor(number));
    broadcastCounter(session);
    return true;
}

function changeSquatCounter(session, amount, source = "manual") {
    const number = Number(amount);
    if (!Number.isFinite(number) || number === 0) return false;

    session.squatCounter = Math.max(
        0,
        session.squatCounter + Math.floor(number)
    );

    broadcastCounter(session);

    console.log(
        `🔢 [${session.twitchUser?.display_name || session.id.slice(0, 8)}] ${number > 0 ? "+" : ""}${number} | ${source} | total: ${session.squatCounter}`
    );

    return true;
}

function addSquats(session, amount, source = "Twitch") {
    const number = Number(amount);
    if (!Number.isFinite(number) || number <= 0) return false;

    session.squatCounter += Math.floor(number);
    broadcastCounter(session);

    console.log(
        `➕ [${session.twitchUser?.display_name || session.id.slice(0, 8)}] +${Math.floor(number)} | ${source} | total: ${session.squatCounter}`
    );

    return true;
}

app.get("/api/squats", (req, res) => {
    const session = getSession(req, res);
    res.json({ ok: true, ...getCounterData(session) });
});

app.post("/api/squats/change", (req, res) => {
    const session = getSession(req, res);
    const amount = Number(req.body?.amount);

    if (!Number.isFinite(amount) || amount === 0) {
        return res.status(400).json({ ok: false, error: "Cantidad inválida" });
    }

    changeSquatCounter(session, amount, "sentadilla detectada");
    res.json({ ok: true, ...getCounterData(session) });
});

app.post("/api/squats/add", (req, res) => {
    const session = getSession(req, res);
    const amount = Number(req.body?.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ ok: false, error: "Cantidad inválida" });
    }

    addSquats(session, amount, "manual");
    res.json({ ok: true, ...getCounterData(session) });
});

app.post("/api/squats/set", (req, res) => {
    const session = getSession(req, res);
    const value = Number(req.body?.value);

    if (!Number.isFinite(value)) {
        return res.status(400).json({ ok: false, error: "Valor inválido" });
    }

    setSquatCounter(session, value);
    res.json({ ok: true, ...getCounterData(session) });
});

app.post("/api/squats/reset", (req, res) => {
    const session = getSession(req, res);
    setSquatCounter(session, 0);
    console.log(`🔄 [${session.id.slice(0, 8)}] Contador reiniciado`);
    res.json({ ok: true, ...getCounterData(session) });
});

// ============================================================
// TWITCH CONFIGURACIÓN
// ============================================================

app.get("/api/twitch/config", (req, res) => {
    const session = getSession(req, res);

    res.json({
        ok: true,
        clientId: CLIENT_ID,
        credentialsConfigured: Boolean(CLIENT_ID && CLIENT_SECRET),
        credentialsSource: "environment",
        bitsPerBlock: session.bitsPerBlock,
        squatsPerBlock: session.squatsPerBlock
    });
});

app.post("/api/twitch/bits-config", (req, res) => {
    const session = getSession(req, res);

    const bitsPerBlock = Math.max(
        1,
        Math.floor(Number(req.body?.bitsPerBlock) || 0)
    );

    const squatsPerBlock = Math.max(
        1,
        Math.floor(Number(req.body?.squatsPerBlock) || 0)
    );

    session.bitsPerBlock = bitsPerBlock;
    session.squatsPerBlock = squatsPerBlock;

    res.json({ ok: true, bitsPerBlock, squatsPerBlock });
});

// ============================================================
// ESTADO TWITCH
// ============================================================

app.get("/api/status", (req, res) => {
    const session = getSession(req, res);

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
            "Client-Id": CLIENT_ID,
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

app.post("/api/twitch/reward-mappings", (req, res) => {
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

    session.rewardMappings = newMappings;

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

function createTwitchAuthorizationUrl(session) {
    if (!CLIENT_ID) {
        throw new Error(
            "Falta TWITCH_CLIENT_ID en las variables de entorno de Render."
        );
    }

    if (!CLIENT_SECRET) {
        throw new Error(
            "Falta TWITCH_CLIENT_SECRET en las variables de entorno de Render."
        );
    }

    session.oauthState = crypto.randomBytes(32).toString("hex");

    const scopes = [
        "channel:read:redemptions",
        "bits:read"
    ];

    const twitchURL = new URL(
        "https://id.twitch.tv/oauth2/authorize"
    );

    twitchURL.searchParams.set("client_id", CLIENT_ID);
    twitchURL.searchParams.set("redirect_uri", getRedirectUri());
    twitchURL.searchParams.set("response_type", "code");
    twitchURL.searchParams.set("scope", scopes.join(" "));
    twitchURL.searchParams.set("state", session.oauthState);

    return twitchURL.toString();
}

app.get("/api/twitch/login-url", (req, res) => {
    const session = getSession(req, res);

    try {
        res.json({
            ok: true,
            url: createTwitchAuthorizationUrl(session)
        });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});

app.get("/auth/twitch", (req, res) => {
    const session = getSession(req, res);

    try {
        const url = createTwitchAuthorizationUrl(session);
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
    const session = getSession(req, res);

    const {
        code,
        state,
        error,
        error_description
    } = req.query;

    if (error) {
        return res.status(400).send(connectionPage(
            false,
            "Conexión cancelada",
            `${error}: ${error_description || ""}`
        ));
    }

    if (!state || state !== session.oauthState) {
        return res.status(400).send(connectionPage(
            false,
            "Error de seguridad",
            "El estado de autorización no coincide con esta sesión."
        ));
    }

    session.oauthState = null;

    if (!code) {
        return res.status(400).send(connectionPage(
            false,
            "No se recibió código",
            "Twitch no devolvió el código de autorización."
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
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
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
                    "Client-Id": CLIENT_ID
                }
            }
        );

        const userData = await userResponse.json();

        if (!userResponse.ok || !userData.data?.length) {
            throw new Error("No se pudo obtener el usuario de Twitch.");
        }

        session.twitchUser = userData.data[0];

        console.log("==============================================");
        console.log("✅ TWITCH CONECTADO");
        console.log("Sesión:", session.id.slice(0, 8));
        console.log("Usuario:", session.twitchUser.display_name);
        console.log("==============================================");

        await startEventSub(session);

        return res.send(connectionPage(
            true,
            "¡Twitch conectado!",
            session.twitchUser.display_name
        ));

    } catch (error) {
        console.error("❌ ERROR EN CALLBACK:", error);

        session.twitchAccessToken = null;
        session.twitchRefreshToken = null;
        session.twitchUser = null;

        return res.status(500).send(connectionPage(
            false,
            "Error conectando Twitch",
            error.message
        ));
    }
});

function connectionPage(success, title, message) {
    const color = success ? "#9147ff" : "#a91f1f";
    const icon = success ? "✅" : "❌";

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
<button onclick="window.close();setTimeout(()=>{location.href='/'},300)">Cerrar ventana</button>
</div>
</body>
</html>`;
}

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
    if (session.processedEventIds.has(messageId)) return;

    session.processedEventIds.add(messageId);

    if (session.processedEventIds.size > 1000) {
        const first = session.processedEventIds.values().next().value;
        session.processedEventIds.delete(first);
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
            addSquats(session, amount, `Twitch: ${rewardTitle}`);
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
            addSquats(session, amount, "Twitch Bits");
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
                        "Client-Id": CLIENT_ID,
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
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET
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

    try {
        if (session.twitchAccessToken) {
            await fetch(
                "https://id.twitch.tv/oauth2/revoke" +
                `?client_id=${encodeURIComponent(CLIENT_ID)}` +
                `&token=${encodeURIComponent(session.twitchAccessToken)}`,
                { method: "POST" }
            );
        }
    } catch {}

    if (session.eventSubSocket) {
        try {
            session.eventSubSocket.close();
        } catch {}
    }

    session.twitchAccessToken = null;
    session.twitchRefreshToken = null;
    session.twitchUser = null;
    session.oauthState = null;
    session.eventSubSocket = null;
    session.eventSubConnecting = false;

    res.json({ ok: true });
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

browserWS.on("connection", (socket, request, session) => {
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
// LIMPIEZA DE SESIONES SIN ACTIVIDAD
// No elimina sesiones que tengan Twitch conectado o clientes WS.
// ============================================================

setInterval(() => {
    // En esta versión no eliminamos automáticamente sesiones.
    // Así no se pierde la sesión de un streamer mientras trabaja.
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

    if (!CLIENT_ID || !CLIENT_SECRET) {
        console.warn("⚠️ Faltan TWITCH_CLIENT_ID y/o TWITCH_CLIENT_SECRET en Render.");
    } else {
        console.log("🟢 Credenciales Twitch encontradas en variables de entorno.");
    }

    console.log("🟢 Servidor listo.");
    console.log("==============================================");
    console.log("");
});

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
