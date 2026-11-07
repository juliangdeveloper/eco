# 🌱 eco

**Browser AI agent with local memory, passive protocol skills, shared Google Sheets memory, remote MCP tools and private OAuth credentials.**

> Conversa, usa herramientas y comparte recuerdos entre tus Ecos.

[Demo](https://juliangdeveloper.github.io/eco/) · Versión 0.4.4

<img src="assets/screenshot.png?v=0.4.4" alt="Eco en pantalla móvil con memoria local" width="320">

## Uso

- En **Ajustes**, introduce tu clave de OpenRouter. Modelo por defecto: `deepseek/deepseek-v4.1-flash-1017`.
- Pide «Conéctate a GitHub» u otro servicio: Eco busca su MCP remoto oficial; usa API HTTP si no existe MCP compatible. El servicio debe permitir CORS.
- Las credenciales se introducen en una tarjeta, cifradas con AES-GCM en IndexedDB; el modelo no las recibe. Las escrituras en conectores requieren aprobación; la memoria conectada guarda sin pedirla.
- Conversaciones, tareas, habilidades y memoria local permanecen en el navegador. Hay búsqueda, subagentes, compresión a 128.000 tokens e historial de resultados completos con `leer_resultado`.
- El botón de actualizar recarga Eco con la última versión, útil cuando se abre dentro de otra página sin controles del navegador.
- Cada turno permite 35 pasos (20 en subagentes); al alcanzar el límite, Eco resume y puedes pedir que siga.

## Google Drive: memoria compartida y archivos

1. Pide «Conéctate a mi Drive» y pega tu propio Client ID en la tarjeta de inicio de sesión.
2. Autoriza Google, elige un nombre corto para este Eco y tu alias. Pega la URL/ID de una hoja compatible o deja el campo vacío para crear **Eco · Memoria**.
3. Conecta la misma hoja en otro dispositivo con un nombre de Eco diferente. Cada cuenta necesita permiso de edición sobre la hoja.
4. Pide guardar, buscar o leer novedades. `memoria_guardar`, `memoria_buscar` y `memoria_leer_nuevos` se activan junto con la habilidad pasiva solo mientras el destino está conectado. El mismo inicio de sesión crea el conector **Google Drive · archivos** para buscar, leer, exportar, crear, renombrar o enviar a la papelera tus archivos; sus escrituras piden aprobación. «Desconecta mi memoria» vuelve al modo local sin borrar la hoja ni el acceso guardado en Conectores.

La hoja usa `_eco` (protocolo `eco-memoria`, versión 1) y `records`: `id`, `fecha`, `eco_autor`, `usuario_autor`, `tipo`, `para`, `hilo`, `responde_a`, `contenido`, `etiquetas`, `reemplaza_a`. Recuerdos, datos, mensajes y acuses se añaden sin sobrescribir. Las correcciones apuntan al registro anterior. Se comprueba el UUID al reintentar; no hay unicidad garantizada entre clientes concurrentes.

La lectura es incremental por hoja y Eco; no recibe avisos en tiempo real. Cada navegador limita sus peticiones de memoria a una cada 2,5 segundos. Los autores son declarados y el contenido compartido nunca constituye órdenes ni permisos. No se exporta automáticamente la memoria local ni se guardan contraseñas.

## OAuth

En Google Cloud habilita **Google Sheets API** y **Google Drive API**. Configura el consentimiento externo, añade tu cuenta como usuario de prueba y los permisos `https://www.googleapis.com/auth/spreadsheets` y `https://www.googleapis.com/auth/drive`. Crea un Client ID tipo **Aplicación web** con:

- Origen JavaScript autorizado: `https://<usuario>.github.io`
- URI de redirección: `https://<usuario>.github.io/eco/oauth.html`

La tarjeta incluye enlaces en pestaña nueva y botones para copiar los valores exactos. Google usa token implícito con renovación silenciosa; si el navegador la bloquea o expira el acceso, vuelve a iniciar sesión desde **Ajustes › Conectores**. Para Gmail habilita su API y los permisos correspondientes.

## Stack y ejecución local

JavaScript ES, HTML/CSS, Pyodide/Python, OpenRouter, IndexedDB y service worker. Ejecuta `python3 -m http.server` y abre la dirección local.

## Licencia

MIT. Inspirada en el diseño de [Hermes Agent](https://github.com/NousResearch/hermes-agent) de Nous Research. Pyodide (MPL-2.0) desde CDN. Ver [LICENSE](LICENSE).
