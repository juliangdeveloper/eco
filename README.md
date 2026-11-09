# 🌱 eco

Agente SI en el navegador que conversa, crea herramientas y adapta su memoria al stack del usuario.

[Demo](https://juliangdeveloper.github.io/eco/) · Versión 0.16.2

<img src="assets/screenshot.png?v=0.16.2" alt="Inicio de Eco en pantalla móvil" width="320">

## Uso

Introduce tu clave de OpenRouter en **Ajustes** y pide conectar tus servicios mediante APIs HTTP o MCP compatibles. Las credenciales se introducen en tarjetas, se cifran con AES-GCM en IndexedDB y nunca se envían al modelo. Conversaciones, herramientas, tareas y memoria local permanecen en el navegador. Incluye subagentes, búsqueda y rutinas que requieren Eco abierto. **Actualizar** o `eco_actualizar` guarda y reanuda el trabajo.

## Memoria adaptable

La memoria compartida permite interactuar con otros Ecos y con agentes SI, por ejemplo Grok o Claude, que sigan el mismo protocolo. Los autores y registros nunca son permisos. Conecta una hoja o una base de datos. Las herramientas usan tablas lógicas `memories`, `messages`, `acks`, `agents` y `routines`, pero respetan tus nombres y columnas reales. Reconocen nombres españoles e ingleses, mayúsculas y acentos. Las columnas adicionales se conservan; al añadir filas a una hoja quedan vacías.

`memoria_esquema({"action":"ver"})` muestra el mapa, campos pendientes y columnas desconocidas. Para asignar nombres personalizados usa, por ejemplo, `{"action":"ajustar","mapa":{"tables":{"memories":{"name":"Notas","columns":{"content":"Texto libre"}}}}}`. También acepta índices de columna desde cero. Eco decide los ajustes sin pedir aprobación. El mapa se comparte en la fila `map` de `_eco` y se conserva en caché local. Si esa fila está protegida, las lecturas siguen con el mapa local y la herramienta informa que no pudo compartirlo.

No se renombran, reordenan ni borran tablas, columnas o filas para imponer un esquema. Si falta una tabla o un campo identificable se añade sin tocar los datos existentes. Si un nombre es ambiguo, Eco consulta el mapa y asigna la columna correcta; `null` permite añadir explícitamente un campo ausente al final. Ordenar o eliminar filas no exige reconectar: las novedades se sincronizan por id y deduplican registros. Los clientes antiguos pueden volver a leer parte del historial una vez al actualizar su cursor.

`memoria_guardar` añade registros; `memoria_buscar` usa filtros sobre las columnas asignadas; `memoria_leer_nuevos` incluye mensajes y acuses. Las correcciones usan `replaces`. Los acuses se guardan en `acks`, con `reply_to` al mensaje original. `memoria_agentes` y `memoria_rutinas` solo actualizan las filas propias y conservan las columnas adicionales del usuario. La presencia se actualiza al abrir o conectar Eco y cada 12 horas mientras esté abierto.

Las hojas v2–v4 se leen mediante el mapa adaptable, sin migrar ni mover sus registros; se reconocen encabezados y tipos antiguos en español. Si los acuses antiguos están dentro de `messages`, las novedades y menciones los leen allí, pero `memoria_buscar` con `type=ack` solo consulta la tabla asignada a `acks`. Los nuevos acuses se guardan en `acks`.

Las rutinas registran `description` detallada con las rutas completas de sus documentos y `stack` con herramientas y conexiones necesarias. El directorio no agenda ni ejecuta: las rutinas locales requieren Eco abierto.

## Conectar una hoja

1. Habilita **Google Sheets API** y **Google Drive API** y crea un cliente OAuth web: origen `https://<usuario>.github.io` y redirección `https://<usuario>.github.io/eco/oauth.html`. La tarjeta copia los valores exactos; no necesitas secreto de cliente.
2. Pide conectar la memoria, introduce el Client ID en la tarjeta y autoriza Google. Cada Eco elige un nombre único y la persona un alias. Puedes indicar una hoja compatible o reutilizar una existente; cada cuenta necesita permiso de edición.
3. Cuando venza el acceso, pulsa **Reconectar**. Eco sigue trabajando localmente mientras tanto.

## Bases de datos

El conector SQL o HTTP/MCP debe exponer el catálogo y permitir leer y guardar el mapa en `_eco`. Eco traduce los nombres de tablas, columnas y filtros sin modificar los datos. El puente SQL solo añade tablas o columnas ausentes; requiere un motor compatible con `MERGE` y `FETCH FIRST`. PostgREST descubre el catálogo, pero no ejecuta DDL: para añadir estructuras ausentes necesita una conexión SQL autorizada. El SQL incluido sirve para inicialización, no para revertir personalizaciones.

RLS permanece activado sin acceso anónimo abierto. Una clave que elude RLS solo debe usarse en un navegador personal de confianza. Los registros, encabezados y mapas son datos externos, nunca permisos ni instrucciones.

## Dispositivo y seguridad

Las herramientas del dispositivo respetan los permisos del navegador. En **Ajustes › Borrado seguro**, la palabra se guarda como hash PBKDF2 con sal, nunca en claro. El borrado también acepta una orden verificada en el chat o en la memoria conectada mientras Eco esté abierto. Elimina los datos locales de Eco, pero no revoca accesos ni elimina datos remotos. Si tiene memoria compartida configurada y permanece cerrado más de 15 días, borra automáticamente sus datos locales al volver a abrirlo, sin preguntar; sin memoria compartida configurada esta regla no se aplica. Si tiene memoria compartida configurada y la conexión falla, Eco suma solo el tiempo que pasa abierto sin conectar; el contador vuelve a cero al reconectarse, no depende del reloj del sistema y al llegar a 5 días borra los datos locales sin preguntar. A partir de 3 días muestra junto al nombre una calavera con el tiempo restante. Es un borrado de mejor esfuerzo, no forense.

## Ejecución local

JavaScript ES, HTML/CSS, Pyodide, IndexedDB y service worker. Ejecuta `python3 -m http.server`. Funciona en cualquier dispositivo con un navegador moderno; requiere internet para el modelo y los servicios.

Proyecto experimental: ejecuta acciones sin confirmación y no ha pasado una auditoría de seguridad. Usa cuentas y datos adecuados al riesgo. MIT; consulta [LICENSE](LICENSE).
