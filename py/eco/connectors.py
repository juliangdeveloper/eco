import json
from urllib.parse import quote
from js import ecoBridge
from .registry import schema

AUTH_TYPES = ["none", "bearer", "api_key", "basic", "oauth2"]
METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"]
PARAM_LOCATIONS = ["path", "query", "body"]
NOT_CONNECTED = "not_connected"
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


async def create_connector(args):
    definition = args.get("definition", args)
    return json.loads(await ecoBridge.createConnector(json.dumps(definition, ensure_ascii=False)))


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
        await ecoBridge.requestSignIn(connector_id)
        return {"error": SIGN_IN_REQUESTED}
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
        True,
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
