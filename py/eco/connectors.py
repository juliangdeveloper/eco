import json
import re
from urllib.parse import quote, urlparse
from js import ecoBridge
from .registry import schema

AUTH_TYPES = ["none", "bearer", "api_key", "basic", "oauth2"]
METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
PARAM_LOCATIONS = ["path", "query", "body"]
NOT_CONNECTED = "not_connected"
AUTH_REASONS = {
    "missing_credential": "No hay credencial guardada para este conector.",
    "credential_unreadable": "La credencial guardada no se pudo descifrar en este navegador.",
    "expired": "El acceso expiró y no se pudo renovar.",
    "rejected_by_api": "El servicio rechazó la credencial (401): puede ser inválida, revocada o sin permisos.",
}
SIGN_IN_REQUESTED = "El conector no está conectado. Se pidió a la persona iniciar sesión; vuelve a intentarlo cuando confirme."

DEFINITION_SCHEMA = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "Identificador corto en minúsculas, números y guiones."},
        "name": {"type": "string"},
        "base_url": {"type": "string", "description": "URL https base de la API."},
        "auth": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": AUTH_TYPES},
                "header": {"type": "string", "description": "Cabecera para api_key."},
                "query_param": {"type": "string", "description": "Parámetro de query para api_key."},
                "prefix": {"type": "string", "description": "Prefijo para bearer, por defecto 'Bearer '."},
                "authorize_url": {"type": "string"},
                "token_url": {"type": "string"},
                "developer_url": {"type": "string", "description": "Opcional: página https del proveedor para registrar la aplicación OAuth y obtener el Client ID."},
                "scopes": {"type": "array", "items": {"type": "string"}},
                "flow": {"type": "string", "enum": ["pkce", "implicit"], "description": "Para Google usa implicit."},
                "extra_params": {"type": "object"},
                "renewal": {"type": "string", "enum": ["refresh_token", "silent", "none"], "description": "Cómo renovar el acceso sin molestar: refresh_token si el proveedor entrega uno (flow pkce), silent para renovación silenciosa con prompt=none (Google, flow implicit), none si no se puede."},
            },
            "required": ["type"],
        },
        "operations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "method": {"type": "string", "enum": METHODS},
                    "path": {"type": "string", "description": "Ruta que empieza con /, con {param} para parámetros de ruta."},
                    "params": {"type": "object", "description": "nombre -> {type, in: path|query|body, required, description}"},
                    "write": {"type": "boolean"},
                },
                "required": ["name", "method", "path"],
            },
        },
    },
    "required": ["id", "name", "base_url", "auth", "operations"],
}


async def connectors():
    return json.loads(await ecoBridge.connectors())


AUTH_ALIASES = {
    "oauth": "oauth2", "oauth2": "oauth2", "oauth20": "oauth2", "google": "oauth2", "openid": "oauth2",
    "bearer": "bearer", "token": "bearer", "bearertoken": "bearer", "pat": "bearer", "personalaccesstoken": "bearer", "accesstoken": "bearer",
    "apikey": "api_key", "key": "api_key", "header": "api_key", "query": "api_key",
    "basic": "basic", "basicauth": "basic", "password": "basic", "userpassword": "basic",
    "none": "none", "noauth": "none", "public": "none", "": "none",
}
FLOW_ALIASES = {"pkce": "pkce", "authorizationcode": "pkce", "code": "pkce", "authcode": "pkce", "implicit": "implicit", "token": "implicit"}
AUTH_KEY_ALIASES = {
    "authorization_url": "authorize_url", "auth_url": "authorize_url", "authorization_endpoint": "authorize_url", "authorize_endpoint": "authorize_url",
    "access_token_url": "token_url", "token_endpoint": "token_url",
    "scope": "scopes", "header_name": "header", "query": "query_param", "param": "query_param", "query_parameter": "query_param",
}
GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_API_SUFFIX = ".googleapis.com"
GOOGLE_SCOPE_PREFIX = "https://www.googleapis.com/auth/"
DEFINITION_KEYS = ("definition", "connector", "config")
MAX_ID_LENGTH = 40
RETRY_HINT = " Corrige la definición y vuelve a llamar a create_connector."


def compact(value):
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


def slug(value):
    text = re.sub(r"[^a-z0-9]+", "-", str(value or "").lower()).strip("-")
    return text[:MAX_ID_LENGTH].strip("-")


def as_https(value):
    text = str(value or "").strip()
    if text and "://" not in text:
        text = "https://" + text
    return text.replace("http://", "https://", 1).rstrip("/")


def unwrap(args):
    definition = args
    for _ in range(3):
        if isinstance(definition, str):
            try:
                definition = json.loads(definition)
            except Exception:
                return None
        if isinstance(definition, dict):
            inner = next((definition[key] for key in DEFINITION_KEYS if key in definition and isinstance(definition[key], (dict, str))), None)
            if inner is None:
                break
            definition = inner
    return definition if isinstance(definition, dict) else None


def normalize_auth(raw, base_url):
    auth = {"type": raw} if isinstance(raw, str) else dict(raw or {}) if isinstance(raw, dict) else {}
    for old, new in AUTH_KEY_ALIASES.items():
        if old in auth and new not in auth:
            auth[new] = auth.pop(old)
    kind = compact(auth.get("type"))
    host = urlparse(base_url).hostname or ""
    google = host.endswith(GOOGLE_API_SUFFIX)
    if kind not in AUTH_ALIASES:
        kind = "oauth" if google or auth.get("authorize_url") else "bearer" if kind else ""
    auth["type"] = AUTH_ALIASES[kind]
    if compact(raw.get("type") if isinstance(raw, dict) else raw) == "query" and not auth.get("query_param"):
        auth["query_param"] = "key"
    if auth["type"] != "oauth2":
        return auth
    if google:
        auth["authorize_url"] = GOOGLE_AUTHORIZE_URL
        auth["flow"] = "implicit"
        auth["renewal"] = "silent"
        auth.pop("token_url", None)
    else:
        auth["flow"] = FLOW_ALIASES.get(compact(auth.get("flow")), "pkce")
    for key in ("authorize_url", "token_url", "developer_url"):
        if auth.get(key):
            auth[key] = as_https(auth[key])
    scopes = auth.get("scopes") or []
    auth["scopes"] = [str(item) for item in scopes] if isinstance(scopes, list) else [item for item in re.split(r"[\s,]+", str(scopes)) if item]
    if google:
        auth["scopes"] = [item if "://" in item else GOOGLE_SCOPE_PREFIX + item for item in auth["scopes"]]
    if auth.get("renewal") not in ("refresh_token", "silent", "none"):
        auth.pop("renewal", None)
    auth.pop("client_secret", None)
    return auth


def normalize_params(raw):
    if isinstance(raw, list):
        result = {}
        for item in raw:
            if isinstance(item, str):
                result[item] = {}
            elif isinstance(item, dict) and item.get("name"):
                result[str(item["name"])] = {key: value for key, value in item.items() if key != "name"}
        raw = result
    if not isinstance(raw, dict):
        return {}
    if raw.get("type") == "object" and isinstance(raw.get("properties"), dict):
        required = raw.get("required") or []
        raw = {name: {**(spec if isinstance(spec, dict) else {}), "required": name in required} for name, spec in raw["properties"].items()}
    params = {}
    for name, spec in raw.items():
        spec = {"in": spec} if isinstance(spec, str) else dict(spec) if isinstance(spec, dict) else {}
        location = spec.get("in") or spec.get("location")
        if location not in PARAM_LOCATIONS:
            spec.pop("in", None)
        else:
            spec["in"] = location
        spec.pop("location", None)
        params[str(name)] = spec
    return params


def normalize_operation(name, raw, base_path):
    operation = dict(raw) if isinstance(raw, dict) else {}
    operation["name"] = str(operation.get("name") or operation.get("id") or name or "").strip()
    method = str(operation.get("method") or operation.get("http_method") or operation.get("verb") or "GET").upper()
    path = str(operation.get("path") or operation.get("endpoint") or operation.get("url") or "/")
    match = re.match(r"^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$", path, re.IGNORECASE)
    if match:
        method, path = match.group(1).upper(), match.group(2)
    if "://" in path:
        path = urlparse(path).path or "/"
        if base_path and path.startswith(base_path):
            path = path[len(base_path):] or "/"
    if not path.startswith("/"):
        path = "/" + path
    if base_path and path.startswith(base_path + "/"):
        path = path[len(base_path):]
    operation["method"] = method
    operation["path"] = path
    if not isinstance(operation.get("write"), bool):
        operation["write"] = method != "GET"
    operation["params"] = normalize_params(operation.get("params") or operation.get("parameters"))
    for key in ("http_method", "verb", "endpoint", "url", "parameters", "id"):
        operation.pop(key, None)
    return operation


def normalize_definition(raw):
    definition = unwrap(raw)
    if not definition:
        return None, "La definición debe ser un objeto JSON." + RETRY_HINT
    base_url = as_https(definition.get("base_url") or definition.get("baseUrl") or definition.get("url") or definition.get("api_url"))
    if not urlparse(base_url).hostname:
        return None, "Falta base_url, la URL https de la API." + RETRY_HINT
    base_path = urlparse(base_url).path.rstrip("/")
    name = str(definition.get("name") or definition.get("title") or "").strip()
    identifier = slug(definition.get("id") or name or urlparse(base_url).hostname.split(".")[0])
    raw_operations = definition.get("operations") or definition.get("endpoints") or definition.get("actions") or []
    if isinstance(raw_operations, dict):
        pairs = list(raw_operations.items())
    elif isinstance(raw_operations, list):
        pairs = [(None, item) for item in raw_operations]
    else:
        pairs = []
    operations = [normalize_operation(key, value, base_path) for key, value in pairs]
    operations = [item for item in operations if item["name"] and item["method"] in METHODS]
    if not operations:
        return None, "Incluye al menos una operación con name, method y path." + RETRY_HINT
    result = {
        "id": identifier,
        "name": name or identifier,
        "base_url": base_url,
        "auth": normalize_auth(definition.get("auth") or definition.get("authentication"), base_url),
        "operations": operations,
    }
    if definition.get("description"):
        result["description"] = str(definition["description"])
    return result, None


async def create_connector(args):
    definition, error = normalize_definition(args)
    if error:
        return {"ok": False, "error": error}
    host = urlparse(definition["base_url"]).hostname
    existing = [item for item in await connectors() if urlparse(item.get("base_url", "")).hostname == host]
    if existing and not any(item["id"] == definition["id"] for item in existing):
        definition["id"] = existing[0]["id"]
    try:
        result = json.loads(await ecoBridge.createConnector(json.dumps(definition, ensure_ascii=False)))
    except Exception:
        return {"ok": False, "error": "No se pudo guardar el conector." + RETRY_HINT}
    if not result.get("ok") and result.get("error"):
        result["error"] = str(result["error"]) + "." + RETRY_HINT
    return result


async def list_connectors(args):
    return {"connectors": await connectors()}


async def request_sign_in(args):
    return json.loads(await ecoBridge.requestSignIn(str(args.get("connector", ""))))


def build_request(operation, params):
    path = operation["path"]
    query = {}
    body = {}
    declared = operation.get("params") or {}
    for name, value in params.items():
        location = (declared.get(name) or {}).get("in")
        token = "{" + name + "}"
        if location == "path" or (location is None and token in path):
            text = str(value)
            if ".." in text.split("/"):
                return None, "Parámetro de ruta inválido: " + name
            path = path.replace(token, quote(text, safe="/"))
        elif location == "body" or (location is None and operation["method"] != "GET"):
            body[name] = value
        else:
            query[name] = value
    missing = [name for name, spec in declared.items() if (spec or {}).get("required") and name not in params]
    if "{" in path or missing:
        return None, "Faltan parámetros: " + ", ".join(missing or [path])
    return {"path": path, "query": query, "body": body or None}, None


async def call_connector(args):
    connector_id = str(args.get("connector", ""))
    operation_name = str(args.get("operation", ""))
    params = args.get("params") or {}
    items = {item["id"]: item for item in await connectors()}
    connector = items.get(connector_id)
    if not connector:
        return {"error": "Conector no encontrado"}
    operation = next((item for item in connector.get("operations", []) if item.get("name") == operation_name), None)
    if not operation:
        return {"error": "Operación no encontrada"}
    request, error = build_request(operation, params)
    if error:
        return {"error": error}
    if operation.get("write"):
        summary = {"connector": connector.get("name", connector_id), "operation": operation_name, "method": operation["method"], "path": request["path"], "params": params}
        approved = await ecoBridge.confirm("call_connector", json.dumps(summary, ensure_ascii=False))
        if not approved:
            return {"error": "Acción cancelada"}
    raw = await ecoBridge.connectorFetch(
        connector_id,
        operation["method"],
        request["path"],
        json.dumps(request["query"], ensure_ascii=False),
        json.dumps(request["body"], ensure_ascii=False),
    )
    result = json.loads(raw)
    if result.get("error") == NOT_CONNECTED:
        reason = result.get("reason", "")
        await ecoBridge.requestSignIn(connector_id)
        detail = AUTH_REASONS.get(reason, "")
        if result.get("api_message"):
            detail += " Respuesta del servicio: " + str(result["api_message"])
        return {"error": SIGN_IN_REQUESTED, "reason": reason, "detail": detail.strip()}
    return result


def register(registry):
    registry.add(
        "create_connector",
        schema(
            "Crea un conector a una API externa cuando la persona pide conectarse a un servicio. Define URL base, autenticación y operaciones HTTP; marca write en las que modifican datos. Nunca pidas contraseñas ni tokens en el chat: tras crearlo, la app muestra a la persona un formulario seguro de inicio de sesión.",
            {"definition": DEFINITION_SCHEMA},
            ["definition"],
        ),
        create_connector,
    )
    registry.add("list_connectors", schema("Lista los conectores, sus operaciones y si están conectados.", {}), list_connectors)
    registry.add(
        "call_connector",
        schema(
            "Llama a una operación de un conector. Las operaciones de escritura piden aprobación.",
            {"connector": {"type": "string"}, "operation": {"type": "string"}, "params": {"type": "object"}},
            ["connector", "operation"],
        ),
        call_connector,
    )
    registry.add(
        "request_sign_in",
        schema("Muestra a la persona el formulario seguro para iniciar sesión en un conector.", {"connector": {"type": "string"}}, ["connector"]),
        request_sign_in,
    )
