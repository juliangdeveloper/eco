# Eco

Agente de IA que corre en tu navegador, sin servidor. Conversa con un modelo de OpenRouter, usa herramientas y se conecta a servidores MCP remotos o a APIs externas.

![Eco](assets/screenshot.png)

## Uso

1. Abre la app en GitHub Pages.
2. En **Ajustes** pon tu clave de OpenRouter y, si quieres, el modelo (por defecto `deepseek/deepseek-v4.1-flash-1017`).
3. Pide lo que necesites, por ejemplo «Conéctate a GitHub». Eco busca el servidor MCP oficial del servicio, crea el conector y te muestra un formulario seguro para pegar tu token.

## Conectores

### MCP remotos

- Eco busca el servidor MCP remoto oficial del servicio, comprueba con `probe_mcp` que responda desde el navegador y si pide token, y lo crea con `create_connector` y `mcp_url`.
- Transporte Streamable HTTP con JSON-RPC 2.0: `initialize`, `notifications/initialized`, `tools/list` y `tools/call`, con `Mcp-Session-Id`, `MCP-Protocol-Version` y respuestas JSON o SSE.
- Acceso sin credencial o con token Bearer. El conector queda «Conectado» solo si `tools/list` responde con tu token; si el servicio lo rechaza, la tarjeta te lo dice y el token no se guarda.
- Las herramientas del servidor se cargan como herramientas nativas del modelo con el prefijo del conector (por ejemplo `github__get_me`), hasta 60 en total, primero las de solo lectura. Las que no se declaran de solo lectura piden tu aprobación.
- El servidor tiene que permitir CORS; los MCP locales no se pueden usar desde una página web.

### APIs HTTP

- Se crean con la herramienta `create_connector`: URL base, tipo de acceso y operaciones HTTP. Eco crea el conector y te muestra directamente la tarjeta para iniciar sesión; solo las operaciones de escritura piden tu aprobación.
- Acceso: token, clave de API (cabecera o query), usuario y contraseña, u OAuth 2 (código con PKCE o token implícito) con tu propio Client ID.
- Las credenciales se cifran con AES-GCM usando una clave no exportable guardada en IndexedDB y solo se descifran al hacer la petición. El modelo nunca las ve: solo sabe si el conector está conectado.
- En **Ajustes › Conectores** puedes conectar, quitar el acceso o eliminar cada conector.

### OAuth (por ejemplo Gmail)

Crea un Client ID OAuth tipo «Aplicación web» en la consola del servicio (en Google: Google Cloud Console, con la API de Gmail habilitada) y autoriza:

- Origen JavaScript: el origen de tu Pages, `https://<usuario>.github.io`
- URL de redirección: `https://<usuario>.github.io/eco/oauth.html`

Eco nunca trae un Client ID propio: cada persona usa el suyo. La tarjeta de inicio de sesión incluye una guía paso a paso y botones para copiar el origen y la URL de redirección exactos. La guía de la tarjeta de inicio de sesión enlaza cada página de la consola del proveedor en una pestaña nueva. Pega el Client ID cuando Eco te lo pida.

### Renovación automática

Al crear un conector OAuth, Eco elige cómo renovar el acceso: con refresh token si el servicio lo entrega o, como en Google, con una renovación silenciosa (`prompt=none`). Mientras la página esté abierta, una tarea programada renueva cada acceso unos minutos antes de que expire, sin pedirte nada. Si el navegador o el servicio no lo permiten, el conector queda como «Expirado» y Eco te pide iniciar sesión la próxima vez que lo uses.

## Herramientas

`create_connector`, `probe_mcp`, `list_connectors`, `call_connector`, `request_sign_in`, las herramientas de cada MCP conectado, `memory`, `todo_list`, `skills_list`, `skill_view`, `skill_manage`, `session_search`, `clarify` y `delegate_task` (encarga una tarea a un subagente con contexto limpio).

El historial largo se resume automáticamente. Las respuestas se muestran con formato Markdown seguro.

## Privacidad

Todo se guarda solo en tu navegador (localStorage e IndexedDB). Las llamadas van directo del navegador a OpenRouter y a los servicios que conectes.

## Local

```sh
python3 -m http.server
```

## Licencia

MIT. Basada en Hermes Agent de Nous Research (MIT). Usa Pyodide (MPL-2.0) desde CDN. Ver [LICENSE](LICENSE).
