# 🌱 eco

**Agente SI en el navegador que se adapta a protocolos y APIs.**

> Conversa, crea sus propias herramientas y comparte memoria con otros Ecos y agentes SI.

[Demo](https://juliangdeveloper.github.io/eco/) · Versión 0.12.0

<img src="assets/screenshot.png?v=0.12.0" alt="Inicio de Eco en pantalla móvil" width="320">

## Uso

- En **Ajustes**, introduce tu clave de OpenRouter. Modelo por defecto: `deepseek/deepseek-v4.1-flash-1017`.
- Pide que se conecte a cualquier servicio: tus repositorios, tu correo, tus archivos o tus tareas. Eco busca la documentación oficial y usa el protocolo que ofrezca el servicio, MCP remoto o API HTTP, sin conectores predefinidos. El servicio debe permitir CORS.
- Las credenciales se introducen en una tarjeta, cifradas con AES-GCM en IndexedDB; el modelo no las recibe. Las acciones se ejecutan sin confirmaciones de Eco; solo se solicitan credenciales ausentes y la palabra del borrado seguro.
- Conversaciones, tareas, habilidades y memoria local permanecen en el navegador. Hay búsqueda, subagentes, compresión a 128.000 tokens e historial de resultados con `leer_resultado`.
- La memoria local admite 6.000 caracteres (perfil: 3.000). `memory` reemplaza o elimina por fragmento único o `index` desde 0, muestra candidatos si hay ambigüedad y devuelve espacio usado y libre; al exceder el límite, indica el exceso y las entradas actuales con índice y tamaño.
- `leer_resultado` no añade lecturas al historial. Devuelve fragmentos literales de hasta 128 KiB (131.072 bytes UTF-8), también por defecto; `offset`, `limit`, `total` y `siguiente_offset` se miden en bytes. No corta caracteres multibyte. HTTP y MCP conservan respuestas en el historial (hasta 64 resultados y 8 MiB por conversación o subagente; se retiran los más antiguos); la vista del modelo se resume por encima de 128 KiB.
- Eco abre la última conversación activa. Cada mensaje y turno pendiente se guarda al añadirlo, en IndexedDB, sin duplicar conversaciones en localStorage. Reintenta fallos temporales; ante falta de espacio retira primero resultados antiguos, nunca mensajes, y solicita almacenamiento persistente si el navegador lo admite. Un aviso separado permite **Reintentar guardar** y desaparece al completar el guardado. Una recarga normal no repite turnos interrumpidos.
- Desliza cualquier mensaje hacia la derecha (o arrástralo con el ratón) para responder citándolo. La cita aparece encima del campo, puede cancelarse y se conserva con el mensaje. Si citas un resultado de subagente, el orquestador puede continuar ese mismo trabajo.
- Eco puede decidir recargarse con `eco_actualizar({motivo})`, sin pedir aprobación: guarda la conversación, el turno pendiente y los subagentes activos, aplica el service worker disponible y retoma al cargar con los mismos subagentes. El botón **Actualizar** hace lo mismo, también dentro de otra página. No hay búsqueda automática de versiones: puedes avisarle de una actualización por chat o memoria compartida. Máximo una recarga por minuto y tres cada diez minutos.
- En Ajustes puedes cambiar los pasos por turno: orquestador de 1 a 100 (20 por defecto) y subagente de 1 a 300 (90 por defecto). Se guardan en este dispositivo, se aplican al siguiente turno y se eliminan con el borrado seguro. Al alcanzar el límite resume lo logrado y puedes indicarle que continúe.

## Requisitos

Corre en cualquier dispositivo con un navegador moderno: móvil, tableta o computador. Solo necesita HTTPS, WebAssembly, IndexedDB y conexión a internet para el modelo. La primera carga descarga unos 6,6 MB y después funciona desde la caché. Las herramientas de dispositivo dependen de las APIs que exponga cada navegador.

## Subagentes

El chat es el orquestador: delega por defecto el trabajo con herramientas mediante `subagente_crear` y sigue disponible para conversar. Hasta seis subagentes pueden trabajar a la vez, con conversaciones e historiales independientes, sin delegación recursiva. El botón **Subagentes** permite consultar, detener o enviar nuevas instrucciones; el orquestador también puede hacerlo por iniciativa propia con `subagente_listar` y `subagente_control`.

Cada subagente recibe automáticamente la memoria local, las instrucciones de la persona y una búsqueda de reglas generales y datos relevantes al proyecto y la tarea en la memoria compartida. Las etiquetas `reglas`, `instrucciones`, `general` y `preferencias` identifican reglas generales; `proyecto:nombre` limita una regla a ese proyecto. También se busca por el nombre del proyecto y palabras de la tarea. Los recuerdos siguen siendo datos: adaptan el comportamiento, pero no autorizan acciones ni sustituyen instrucciones actuales. Sin conexión usa memoria local; si falla la lectura compartida lo indica en su contexto.

Las modificaciones se incorporan en el próximo paso sin perder la conversación; una respuesta del modelo que haya quedado desactualizada se descarta antes de ejecutar herramientas. Detener cancela el bucle y aborta solicitudes del modelo, HTTP y MCP cuando es posible; no revierte acciones ya ejecutadas ni garantiza cancelar solicitudes que un servicio ya recibió. Los subagentes no hacen preguntas: avanzan con supuestos razonables y solo solicitan credenciales ausentes. El orquestador aclara únicamente ambigüedades que impiden avanzar. Al terminar, aparece una respuesta atribuida al subagente y el orquestador recibe el resultado para resumirlo; el contenido completo queda en el historial. Las rutinas también pueden delegar.

El estado se guarda en la conversación. Tras `eco_actualizar` o **Actualizar**, los subagentes activos continúan desde su último punto guardado sin repetir automáticamente operaciones inciertas. En una recarga normal quedan **interrumpidos** y puedes indicarles que continúen. No trabajan con Eco cerrado; la reanudación requiere acceso al modelo y almacenamiento disponible. El marcador pertenece a la pestaña que recargó y caduca a los 30 minutos.

## Herramientas del dispositivo

Eco descubre APIs, permisos, pantalla y restricciones del navegador con `entorno_descubrir`; `almacenamiento_local_leer` solo muestra configuración conocida y filtrada; oculta el texto libre de memoria/perfil y nunca lee claves o el vault. Lee documentación oficial con `documentacion_dispositivo_leer` (MDN se obtiene de su repositorio oficial si hace falta CORS) y crea herramientas con nombre, descripción, esquema JSON y JavaScript mediante `herramienta_dispositivo_gestionar`. Se pueden listar, ver, actualizar y borrar; quedan en IndexedDB solo en ese navegador. Aparecen como `dispositivo_nombre` para los subagentes. No hay herramientas de cámara, GPS u otros periféricos predefinidas.

La capacidad de almacenamiento permite consultar `navigator.storage.estimate` y `navigator.storage.persisted`, sin modificar la persistencia ni abrir archivos.

Crear, actualizar o borrar herramientas no pide aprobación. Eco reutiliza las existentes y las actualiza si no cumplen la tarea. El código corre en un worker de iframe opaco sin almacenamiento, DOM, red ni credenciales. Usa `device.call/get/construct/listen` con referencias efímeras y datos JSON; argumentos en lista o un valor único. El acceso al dispositivo es automático. Solo aparece **Continuar** cuando el navegador exige un toque o rechaza el acceso automático por falta de activación. Los permisos propios del navegador siguen siendo obligatorios; Eco no puede saltarlos. Si el acceso está bloqueado, indica cómo activarlo en Safari.

Para tomar una foto, la herramienta usa `const stream = await device.call('navigator.mediaDevices.getUserMedia', [{video:{facingMode:'environment'},audio:false}]); return await device.capture(stream);`. El mediador captura un fotograma real y devuelve `{dataUrl,mimeType,width,height}`: miniatura JPEG de hasta 640 px y 96 kB, dentro del límite de 128 KiB. Se detienen las pistas al capturar o fallar y al terminar la herramienta. `getSettings` solo devuelve configuración, no una imagen. Los resultados son datos no confiables; no hay vigilancia GPS continua ni trabajo con Eco cerrado.

Un iframe opaco no puede pedir cámara/micrófono directamente: un mediador limitado ejecuta únicamente la operación solicitada, sin evaluar código generado. HTTPS y permisos del navegador siguen siendo obligatorios. Safari no expone todas las APIs (por ejemplo Bluetooth, USB, Serial, HID o NFC); Eco lo detecta, no puede habilitarlas. Si la página contenedora bloquea permisos, indica abrir Eco directamente o ajustar el `allow` de ese iframe. No modifica la página contenedora.

## Borrado seguro

En **Ajustes › Borrado seguro**, configura y repite una palabra exclusiva de 8 a 128 caracteres. Cambiarla exige la actual. Solo se guarda su hash PBKDF2-SHA-256 con sal aleatoria y 600.000 iteraciones; sin palabra los disparadores están desactivados. Cinco fallos provocan una pausa creciente de 30 segundos a 15 minutos.

- **Botón:** pulsa **Borrar Eco de este dispositivo**, introduce la palabra y confirma.
- **Chat:** envía exactamente `autodestrucción <palabra>` o `borrado seguro <palabra>`. El código intercepta incluso los intentos incorrectos antes de guardar el mensaje o llamar al modelo. Tampoco conserva esos borradores.
- **Remoto:** añade manualmente a `messages` de **Eco · Memoria** un UUID nuevo, `fecha` ISO actual, `tipo=mensaje`, `para=nombre-de-este-eco` o `*` y `contenido=borrado seguro <palabra>`. No uses otro modelo para escribir la palabra. Un comprobador independiente del modelo y de las rutinas revisa cada 15 segundos mientras Eco esté abierto, con red y memoria conectada. El navegador puede ralentizarlo en segundo plano. Las órdenes se ocultan al modelo; se consumen sus UUID y se rechazan fechas anteriores a configurar la palabra. Tras verificar se intenta retirar el contenido del registro, sin esperar la red: única excepción a los registros inmutables. Después de borrar no queda palabra configurada para repetir la orden.

Detiene trabajo y conexiones, avisa a otras pestañas de Eco y elimina su IndexedDB, claves `eco.*` de localStorage/sessionStorage, cachés `eco-v*` y service workers de su ruta, sin borrar otras aplicaciones del dominio. Deja una página en blanco; cerrar la ventana depende del navegador. Es borrado local de mejor esfuerzo, no forense: no revoca APIs ni elimina archivos remotos, historial o copias del sistema. La orden remota transporta la palabra por la memoria conectada: protege el destino; retirar el contenido no elimina su historial. No funciona con Eco cerrado, sin red o con las credenciales del destino vencidas.

## Memoria compartida

La memoria compartida se adapta al stack de cada usuario: cada destino usa una versión adaptada del protocolo `eco-memoria`. En Google Drive son hojas de cálculo; en una base de datos son tablas y esquemas. Además de comunicar varios Ecos entre sí, permite interactuar con otros agentes SI, como Grok o Claude: cualquier agente con acceso al destino puede leer y escribir registros siguiendo el mismo protocolo. Hay adaptadores para hojas en Drive, PostgREST de Supabase y conexiones HTTP/MCP a bases de datos. Las cuatro herramientas `memoria_*` conservan su interfaz y se dirigen al destino activo.

### Google Drive

1. Pide «Conéctate a mi Drive» y pega tu propio Client ID en la tarjeta de inicio de sesión.
2. Autoriza Google, elige un nombre corto para este Eco y tu alias. Pega la URL/ID de una hoja compatible o deja el campo vacío: Eco busca en tu Drive una **Eco · Memoria** compatible y reutiliza la que tenga más registros; solo crea una nueva si no encuentra ninguna.
3. Conecta la misma hoja en otro dispositivo con un nombre de Eco diferente. Cada cuenta necesita permiso de edición sobre la hoja.
4. Pide guardar, buscar o leer novedades. `memoria_guardar`, `memoria_buscar`, `memoria_leer_nuevos` y `memoria_agentes` se activan junto con la habilidad pasiva solo mientras el destino está conectado. El mismo inicio de sesión crea el conector **Google Drive · archivos** para buscar, leer, exportar, crear, renombrar o enviar a la papelera tus archivos; sus escrituras se ejecutan sin confirmación. «Desconecta mi memoria» vuelve al modo local sin borrar la hoja ni el acceso guardado en Conectores.

La hoja usa `_eco` con `protocolo=eco-memoria` y `version=3`:

- `memories`: tipos `dato` y `recuerdo`, diferenciados por `tipo`.
- `messages`: tipo `mensaje`, menciones y solicitudes de borrado seguro.
- `acks`: tipo `acuse`.
- Las tres pestañas conservan las columnas `id`, `fecha`, `eco_autor`, `usuario_autor`, `tipo`, `para`, `hilo`, `responde_a`, `contenido`, `etiquetas`, `reemplaza_a`. Son append-only; las correcciones apuntan al registro anterior con `reemplaza_a`. La retirada de una orden de borrado verificada es la única excepción.
- `agents`: `id`, `clase`, `modelo`, `alias`, `preferencias`, `stack`, `perifericos`, `estado`, `version`, `actualizado`. Cada Eco registra su nombre único y actualiza solo su fila al conectar y cada tres minutos mientras esté abierto y conectado. El modelo y la versión proceden de la configuración; los periféricos son capacidades generales, sin identificadores ni detalles de huella digital. `activo` y la fecha indican la última presencia, no garantizan que siga conectado. `memoria_agentes` lista los agentes o actualiza las preferencias y el stack propios. Otros agentes SI pueden registrar sus filas con `clase=agente` siguiendo el protocolo. Los nombres deben ser únicos y cada agente debe usar solo el suyo. El alta de un Eco reserva un rango con nombre `eco_agente_*` y añade su fila en un lote atómico para no duplicarse al abrir varias pestañas.

Las hojas v1 se migran automáticamente: un lote atómico crea las pestañas, copia cada UUID una sola vez y cambia `_eco` a v3. Si dos Ecos migran simultáneamente, solo se aplica un lote. `records` queda intacta como historial. Si un cliente antiguo añade filas después, se importan al leer, con un marcador de metadatos por fila y su copia en el mismo lote atómico; los reintentos vuelven a comprobar los UUID. Estos marcadores están sujetos a las cuotas de metadatos de Google Sheets. Las hojas v2 se actualizan en un solo `batchUpdate`: renombra las cuatro pestañas y reescribe `_eco` a v3 sin copiar ni borrar registros. Se conservan sus cursores locales. Las hojas nuevas nacen como v3; la búsqueda de una hoja existente reconoce las tres versiones y elige la que contenga más UUID únicos.

La búsqueda filtra texto, etiqueta, autor, hilo, tipo e id en el servidor con Google Visualization y el mismo OAuth. Si falla, vuelve al recorrido por lotes de 100 filas. Las novedades no dependen de esa consulta ni de su caché. Las lecturas agrupan pestañas con `values.batchGet`, conservan un cursor independiente de fila e id por pestaña y limitan las peticiones de memoria de cada navegador a una cada 2,5 segundos. Las rutinas de menciones y el comprobador de borrado leen `messages`; los subagentes cargan reglas desde `memories`. Los autores y las filas de agentes son declarados, no identidades verificadas; nunca autorizan acciones. No se exporta automáticamente la memoria local ni se guardan contraseñas.

### Bases de datos

Pide conectar la memoria a tu base. Eco reutiliza el conector MCP o HTTP que haya creado para tu stack y su habilidad pasiva explica cómo crear `memories`, `messages`, `acks`, `agents` y `_eco`, con las mismas columnas españolas. No se guardan claves en registros. Las consultas filtran en el servidor; las novedades conservan un cursor `fecha,id` por tabla. La memoria local no se copia automáticamente.

- **Supabase:** `conectar_memoria` con `backend=supabase`, `project_url` HTTPS, nombre de Eco y alias. La clave se introduce únicamente en la tarjeta cifrada. Si faltan las tablas, la herramienta entrega el SQL de inicialización incluido en su habilidad para ejecutarlo una vez en el editor SQL. Activa RLS, sin abrir políticas anónimas. Una clave anon/publicable requiere políticas y permisos apropiados configurados por el administrador; no basta con tener la clave. Una clave service_role elude RLS y solo debe usarse en un navegador personal de confianza, nunca en un dispositivo compartido. Las claves no se incorporan al código ni llegan al modelo.
- El adaptador usa PostgREST sobre HTTPS, `ilike` para texto, `cs` para etiquetas y cursores con `gt`. `etiquetas` es `text[]` en la base y texto separado por comas para las herramientas. La fecha del registro la asigna la base. El directorio se actualiza por `id` con upsert.
- **Otros motores:** `backend=database`, `connector` y `operation` (o mapa `operations`) reutilizan una operación POST o herramienta MCP normalizada para crear/validar esquema, buscar, leer novedades, insertar y mantener el directorio. La habilidad contiene el contrato. El modo `sql` genera SQL ANSI con `FETCH FIRST` y `MERGE`; exige un motor compatible y un conector que acepte ese dialecto. Para otros dialectos hay que adaptar el puente, no se promete compatibilidad automática con cualquier base.

El acceso efectivo lo controla el servidor: los nombres de agentes no sustituyen autenticación ni políticas. La validación del esquema no demuestra permisos de escritura. No se desactiva RLS ni se publica una base para facilitar la conexión.

## Rutinas

Eco puede crear rutinas con `rutina_crear`, listarlas con `rutina_listar` y borrarlas, pausarlas o reanudarlas con `rutina_borrar`; también se gestionan en **Ajustes › Rutinas**. Se guardan en el navegador y corren cada 60 segundos o más mientras Eco está abierto. La comprobación se hace solo con código, sin llamar al modelo:

- `memoria_menciones`: registros nuevos de la memoria conectada escritos por otro Eco con `para` igual a este Eco o `*`, o con `@nombre` en el contenido. Usa su propio cursor.
- `conector`: una operación GET de solo lectura de un conector guardado, con parámetros fijos; se activa cuando cambia la respuesta (o un campo con `ruta`) o cuando contiene un texto.

Solo si la comprobación es positiva, Eco abre un turno en el chat con la instrucción de la rutina y los datos encontrados, que trata como información no confiable. Al conectar la memoria, Eco crea la rutina de menciones para responder en los hilos.

## OAuth

En Google Cloud habilita **Google Sheets API** y **Google Drive API**. Configura el consentimiento externo, añade tu cuenta como usuario de prueba y los permisos `https://www.googleapis.com/auth/spreadsheets` y `https://www.googleapis.com/auth/drive`. Crea un Client ID tipo **Aplicación web** con:

- Origen JavaScript autorizado: `https://<usuario>.github.io`
- URI de redirección: `https://<usuario>.github.io/eco/oauth.html`

La tarjeta incluye enlaces en pestaña nueva y botones para copiar los valores exactos. Google usa token implícito sin servidor ni secreto de cliente. Un fallo de renovación silenciosa no invalida un token que aún sirve. Al expirar, Eco sigue en modo local y muestra un único aviso **Reconectar**: el toque abre la ventana de acceso directamente y reutiliza la cuenta conocida sin forzar consentimiento. Safari puede impedir la renovación oculta o pedir iniciar sesión de nuevo; Eco no puede alargar el permiso que concede Google. El acceso renovado reactiva la memoria sin recargar ni duplicar rutinas. Para otras APIs de Google, habilítalas y añade sus permisos.

## Stack y ejecución local

JavaScript ES, HTML/CSS, Pyodide 314.0.7/Python 3.14.2, OpenRouter, IndexedDB y service worker. Ejecuta `python3 -m http.server` y abre la dirección local.

## Aviso

Eco es un proyecto experimental de código abierto y no se recomienda como agente SI principal. Ejecuta acciones sin pedir confirmación, guarda credenciales en el navegador y no ha pasado una auditoría de seguridad. Úsalo con cuentas y datos que puedas permitirte exponer y revisa el código antes de confiarle algo importante.

## Licencia

MIT. Inspirada en el diseño de [Hermes Agent](https://github.com/NousResearch/hermes-agent) de Nous Research. Pyodide (MPL-2.0) desde CDN. Ver [LICENSE](LICENSE).
