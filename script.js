/* ============================================================
   IDENTIDAD PERSISTENTE DEL STREAMER
   El sessionId se conserva en localStorage para que el mismo
   navegador vuelva a reconocer al streamer aunque cierre la pesta\u{F1}a.
   La identidad permanente de Twitch se guarda adem\u{E1}s en PostgreSQL.
   ============================================================ */
(function setupSquatSessionIsolation() {
    const nativeFetch = window.fetch.bind(window);
    const storedSession = localStorage.getItem("squat_session_id");

    function addSession(url) {
        if (!window.SQUAT_SESSION_ID) return url;

        const absolute = new URL(url, window.location.origin);

        if (absolute.origin !== window.location.origin) {
            return url;
        }

        if (
            absolute.pathname.startsWith("/api/") ||
            absolute.pathname === "/auth/twitch"
        ) {
            absolute.searchParams.set("session", window.SQUAT_SESSION_ID);
            return absolute.pathname + absolute.search + absolute.hash;
        }

        return url;
    }

    window.SQUAT_SESSION_ID = storedSession || "";

    window.SQUAT_SESSION_READY = (async () => {
        try {
            const endpoint = window.SQUAT_SESSION_ID
                ? `/api/session?session=${encodeURIComponent(window.SQUAT_SESSION_ID)}`
                : "/api/session?new=1";

            const response = await nativeFetch(endpoint, {
                credentials: "same-origin"
            });

            if (!response.ok) {
                throw new Error("No se pudo crear/recuperar la sesi\u{F3}n.");
            }

            const data = await response.json();

            if (!data.ok || !data.sessionId) {
                throw new Error("El servidor no devolvi\u{F3} una sesi\u{F3}n v\u{E1}lida.");
            }

            window.SQUAT_SESSION_ID = data.sessionId;
            localStorage.setItem("squat_session_id", data.sessionId);

            return data;
        } catch (error) {
            console.error("Error inicializando sesi\u{F3}n:", error);
            throw error;
        }
    })();

    window.fetch = async function(input, init) {
        await window.SQUAT_SESSION_READY;

        if (typeof input === "string") {
            input = addSession(input);
        } else if (input instanceof Request) {
            input = new Request(addSession(input.url), input);
        }

        return nativeFetch(input, init);
    };
})();

// ============================================================
// ELEMENTOS HTML
// ============================================================

const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");

const counterElement = document.getElementById("counter");
const stateElement = document.getElementById("state");
const statusElement = document.getElementById("status");

const startButton = document.getElementById("startButton");
const pauseButton = document.getElementById("pauseButton");
const resetButton = document.getElementById("resetButton");
const stopCameraButton = document.getElementById("stopCameraButton");

const counterInput = document.getElementById("counterInput");
const setCounterButton = document.getElementById("setCounterButton");

const addModeButton = document.getElementById("addModeButton");
const subtractModeButton = document.getElementById("subtractModeButton");
const modeText = document.getElementById("modeText");
const saveDetectorModeButton = document.getElementById("saveDetectorModeButton");
const detectorModeSaveStatus = document.getElementById("detectorModeSaveStatus");

const twitchStatus = document.getElementById("twitchStatus");
const connectTwitchButton = document.getElementById("connectTwitchButton");
const disconnectTwitchButton = document.getElementById("disconnectTwitchButton");

const clientIdInput = document.getElementById("clientIdInput");
const clientSecretInput = document.getElementById("clientSecretInput");

const rewardsContainer = document.getElementById("rewardsContainer");
const rewardsList = document.getElementById("rewardsList");
const saveRewardsButton = document.getElementById("saveRewardsButton");

const bitsAmountInput = document.getElementById("bitsAmountInput");
const bitsSquatsInput = document.getElementById("bitsSquatsInput");
const saveBitsButton = document.getElementById("saveBitsButton");


// ============================================================
// VARIABLES
// ============================================================

let counter = 0;

// Twitch/recompensas: las recompensas solo se cargan cuando cambia
// el estado de conexi\u{F3}n. No se vuelven a reconstruir cada 5 segundos,
// porque eso reemplazaba los n\u{FA}meros que el usuario estaba editando.
let twitchWasConnected = false;
let twitchRewardsLoaded = false;

let detectorActive = false;
let camera = null;
let socket = null;

// IMPORTANTE:
// "add" = cada sentadilla suma 1
// "subtract" = cada sentadilla resta 1
let detectorMode = "add";
let selectedDetectorMode = "add";


// ============================================================
// CONTADOR
// ============================================================

function updateCounter() {

    counter = Math.max(
        0,
        Math.floor(Number(counter) || 0)
    );

    counterElement.textContent = counter;

    counterInput.value = counter;
}


function applyDetectorMode(mode) {

    detectorMode =
        mode === "subtract"
            ? "subtract"
            : "add";

    selectedDetectorMode = detectorMode;

    addModeButton.classList.toggle(
        "active",
        selectedDetectorMode === "add"
    );

    subtractModeButton.classList.toggle(
        "active",
        selectedDetectorMode === "subtract"
    );

    modeText.textContent =
        selectedDetectorMode === "add"
            ? "\u{2795} Cada sentadilla suma 1"
            : "\u{2796} Cada sentadilla resta 1";

    if (detectorModeSaveStatus) {
        detectorModeSaveStatus.textContent = "";
    }
}


function selectDetectorMode(mode) {

    selectedDetectorMode =
        mode === "subtract"
            ? "subtract"
            : "add";

    addModeButton.classList.toggle(
        "active",
        selectedDetectorMode === "add"
    );

    subtractModeButton.classList.toggle(
        "active",
        selectedDetectorMode === "subtract"
    );

    modeText.textContent =
        selectedDetectorMode === "add"
            ? "\u{2795} Cada sentadilla suma 1"
            : "\u{2796} Cada sentadilla resta 1";

    if (detectorModeSaveStatus) {
        detectorModeSaveStatus.textContent =
            "Cambios sin guardar";
    }
}


async function saveDetectorMode() {

    const modeToSave = selectedDetectorMode;

    if (saveDetectorModeButton) {
        saveDetectorModeButton.disabled = true;
        saveDetectorModeButton.textContent = "Guardando...";
    }

    try {
        const response = await fetch(
            "/api/squats/mode",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ mode: modeToSave })
            }
        );

        if (!response.ok) {
            throw new Error(
                "No se pudo guardar el modo del detector"
            );
        }

        const data = await response.json();

        applyDetectorMode(data.detectorMode);

        if (detectorModeSaveStatus) {
            detectorModeSaveStatus.textContent =
                "Modo guardado correctamente";
        }

    } catch (error) {

        console.error(
            "Error guardando modo del detector:",
            error
        );

        if (detectorModeSaveStatus) {
            detectorModeSaveStatus.textContent =
                "No se pudo guardar el modo";
        }

    } finally {

        if (saveDetectorModeButton) {
            saveDetectorModeButton.disabled = false;
            saveDetectorModeButton.textContent = "Guardar modo";
        }
    }
}


// ============================================================
// CARGAR CONTADOR
// ============================================================

async function loadCounter() {

    try {

        const response = await fetch("/api/squats");

        if (!response.ok) {
            throw new Error("No se pudo obtener el contador");
        }

        const data = await response.json();

        counter = Number(data.pendingSquats || 0);

        updateCounter();

        applyDetectorMode(data.detectorMode);

    } catch (error) {

        console.error(
            "Error cargando contador:",
            error
        );

    }

}


// ============================================================
// CAMBIAR CONTADOR POR UNA SENTADILLA
// ============================================================

async function registerDetectedSquat() {

    try {

        const amount =
            detectorMode === "add"
                ? 1
                : -1;

        const response = await fetch(
            "/api/squats/change",
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    amount
                })
            }
        );

        if (!response.ok) {
            throw new Error(
                "No se pudo cambiar el contador"
            );
        }

        const data = await response.json();

        counter = Number(
            data.pendingSquats || 0
        );

        updateCounter();

        return true;

    } catch (error) {

        console.error(
            "Error registrando sentadilla:",
            error
        );

        return false;
    }

}


// ============================================================
// ESTABLECER CONTADOR
// ============================================================

async function setCounter(value) {

    const number = Number(value);

    if (!Number.isFinite(number)) {
        return;
    }

    try {

        const response = await fetch(
            "/api/squats/set",
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({
                    value: Math.max(
                        0,
                        Math.floor(number)
                    )
                })
            }
        );

        if (!response.ok) {
            throw new Error(
                "No se pudo establecer el contador"
            );
        }

    } catch (error) {

        console.error(
            "Error estableciendo contador:",
            error
        );

    }

}


// ============================================================
// REINICIAR CONTADOR
// ============================================================

async function resetCounter() {

    try {

        await fetch(
            "/api/squats/reset",
            {
                method: "POST"
            }
        );

    } catch (error) {

        console.error(
            "Error reiniciando:",
            error
        );

    }

}


// ============================================================
// MODO SUMAR
// ============================================================

addModeButton.addEventListener(
    "click",
    () => {
        selectDetectorMode("add");
    }
);


// ============================================================
// MODO RESTAR
// ============================================================

subtractModeButton.addEventListener(
    "click",
    () => {
        selectDetectorMode("subtract");
    }
);


if (saveDetectorModeButton) {
    saveDetectorModeButton.addEventListener(
        "click",
        saveDetectorMode
    );
}


// ============================================================
// ESTABLECER VALOR
// ============================================================

setCounterButton.addEventListener(
    "click",
    () => {

        setCounter(
            counterInput.value
        );

    }
);


counterInput.addEventListener(
    "keydown",
    event => {

        if (event.key === "Enter") {

            setCounter(
                counterInput.value
            );

        }

    }
);


// ============================================================
// WEBSOCKET
// ============================================================

async function connectWebSocket() {

    try {
        await window.SQUAT_SESSION_READY;
    } catch {
        return;
    }

    if (
        socket &&
        (
            socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING
        )
    ) {
        return;
    }

    const protocol =
        location.protocol === "https:"
            ? "wss:"
            : "ws:";

    const url =
        `${protocol}//${location.host}/ws?session=${encodeURIComponent(
            window.SQUAT_SESSION_ID || ""
        )}`;

    socket = new WebSocket(url);


    socket.addEventListener(
        "open",
        () => {

            console.log(
                "WebSocket conectado"
            );

        }
    );


    socket.addEventListener(
        "message",
        event => {

            try {

                const message =
                    JSON.parse(event.data);

                if (
                    message.type ===
                    "counter:update"
                ) {

                    counter =
                        Number(
                            message.data
                                ?.pendingSquats || 0
                        );

                    updateCounter();

                    if (message.data?.detectorMode) {
                        applyDetectorMode(
                            message.data.detectorMode
                        );
                    }

                }

            } catch (error) {

                console.error(
                    "Error WebSocket:",
                    error
                );

            }

        }
    );


    socket.addEventListener(
        "close",
        () => {

            console.log(
                "WebSocket desconectado"
            );

            setTimeout(
                connectWebSocket,
                2000
            );

        }
    );

}


// ============================================================
// DETECCION
// ============================================================

// ============================================================
// DETECTOR DE SENTADILLAS v2
// ------------------------------------------------------------
// Mejoras principales respecto a la version anterior:
//  - Calibracion real: solo cuenta tiempo cuando la persona esta
//    de pie, quieta y con las rodillas estiradas. Usa el promedio
//    de muestras (no una media movil que arrastra el primer frame).
//  - Recalibracion automatica si te mueves, cambias de distancia
//    o calibraste agachado.
//  - Umbrales de profundidad mucho mas altos (antes 2.5% del torso,
//    ahora 14% para empezar y 34% para validar el fondo).
//  - Filtro de picos (mediana de 3) + suavizado por tiempo, asi
//    el detector funciona igual a 15, 30 o 60 FPS.
//  - La sentadilla se cuenta cuando ya subiste a mitad de camino,
//    no por ruido en el fondo (antes un bug hacia que la velocidad
//    siempre pareciera "subiendo").
//  - Se corrige la relacion de aspecto del video en las distancias.
// Las unidades de profundidad son "torsos": 1.0 = distancia
// hombros-cadera de pie.
// ============================================================

const SQUAT_CONFIG = {

    // --- Calibracion ---
    DEBUG: (typeof location !== "undefined" && /[?&]debug=1/.test(location.search)),  // abre la pagina con ?debug=1 para ver valores
    CALIBRATION_MS: 600,           // tiempo quieto y de pie necesario
    CALIBRATION_MIN_SAMPLES: 3,
    CALIBRATION_MAX_MOTION: 0.14,  // movimiento maximo (en torsos) para calibrar
    CALIBRATION_GRACE_MS: 350,     // frames malos tolerados sin reiniciar
    STANDING_KNEE_ANGLE: 150,      // rodilla "estirada" (solo para ajustes finos)
    CALIBRATION_MIN_KNEE: 115,     // por debajo de esto se asume que estas agachado
    MIN_VISIBILITY: 0.35,          // hombros y cabeza
    MIN_HIP_VISIBILITY: 0.50,      // caderas (si no se ven bien se usa solo el torso superior)
    HIP_MAX_Y: 0.80,               // caderas mas abajo que esto (en el encuadre) = modo torso
    BEND_LIMIT: 0.30,              // cabeza cayendo respecto a hombros = te inclinas, no sentadilla
    MIN_KNEE_VISIBILITY: 0.35,
    STILL_MOTION: 0.06,            // movimiento maximo (en torsos) para "estas quieto"
    STILL_VELOCITY: 0.12,          // torsos/seg

    // --- Profundidad (en torsos) ---
    DOWN_START: 0.10,              // empieza a bajar
    DOWN_EXIT: 0.07,               // ya volviste a estar de pie
    BOTTOM_DEPTH: 0.27,            // profundidad minima para valer como sentadilla
    KNEE_BOTTOM_ANGLE: 125,        // rodilla muy flexionada (vista lateral)
    KNEE_BOTTOM_MIN_DEPTH: 0.16,
    RISE_DELTA: 0.07,              // cuanto debe subir desde el fondo
    COUNT_ASCENT_RATIO: 0.55,      // cuenta al subir ~45% del recorrido

    // --- Tiempos (ms) ---
    BOTTOM_HOLD_MS: 80,
    RISE_CONFIRM_MS: 60,
    DOWN_CONFIRM_MS: 50,
    MIN_REP_MS: 450,
    MIN_TIME_BETWEEN_SQUATS: 700,
    MAX_DESCENT_MS: 8000,
    MAX_ASCENT_MS: 8000,
    MAX_BOTTOM_MS: 6000,
    LOST_RESET_MS: 3500,
    LOW_FPS_DT: 200                // si pasan >= 200 ms entre frames se usa el modo de pocos FPS
};


class SquatDetector {

    constructor(config) {
        this.cfg = Object.assign({}, SQUAT_CONFIG, config || {});
        this.lastCount = -1e9;
        this.reset();
    }


    reset() {
        this.phase = "CALIBRATING";
        this.baseline = null;
        this.cal = null;
        this.calMs = 0;
        this.lastT = 0;
        this.lastSeen = 0;
        this.rawHist = [];
        this.depth = 0;
        this.prevDepth = 0;
        this.vel = 0;
        this.motion = 0;
        this.anchorLP = null;
        this.depthHist = [];
        this.motionEff = 0;
        this._changed = false;
        this.bending = false;
        this.sinceCalMs = 0;
        this.distStillMs = 0;
        this.badMs = 0;
        this.stillMs = 0;
        this.downMs = 0;
        this.scaleOffMs = 0;
        this.phaseStart = 0;
        this.rep = null;
    }


    // --------------------------------------------------------
    // Utilidades
    // --------------------------------------------------------

    static _angle(a, b, c) {
        const abx = a.x - b.x, aby = a.y - b.y;
        const cbx = c.x - b.x, cby = c.y - b.y;
        const m1 = Math.hypot(abx, aby);
        const m2 = Math.hypot(cbx, cby);
        if (!m1 || !m2) return null;
        const cos = Math.max(-1, Math.min(1, (abx * cbx + aby * cby) / (m1 * m2)));
        return Math.acos(cos) * 180 / Math.PI;
    }

    static _median3(list) {
        const s = list.slice().sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
    }

    static _k(dt, tau) {
        return 1 - Math.exp(-dt / tau);
    }

    _out(text, counted) {
        if (this.cfg.DEBUG && !counted) {
            text += ` [${this.baseline ? this.baseline.mode : "?"} p=${this.depth.toFixed(2)} meta=${this.cfg.BOTTOM_DEPTH}` +
                (this._knee !== null && this._knee !== undefined ? ` rod=${Math.round(this._knee)}` : "") + "]";
        }
        return {
            phase: this.phase,
            text,
            counted: !!counted,
            lost: false,
            depth: this.depth
        };
    }

    _enter(phase, now) {
        this._changed = true;
        this.phase = phase;
        this.phaseStart = now;
    }

    _recalibrate() {
        this.reset();
    }


    // --------------------------------------------------------
    // Lectura de landmarks de MediaPipe
    // --------------------------------------------------------

    _read(lm, aspect) {

        const c = this.cfg;
        const vis = i => (lm[i] && lm[i].visibility !== undefined ? lm[i].visibility : 0);

        // Solo se exigen los hombros. Caderas y piernas son opcionales
        // (muchos encuadres solo muestran el torso).
        if (vis(11) < c.MIN_VISIBILITY || vis(12) < c.MIN_VISIBILITY) {
            return null;
        }

        // x se multiplica por la relacion de aspecto para que las
        // distancias horizontales y verticales usen la misma escala.
        const P = i => ({ x: lm[i].x * aspect, y: lm[i].y });

        const shoulders = {
            x: (P(11).x + P(12).x) / 2,
            y: (P(11).y + P(12).y) / 2
        };

        const sw = Math.hypot(P(11).x - P(12).x, P(11).y - P(12).y);

        // Cabeza: promedio de nariz, ojos y orejas que se vean.
        let hx = 0, hy = 0, hn = 0;

        for (const i of [0, 2, 5, 7, 8]) {
            if (vis(i) >= c.MIN_VISIBILITY) {
                hx += P(i).x;
                hy += P(i).y;
                hn++;
            }
        }

        const head = hn >= 2 ? { x: hx / hn, y: hy / hn } : null;

        // Caderas: solo si se ven bien y estan dentro del encuadre.
        const hipOk = i => vis(i) >= c.MIN_HIP_VISIBILITY && lm[i].y <= 0.97;
        let hips = null;
        let torso = null;

        if (hipOk(23) && hipOk(24)) {
            hips = {
                x: (P(23).x + P(24).x) / 2,
                y: (P(23).y + P(24).y) / 2
            };
            torso = Math.hypot(hips.x - shoulders.x, hips.y - shoulders.y);

            if (torso < 0.04) {
                hips = null;
                torso = null;
            }
        }

        // Unidad de medida: torso si hay caderas; si no, ancho de hombros
        // (un torso mide aprox. 1.25 anchos de hombros).
        const unit = torso !== null ? torso : sw * 1.25;

        if (unit < 0.04) {
            return null;
        }

        const leg = (h, k, a) =>
            (hips !== null && vis(h) >= c.MIN_KNEE_VISIBILITY && vis(k) >= c.MIN_KNEE_VISIBILITY && vis(a) >= c.MIN_KNEE_VISIBILITY)
                ? SquatDetector._angle(P(h), P(k), P(a))
                : null;

        const left = leg(23, 25, 27);
        const right = leg(24, 26, 28);

        let knee = null;

        if (left !== null && right !== null) {
            knee = Math.abs(left - right) <= 40 ? (left + right) / 2 : null;
        } else if (left !== null) {
            knee = left;
        } else if (right !== null) {
            knee = right;
        }

        return { shoulders, head, hips, torso, sw, unit, unitT: sw * 1.25, knee, hipY: hips ? hips.y : null };
    }


    _axis(shoulders, hips) {
        const vx = hips.x - shoulders.x;
        const vy = hips.y - shoulders.y;
        const m = Math.hypot(vx, vy);
        if (!m) return { x: 0, y: 1 };
        return { x: vx / m, y: vy / m };
    }


    _depth(d) {

        const b = this.baseline;
        const s = Math.max(b.unit, 0.001);

        if (b.mode === "hips") {

            if (!d.hips) {
                return null;
            }

            const ax = b.axis;
            const hipDown = ((d.hips.x - b.hips.x) * ax.x + (d.hips.y - b.hips.y) * ax.y) / s;
            const shDown = ((d.shoulders.x - b.shoulders.x) * ax.x + (d.shoulders.y - b.shoulders.y) * ax.y) / s;

            // La cadera manda; los hombros evitan que un simple temblor de cadera cuente.
            return hipDown * 0.8 + shDown * 0.2;
        }

        // Modo torso: solo hombros y cabeza (movimiento vertical).
        const shDown = (d.shoulders.y - b.shoulders.y) / s;

        this.bending = false;

        if (d.head && b.head) {
            const headDown = (d.head.y - b.head.y) / s;

            // Si la cabeza cae mucho mas que los hombros te estas inclinando
            // hacia adelante (amarrarte un zapato), no es una sentadilla.
            const bendRel = ((d.head.y - d.shoulders.y) - (b.head.y - b.shoulders.y)) / s;
            this.bending = bendRel > this.cfg.BEND_LIMIT;

            return shDown * 0.7 + headDown * 0.3;
        }

        return shDown;
    }


    _blendBaseline(d, k) {
        const b = this.baseline;
        b.shoulders.x += (d.shoulders.x - b.shoulders.x) * k;
        b.shoulders.y += (d.shoulders.y - b.shoulders.y) * k;

        if (d.head && b.head) {
            b.head.x += (d.head.x - b.head.x) * k;
            b.head.y += (d.head.y - b.head.y) * k;
        }

        if (b.mode === "hips" && d.hips) {
            b.hips.x += (d.hips.x - b.hips.x) * k;
            b.hips.y += (d.hips.y - b.hips.y) * k;
            b.torso += (d.torso - b.torso) * k;
            b.unit = b.torso;
            b.axis = this._axis(b.shoulders, b.hips);
        } else if (b.mode === "torso") {
            b.sw += (d.sw - b.sw) * k;
            b.unit = b.sw * 1.25;
        }

        if (d.knee !== null) {
            b.knee = b.knee === null ? d.knee : b.knee + (d.knee - b.knee) * k;
        }
    }


    // --------------------------------------------------------
    // Cuerpo no visible
    // --------------------------------------------------------

    lost(now, text) {
        if (this.lastSeen && now - this.lastSeen > this.cfg.LOST_RESET_MS) {
            this.reset();
        }
        return {
            phase: this.phase,
            text: text || "No se detecta el cuerpo",
            counted: false,
            lost: true,
            depth: this.depth
        };
    }


    // --------------------------------------------------------
    // Actualizacion principal (llamar en cada frame)
    // --------------------------------------------------------

    update(landmarks, now, aspect) {

        const c = this.cfg;
        const d = this._read(landmarks, aspect || 1);
        this._knee = d ? d.knee : null;

        if (!d) {
            return this.lost(now, "Cuerpo no visible");
        }

        if (this.lastSeen && now - this.lastSeen > c.LOST_RESET_MS) {
            this.reset();
        }

        let dt = this.lastT ? now - this.lastT : 33;

        if (dt > 2500) {
            // Hubo una pausa larga: no usamos datos viejos.
            dt = 33;
            this.rawHist.length = 0;
            this.depthHist.length = 0;
            this.vel = 0;
            this.motion = 0;
            this.anchorLP = null;
            this.lastAnchor = null;
        }

        dt = Math.max(1, Math.min(dt, 1000));
        this.lastT = now;
        this.lastSeen = now;

        // Cantidad de movimiento reciente de los hombros: distancia entre la
        // posicion actual y su promedio de los ultimos ~0.4 s, en unidades
        // de cuerpo. Es mucho mas estable que derivar frame a frame.
        const scale = this.baseline ? this.baseline.unit : (d.hips ? d.unit : d.unitT);

        let stepDev = 0;

        if (!this.anchorLP) {
            this.anchorLP = { x: d.shoulders.x, y: d.shoulders.y };
            this.lastAnchor = { x: d.shoulders.x, y: d.shoulders.y };
        } else {
            const dev = Math.hypot(d.shoulders.x - this.anchorLP.x, d.shoulders.y - this.anchorLP.y) / scale;
            this.motion += (dev - this.motion) * SquatDetector._k(dt, 150);
            const kLP = SquatDetector._k(dt, 400);
            this.anchorLP.x += (d.shoulders.x - this.anchorLP.x) * kLP;
            this.anchorLP.y += (d.shoulders.y - this.anchorLP.y) * kLP;

            // Con pocos FPS el promedio "alcanza" a la posicion actual y el
            // movimiento se subestima: se usa tambien el salto entre frames.
            stepDev = Math.hypot(d.shoulders.x - this.lastAnchor.x, d.shoulders.y - this.lastAnchor.y) / scale;
            this.lastAnchor = { x: d.shoulders.x, y: d.shoulders.y };
        }

        const lowFps = dt >= c.LOW_FPS_DT;
        this.motionEff = lowFps ? Math.max(this.motion, stepDev * 0.8) : this.motion;

        // ====================================================
        // CALIBRANDO
        // ====================================================

        if (this.phase === "CALIBRATING") {
            return this._calibrate(d, dt, now);
        }

        // ====================================================
        // PROFUNDIDAD FILTRADA
        // ====================================================

        const raw = this._depth(d);

        if (raw === null) {
            return this.lost(now, "Cuerpo no visible");
        }

        // La mediana de 3 quita picos sueltos, pero con pocos FPS atrasa
        // demasiado la lectura: solo se usa si hay muchos cuadros por segundo.
        let med = raw;

        if (dt < 100) {
            this.rawHist.push(raw);
            if (this.rawHist.length > 3) this.rawHist.shift();
            med = SquatDetector._median3(this.rawHist);
        } else {
            this.rawHist.length = 0;
        }

        this.depth += (med - this.depth) * SquatDetector._k(dt, 70);

        // Velocidad en torsos/seg: contra la muestra mas reciente que tenga al
        // menos 100 ms de antiguedad (sirve igual a 30 FPS que a 1-2 FPS).
        this.depthHist.push({ t: now, d: this.depth });

        while (this.depthHist.length > 2 && now - this.depthHist[0].t > 1500) {
            this.depthHist.shift();
        }

        let ref = null;

        for (let i = this.depthHist.length - 2; i >= 0; i--) {
            if (now - this.depthHist[i].t >= 100) {
                ref = this.depthHist[i];
                break;
            }
        }

        this.vel = ref ? (this.depth - ref.d) / ((now - ref.t) / 1000) : 0;

        const depth = this.depth;
        const vel = this.vel;
        const b = this.baseline;

        // ====================================================
        // CAMBIO DE DISTANCIA (modo torso, de frente a la camara)
        // El ancho de hombros no cambia al hacer una sentadilla, pero si
        // al acercarte o alejarte. Si cambia y te quedas quieto, se
        // recalibra rapido en lugar de quedarse atascado.
        // ====================================================

        this.sinceCalMs += dt;

        if (b.mode === "torso") {

            const swR = d.sw / b.sw;
            const off = swR < 0.82 || swR > 1.22;
            const calm = this.motionEff < c.STILL_MOTION * 1.5 && Math.abs(vel) < c.STILL_VELOCITY;

            this.distStillMs = (off && calm) ? this.distStillMs + dt : 0;

            if (off && this.rep) {
                this.rep.bend = true;   // te estas moviendo de lugar: no cuenta
            }

            if (this.sinceCalMs > 1500 && this.distStillMs > 600) {
                this._recalibrate();
                return this._out("Calibrando... cambio de distancia");
            }
        }

        // Fases. Con pocos FPS una sentadilla completa son pocos cuadros, asi que
        // se encadenan las fases dentro del mismo cuadro en lugar de esperar
        // un frame por cada transicion.
        this._changed = false;
        let res = this._phase(d, now, dt, lowFps);
        let counted = res.counted;
        let n = 0;

        while (
            lowFps && this._changed && n < 3 &&
            (this.phase === "DESCENDING" || this.phase === "BOTTOM" || this.phase === "ASCENDING")
        ) {
            this._changed = false;
            const r2 = this._phase(d, now, 0, lowFps);
            counted = counted || r2.counted;
            res = r2;
            n++;
        }

        if (counted && !res.counted) {
            res = this._out("Sentadilla", true);
        }

        return res;
    }


    _phase(d, now, dt, lowFps) {

        const c = this.cfg;
        const b = this.baseline;
        const depth = this.depth;
        const vel = this.vel;
        const kneeStraight = d.knee === null || d.knee >= c.STANDING_KNEE_ANGLE - 5;
        const cf = lowFps ? 0 : 1;     // con pocos FPS un frame basta como confirmacion

        // ====================================================
        // DE PIE
        // ====================================================

        if (this.phase === "STANDING") {

            const still = this.motionEff < c.STILL_MOTION && Math.abs(vel) < c.STILL_VELOCITY;
            this.stillMs = still ? this.stillMs + dt : 0;

            // Te acercaste o alejaste de la camara: recalibrar.
            const ratio = b.mode === "hips" ? (d.torso || b.unit) / b.unit : 1;

            if (this.sinceCalMs > 1500 && this.stillMs > 0 && (ratio < 0.75 || ratio > 1.35)) {
                this.scaleOffMs += dt;
            } else {
                this.scaleOffMs = 0;
            }

            if (this.scaleOffMs > 800) {
                this._recalibrate();
                return this._out("Calibrando... cambio de distancia");
            }

            // La base sigue tus cambios lentos de postura cuando estas quieto.
            if (this.stillMs > 800 && kneeStraight && depth < 0.30) {
                const tau = Math.abs(depth) < c.DOWN_EXIT ? 1500 : 400;
                this._blendBaseline(d, SquatDetector._k(dt, tau));
            }

            const goingDown = depth > c.DOWN_START && vel > 0.02;

            this.downMs = goingDown ? this.downMs + dt : 0;

            if (goingDown && this.downMs >= c.DOWN_CONFIRM_MS * cf) {
                this.downMs = 0;
                this.rep = {
                    start: now,
                    max: depth,
                    bottomMs: 0,
                    riseMs: 0,
                    ascMin: depth,
                    valid: false,
                    bend: false,
                    counted: false
                };
                this._enter("DESCENDING", now);
                return this._out("Bajando...");
            }

            return this._out("Listo");
        }

        const r = this.rep;

        // ====================================================
        // BAJANDO
        // ====================================================

        if (this.phase === "DESCENDING") {

            r.max = Math.max(r.max, depth);

            if (this.bending) {
                r.bend = true;
            }

            const kneeBent =
                d.knee !== null &&
                d.knee <= c.KNEE_BOTTOM_ANGLE &&
                depth >= c.KNEE_BOTTOM_MIN_DEPTH;

            const atBottom = (depth >= c.BOTTOM_DEPTH || kneeBent) && !r.bend;

            r.bottomMs = atBottom ? r.bottomMs + dt : 0;

            if (atBottom && r.bottomMs >= c.BOTTOM_HOLD_MS * cf) {
                r.valid = true;
                r.riseMs = 0;
                this._enter("BOTTOM", now);
                return this._out("Fondo");
            }

            if (depth < c.DOWN_EXIT) {
                this.rep = null;
                this._enter("STANDING", now);
                this.stillMs = 0;
                return this._out("Movimiento incompleto");
            }

            if (r.max - depth > c.RISE_DELTA + 0.02 && vel < -0.05) {
                // Te arrepentiste antes de llegar al fondo.
                r.valid = false;
                r.ascMin = depth;
                this._enter("ASCENDING", now);
                return this._out("Subiendo...");
            }

            if (now - this.phaseStart > c.MAX_DESCENT_MS) {
                this.rep = null;
                this._enter("STANDING", now);
                this.stillMs = 0;
                return this._out("Listo");
            }

            return this._out("Bajando...");
        }

        // ====================================================
        // FONDO
        // ====================================================

        if (this.phase === "BOTTOM") {

            r.max = Math.max(r.max, depth);

            if (this.bending) {
                r.bend = true;
            }

            const rising = (r.max - depth) > c.RISE_DELTA && vel < -0.04;
            r.riseMs = rising ? r.riseMs + dt : 0;

            if (rising && r.riseMs >= c.RISE_CONFIRM_MS * cf) {
                r.ascMin = depth;
                this._enter("ASCENDING", now);
                return this._out("Subiendo...");
            }

            if (now - this.phaseStart > c.MAX_BOTTOM_MS && Math.abs(vel) < 0.05) {
                // Probablemente la calibracion quedo mal: empezar de nuevo.
                this._recalibrate();
                return this._out("Calibrando... recalibrando");
            }

            return this._out("Fondo");
        }

        // ====================================================
        // SUBIENDO
        // ====================================================

        if (this.phase === "ASCENDING") {

            r.ascMin = Math.min(r.ascMin, depth);

            let counted = false;

            if (
                r.valid &&
                !r.bend &&
                !r.counted &&
                depth <= r.max * c.COUNT_ASCENT_RATIO &&
                now - r.start >= c.MIN_REP_MS &&
                now - this.lastCount >= c.MIN_TIME_BETWEEN_SQUATS
            ) {
                r.counted = true;
                this.lastCount = now;
                counted = true;
            }

            // Volviste a bajar sin pararte del todo: nueva repeticion.
            if (depth - r.ascMin > c.RISE_DELTA + 0.02 && vel > 0.05) {
                this.rep = {
                    start: now,
                    max: depth,
                    bottomMs: 0,
                    riseMs: 0,
                    ascMin: depth,
                    valid: false,
                    bend: false,
                    counted: false
                };
                this._enter("DESCENDING", now);
                return this._out(counted ? "Sentadilla" : "Bajando...", counted);
            }

            if (depth < c.DOWN_EXIT) {
                this.rep = null;
                this._enter("STANDING", now);
                this.stillMs = 0;
                return this._out(counted ? "Sentadilla" : "Listo", counted);
            }

            if (now - this.phaseStart > c.MAX_ASCENT_MS) {
                this.rep = null;
                this._enter("STANDING", now);
                this.stillMs = 0;
                return this._out("Listo", counted);
            }

            return this._out(counted ? "Sentadilla" : "Subiendo...", counted);
        }

        return this._out("Listo");
    }


    // --------------------------------------------------------
    // Calibracion
    // --------------------------------------------------------

    _calibrate(d, dt, now) {

        const c = this.cfg;

        // Solo se rechaza si estas claramente agachado o moviendote mucho.
        const kneeOk = d.knee === null || d.knee >= c.CALIBRATION_MIN_KNEE;
        const still = this.motionEff < c.CALIBRATION_MAX_MOTION;

        if (!kneeOk || !still) {
            this.badMs = (this.badMs || 0) + dt;

            if (this.badMs > c.CALIBRATION_GRACE_MS) {
                this.cal = null;
                this.calMs = 0;
            }

            return this._out(
                !kneeOk
                    ? "Calibrando: ponte de pie"
                    : "Calibrando: qu\u00e9date quieto"
            );
        }

        this.badMs = 0;

        if (!this.cal) {
            this.cal = { n: 0, sx: 0, sy: 0, hx: 0, hy: 0, hn: 0, hcx: 0, hcy: 0, hcn: 0, t: 0, sw: 0, k: 0, kn: 0, hipYs: 0 };
        }

        const k = this.cal;
        k.n++;
        k.sx += d.shoulders.x;
        k.sy += d.shoulders.y;
        k.sw += d.sw;

        if (d.head) {
            k.hcx += d.head.x;
            k.hcy += d.head.y;
            k.hcn++;
        }

        if (d.hips) {
            k.hx += d.hips.x;
            k.hy += d.hips.y;
            k.t += d.torso;
            k.hn++;
            k.hipYs += d.hipY;
        }

        if (d.knee !== null) {
            k.k += d.knee;
            k.kn++;
        }

        this.calMs += dt;

        if (this.calMs >= c.CALIBRATION_MS && k.n >= c.CALIBRATION_MIN_SAMPLES) {

            const shoulders = { x: k.sx / k.n, y: k.sy / k.n };
            const head = k.hcn >= k.n * 0.6 ? { x: k.hcx / k.hcn, y: k.hcy / k.hcn } : null;

            // Modo caderas solo si se ven siempre y hay margen para bajar
            // sin salirse del encuadre. Si no, modo torso (hombros + cabeza).
            const hipsStable = k.hn >= k.n * 0.8 && (k.hipYs / k.hn) <= c.HIP_MAX_Y;

            if (hipsStable) {
                const hips = { x: k.hx / k.hn, y: k.hy / k.hn };
                const torso = k.t / k.hn;

                this.baseline = {
                    mode: "hips",
                    shoulders, head, hips, torso,
                    sw: k.sw / k.n,
                    unit: torso,
                    knee: k.kn ? k.k / k.kn : null,
                    axis: this._axis(shoulders, hips)
                };
            } else {
                const sw = k.sw / k.n;

                this.baseline = {
                    mode: "torso",
                    shoulders, head, hips: null, torso: null,
                    sw,
                    unit: sw * 1.25,
                    knee: null,
                    axis: { x: 0, y: 1 }
                };
            }

            this.cal = null;
            this.calMs = 0;
            this.depth = 0;
            this.vel = 0;
            this.rawHist.length = 0;
            this.depthHist.length = 0;
            this.stillMs = 0;
            this.downMs = 0;
            this.bending = false;
            this.sinceCalMs = 0;
            this._enter("STANDING", now);

            return this._out("Listo");
        }

        return this._out("Calibrando...");
    }
}


const detector = new SquatDetector();

// Mensaje de "+1 / -1" visible un instante antes de volver al estado normal.
let countMessageUntil = 0;

function resetDetector() {
    detector.reset();
    countMessageUntil = 0;
}

// ============================================================
// MEDIAPIPE
// ============================================================

const pose =
    new Pose({

        locateFile:
            file =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`

    });


pose.setOptions({

    modelComplexity: 1,

    smoothLandmarks: true,

    enableSegmentation: false,

    smoothSegmentation: false,

    minDetectionConfidence: 0.3,

    minTrackingConfidence: 0.4

});


pose.onResults(
    results => {

        if (!results.poseLandmarks) {

            if (detectorActive) {
                detector.lost(
                    performance.now(),
                    "No se detecta el cuerpo"
                );
            }

            stateElement.textContent =
                "No se detecta el cuerpo";

            return;
        }


        canvas.width =
            video.videoWidth;

        canvas.height =
            video.videoHeight;


        ctx.clearRect(
            0,
            0,
            canvas.width,
            canvas.height
        );


        if (detectorActive) {

            detectSquat(
                results.poseLandmarks
            );

        }

    }
);


// ============================================================
// DETECTOR
// ============================================================

function detectSquat(landmarks) {

    const aspect =
        video.videoWidth && video.videoHeight
            ? video.videoWidth / video.videoHeight
            : 16 / 9;

    const result =
        detector.update(
            landmarks,
            performance.now(),
            aspect
        );

    if (result.counted) {

        registerDetectedSquat();

        stateElement.textContent =
            detectorMode === "add"
                ? "\u{2705} \u{A1}+1 SENTADILLA!"
                : "\u{2705} \u{A1}-1 SENTADILLA!";

        countMessageUntil = performance.now() + 900;

        return;
    }

    if (performance.now() < countMessageUntil) {
        return;
    }

    stateElement.textContent = result.text;
}


// ============================================================
// DETENER / QUITAR C\u{C1}MARA
// ============================================================

function stopCamera() {

    detectorActive = false;

    // Detener el procesamiento de MediaPipe.
    if (camera) {
        try {
            if (typeof camera.stop === "function") {
                camera.stop();
            }
        } catch (error) {
            console.warn("No se pudo detener Camera:", error);
        }

        camera = null;
    }

    // Liberar realmente la c\u{E1}mara del navegador.
    if (video.srcObject) {
        const tracks = video.srcObject.getTracks();

        tracks.forEach(track => {
            try {
                track.stop();
            } catch {}
        });

        video.srcObject = null;
    }

    ctx.clearRect(
        0,
        0,
        canvas.width,
        canvas.height
    );

    canvas.width = 0;
    canvas.height = 0;

    resetDetector();

    startButton.disabled = false;
    pauseButton.disabled = true;
    pauseButton.textContent = "\u{23F8} Pausar detector";

    if (stopCameraButton) {
        stopCameraButton.disabled = true;
    }

    statusElement.textContent =
        "C\u{E1}mara detenida";

    stateElement.textContent =
        "C\u{E1}mara desconectada";
}


// ============================================================
// INICIAR C\u{C1}MARA
// ============================================================

startButton.addEventListener(
    "click",
    async () => {

        try {

            statusElement.textContent =
                "Solicitando c\u{E1}mara...";


            const stream =
                await navigator.mediaDevices
                    .getUserMedia({

                        video: {
                            width: 1280,
                            height: 720
                        },

                        audio: false

                    });


            video.srcObject =
                stream;


            await video.play();


            detectorActive =
                true;


            resetDetector();


            statusElement.textContent =
                "C\u{E1}mara activa";


            stateElement.textContent =
                "Ponte de pie para calibrar";


            startButton.disabled =
                true;


            pauseButton.disabled =
                false;

            stopCameraButton.disabled =
                false;


            camera =
                new Camera(
                    video,
                    {

                        onFrame:
                            async () =>
                                await pose.send({
                                    image: video
                                }),

                        width: 1280,

                        height: 720

                    }
                );


            camera.start();


        } catch (error) {

            console.error(error);


            statusElement.textContent =
                "Error de c\u{E1}mara";


            stateElement.textContent =
                "No se pudo acceder a la c\u{E1}mara";


            alert(
                "No se pudo acceder a la c\u{E1}mara.\n\n" +
                error.message
            );

        }

    }
);


// ============================================================
// PAUSAR
// ============================================================

pauseButton.addEventListener(
    "click",
    () => {

        detectorActive =
            !detectorActive;

        if (detectorActive) {
            resetDetector();
        }


        pauseButton.textContent =
            detectorActive
                ? "\u{23F8} Pausar detector"
                : "\u{25B6}\u{FE0F} Reanudar detector";


        stateElement.textContent =
            detectorActive
                ? "Detector activo"
                : "\u{23F8} Detector pausado";

    }
);


// ============================================================
// REINICIAR
// ============================================================

resetButton.addEventListener(
    "click",
    async () => {

        await resetCounter();

        resetDetector();

        if (detectorActive) {
            stateElement.textContent =
                "Ponte de pie para calibrar";
        } else {
            stateElement.textContent =
                "Detector reiniciado";
        }

    }
);


// ============================================================
// QUITAR C\u{C1}MARA
// ============================================================

stopCameraButton.addEventListener(
    "click",
    () => {
        stopCamera();
    }
);


// ============================================================
// CONFIGURACI\u{D3}N TWITCH
// ============================================================
// En la versi\u{F3}n web las credenciales se configuran en el servidor
// mediante variables de entorno. El Client Secret nunca se expone
// al navegador.

// ============================================================
// CONECTAR TWITCH
// ============================================================

connectTwitchButton.addEventListener(
    "click",
    async () => {

        const clientId = String(clientIdInput?.value || "").trim();
        const clientSecret = String(clientSecretInput?.value || "").trim();

        if (!clientId) {
            alert("Introduce el Client ID de Twitch.");
            clientIdInput?.focus();
            return;
        }

        if (!clientSecret) {
            alert("Introduce el Client Secret de Twitch.");
            clientSecretInput?.focus();
            return;
        }

        try {
            connectTwitchButton.disabled = true;
            connectTwitchButton.textContent = "Conectando...";

            await window.SQUAT_SESSION_READY;

            const response = await fetch("/api/twitch/credentials", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    clientId,
                    clientSecret
                })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || "No se pudieron guardar las credenciales.");
            }

            window.location.href =
                `/auth/twitch?session=${encodeURIComponent(
                    window.SQUAT_SESSION_ID
                )}`;

        } catch (error) {
            console.error("No se pudo iniciar la sesi\u{F3}n de Twitch:", error);
            alert("\u{274C} " + error.message);
            connectTwitchButton.disabled = false;
            connectTwitchButton.textContent = "\u{1F7E3} Conectar con Twitch";
        }
    }
);


// ============================================================
// DESVINCULAR TWITCH
// ============================================================

if (disconnectTwitchButton) {
    disconnectTwitchButton.addEventListener("click", async () => {
        if (!confirm("\u{BF}Quieres desvincular Twitch? Esto revocar\u{E1} la conexi\u{F3}n y tendr\u{E1}s que autorizar Twitch nuevamente.")) {
            return;
        }

        try {
            disconnectTwitchButton.disabled = true;
            const response = await fetch("/auth/twitch/disconnect", {
                method: "POST"
            });

            const data = await response.json();

            if (!response.ok || !data.ok) {
                throw new Error(data.error || "No se pudo desvincular Twitch.");
            }

            twitchWasConnected = false;
            twitchRewardsLoaded = false;
            await checkTwitchStatus();
            alert("Twitch fue desvinculado. Tu configuraci\u{F3}n de sentadillas permanece guardada.");
        } catch (error) {
            console.error("Error desvinculando Twitch:", error);
            alert("\u{274C} " + error.message);
        } finally {
            disconnectTwitchButton.disabled = false;
        }
    });
}


// ============================================================
// ESTADO TWITCH
// ============================================================

async function checkTwitchStatus() {

    try {

        const response = await fetch("/api/status");
        const data = await response.json();

        const connected = Boolean(
            data.twitch && data.twitch.connected
        );

        if (connected) {

            twitchStatus.textContent =
                `Conectado como ${data.twitch.user?.display_name || "canal"}`;

            twitchStatus.classList.add("connected");
            connectTwitchButton.textContent = "Twitch conectado";
            connectTwitchButton.disabled = true;
            if (disconnectTwitchButton) disconnectTwitchButton.style.display = "inline-flex";

            // Cargar una sola vez por conexi\u{F3}n.
            // IMPORTANTE: NO llamar loadTwitchRewards() en cada polling.
            if (!twitchWasConnected || !twitchRewardsLoaded) {
                twitchWasConnected = true;
                twitchRewardsLoaded = true;
                await loadTwitchRewards();
                await loadTwitchConfig();
            }

        } else {

            twitchStatus.textContent = "No conectado";
            twitchStatus.classList.remove("connected");
            connectTwitchButton.textContent = "Conectar con Twitch";
            connectTwitchButton.disabled = false;
            if (disconnectTwitchButton) disconnectTwitchButton.style.display = "none";

            twitchWasConnected = false;
            twitchRewardsLoaded = false;
        }

    } catch (error) {

        console.error("Error comprobando Twitch:", error);

    }

}


// ============================================================
// CARGAR CONFIGURACI\u{D3}N TWITCH
// ============================================================

async function loadTwitchConfig() {

    try {

        const response =
            await fetch(
                "/api/twitch/config"
            );


        const data =
            await response.json();


        if (data.clientId) {

            clientIdInput.value =
                data.clientId;
            clientIdInput.readOnly = false;

        }


        if (data.bitsPerBlock) {

            bitsAmountInput.value =
                data.bitsPerBlock;

        }


        if (data.squatsPerBlock) {

            bitsSquatsInput.value =
                data.squatsPerBlock;

        }

    } catch (error) {

        console.error(
            "Error cargando configuraci\u{F3}n:",
            error
        );

    }

}


// ============================================================
// CARGAR RECOMPENSAS DE TWITCH
// ============================================================

async function loadTwitchRewards() {

    try {

        const response =
            await fetch(
                "/api/twitch/rewards"
            );


        const data =
            await response.json();


        if (!response.ok) {

            throw new Error(
                data.error ||
                "No se pudieron obtener las recompensas."
            );

        }


        rewardsList.innerHTML = "";


        if (
            !data.rewards ||
            data.rewards.length === 0
        ) {

            rewardsList.innerHTML =
                `
                <div class="rewards-description">
                    No tienes recompensas personalizadas creadas.
                </div>
                `;

            rewardsContainer.style.display =
                "block";

            return;
        }


        data.rewards.forEach(
            reward => {

                const savedValue =
                    data.mappings?.[reward.id] ??
                    0;


                const item =
                    document.createElement(
                        "div"
                    );


                item.className =
                    "reward-item";


                item.innerHTML =
                    `
                    <div class="reward-info">

                        <div class="reward-name">
                            ${escapeHtml(
                                reward.title
                            )}
                        </div>

                        <div class="reward-cost">
                            ${reward.cost.toLocaleString()}
                            puntos
                        </div>

                    </div>

                    <input
                        class="reward-value"
                        type="number"
                        min="0"
                        value="${savedValue}"
                        data-reward-id="${reward.id}"
                        placeholder="0"
                    >
                    `;


                rewardsList.appendChild(
                    item
                );

            }
        );


        rewardsContainer.style.display =
            "block";


    } catch (error) {

        console.error(
            "Error cargando recompensas:",
            error
        );

        rewardsContainer.style.display =
            "block";


        rewardsList.innerHTML =
            `
            <div class="rewards-description">
                \u{26A0}\u{FE0F} ${escapeHtml(
                    error.message
                )}
            </div>
            `;

    }

}


// ============================================================
// GUARDAR VALORES DE RECOMPENSAS
// ============================================================

saveRewardsButton.addEventListener(
    "click",
    async () => {

        const inputs =
            document.querySelectorAll(
                ".reward-value"
            );


        const mappings = [];


        inputs.forEach(
            input => {

                const rewardId =
                    input.dataset.rewardId;


                const squats =
                    Math.max(
                        0,
                        Math.floor(
                            Number(
                                input.value
                            ) || 0
                        )
                    );


                mappings.push({

                    rewardId,

                    squats

                });

            }
        );


        try {

            const response =
                await fetch(
                    "/api/twitch/reward-mappings",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify({
                            mappings
                        })
                    }
                );


            const data =
                await response.json();


            if (!response.ok) {

                throw new Error(
                    data.error ||
                    "No se pudieron guardar."
                );

            }


            // El servidor ya guard\u{F3} los valores en la sesi\u{F3}n.
            // No recargamos las recompensas aqu\u{ED} porque eso reconstruir\u{ED}a
            // los inputs y podr\u{ED}a reemplazar lo que acaba de escribir el usuario.
            twitchRewardsLoaded = true;

            alert(
                "\u{2705} Valores de recompensas guardados."
            );


        } catch (error) {

            alert(
                "Error: " +
                error.message
            );

        }

    }
);


// ============================================================
// GUARDAR BITS
// ============================================================

saveBitsButton.addEventListener(
    "click",
    async () => {

        const bitsPerBlock =
            Math.max(
                1,
                Math.floor(
                    Number(
                        bitsAmountInput.value
                    ) || 1
                )
            );


        const squatsPerBlock =
            Math.max(
                1,
                Math.floor(
                    Number(
                        bitsSquatsInput.value
                    ) || 1
                )
            );


        try {

            const response =
                await fetch(
                    "/api/twitch/bits-config",
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify({

                            bitsPerBlock,

                            squatsPerBlock

                        })
                    }
                );


            const data =
                await response.json();


            if (!response.ok) {

                throw new Error(
                    data.error ||
                    "No se pudo guardar."
                );

            }


            alert(
                "\u{2705} Configuraci\u{F3}n de Bits guardada."
            );


        } catch (error) {

            alert(
                "Error: " +
                error.message
            );

        }

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


// ========================================================
// INICIALIZACI\u{D3}N
// ========================================================

connectWebSocket();

loadCounter();

checkTwitchStatus();

setInterval(
    checkTwitchStatus,
    5000
);

updateCounter();