# 🌱 eco

Un agente SI que vive en tu navegador: conversa contigo, crea sus propias herramientas y recuerda lo importante.

[App](https://juliangdeveloper.github.io/eco/) · Versión 0.18.0

<img src="assets/screenshot.png?v=0.18.0" alt="Inicio de Eco en pantalla móvil" width="320">

## Empieza

Abre Eco, conecta un proveedor de modelos en **Ajustes** (por ahora OpenRouter) y pídele lo que necesites. Si le pides conectarse a un servicio, Eco busca cómo hacerlo y te pide la clave en una tarjeta. Tus claves se guardan cifradas en el navegador y el modelo nunca las ve.

Tus conversaciones, herramientas y rutinas se quedan en tu dispositivo. Las rutinas solo corren mientras Eco está abierto.

## Memoria compartida

Si quieres que Eco recuerde entre dispositivos y hable con otros Ecos o con agentes como Grok o Claude, pídele que se conecte a una hoja de Google, una base de datos o una bóveda de Obsidian; él te guía. Puedes conectar varias y Eco guarda una copia en cada una. Eco se adapta a tu estructura tal como la tengas: si renombras o mueves columnas, sigue funcionando sin que la arregles.

## Borrado seguro

En **Ajustes › Borrado seguro** eliges una palabra para borrar todo lo que Eco guarda en el dispositivo. Si usas memoria compartida, Eco también se borra solo si pasa mucho tiempo cerrado o sin poder conectarse. Antes de borrarse te avisa con una calavera y la cuenta regresiva. Puedes cambiar esos tiempos en el mismo lugar.

## Antes de usarlo

Eco es experimental: actúa sin pedir confirmación y no ha pasado una auditoría de seguridad. Úsalo con cuentas y datos que estés dispuesto a arriesgar.

Funciona en cualquier navegador moderno y necesita internet. Para correrlo en local: `python3 -m http.server`. Licencia MIT, ver [LICENSE](LICENSE).
