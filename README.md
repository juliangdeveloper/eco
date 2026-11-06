# Eco

Agente de IA que corre en tu navegador, sin servidor. Conversa con un modelo de OpenRouter, usa herramientas y se conecta directamente a GitHub y Gmail.

![Eco](assets/screenshot.png)

## Uso

1. Abre la app en GitHub Pages.
2. En **Ajustes** pon tu clave de OpenRouter y, si quieres, el modelo (por defecto `openrouter/auto`).
3. Escribe. Las acciones que escriben (archivos, pull requests, borradores, habilidades) piden tu aprobación antes de ejecutarse.

## Configuración

- **OpenRouter**: clave de API de openrouter.ai.
- **GitHub** (opcional): token fine-grained con acceso a los repos que elijas y permisos Metadata: read, Contents: read and write, Issues: read, Pull requests: read and write. Sin token solo lee repos públicos.
- **Gmail** (opcional): Client ID OAuth 2.0 de Google tipo «Aplicación web», con la API de Gmail habilitada, el origen JavaScript autorizado igual al de tu Pages (`https://<usuario>.github.io`) y los scopes `gmail.readonly` y `gmail.compose`. Luego toca **Conectar Gmail**.

## Herramientas

- `memory`, `todo_list`, `skills_list`, `skill_view`, `skill_manage`, `session_search`, `clarify`
- `delegate_task`: encarga una tarea a un subagente con contexto limpio y recibe su resumen.
- GitHub: `github_list_repos`, `github_list_issues`, `github_list_prs`, `github_read_file`, `github_write_file`, `github_create_pr`
- Gmail: `gmail_search`, `gmail_read`, `gmail_create_draft` (no envía correos)

Las APIs se definen de forma declarativa en `py/eco/apis.py` (URL base, autenticación bearer u OAuth de Google, rutas y parámetros).

El historial largo se resume automáticamente para no exceder el contexto. Las respuestas se muestran con formato Markdown seguro (sin HTML; solo enlaces http y https).

## Privacidad

Claves, tokens, sesiones, memoria y habilidades se guardan solo en el navegador (localStorage e IndexedDB). Las llamadas van directo del navegador a OpenRouter, GitHub y Google.

## Local

```sh
python3 -m http.server
```

## Licencia

MIT. Basada en Hermes Agent de Nous Research (MIT). Usa Pyodide (MPL-2.0) desde CDN. Ver [LICENSE](LICENSE).
