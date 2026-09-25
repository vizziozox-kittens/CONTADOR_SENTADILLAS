# Squat Twitch - versión web

Esta versión está preparada para ejecutarse como servidor Node/Express y ser accesible desde una URL pública.

## Variables de entorno

Configura en el hosting:

- `PUBLIC_URL`: URL pública del servicio, por ejemplo `https://tu-app.onrender.com`
- `TWITCH_CLIENT_ID`: Client ID de Twitch
- `TWITCH_CLIENT_SECRET`: Client Secret de Twitch
- `TWITCH_REDIRECT_URI`: `https://tu-app.onrender.com/auth/twitch/callback`

El Client Secret no debe guardarse en HTML, JavaScript del navegador, Git ni un archivo público.

## Twitch

En el Developer Console de Twitch registra exactamente `TWITCH_REDIRECT_URI` como OAuth Redirect URL.

## Ejecutar localmente

```bash
npm install
npm start
```

## Rutas principales

- `/` - panel principal
- `/obs.html` - vista OBS
- `/contador.html` - contador para Browser Source
- `/controles.html` - controles para OBS
- `/auth/twitch` - inicio de OAuth de Twitch
- `/auth/twitch/callback` - callback OAuth
- `/prueba` - health check
- `/ws` - WebSocket en tiempo real

## Nota de arquitectura

La versión actual mantiene un único estado global de contador y una única conexión Twitch para el servidor. Esto es apropiado para un streamer que comparte el contador con sus espectadores. Para permitir que muchos streamers usen el sitio con canales Twitch independientes habría que añadir cuentas/sesiones y una base de datos.
