const express = require("express");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const WebSocket = require("ws");


// ============================================================
// CONFIGURACIÓN GENERAL
// ============================================================

const app = express();

const PORT =
    Number(process.env.PORT || 3000);

const HOST =
    "0.0.0.0";


// ============================================================
// ARCHIVOS DE CONFIGURACIÓN
// ============================================================

const STATE_FILE =
    path.join(
        __dirname,
        "squat-state.json"
    );


const CONFIG_FILE =
    path.join(
        __dirname,
        "twitch-config.json"
    );


// ============================================================
// CONFIGURACIÓN TWITCH
// ============================================================

let twitchConfig = {

    clientId: "",

    clientSecret: "",

    bitsPerBlock: 100,

    squatsPerBlock: 10,

    rewardMappings: {}

};


// ============================================================
// CARGAR CONFIGURACIÓN
// ============================================================

function loadTwitchConfig() {

    try {

        if (
            !fs.existsSync(
                CONFIG_FILE
            )
        ) {

            saveTwitchConfig();

            return;
        }


        const data =
            JSON.parse(
                fs.readFileSync(
                    CONFIG_FILE,
                    "utf8"
                )
            );


        twitchConfig = {

            clientId:
                String(
                    data.clientId || ""
                ),

            clientSecret:
                String(
                    data.clientSecret || ""
                ),

            bitsPerBlock:
                Math.max(
                    1,
                    Math.floor(
                        Number(
                            data.bitsPerBlock
                        ) || 100
                    )
                ),

            squatsPerBlock:
                Math.max(
                    1,
                    Math.floor(
                        Number(
                            data.squatsPerBlock
                        ) || 10
                    )
                ),

            rewardMappings:
                data.rewardMappings &&
                typeof data.rewardMappings === "object"
                    ? data.rewardMappings
                    : {}

        };


        console.log(
            "⚙️ Configuración Twitch cargada."
        );


    } catch (error) {

        console.error(
            "❌ Error cargando twitch-config.json:",
            error
        );

    }

}


// ============================================================
// GUARDAR CONFIGURACIÓN
// ============================================================

function saveTwitchConfig() {

    try {

        fs.writeFileSync(

            CONFIG_FILE,

            JSON.stringify(
                twitchConfig,
                null,
                2
            ),

            "utf8"

        );

    } catch (error) {

        console.error(
            "❌ Error guardando configuración Twitch:",
            error
        );

    }

}


// ============================================================
// CLIENT ID / SECRET
// ============================================================

function getClientId() {

    return String(
        process.env.TWITCH_CLIENT_ID ||
        twitchConfig.clientId ||
        ""
    ).trim();

}


function getClientSecret() {

    return String(
        process.env.TWITCH_CLIENT_SECRET ||
        twitchConfig.clientSecret ||
        ""
    ).trim();

}


// ============================================================
// REDIRECT URI
// ============================================================

function getRedirectUri() {

    if (process.env.TWITCH_REDIRECT_URI) {
        return process.env.TWITCH_REDIRECT_URI.trim();
    }

    const publicUrl = String(
        process.env.PUBLIC_URL ||
        ""
    ).trim().replace(/\/$/, "");

    if (publicUrl) {
        return `${publicUrl}/auth/twitch/callback`;
    }

    return `http://localhost:${PORT}/auth/twitch/callback`;
}


// ============================================================
// SERVIDOR HTTP
// ============================================================

const server =
    http.createServer(app);


// ============================================================
// WEBSOCKET
// ============================================================

const browserWS =
    new WebSocket.Server({

        server,

        path: "/ws"

    });


const browserClients =
    new Set();


browserWS.on(
    "connection",
    socket => {

        console.log(
            "🖥️ Cliente WebSocket conectado"
        );


        browserClients.add(
            socket
        );


        sendCounterToSocket(
            socket
        );


        socket.on(
            "close",
            () => {

                browserClients.delete(
                    socket
                );

            }
        );


        socket.on(
            "error",
            () => {

                browserClients.delete(
                    socket
                );

            }
        );

    }
);


// ============================================================
// TWITCH
// ============================================================

let twitchAccessToken = null;

let twitchRefreshToken = null;

let twitchUser = null;

let oauthState = null;

let eventSubSocket = null;

let eventSubReconnectUrl = null;

let eventSubConnecting = false;


// Evita duplicados
const processedEventIds =
    new Set();


// ============================================================
// CONTADOR
// ============================================================

let squatCounter = 0;


// ============================================================
// CARGAR CONTADOR
// ============================================================

function loadSquatState() {

    try {

        if (
            !fs.existsSync(
                STATE_FILE
            )
        ) {

            squatCounter = 0;

            saveSquatState();

            return;
        }


        const data =
            JSON.parse(
                fs.readFileSync(
                    STATE_FILE,
                    "utf8"
                )
            );


        squatCounter =
            Math.max(
                0,
                Math.floor(
                    Number(
                        data.pendingSquats
                    ) || 0
                )
            );


        console.log(
            `📊 Contador cargado: ${squatCounter}`
        );


    } catch (error) {

        console.error(
            "❌ Error cargando contador:",
            error
        );

        squatCounter = 0;

    }

}


// ============================================================
// GUARDAR CONTADOR
// ============================================================

function saveSquatState() {

    try {

        fs.writeFileSync(

            STATE_FILE,

            JSON.stringify(
                {
                    pendingSquats:
                        squatCounter
                },
                null,
                2
            ),

            "utf8"

        );

    } catch (error) {

        console.error(
            "❌ Error guardando contador:",
            error
        );

    }

}


// ============================================================
// ESTABLECER CONTADOR
// ============================================================

function setSquatCounter(value) {

    const number =
        Number(value);


    if (
        !Number.isFinite(number)
    ) {

        return;

    }


    squatCounter =
        Math.max(
            0,
            Math.floor(number)
        );


    saveSquatState();

    broadcastCounter();

}


// ============================================================
// CAMBIAR CONTADOR
// ============================================================

function changeSquatCounter(
    amount,
    source = "manual"
) {

    const number =
        Number(amount);


    if (
        !Number.isFinite(number)
    ) {

        return false;

    }


    squatCounter =
        Math.max(
            0,
            squatCounter +
                Math.floor(number)
        );


    saveSquatState();

    broadcastCounter();


    console.log(
        `🔢 Cambio ${number > 0 ? "+" : ""}${number} | origen: ${source} | total: ${squatCounter}`
    );


    return true;

}


// ============================================================
// SUMAR SENTADILLAS
// ============================================================

function addSquats(
    amount,
    source = "Twitch"
) {

    const number =
        Number(amount);


    if (
        !Number.isFinite(number) ||
        number <= 0
    ) {

        return false;

    }


    squatCounter +=
        Math.floor(number);


    saveSquatState();

    broadcastCounter();


    console.log(
        `➕ +${Math.floor(number)} sentadillas | origen: ${source} | total: ${squatCounter}`
    );


    return true;

}


// ============================================================
// ESTADO CONTADOR
// ============================================================

function getCounterData() {

    return {

        pendingSquats:
            squatCounter

    };

}


// ============================================================
// ENVIAR A UN CLIENTE
// ============================================================

function sendCounterToSocket(
    socket
) {

    if (
        !socket ||
        socket.readyState !==
            WebSocket.OPEN
    ) {

        return;

    }


    socket.send(

        JSON.stringify({

            type:
                "counter:update",

            data:
                getCounterData()

        })

    );

}


// ============================================================
// ENVIAR A TODOS
// ============================================================

function broadcastCounter() {

    const message =
        JSON.stringify({

            type:
                "counter:update",

            data:
                getCounterData()

        });


    for (
        const socket
        of browserClients
    ) {

        if (
            socket.readyState ===
            WebSocket.OPEN
        ) {

            try {

                socket.send(
                    message
                );

            } catch {

                browserClients.delete(
                    socket
                );

            }

        }

    }

}


// ============================================================
// EXPRESS
// ============================================================

app.use(
    express.json()
);


// ============================================================
// CORS
// ============================================================

app.use(
    (req, res, next) => {

        res.setHeader(
            "Access-Control-Allow-Origin",
            "*"
        );

        res.setHeader(
            "Access-Control-Allow-Methods",
            "GET,POST,OPTIONS"
        );

        res.setHeader(
            "Access-Control-Allow-Headers",
            "Content-Type"
        );


        if (
            req.method ===
            "OPTIONS"
        ) {

            return res.sendStatus(
                204
            );

        }


        next();

    }
);


// ============================================================
// ARCHIVOS DEL PROYECTO
// ============================================================

// Archivos originales del proyecto
app.use(
    express.static(
        __dirname
    )
);

// Archivos nuevos para OBS
app.use(
    express.static(
        path.join(__dirname, "public")
    )
);

// ============================================================
// PÁGINA PRINCIPAL
// ============================================================

app.get(
    "/",
    (req, res) => {

        res.sendFile(
            path.join(
                __dirname,
                "index.html"
            )
        );

    }
);


// ============================================================
// PRUEBA
// ============================================================

app.get(
    "/prueba",
    (req, res) => {

        res.type(
            "text"
        ).send(
            "OK - Servidor Squat Twitch funcionando en el puerto " +
            PORT
        );

    }
);


// ============================================================
// API CONTADOR
// ============================================================

app.get(
    "/api/squats",
    (req, res) => {

        res.json({

            ok: true,

            ...getCounterData()

        });

    }
);


// ============================================================
// CAMBIAR CONTADOR
// ============================================================

app.post(
    "/api/squats/change",
    (req, res) => {

        const amount =
            Number(
                req.body?.amount
            );


        if (
            !Number.isFinite(amount) ||
            amount === 0
        ) {

            return res.status(
                400
            ).json({

                ok: false,

                error:
                    "Cantidad inválida"

            });

        }


        changeSquatCounter(
            amount,
            "sentadilla detectada"
        );


        res.json({

            ok: true,

            ...getCounterData()

        });

    }
);


// ============================================================
// SUMAR MANUALMENTE
// ============================================================

app.post(
    "/api/squats/add",
    (req, res) => {

        const amount =
            Number(
                req.body?.amount
            );


        if (
            !Number.isFinite(amount) ||
            amount <= 0
        ) {

            return res.status(
                400
            ).json({

                ok: false,

                error:
                    "Cantidad inválida"

            });

        }


        addSquats(
            amount,
            "manual"
        );


        res.json({

            ok: true,

            ...getCounterData()

        });

    }
);


// ============================================================
// ESTABLECER CONTADOR
// ============================================================

app.post(
    "/api/squats/set",
    (req, res) => {

        const value =
            Number(
                req.body?.value
            );


        if (
            !Number.isFinite(value)
        ) {

            return res.status(
                400
            ).json({

                ok: false,

                error:
                    "Valor inválido"

            });

        }


        setSquatCounter(
            value
        );


        res.json({

            ok: true,

            ...getCounterData()

        });

    }
);


// ============================================================
// REINICIAR
// ============================================================

app.post(
    "/api/squats/reset",
    (req, res) => {

        setSquatCounter(0);


        console.log(
            "🔄 Contador reiniciado"
        );


        res.json({

            ok: true,

            ...getCounterData()

        });

    }
);


// ============================================================
// CONFIGURACIÓN TWITCH DESDE LA APP
// ============================================================

app.get(
    "/api/twitch/config",
    (req, res) => {

        res.json({

            ok: true,

            clientId:
                getClientId(),

            credentialsConfigured:
                Boolean(getClientId() && getClientSecret()),

            credentialsSource:
                process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET
                    ? "environment"
                    : "file",

            bitsPerBlock:
                twitchConfig.bitsPerBlock,

            squatsPerBlock:
                twitchConfig.squatsPerBlock

        });

    }
);


// La credencial secreta nunca se envía al navegador ni se guarda desde la UI.
// En producción debe configurarse con TWITCH_CLIENT_SECRET.

// ============================================================
// CONFIGURACIÓN BITS
// ============================================================

app.post(
    "/api/twitch/bits-config",
    (req, res) => {

        const bitsPerBlock =
            Math.max(
                1,
                Math.floor(
                    Number(
                        req.body?.bitsPerBlock
                    ) || 0
                )
            );


        const squatsPerBlock =
            Math.max(
                1,
                Math.floor(
                    Number(
                        req.body?.squatsPerBlock
                    ) || 0
                )
            );


        twitchConfig.bitsPerBlock =
            bitsPerBlock;


        twitchConfig.squatsPerBlock =
            squatsPerBlock;


        saveTwitchConfig();


        res.json({

            ok: true,

            bitsPerBlock,

            squatsPerBlock

        });

    }
);


// ============================================================
// ESTADO GENERAL
// ============================================================

app.get(
    "/api/status",
    (req, res) => {

        res.json({

            ok: true,

            twitch: {

                connected:
                    Boolean(
                        twitchAccessToken
                    ),

                eventSub:
                    Boolean(
                        eventSubSocket
                    ),

                user:
                    twitchUser
                        ? {

                            id:
                                twitchUser.id,

                            login:
                                twitchUser.login,

                            display_name:
                                twitchUser.display_name

                        }
                        : null

            },

            squats: {

                pending:
                    squatCounter

            }

        });

    }
);


// ============================================================
// OBTENER RECOMPENSAS DEL CANAL
// ============================================================

async function getTwitchRewards() {

    if (
        !twitchAccessToken ||
        !twitchUser
    ) {

        throw new Error(
            "Twitch no está conectado."
        );

    }


    const clientId =
        getClientId();


    const url =
        new URL(
            "https://api.twitch.tv/helix/channel_points/custom_rewards"
        );


    url.searchParams.set(
        "broadcaster_id",
        twitchUser.id
    );


    const response =
        await fetch(
            url,
            {

                headers: {

                    "Client-Id":
                        clientId,

                    Authorization:
                        `Bearer ${twitchAccessToken}`

                }

            }
        );


    const data =
        await response.json();


    if (!response.ok) {

        throw new Error(
            data.message ||
            "Twitch no permitió obtener las recompensas."
        );

    }


    return data.data || [];

}


// ============================================================
// API RECOMPENSAS
// ============================================================

app.get(
    "/api/twitch/rewards",
    async (req, res) => {

        try {

            const rewards =
                await getTwitchRewards();


            res.json({

                ok: true,

                rewards:

                    rewards.map(
                        reward => ({

                            id:
                                reward.id,

                            title:
                                reward.title,

                            cost:
                                reward.cost,

                            is_enabled:
                                reward.is_enabled,

                            is_paused:
                                reward.is_paused

                        })
                    ),

                mappings:
                    twitchConfig.rewardMappings

            });


        } catch (error) {

            console.error(
                "❌ Error obteniendo recompensas:",
                error
            );


            res.status(
                500
            ).json({

                ok: false,

                error:
                    error.message

            });

        }

    }
);


// ============================================================
// GUARDAR VALORES DE RECOMPENSAS
// ============================================================

app.post(
    "/api/twitch/reward-mappings",
    (req, res) => {

        const mappings =
            req.body?.mappings;


        if (
            !Array.isArray(mappings)
        ) {

            return res.status(
                400
            ).json({

                ok: false,

                error:
                    "Formato inválido."

            });

        }


        const newMappings = {};


        for (
            const mapping
            of mappings
        ) {

            const rewardId =
                String(
                    mapping.rewardId ||
                    ""
                ).trim();


            const squats =
                Math.max(
                    0,
                    Math.floor(
                        Number(
                            mapping.squats
                        ) || 0
                    )
                );


            if (
                rewardId
            ) {

                newMappings[
                    rewardId
                ] =
                    squats;

            }

        }


        twitchConfig.rewardMappings =
            newMappings;


        saveTwitchConfig();


        console.log(
            "🎁 Mapeos de recompensas actualizados."
        );


        res.json({

            ok: true,

            mappings:
                twitchConfig.rewardMappings

        });

    }
);


// ============================================================
// CREAR URL DE AUTORIZACIÓN
// ============================================================

function createTwitchAuthorizationUrl() {

    const clientId =
        getClientId();


    const clientSecret =
        getClientSecret();


    if (!clientId) {

        throw new Error(
            "Falta TWITCH_CLIENT_ID en las variables de entorno del servidor."
        );

    }


    if (!clientSecret) {

        throw new Error(
            "Falta TWITCH_CLIENT_SECRET en las variables de entorno del servidor."
        );

    }


    oauthState =
        crypto
            .randomBytes(32)
            .toString("hex");


    const scopes = [

        "channel:read:redemptions",

        "bits:read"

    ];


    const twitchURL =
        new URL(
            "https://id.twitch.tv/oauth2/authorize"
        );


    twitchURL.searchParams.set(
        "client_id",
        clientId
    );


    twitchURL.searchParams.set(
        "redirect_uri",
        getRedirectUri()
    );


    twitchURL.searchParams.set(
        "response_type",
        "code"
    );


    twitchURL.searchParams.set(
        "scope",
        scopes.join(" ")
    );


    twitchURL.searchParams.set(
        "state",
        oauthState
    );


    return twitchURL.toString();

}


// ============================================================
// LOGIN URL
// ============================================================

app.get(
    "/api/twitch/login-url",
    (req, res) => {

        try {

            res.json({

                ok: true,

                url:
                    createTwitchAuthorizationUrl()

            });

        } catch (error) {

            res.status(
                500
            ).json({

                ok: false,

                error:
                    error.message

            });

        }

    }
);


// ============================================================
// INICIAR TWITCH
// ============================================================

app.get(
    "/auth/twitch",
    (req, res) => {

        try {

            const url =
                createTwitchAuthorizationUrl();


            console.log(
                "🔵 Iniciando conexión con Twitch..."
            );


            res.redirect(
                url
            );


        } catch (error) {

            res.status(
                500
            ).send(`

                <h1>Error de configuración</h1>

                <p>
                    ${escapeHtml(
                        error.message
                    )}
                </p>

            `);

        }

    }
);


// ============================================================
// CALLBACK TWITCH
// ============================================================

app.get(
    "/auth/twitch/callback",
    async (req, res) => {

        const {
            code,
            state,
            error,
            error_description
        } = req.query;


        if (error) {

            return res.status(
                400
            ).send(`

                <h1>❌ Conexión cancelada</h1>

                <p>
                    ${escapeHtml(error)}
                </p>

                <p>
                    ${escapeHtml(
                        error_description || ""
                    )}
                </p>

                <button
                    onclick="window.close()"
                >
                    Cerrar
                </button>

            `);

        }


        if (
            !state ||
            state !== oauthState
        ) {

            return res.status(
                400
            ).send(`

                <h1>❌ Error de seguridad</h1>

                <p>
                    El estado de autorización no coincide.
                </p>

                <button
                    onclick="window.close()"
                >
                    Cerrar
                </button>

            `);

        }


        oauthState = null;


        if (!code) {

            return res.status(
                400
            ).send(`

                <h1>❌ No se recibió código</h1>

                <button
                    onclick="window.close()"
                >
                    Cerrar
                </button>

            `);

        }


        try {

            const clientId =
                getClientId();


            const clientSecret =
                getClientSecret();


            // =================================================
            // TOKEN
            // =================================================

            const tokenResponse =
                await fetch(
                    "https://id.twitch.tv/oauth2/token",
                    {

                        method:
                            "POST",

                        headers: {

                            "Content-Type":
                                "application/x-www-form-urlencoded"

                        },

                        body:
                            new URLSearchParams({

                                client_id:
                                    clientId,

                                client_secret:
                                    clientSecret,

                                code:
                                    code,

                                grant_type:
                                    "authorization_code",

                                redirect_uri:
                                    getRedirectUri()

                            })

                    }
                );


            const tokenData =
                await tokenResponse.json();


            if (
                !tokenResponse.ok
            ) {

                throw new Error(
                    tokenData.message ||
                    "Error obteniendo token."
                );

            }


            twitchAccessToken =
                tokenData.access_token;


            twitchRefreshToken =
                tokenData.refresh_token ||
                null;


            // =================================================
            // USUARIO
            // =================================================

            const userResponse =
                await fetch(
                    "https://api.twitch.tv/helix/users",
                    {

                        headers: {

                            Authorization:
                                `Bearer ${twitchAccessToken}`,

                            "Client-Id":
                                clientId

                        }

                    }
                );


            const userData =
                await userResponse.json();


            if (
                !userResponse.ok ||
                !userData.data ||
                !userData.data.length
            ) {

                throw new Error(
                    "No se pudo obtener el usuario de Twitch."
                );

            }


            twitchUser =
                userData.data[0];


            console.log(
                "=============================================="
            );

            console.log(
                "✅ TWITCH CONECTADO"
            );

            console.log(
                "Usuario:",
                twitchUser.display_name
            );

            console.log(
                "=============================================="
            );


            // =================================================
            // EVENTSUB
            // =================================================

            await startEventSub();


            // =================================================
            // ÉXITO
            // =================================================

            res.send(`

                <!DOCTYPE html>

                <html lang="es">

                <head>

                    <meta charset="UTF-8">

                    <title>
                        Twitch conectado
                    </title>

                    <style>

                        body {

                            margin: 0;

                            min-height: 100vh;

                            display: flex;

                            align-items: center;

                            justify-content: center;

                            background: #111827;

                            color: white;

                            font-family: Arial;

                        }

                        .box {

                            width: 90%;

                            max-width: 500px;

                            background: #1f2937;

                            padding: 40px;

                            border-radius: 20px;

                            text-align: center;

                        }

                        .icon {

                            font-size: 70px;

                        }

                        .user {

                            color: #a970ff;

                            font-size: 22px;

                            font-weight: bold;

                            margin: 20px 0;

                        }

                        button {

                            border: none;

                            border-radius: 10px;

                            padding: 14px 25px;

                            background: #9147ff;

                            color: white;

                            font-size: 16px;

                            font-weight: bold;

                            cursor: pointer;

                        }

                    </style>

                </head>

                <body>

                    <div class="box">

                        <div class="icon">
                            ✅
                        </div>

                        <h1>
                            ¡Twitch conectado!
                        </h1>

                        <p>
                            La cuenta se conectó correctamente.
                        </p>

                        <div class="user">
                            ${escapeHtml(
                                twitchUser.display_name
                            )}
                        </div>

                        <p>
                            Las recompensas y Bits
                            ya pueden controlar
                            el contador.
                        </p>

                        <button
                            onclick="window.close()"
                        >
                            Cerrar ventana
                        </button>

                    </div>

                </body>

                </html>

            `);


        } catch (error) {

            console.error(
                "❌ ERROR EN CALLBACK:",
                error
            );


            res.status(
                500
            ).send(`

                <h1>❌ Error conectando Twitch</h1>

                <pre>
                    ${escapeHtml(
                        error.message
                    )}
                </pre>

            `);

        }

    }
);


// ============================================================
// EVENTSUB
// ============================================================

async function startEventSub(
    customUrl = null
) {

    if (
        !twitchAccessToken ||
        !twitchUser
    ) {

        console.log(
            "⚠️ No se puede iniciar EventSub todavía."
        );

        return;

    }


    if (
        eventSubConnecting
    ) {

        return;

    }


    eventSubConnecting =
        true;


    try {

        if (
            eventSubSocket
        ) {

            try {
                eventSubSocket.close();
            } catch {}

        }


        const url =
            customUrl ||
            "wss://eventsub.wss.twitch.tv/ws";


        console.log(
            "🔌 Conectando a Twitch EventSub..."
        );


        const socket =
            new WebSocket(
                url
            );


        eventSubSocket =
            socket;


        socket.on(
            "open",
            () => {

                console.log(
                    "🟢 EventSub WebSocket conectado"
                );

            }
        );


        socket.on(
            "message",
            async raw => {

                try {

                    const message =
                        JSON.parse(
                            raw.toString()
                        );


                    await handleEventSubMessage(
                        message,
                        socket
                    );


                } catch (error) {

                    console.error(
                        "❌ Error procesando EventSub:",
                        error
                    );

                }

            }
        );


        socket.on(
            "close",
            () => {

                console.log(
                    "🔴 EventSub desconectado"
                );


                if (
                    eventSubSocket ===
                    socket
                ) {

                    eventSubSocket =
                        null;

                }


                eventSubConnecting =
                    false;


                setTimeout(
                    () => {

                        if (
                            twitchAccessToken &&
                            twitchUser &&
                            !eventSubSocket
                        ) {

                            startEventSub();

                        }

                    },
                    5000
                );

            }
        );


        socket.on(
            "error",
            error => {

                console.error(
                    "❌ Error EventSub:",
                    error.message
                );

            }
        );


    } catch (error) {

        console.error(
            "❌ No se pudo iniciar EventSub:",
            error
        );

    }


    eventSubConnecting =
        false;

}


// ============================================================
// MENSAJES EVENTSUB
// ============================================================

async function handleEventSubMessage(
    message,
    socket
) {

    const type =
        message?.metadata?.message_type;


    // ========================================================
    // WELCOME
    // ========================================================

    if (
        type ===
        "session_welcome"
    ) {

        const sessionId =
            message.payload.session.id;


        eventSubReconnectUrl =
            message.payload.session
                .reconnect_url;


        console.log(
            "👋 Twitch EventSub dio la bienvenida."
        );


        await createEventSubSubscriptions(
            sessionId
        );


        return;

    }


    // ========================================================
    // RECONNECT
    // ========================================================

    if (
        type ===
        "session_reconnect"
    ) {

        const reconnectUrl =
            message.payload.session
                .reconnect_url;


        if (reconnectUrl) {

            try {
                socket.close();
            } catch {}


            setTimeout(
                () => {

                    startEventSub(
                        reconnectUrl
                    );

                },
                100
            );

        }


        return;

    }


    // ========================================================
    // KEEPALIVE
    // ========================================================

    if (
        type ===
        "session_keepalive"
    ) {

        return;

    }


    // ========================================================
    // REVOCACIÓN
    // ========================================================

    if (
        type ===
        "revocation"
    ) {

        console.error(
            "⚠️ Twitch revocó una suscripción EventSub."
        );

        return;

    }


    // ========================================================
    // NOTIFICACIÓN
    // ========================================================

    if (
        type !==
        "notification"
    ) {

        return;

    }


    const messageId =
        message.metadata.message_id;


    if (
        processedEventIds.has(
            messageId
        )
    ) {

        return;

    }


    processedEventIds.add(
        messageId
    );


    if (
        processedEventIds.size >
        1000
    ) {

        const first =
            processedEventIds
                .values()
                .next()
                .value;


        processedEventIds.delete(
            first
        );

    }


    const subscriptionType =
        message.payload.subscription
            .type;


    const event =
        message.payload.event;


    // ========================================================
    // RECOMPENSA DE CHANNEL POINTS
    // ========================================================

    if (
        subscriptionType ===
        "channel.channel_points_custom_reward_redemption.add"
    ) {

        const rewardId =
            String(
                event?.reward?.id ||
                ""
            );


        const rewardTitle =
            String(
                event?.reward?.title ||
                "Recompensa"
            );


        const amount =
            Math.max(
                0,
                Math.floor(
                    Number(
                        twitchConfig
                            .rewardMappings
                            [rewardId]
                    ) || 0
                )
            );


        console.log(
            "=============================================="
        );


        console.log(
            "🎁 CANJE DE CHANNEL POINTS"
        );


        console.log(
            "Usuario:",
            event.user_name
        );


        console.log(
            "Recompensa:",
            rewardTitle
        );


        console.log(
            "Valor configurado:",
            amount
        );


        console.log(
            "=============================================="
        );


        if (
            amount <= 0
        ) {

            console.log(
                "⚠️ Esta recompensa tiene 0 sentadillas configuradas."
            );

            return;

        }


        addSquats(
            amount,
            `Twitch: ${rewardTitle}`
        );


        return;

    }


    // ========================================================
    // BITS
    // ========================================================

    if (
        subscriptionType ===
        "channel.cheer"
    ) {

        const bits =
            Number(
                event?.bits || 0
            );


        if (
            !Number.isFinite(bits) ||
            bits <= 0
        ) {

            return;

        }


        const bitsPerBlock =
            Math.max(
                1,
                Math.floor(
                    Number(
                        twitchConfig
                            .bitsPerBlock
                    ) || 1
                )
            );


        const squatsPerBlock =
            Math.max(
                1,
                Math.floor(
                    Number(
                        twitchConfig
                            .squatsPerBlock
                    ) || 1
                )
            );


        const blocks =
            Math.floor(
                bits /
                bitsPerBlock
            );


        const amount =
            blocks *
            squatsPerBlock;


        console.log(
            "=============================================="
        );


        console.log(
            "💎 BITS RECIBIDOS"
        );


        console.log(
            "Usuario:",
            event.user_name ||
            "Anónimo"
        );


        console.log(
            "Bits:",
            bits
        );


        console.log(
            "Sentadillas:",
            amount
        );


        console.log(
            "=============================================="
        );


        if (
            amount > 0
        ) {

            addSquats(
                amount,
                "Twitch Bits"
            );

        }


        return;

    }

}


// ============================================================
// CREAR SUSCRIPCIONES EVENTSUB
// ============================================================

async function createEventSubSubscriptions(
    sessionId
) {

    if (
        !twitchAccessToken ||
        !twitchUser
    ) {

        return;

    }


    const subscriptions = [

        {

            type:
                "channel.channel_points_custom_reward_redemption.add",

            version:
                "1",

            condition: {

                broadcaster_user_id:
                    twitchUser.id

            }

        },

        {

            type:
                "channel.cheer",

            version:
                "1",

            condition: {

                broadcaster_user_id:
                    twitchUser.id

            }

        }

    ];


    for (
        const subscription
        of subscriptions
    ) {

        try {

            const response =
                await fetch(
                    "https://api.twitch.tv/helix/eventsub/subscriptions",
                    {

                        method:
                            "POST",

                        headers: {

                            "Client-Id":
                                getClientId(),

                            Authorization:
                                `Bearer ${twitchAccessToken}`,

                            "Content-Type":
                                "application/json"

                        },

                        body:
                            JSON.stringify({

                                ...subscription,

                                transport: {

                                    method:
                                        "websocket",

                                    session_id:
                                        sessionId

                                }

                            })

                    }
                );


            const data =
                await response.json();


            if (
                response.ok
            ) {

                console.log(
                    `✅ EventSub suscrito: ${subscription.type}`
                );

            } else {

                console.error(
                    `❌ Error suscribiendo ${subscription.type}:`,
                    JSON.stringify(
                        data,
                        null,
                        2
                    )
                );

            }


        } catch (error) {

            console.error(
                "❌ Error EventSub:",
                error
            );

        }

    }

}


// ============================================================
// REFRESCAR TOKEN
// ============================================================

async function refreshTwitchToken() {

    if (
        !twitchRefreshToken
    ) {

        return false;

    }


    try {

        const response =
            await fetch(
                "https://id.twitch.tv/oauth2/token",
                {

                    method:
                        "POST",

                    headers: {

                        "Content-Type":
                            "application/x-www-form-urlencoded"

                    },

                    body:
                        new URLSearchParams({

                            grant_type:
                                "refresh_token",

                            refresh_token:
                                twitchRefreshToken,

                            client_id:
                                getClientId(),

                            client_secret:
                                getClientSecret()

                        })

                }
            );


        const data =
            await response.json();


        if (
            !response.ok
        ) {

            console.error(
                "❌ No se pudo renovar token:",
                data
            );

            return false;

        }


        twitchAccessToken =
            data.access_token;


        if (
            data.refresh_token
        ) {

            twitchRefreshToken =
                data.refresh_token;

        }


        console.log(
            "✅ Token de Twitch renovado."
        );


        return true;


    } catch (error) {

        console.error(
            "❌ Error renovando token:",
            error
        );

        return false;

    }

}


// ============================================================
// RENOVAR TOKEN
// ============================================================

setInterval(
    async () => {

        if (
            twitchAccessToken &&
            twitchRefreshToken
        ) {

            const success =
                await refreshTwitchToken();


            if (
                success
            ) {

                if (
                    eventSubSocket
                ) {

                    try {
                        eventSubSocket.close();
                    } catch {}

                }


                setTimeout(
                    () => {

                        if (
                            twitchAccessToken &&
                            twitchUser
                        ) {

                            startEventSub();

                        }

                    },
                    1000
                );

            }

        }

    },
    50 * 60 * 1000
);


// ============================================================
// DESCONECTAR TWITCH
// ============================================================

app.post(
    "/auth/twitch/logout",
    async (req, res) => {

        try {

            if (
                twitchAccessToken
            ) {

                await fetch(

                    "https://id.twitch.tv/oauth2/revoke" +

                    `?client_id=${encodeURIComponent(
                        getClientId()
                    )}` +

                    `&token=${encodeURIComponent(
                        twitchAccessToken
                    )}`,

                    {
                        method:
                            "POST"
                    }

                );

            }

        } catch {}


        if (
            eventSubSocket
        ) {

            try {
                eventSubSocket.close();
            } catch {}

        }


        twitchAccessToken =
            null;

        twitchRefreshToken =
            null;

        twitchUser =
            null;

        oauthState =
            null;

        eventSubSocket =
            null;


        console.log(
            "🔴 Twitch desconectado"
        );


        res.json({

            ok: true

        });

    }
);


// ============================================================
// ESCAPAR HTML
// ============================================================

function escapeHtml(value) {

    return String(value)

        .replaceAll(
            "&",
            "&amp;"
        )

        .replaceAll(
            "<",
            "&lt;"
        )

        .replaceAll(
            ">",
            "&gt;"
        )

        .replaceAll(
            '"',
            "&quot;"
        )

        .replaceAll(
            "'",
            "&#039;"
        );

}


// ============================================================
// INICIALIZAR
// ============================================================

loadTwitchConfig();

loadSquatState();


// ============================================================
// INICIAR SERVIDOR
// ============================================================

function startServer() {
    server.listen(PORT, HOST, () => {

        console.log("");
        console.log("==============================================");
        console.log("🏋️ SQUAT TWITCH SERVER");
        console.log("==============================================");

        const publicUrl = String(process.env.PUBLIC_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
        console.log(`🌐 Aplicación: ${publicUrl}`);
        console.log(`📺 OBS:        ${publicUrl}/obs.html`);
        console.log(`🧪 Prueba:     ${publicUrl}/prueba`);
        console.log(`🔐 Twitch OAuth: ${getRedirectUri()}`);

        console.log("----------------------------------------------");

        if (!getClientId() || !getClientSecret()) {
            console.warn("⚠️ Twitch no está configurado. Define TWITCH_CLIENT_ID y TWITCH_CLIENT_SECRET.");
        }

        console.log(`📊 Sentadillas pendientes: ${squatCounter}`);

        if (twitchUser) {
            console.log(
                `🟢 Twitch conectado: ${twitchUser.display_name}`
            );
        } else {
            console.log("🔴 Twitch no conectado");
        }

        console.log("----------------------------------------------");
        console.log("Servidor listo.");
        console.log("==============================================");
        console.log("");
    });
}


// ============================================================
// CIERRE CONTROLADO
// ============================================================

function shutdownServer() {

    console.log("");
    console.log("🛑 Cerrando Squat Twitch Server...");

    try {

        if (eventSubSocket) {
            try {
                eventSubSocket.close();
            } catch {}
        }

        if (browserWS) {
            try {
                browserWS.close();
            } catch {}
        }

        server.close(() => {

            console.log("✅ Servidor cerrado correctamente.");

            process.exit(0);

        });

    } catch (error) {

        console.error(
            "❌ Error cerrando servidor:",
            error
        );

        process.exit(1);
    }
}


// ============================================================
// SEÑALES DE WINDOWS / NODE
// ============================================================

process.on("SIGINT", () => {

    shutdownServer();

});

process.on("SIGTERM", () => {

    shutdownServer();

});


// ============================================================
// INICIAR
// ============================================================

startServer();