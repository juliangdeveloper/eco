# 🌱 eco

Agente SI en el navegador que conversa, crea herramientas y adapta su memoria al stack del usuario.

[Demo](https://juliangdeveloper.github.io/eco/) · Versión 0.13.0

<img src="assets/screenshot.png?v=0.13.0" alt="Inicio de Eco en pantalla móvil" width="320">

## Uso

- Introduce tu clave de OpenRouter en **Ajustes** y elige modelo.
- Pide conectar tus servicios. Eco consulta su documentación y usa MCP remoto o APIs HTTP compatibles con CORS.
- Las credenciales se introducen en tarjetas y se cifran con AES-GCM en IndexedDB; el modelo no las recibe.
- Conversaciones, tareas, habilidades y memoria local quedan en el navegador. Incluye subagentes, citas, búsqueda e historial de resultados.
- **Actualizar** o `eco_actualizar` guarda y reanuda el trabajo. Una recarga normal no repite turnos interrumpidos.
- Las rutinas realizan comprobaciones con código y activan un turno solo cuando corresponde. Requieren Eco abierto.

## Memoria compartida

Conecta una hoja de cálculo o una base de datos usando su conexión HTTP/MCP. La habilidad pasiva se adapta al destino. Otros Ecos y agentes SI con acceso pueden seguir el mismo protocolo; los autores y registros nunca son permisos.

`eco-memoria` v4 usa nombres en inglés:

- `_eco`: `key,value`, con protocolo, versión, tablas, columnas y reglas.
- `memories` y `messages`: `id,date,eco_author,user_author,type,to,thread,reply_to,content,tags,replaces`.
- Tipos: `memory` y `fact` en `memories`; `message` y `ack` en `messages`.
- `agents`: `id,class,model,alias,preferences,stack,peripherals,status,version,updated`.
- `routines`: `id,name,owner,agent_id,schedule,timezone,trigger,description,stack,status,updated`.

`memoria_guardar` añade registros; `memoria_buscar` filtra por `content,tags,eco_author,thread,type,id`; `memoria_leer_nuevos` mantiene un cursor por tabla. Conserva el UUID al reintentar. Las correcciones usan `replaces` y las respuestas `reply_to`. No se exporta automáticamente la memoria local ni se guardan secretos.

`memoria_agentes` admite `action=listar` o `actualizar`; solo permite cambiar `preferences` y `stack` propios. Eco asigna el resto y renueva su presencia cada tres minutos.

`memoria_rutinas` lista o actualiza solo las filas del propio `agent_id`. La app asigna `owner` con el alias del dueño, `agent_id` y `updated`. `description` debe detallar objetivo, pasos, entradas y resultado esperado, con la ruta completa de cualquier documento mencionado. `stack` enumera herramientas y conexiones necesarias, sin secretos. Usa `status=activa,pausada,borrada`. Este directorio no ejecuta ni agenda: crea las rutinas con `rutina_crear` y registra sus cambios explícitamente.

### Hojas de cálculo

Pide conectar la memoria, autoriza el acceso, elige un nombre único para cada Eco y tu alias. Puedes indicar una hoja compatible o dejar que reutilice una existente. Cada cuenta necesita permiso de edición. El acceso también permite conectar archivos.

Las hojas v2/v3 migran a v4 en un único `batchUpdate`: nombres de pestañas, encabezados y tipos, traslado de confirmaciones a `messages`, nueva columna `stack` vacía en rutinas existentes y actualización de `_eco`. Los registros antiguos se trasladan y su pestaña original se retira en ese mismo lote. Evita clientes antiguos escribiendo durante la migración. Se conservan UUID y cursores; protocolos desconocidos o encabezados incompatibles se rechazan. La búsqueda usa filtros de servidor con recorrido por lotes de 100 filas como alternativa.

Para OAuth habilita las APIs de hojas y archivos y configura un cliente web con origen `https://<usuario>.github.io` y redirección `https://<usuario>.github.io/eco/oauth.html`. La tarjeta permite copiar los valores exactos; nunca necesita secreto de cliente. Al vencer el acceso aparece **Reconectar** y Eco sigue local.

### Bases de datos

Reutiliza un conector HTTP/MCP o conecta un destino PostgREST. La habilidad incluye el contrato y SQL de inicialización/migración: renombra columnas con `ALTER TABLE`, convierte tipos y añade `stack` vacío en rutinas existentes dentro de una transacción. Ejecuta la migración con acceso autorizado antes de reconectar. El adaptador valida v4; PostgREST no ejecuta DDL. La base asigna `date`; las novedades usan `date,id`. En PostgREST, `tags` es `text[]`; en herramientas, texto separado por comas.

El SQL mantiene RLS y no abre acceso anónimo. Una clave con privilegios que elude RLS solo debe usarse en un navegador personal de confianza. Los nombres de agentes no sustituyen autenticación ni políticas del servidor. El modo SQL genérico requiere un motor compatible con `MERGE` y `FETCH FIRST`; otros dialectos necesitan adaptar el puente.

## Dispositivo y seguridad

Eco descubre capacidades y crea herramientas según las APIs disponibles. Los permisos y restricciones del navegador siguen siendo obligatorios. Las herramientas se ejecutan en un entorno aislado; el mediador permite solo las operaciones solicitadas.

En **Ajustes › Borrado seguro** configura una palabra exclusiva. Se guarda un hash PBKDF2 con sal, no la palabra. El borrado local detiene tareas, elimina almacenamiento y cachés de Eco y avisa a sus otras pestañas; no revoca accesos ni borra datos remotos. También admite una orden verificada en chat o en memoria conectada mientras Eco esté abierto. Es un borrado de mejor esfuerzo, no forense.

## Ejecución local

JavaScript ES, HTML/CSS, Pyodide, IndexedDB y service worker. Ejecuta `python3 -m http.server` y abre la dirección local. Requiere un navegador moderno e internet para el modelo y los servicios.

## Aviso y licencia

Proyecto experimental: ejecuta acciones sin confirmación y no ha pasado una auditoría de seguridad. Usa cuentas y datos adecuados al riesgo. MIT; consulta [LICENSE](LICENSE).
