const definitions = [
  ["permissions", "navigator.permissions", []],
  ["storage", "navigator.storage", []],
  ["mediaDevices", "navigator.mediaDevices", ["camera", "microphone"], ["devicechange", "ended", "mute", "unmute"], { cleanupChildren: "getTracks" }],
  ["mediaRecorder", "MediaRecorder", [], ["dataavailable", "stop", "error"]],
  ["geolocation", "navigator.geolocation", ["geolocation"]],
  ["motion", "DeviceMotionEvent", ["accelerometer", "gyroscope"], ["devicemotion"], { eventTarget: "window" }],
  ["orientation", "DeviceOrientationEvent", ["accelerometer", "gyroscope", "magnetometer"], ["deviceorientation"], { eventTarget: "window" }],
  ["vibration", "navigator.vibrate", []],
  ["battery", "navigator.getBattery", []],
  ["bluetooth", "navigator.bluetooth", ["bluetooth"]],
  ["usb", "navigator.usb", ["usb"]],
  ["serial", "navigator.serial", ["serial"]],
  ["hid", "navigator.hid", ["hid"]],
  ["nfc", "NDEFReader", ["nfc"], ["reading", "readingerror"]],
  ["wakeLock", "navigator.wakeLock", ["screen-wake-lock"]],
  ["clipboard", "navigator.clipboard", ["clipboard-read", "clipboard-write"]],
  ["share", "navigator.share", ["web-share"]],
  ["notifications", "Notification", []],
  ["accelerometer", "Accelerometer", ["accelerometer"], ["reading", "error"]],
  ["gyroscope", "Gyroscope", ["gyroscope"], ["reading", "error"]],
  ["magnetometer", "Magnetometer", ["magnetometer"], ["reading", "error"]],
  ["ambientLight", "AmbientLightSensor", ["ambient-light-sensor"], ["reading", "error"]],
  ["absoluteOrientation", "AbsoluteOrientationSensor", ["accelerometer", "gyroscope", "magnetometer"], ["reading", "error"]],
  ["relativeOrientation", "RelativeOrientationSensor", ["accelerometer", "gyroscope"], ["reading", "error"]]
];

export function featureDefinitions() {
  return definitions.map(([name, path, policies, events = [], lifecycle = {}]) => ({ name, path, policies, events, ...lifecycle }));
}

export function featureValue(path) {
  return path.split(".").reduce((value, name) => value?.[name], window);
}

export function policyState(name) {
  const policy = document.permissionsPolicy || document.featurePolicy;
  try {
    if (!policy?.allowsFeature || policy.features && !policy.features().includes(name)) return "unknown";
    return policy.allowsFeature(name) ? "allowed" : "blocked";
  } catch { return "unknown"; }
}

export async function discoverEnvironment() {
  let iframeAllow = null;
  try { iframeAllow = window.frameElement?.getAttribute("allow") ?? null; } catch {}
  const permissions = {};
  await Promise.all(["camera", "microphone", "geolocation", "notifications", "accelerometer", "gyroscope", "magnetometer", "clipboard-read", "clipboard-write", "bluetooth", "persistent-storage", "screen-wake-lock"].map(async name => {
    try {
      const result = await Promise.race([navigator.permissions.query({ name }), new Promise(resolve => setTimeout(() => resolve(null), 800))]);
      permissions[name] = result?.state || "unknown";
    } catch { permissions[name] = "unknown"; }
  }));
  return {
    untrusted: true, secureContext: isSecureContext, embedded: window !== top, iframeAllow,
    userAgent: navigator.userAgent, platform: navigator.userAgentData?.platform || navigator.platform,
    userAgentData: navigator.userAgentData?.toJSON?.() || null, language: navigator.language,
    screen: { width: screen.width, height: screen.height, pixelRatio: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } },
    touchPoints: navigator.maxTouchPoints || 0, cores: navigator.hardwareConcurrency || null, memoryGB: navigator.deviceMemory || null,
    features: featureDefinitions().map((entry) => ({ ...entry, available: Boolean(featureValue(entry.path)), requestPermission: typeof featureValue(entry.path)?.requestPermission === "function", policies: Object.fromEntries(entry.policies.map((name) => [name, policyState(name)])) })),
    permissions, execution: "Código aislado en worker de iframe opaco. Solo device.call/get/construct/listen/capture cruzan al navegador. Permitir siempre por herramienta y dispositivo en operaciones sin activación transitoria; las demás necesitan un toque por acceso. device.capture(stream) devuelve JPEG con dataUrl, width y height y detiene las pistas. No hay acceso a almacenamiento, DOM de Eco ni credenciales. Las APIs ausentes o bloqueadas no pueden habilitarse con código."
  };
}

const safeNames = new Set(["memory", "user", "model", "stats", "lastSession", "persistentMemory", "deviceId"]);
const secretNames = /key|token|secret|credential|password|authorization|cookie|vault|client.?id/i;

function redact(value, name = "") {
  if (secretNames.test(name)) return "[oculto]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, key)]));
  if (typeof value !== "string") return value;
  return value.replace(/(?:sk-[\w-]{8,}|AIza[\w-]{20,}|ya29\.[\w.-]+|gh[pousr]_[\w]+|github_pat_[\w]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|Bearer\s+\S+|(?:api[_ -]?key|token|secret|password|contraseña|clave)\s*[:=]\s*[^\n,;]+)/gi, "[oculto]");
}

export function readEnvironmentStorage() {
  const entries = [];
  let omitted = 0;
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith("eco.")) continue;
    const name = key.slice(4);
    if (!safeNames.has(name) || secretNames.test(name)) { omitted++; continue; }
    let value = localStorage.getItem(key);
    try { value = JSON.parse(value); } catch {}
    if (["memory", "user"].includes(name)) value = { content: "[oculto: texto libre]", characters: localStorage.getItem(key).length };
    if (name === "stats") value = Object.fromEntries(Object.entries(value || {}).filter(([key, item]) => ["mensajes_enviados", "herramientas_usadas"].includes(key) && typeof item === "number"));
    if (name === "persistentMemory") value = Object.fromEntries(Object.entries(value || {}).filter(([key, item]) => ["backend", "sheet", "eco", "usuario"].includes(key) && typeof item === "string"));
    entries.push({ key, value: redact(value) });
  }
  return { untrusted: true, entries, omitted, note: "Solo configuración y memoria local conocidas. El texto libre de memoria/perfil se oculta; las herramientas de memoria normales siguen disponibles. No se leen secretos, diarios de sesiones, datos de conectores ni material cifrado de IndexedDB." };
}
