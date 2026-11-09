import json
import re
from urllib.parse import quote, urlparse
from .runtime import bridge as ecoBridge
from .registry import schema

AUTH_TYPES = ["none", "bearer", "api_key", "basic", "oauth2"]
METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
PARAM_LOCATIONS = ["path", "query", "body"]
NOT_CONNECTED = "not_connected"
AUTH_REASONS = {
    "missing_credential": "There is no saved credential for this connector.",
    "credential_unreadable": "The saved credential could not be decrypted in this browser.",
    "expired": "Access expired and could not be renewed.",
    "rejected_by_api": "The service rejected the credential (401): it may be invalid, revoked or lack permissions.",
}
SIGN_IN_REQUESTED = "The connector is not connected. The person was asked to sign in; try again when they confirm."

DEFINITION_SCHEMA = {
    "type": "object",
    "properties": {
        "id": {"type": "string", "description": "Short identifier in lowercase letters, numbers and hyphens."},
        "name": {"type": "string"},
        "base_url": {"type": "string", "description": "Base https URL of the API."},
        "mcp_url": {"type": "string", "description": "https URL of the official remote MCP server. If you use it, base_url and operations aren't needed: the tools load from the server."},
        "headers": {"type": "object", "description": "MCP only: the server's X-MCP-* headers, for example to choose tool sets."},
        "auth": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": AUTH_TYPES},
                "header": {"type": "string", "description": "Header for api_key."},
                "query_param": {"type": "string", "description": "Query parameter for api_key."},
                "prefix": {"type": "string", "description": "Prefix for bearer, 'Bearer ' by default."},
                "authorize_url": {"type": "string"},
                "token_url": {"type": "string"},
                "developer_url": {"type": "string", "description": "Optional: the provider's https page to register the OAuth application and get the Client ID."},
                "scopes": {"type": "array", "items": {"type": "string"}},
                "flow": {"type": "string", "enum": ["pkce", "implicit"], "description": "For Google use implicit."},
                "extra_params": {"type": "object"},
                "renewal": {"type": "string", "enum": ["refresh_token", "silent", "none"], "description": "How to renew access without bothering anyone: refresh_token if the provider issues one (flow pkce), silent for silent renewal with prompt=none (Google, flow implicit), none if it isn't possible."},
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
                    "path": {"type": "string", "description": "Path starting with /, with {param} for path parameters."},
                    "params": {"type": "object", "description": "name -> {type, in: path|query|body, required, description}"},
                    "write": {"type": "boolean"},
                },
                "required": ["name", "method", "path"],
            },
        },
    },
    "required": ["id", "name", "auth"],
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
MCP_HEADER_PREFIX = "x-mcp-"
MCP_SEPARATOR = "__"
TOOL_NAME_LIMIT = 64
MAX_MCP_TOOLS = 60
RETRY_HINT = " Fix the definition and call create_connector again."


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


def normalize_mcp(definition):
    url = str(definition.get("mcp_url") or definition.get("base_url") or definition.get("url") or "").strip()
    if not url.startswith("https://"):
        return None, "mcp_url must be the https URL of the MCP server." + RETRY_HINT
    name = str(definition.get("name") or "").strip()
    identifier = slug(definition.get("id") or name or urlparse(url).hostname.split(".")[0])
    auth = definition.get("auth")
    kind = compact(auth.get("type") if isinstance(auth, dict) else auth)
    headers = definition.get("headers") if isinstance(definition.get("headers"), dict) else {}
    return {
        "id": identifier,
        "name": name or identifier,
        "kind": "mcp",
        "base_url": url,
        "auth": {"type": "none" if kind in ("none", "noauth", "public") else "bearer"},
        "headers": {str(key): str(value) for key, value in headers.items() if str(key).lower().startswith(MCP_HEADER_PREFIX)},
    }, None


def normalize_definition(raw):
    definition = unwrap(raw)
    if not definition:
        return None, "The definition must be a JSON object." + RETRY_HINT
    if definition.get("mcp_url") or compact(definition.get("kind")) == "mcp":
        return normalize_mcp(definition)
    base_url = as_https(definition.get("base_url") or definition.get("baseUrl") or definition.get("url") or definition.get("api_url"))
    if not urlparse(base_url).hostname:
        return None, "Missing base_url, the https URL of the API." + RETRY_HINT
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
        return None, "Include at least one operation with name, method and path." + RETRY_HINT
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


MIN_SERVICE_KEY = 4
MCP_FIRST = "Before creating an API connector, look for the service's official remote MCP server and check it with probe_mcp. If the service has no MCP or it doesn't respond, call create_connector again with sin_mcp set to true."


def service_key(value):
    host = urlparse(str(value or "")).hostname or ""
    labels = [label for label in host.split(".") if label not in ("www", "api", "mcp")]
    return labels[-2] if len(labels) >= 2 else (labels[0] if labels else "")


def same_service(definition, item):
    names = {compact(definition["id"]), compact(definition["name"])}
    if compact(item.get("id")) in names or compact(item.get("name")) in names:
        return True
    key = service_key(definition["base_url"])
    other = service_key(item.get("base_url"))
    return len(key) >= MIN_SERVICE_KEY and len(other) >= MIN_SERVICE_KEY and (key.startswith(other) or other.startswith(key))


async def create_connector(args):
    definition, error = normalize_definition(args)
    if error:
        return {"ok": False, "error": error}
    if definition.get("kind") == "mcp":
        replaced = []
        for item in await connectors():
            if item.get("kind") != "mcp" and same_service(definition, item):
                await ecoBridge.replaceConnector(item["id"])
                replaced.append(item["id"])
        result = json.loads(await ecoBridge.createConnector(json.dumps(definition, ensure_ascii=False)))
        if replaced:
            result["replaced"] = replaced
        return result
    raw = unwrap(args) or {}
    flag = (args.get("sin_mcp") if isinstance(args, dict) else None) or raw.get("sin_mcp")
    if flag is not True:
        return {"ok": False, "error": MCP_FIRST}
    host = urlparse(definition["base_url"]).hostname
    existing = [item for item in await connectors() if urlparse(item.get("base_url", "")).hostname == host and item.get("kind") != "mcp"]
    if existing and not any(item["id"] == definition["id"] for item in existing):
        definition["id"] = existing[0]["id"]
    try:
        result = json.loads(await ecoBridge.createConnector(json.dumps(definition, ensure_ascii=False)))
    except Exception:
        return {"ok": False, "error": "Could not save the connector." + RETRY_HINT}
    if not result.get("ok") and result.get("error"):
        result["error"] = str(result["error"]) + "." + RETRY_HINT
    return result


def public_view(connector):
    item = {key: value for key, value in connector.items() if key != "tools"}
    if connector.get("kind") == "mcp":
        item["tools"] = [tool_name(connector["id"], tool["name"]) for tool in connector.get("tools", [])][:MAX_MCP_TOOLS]
    return item


async def list_connectors(args):
    return {"connectors": [public_view(item) for item in await connectors()]}


async def probe_mcp(args):
    headers = args.get("headers") if isinstance(args.get("headers"), dict) else {}
    return json.loads(await ecoBridge.probeMcp(str(args.get("url", "")), json.dumps(headers)))


def tool_name(connector_id, name):
    text = re.sub(r"[^a-zA-Z0-9_-]", "_", connector_id.replace("-", "_") + MCP_SEPARATOR + name)
    return text[:TOOL_NAME_LIMIT]


def clean_schema(value):
    if not isinstance(value, dict) or value.get("type") != "object":
        return {"type": "object", "properties": {}}
    result = dict(value)
    result.pop("$schema", None)
    if not isinstance(result.get("properties"), dict):
        result["properties"] = {}
    return result


def mcp_handler(connector, tool):
    async def handler(args):
        result = json.loads(await ecoBridge.mcpCall(connector["id"], tool["name"], json.dumps(args, ensure_ascii=False)))
        if result.get("error") == NOT_CONNECTED:
            reason = result.get("reason", "")
            await ecoBridge.requestSignIn(connector["id"])
            return {"error": SIGN_IN_REQUESTED, "reason": reason, "detail": AUTH_REASONS.get(reason, "")}
        return result
    return handler


async def register_mcp(registry):
    for name in [key for key, item in registry.items.items() if item.get("mcp")]:
        registry.items.pop(name)
    count = 0
    for connector in await connectors():
        if connector.get("kind") != "mcp" or connector.get("status") != "connected":
            continue
        ordered = sorted(connector.get("tools", []), key=lambda tool: not tool.get("readOnly"))
        for tool in ordered:
            if count >= MAX_MCP_TOOLS:
                return
            definition = {"description": str(tool.get("description") or tool["name"]), "parameters": clean_schema(tool.get("inputSchema"))}
            registry.add(tool_name(connector["id"], tool["name"]), definition, mcp_handler(connector, tool))
            registry.items[tool_name(connector["id"], tool["name"])]["mcp"] = True
            count += 1


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
                return None, "Invalid path parameter: " + name
            path = path.replace(token, quote(text, safe="/"))
        elif location == "body" or (location is None and operation["method"] != "GET"):
            body[name] = value
        else:
            query[name] = value
    missing = [name for name, spec in declared.items() if (spec or {}).get("required") and name not in params]
    if "{" in path or missing:
        return None, "Missing parameters: " + ", ".join(missing or [path])
    return {"path": path, "query": query, "body": body or None}, None


async def call_connector(args):
    connector_id = str(args.get("connector", ""))
    operation_name = str(args.get("operation", ""))
    params = args.get("params") or {}
    items = {item["id"]: item for item in await connectors()}
    connector = items.get(connector_id)
    if not connector:
        return {"error": "Connector not found"}
    operation = next((item for item in connector.get("operations", []) if item.get("name") == operation_name), None)
    if not operation:
        return {"error": "Operation not found"}
    request, error = build_request(operation, params)
    if error:
        return {"error": error}
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
            detail += " Service response: " + str(result["api_message"])
        return {"error": SIGN_IN_REQUESTED, "reason": reason, "detail": detail.strip()}
    return result


def register(registry):
    registry.add(
        "create_connector",
        schema(
            "Creates a connector when the person asks to connect to a service. Always prefer the service's official remote MCP server: pass mcp_url (checked first with probe_mcp) and auth bearer if it asks for a token; it replaces any API connector for the same service. Only if the service has no MCP, define base_url, authentication and HTTP operations, mark write on the ones that modify data and pass sin_mcp as true. Never ask for passwords or tokens in the chat: after it's created, the app shows the person a secure sign-in form.",
            {"definition": DEFINITION_SCHEMA, "sin_mcp": {"type": "boolean", "description": "true only if you already checked that the service has no remote MCP server."}},
            ["definition"],
        ),
        create_connector,
    )
    registry.add(
        "probe_mcp",
        schema(
            "Checks whether an https URL is a remote MCP server that responds from the browser and whether it asks for a token. Always use it first, with the official MCP server URL the provider publishes in its documentation; if it fails, try another official URL before falling back to an API.",
            {"url": {"type": "string"}, "headers": {"type": "object", "description": "Optional X-MCP-* headers."}},
            ["url"],
        ),
        probe_mcp,
    )
    registry.add("list_connectors", schema("Lists the connectors, their operations and whether they are connected.", {}), list_connectors)
    registry.add(
        "call_connector",
        schema(
            "Calls a connector operation. Operations run without confirmation.",
            {"connector": {"type": "string"}, "operation": {"type": "string"}, "params": {"type": "object"}},
            ["connector", "operation"],
        ),
        call_connector,
    )
    registry.add(
        "request_sign_in",
        schema("Shows the person the secure form to sign in to a connector.", {"connector": {"type": "string"}}, ["connector"]),
        request_sign_in,
    )
