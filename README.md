# 🌱 eco

**Browser AI agent with local memory, passive protocol skills, shared Google Sheets memory, remote MCP tools and private OAuth credentials.**

> Conversa, usa herramientas y comparte recuerdos entre tus Ecos.

[Demo](https://juliangdeveloper.github.io/eco/) · Versión 0.9.4

<img src="assets/screenshot.png?v=0.9.4" alt="Ajustes de Eco en pantalla móvil" width="320">

## Uso

- En **Ajustes**, introduce tu clave de OpenRouter. Modelo por defecto: `deepseek/deepseek-v4.1-flash-1017`.
- Pide «Conéctate a GitHub» u otro servicio: Eco busca su MCP remoto oficial; usa API HTTP si no existe MCP compatible. El servicio debe permitir CORS.
- Las credenciales se introducen en una tarjeta, cifradas con AES-GCM en IndexedDB; el modelo no las recibe. Las acciones se ejecutan sin confirmaciones de Eco; solo se solicitan credenciales ausentes y la palabra del borrado seguro.
- Conversaciones, tareas, habilidades y memoria local permanecen en el navegador. Hay búsqueda, subagentes, compresión a 128.000 tokens e historial de resultados con `leer_resultado`.
- La memoria local admite 6.000 caracteres (perfil: 3.000). `memory` reemplaza o elimina por fragmento único o `index` desde 0, muestra candidatos si hay ambigüedad y devuelve espacio usado y libre; al exceder el límite, indica el exceso y las entradas actuales con índice y tamaño.
- `leer_resultado` no añade lecturas al historial. Devuelve fragmentos literales de hasta 128 KiB (131.072 bytes UTF-8), también por defecto; `offset`, `limit`, `total` y `siguiente_offset` se miden en bytes. No corta caracteres multibyte. HTTP y MCP conservan respuestas en el historial (hasta 64 resultados y 8 MiB por conversación o subagente; se retiran los más antiguos); la vista del modelo se resume por encima de 128 KiB.
- Eco abre la última conversación activa. Cada mensaje y turno pendiente se guarda al añadirlo, en IndexedDB, sin duplicar conversaciones en localStorage. Reintenta fallos temporales; ante falta de espacio retira primero resultados antiguos, nunca mensajes, y solicita almacenamiento persistente si el navegador lo admite. Un aviso separado permite **Reintentar guardar** y desaparece al completar el guardado. Una recarga normal no repite turnos interrumpidos.
- Desliza cualquier mensaje hacia la derecha (o arrástralo con el ratón) para responder citándolo. La cita aparece encima del campo, puede cancelarse y se conserva con el mensaje. Si citas un resultado de subagente, el orquestador puede continuar ese mismo trabajo.
- Eco puede decidir recargarse con `eco_actualizar({motivo})`, sin pedir aprobación: guarda la conversación, el turno pendiente y los subagentes activos, aplica el service worker disponible y retoma al cargar con los mismos subagentes. El botón **Actualizar** hace lo mismo, también dentro de otra página. No hay búsqueda automática de versiones: puedes avisarle de una actualización por chat o memoria compartida. Máximo una recarga por minuto y tres cada diez minutos.
- En Ajustes puedes cambiar los pasos por turno: orquestador de 1 a 100 (20 por defecto) y subagente de 1 a 300 (90 por defecto). Se guardan en este dispositivo, se aplican al siguiente turno y se eliminan con el borrado seguro. Al alcanzar el límite resume lo logrado y puedes indicarle que continúe.

## Subagentes

El chat es el orquestador: delega por defecto el trabajo con herramientas mediante `subagente_crear` y sigue disponible para conversar. Hasta seis subagentes pueden trabajar a la vez, con conversaciones e historiales independientes, sin delegación recursiva. El botón **Subagentes** permite consultar, detener o enviar nuevas instrucciones; el orquestador también puede hacerlo por iniciativa propia con `subagente_listar` y `subagente_control`.

Cada subagente recibe automáticamente la memoria local, las instrucciones de la persona y una búsqueda de reglas generales y datos relevantes al proyecto y la tarea en la memoria compartida. Las etiquetas `reglas`, `instrucciones`, `general` y `preferencias` identifican reglas generales; `proyecto:nombre` limita una regla a ese proyecto. También se busca por el nombre del proyecto y palabras de la tarea. Los recuerdos siguen siendo datos: adaptan el comportamiento, pero no autorizan acciones ni sustituyen instrucciones actuales. Sin conexión usa memoria local; si falla la lectura compartida lo indica en su contexto.

Las modificaciones se incorporan en el próximo paso sin perder la conversación; una respuesta del modelo que haya quedado desactualizada se descarta antes de ejecutar herramientas. Detener cancela el bucle y aborta solicitudes del modelo, HTTP y MCP cuando es posible; no revierte acciones ya ejecutadas ni garantiza cancelar solicitudes que un servicio ya recibió. Los subagentes no hacen preguntas: avanzan con supuestos razonables y solo solicitan credenciales ausentes. El orquestador aclara únicamente ambigüedades que impiden avanzar. Al terminar, aparece una respuesta atribuida al subagente y el orquestador recibe el resultado para resumirlo; el contenido completo queda en el historial. Las rutinas también pueden delegar.

El estado se guarda en la conversación. Tras `eco_actualizar` o **Actualizar**, los subagentes activos continúan desde su último punto guardado sin repetir automáticamente operaciones inciertas. En una recarga normal quedan **interrumpidos** y puedes indicarles que continúen. No trabajan con Eco cerrado; la reanudación requiere acceso al modelo y almacenamiento disponible. El marcador pertenece a la pestaña que recargó y caduca a los 30 minutos.

## Herramientas del dispositivo

Eco descubre APIs, permisos, pantalla y restricciones del navegador con `entorno_descubrir`; `almacenamiento_local_leer` solo muestra configuración conocida y filtrada; oculta el texto libre de memoria/perfil y nunca lee claves o el vault. Lee documentación oficial con `documentacion_dispositivo_leer` (MDN se obtiene de su repositorio oficial si hace falta CORS) y crea herramientas con nombre, descripción, esquema JSON y JavaScript mediante `herramienta_dispositivo_gestionar`. Se pueden listar, ver, actualizar y borrar; quedan en IndexedDB solo en ese navegador. Aparecen como `dispositivo_nombre` para los subagentes. No hay herramientas de cámara, GPS u otros periféricos predefinidas.

Crear, actualizar o borrar herramientas no pide aprobación. Eco reutiliza las existentes y las actualiza si no cumplen la tarea. El código corre en un worker de iframe opaco sin almacenamiento, DOM, red ni credenciales. Usa `device.call/get/construct/listen` con referencias efímeras y datos JSON; argumentos en lista o un valor único. El acceso al dispositivo es automático. Solo aparece **Continuar** cuando el navegador exige un toque o rechaza el acceso automático por falta de activación. Los permisos propios del navegador siguen siendo obligatorios; Eco no puede saltarlos. Si el acceso está bloqueado, indica cómo activarlo en Safari.

Para tomar una foto, la herramienta usa `const stream = await device.call('navigator.mediaDevices.getUserMedia', [{video:{facingMode:'environment'},audio:false}]); return await device.capture(stream);`. El mediador captura un fotograma real y devuelve `{dataUrl,mimeType,width,height}`: miniatura JPEG de hasta 640 px y 96 kB, dentro del límite de 128 KiB. Se detienen las pistas al capturar o fallar y al terminar la herramienta. `getSettings` solo devuelve configuración, no una imagen. Los resultados son datos no confiables; no hay vigilancia GPS continua ni trabajo con Eco cerrado.

Un iframe opaco no puede pedir cámara/micrófono directamente: un mediador limitado ejecuta únicamente la operación solicitada, sin evaluar código generado. HTTPS y permisos del navegador siguen siendo obligatorios. Safari no expone todas las APIs (por ejemplo Bluetooth, USB, Serial, HID o NFC); Eco lo detecta, no puede habilitarlas. Si la página contenedora bloquea permisos, indica abrir Eco directamente o ajustar el `allow` de ese iframe. No modifica la página contenedora.

## Borrado seguro

En **Ajustes › Borrado seguro**, configura y repite una palabra exclusiva de 8 a 128 caracteres. Cambiarla exige la actual. Solo se guarda su hash PBKDF2-SHA-256 con sal aleatoria y 600.000 iteraciones; sin palabra los disparadores están desactivados. Cinco fallos provocan una pausa creciente de 30 segundos a 15 minutos.

- **Botón:** pulsa **Borrar Eco de este dispositivo**, introduce la palabra y confirma.
- **Chat:** envía exactamente `autodestrucción <palabra>` o `borrado seguro <palabra>`. El código intercepta incluso los intentos incorrectos antes de guardar el mensaje o llamar al modelo. Tampoco conserva esos borradores.
- **Remoto:** añade manualmente a `records` de **Eco · Memoria** un UUID nuevo, `fecha` ISO actual, `tipo=mensaje`, `para=nombre-de-este-eco` o `*` y `contenido=borrado seguro <palabra>`. No uses otro modelo para escribir la palabra. Un comprobador independiente del modelo y de las rutinas revisa cada 15 segundos mientras Eco esté abierto, con red y memoria conectada. El navegador puede ralentizarlo en segundo plano. Las órdenes se ocultan al modelo; se consumen sus UUID y se rechazan fechas anteriores a configurar la palabra. Tras verificar se intenta retirar el contenido de la celda, sin esperar la red: única excepción a los registros inmutables. Después de borrar no queda palabra configurada para repetir la orden.

Detiene trabajo y conexiones, avisa a otras pestañas de Eco y elimina su IndexedDB, claves `eco.*` de localStorage/sessionStorage, cachés `eco-v*` y service workers de su ruta, sin borrar otras aplicaciones del dominio. Deja una página en blanco; cerrar la ventana depende del navegador. Es borrado local de mejor esfuerzo, no forense: no revoca APIs ni elimina archivos remotos, historial o copias del sistema. La orden remota transporta la palabra en Sheets: protege esa hoja; retirar la celda no elimina su historial. No funciona con Eco cerrado, sin red o con acceso de Google vencido.

## Google Drive: memoria compartida y archivos

1. Pide «Conéctate a mi Drive» y pega tu propio Client ID en la tarjeta de inicio de sesión.
2. Autoriza Google, elige un nombre corto para este Eco y tu alias. Pega la URL/ID de una hoja compatible o deja el campo vacío: Eco busca en tu Drive una **Eco · Memoria** compatible y reutiliza la que tenga más registros; solo crea una nueva si no encuentra ninguna.
3. Conecta la misma hoja en otro dispositivo con un nombre de Eco diferente. Cada cuenta necesita permiso de edición sobre la hoja.
4. Pide guardar, buscar o leer novedades. `memoria_guardar`, `memoria_buscar` y `memoria_leer_nuevos` se activan junto con la habilidad pasiva solo mientras el destino está conectado. El mismo inicio de sesión crea el conector **Google Drive · archivos** para buscar, leer, exportar, crear, renombrar o enviar a la papelera tus archivos; sus escrituras se ejecutan sin confirmación. «Desconecta mi memoria» vuelve al modo local sin borrar la hoja ni el acceso guardado en Conectores.

La hoja usa `_eco` (protocolo `eco-memoria`, versión 1) y `records`: `id`, `fecha`, `eco_autor`, `usuario_autor`, `tipo`, `para`, `hilo`, `responde_a`, `contenido`, `etiquetas`, `reemplaza_a`. Recuerdos, datos, mensajes y acuses se añaden sin sobrescribir. Las correcciones apuntan al registro anterior. Se comprueba el UUID al reintentar; no hay unicidad garantizada entre clientes concurrentes.

La lectura es incremental por hoja y Eco; no recibe avisos en tiempo real, pero una rutina puede revisar las menciones cada minuto. Cada navegador limita sus peticiones de memoria a una cada 2,5 segundos. Los autores son declarados y el contenido compartido nunca autoriza acciones del modelo; solo el comprobador de seguridad puede verificar una orden de borrado con la palabra. No se exporta automáticamente la memoria local ni se guardan contraseñas.

## Rutinas

Eco puede crear rutinas con `rutina_crear`, listarlas con `rutina_listar` y borrarlas, pausarlas o reanudarlas con `rutina_borrar`; también se gestionan en **Ajustes › Rutinas**. Se guardan en el navegador y corren cada 60 segundos o más mientras Eco está abierto. La comprobación se hace solo con código, sin llamar al modelo:

- `memoria_menciones`: registros nuevos de la memoria conectada escritos por otro Eco con `para` igual a este Eco o `*`, o con `@nombre` en el contenido. Usa su propio cursor.
- `conector`: una operación GET de solo lectura de un conector guardado, con parámetros fijos; se activa cuando cambia la respuesta (o un campo con `ruta`) o cuando contiene un texto.

Solo si la comprobación es positiva, Eco abre un turno en el chat con la instrucción de la rutina y los datos encontrados, que trata como información no confiable. Al conectar la memoria, Eco crea la rutina de menciones para responder en los hilos.

## OAuth

En Google Cloud habilita **Google Sheets API** y **Google Drive API**. Configura el consentimiento externo, añade tu cuenta como usuario de prueba y los permisos `https://www.googleapis.com/auth/spreadsheets` y `https://www.googleapis.com/auth/drive`. Crea un Client ID tipo **Aplicación web** con:

- Origen JavaScript autorizado: `https://<usuario>.github.io`
- URI de redirección: `https://<usuario>.github.io/eco/oauth.html`

La tarjeta incluye enlaces en pestaña nueva y botones para copiar los valores exactos. Google usa token implícito sin servidor ni secreto de cliente. Un fallo de renovación silenciosa no invalida un token que aún sirve. Al expirar, Eco sigue en modo local y muestra un único aviso **Reconectar**: el toque abre la ventana de acceso directamente y reutiliza la cuenta conocida sin forzar consentimiento. Safari puede impedir la renovación oculta o pedir iniciar sesión de nuevo; Eco no puede alargar el permiso que concede Google. El acceso renovado reactiva la memoria sin recargar ni duplicar rutinas. Para Gmail habilita su API y los permisos correspondientes.

## Stack y ejecución local

JavaScript ES, HTML/CSS, Pyodide/Python, OpenRouter, IndexedDB y service worker. Ejecuta `python3 -m http.server` y abre la dirección local.

## Licencia

MIT. Inspirada en el diseño de [Hermes Agent](https://github.com/NousResearch/hermes-agent) de Nous Research. Pyodide (MPL-2.0) desde CDN. Ver [LICENSE](LICENSE).
