import base64
import json
from urllib.parse import urlencode, quote
from js import ecoBridge
from .registry import js_value

APIS = [
    {"id": "github", "nombre": "GitHub", "base_url": "https://api.github.com", "auth": {"tipo": "bearer", "credential": "githubToken", "opcional": True}, "headers": {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}, "herramientas": [
        {"name": "github_list_repos", "description": "Lista repositorios.", "method": "GET", "path": "/user/repos", "query": ["per_page"], "parameters": {"type": "object", "properties": {"owner": {"type": "string"}, "per_page": {"type": "integer"}}}},
        {"name": "github_list_issues", "description": "Lista incidencias.", "method": "GET", "path": "/repos/{repo}/issues", "query": ["state", "per_page"], "parameters": {"type": "object", "properties": {"repo": {"type": "string"}, "state": {"type": "string"}, "per_page": {"type": "integer"}}, "required": ["repo"]}},
        {"name": "github_list_prs", "description": "Lista pull requests.", "method": "GET", "path": "/repos/{repo}/pulls", "query": ["state", "per_page"], "parameters": {"type": "object", "properties": {"repo": {"type": "string"}, "state": {"type": "string"}, "per_page": {"type": "integer"}}, "required": ["repo"]}},
        {"name": "github_read_file", "description": "Lee un archivo UTF-8.", "method": "GET", "path": "/repos/{repo}/contents/{path}", "query": ["ref"], "parameters": {"type": "object", "properties": {"repo": {"type": "string"}, "path": {"type": "string"}, "ref": {"type": "string"}}, "required": ["repo", "path"]}, "transform": "read"},
        {"name": "github_write_file", "description": "Escribe un archivo.", "method": "PUT", "path": "/repos/{repo}/contents/{path}", "body": ["message", "content", "sha"], "confirmar": True, "parameters": {"type": "object", "properties": {"repo": {"type": "string"}, "path": {"type": "string"}, "message": {"type": "string"}, "content": {"type": "string"}, "sha": {"type": "string"}}, "required": ["repo", "path", "message", "content"]}, "transform": "write"},
        {"name": "github_create_pr", "description": "Crea un pull request.", "method": "POST", "path": "/repos/{repo}/pulls", "body": ["title", "head", "base", "body"], "confirmar": True, "parameters": {"type": "object", "properties": {"repo": {"type": "string"}, "title": {"type": "string"}, "head": {"type": "string"}, "base": {"type": "string"}, "body": {"type": "string"}}, "required": ["repo", "title", "head", "base"]}}
    ]},
    {"id": "gmail", "nombre": "Gmail", "base_url": "https://gmail.googleapis.com/gmail/v1/users/me", "auth": {"tipo": "oauth_google", "credential": "gmailToken"}, "headers": {}, "herramientas": [
        {"name": "gmail_search", "description": "Busca correos.", "method": "GET", "path": "/messages", "query": ["q", "maxResults"], "parameters": {"type": "object", "properties": {"q": {"type": "string"}, "maxResults": {"type": "integer"}}, "required": ["q"]}},
        {"name": "gmail_read", "description": "Lee un correo.", "method": "GET", "path": "/messages/{id}", "query": ["format"], "parameters": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}, "transform": "mail"},
        {"name": "gmail_create_draft", "description": "Crea un borrador.", "method": "POST", "path": "/drafts", "body": ["to", "subject", "body"], "confirmar": True, "parameters": {"type": "object", "properties": {"to": {"type": "string"}, "subject": {"type": "string"}, "body": {"type": "string"}}, "required": ["to", "subject", "body"]}, "transform": "draft"}
    ]}
]


def decode(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode("utf-8", errors="replace")


SUMMARY_FIELDS = {"name": "nombre", "full_name": "repo", "html_url": "url", "state": "estado", "number": "número", "title": "título", "private": "privado", "description": "descripción", "type": "tipo", "path": "ruta", "updated_at": "actualizado"}


def summary(item):
    if not isinstance(item, dict):
        return item
    return {label: item[key] for key, label in SUMMARY_FIELDS.items() if item.get(key) not in (None, "")}


def transform(kind, data):
    if isinstance(data, list):
        return {"items": [summary(item) for item in data]}
    if kind == "read" and data.get("content"):
        data["text"] = base64.b64decode(data["content"]).decode("utf-8", errors="replace")
    if kind == "mail":
        payload = data.get("payload", {})
        headers = {item.get("name", "").lower(): item.get("value", "") for item in payload.get("headers", [])}
        def text(part):
            if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
                return decode(part["body"]["data"])
            return "\n".join(text(child) for child in part.get("parts", []))
        return {"asunto": headers.get("subject", ""), "de": headers.get("from", ""), "fecha": headers.get("date", ""), "cuerpo": text(payload)}
    return data


async def request(api, tool, args):
    config = json.loads(await ecoBridge.config())
    if not config.get(api["id"] + "Enabled", True):
        return {"error": api["nombre"] + " está desactivado"}
    token = config.get(api["auth"].get("credential", ""), "") if api["auth"]["tipo"] != "ninguna" else ""
    if not token and api["auth"]["tipo"] != "ninguna" and not api["auth"].get("opcional"):
        return {"error": "Conecta " + api["nombre"] + " en Ajustes"}
    path = tool["path"]
    if tool["name"] == "github_list_repos" and args.get("owner"):
        path = "/users/{owner}/repos"
    for key, value in args.items():
        safe = "/" if key in ("repo", "path") else ""
        path = path.replace("{" + key + "}", quote(str(value), safe=safe))
    query = {key: args[key] for key in tool.get("query", []) if args.get(key) not in (None, "")}
    headers = dict(api["headers"])
    if token:
        headers["Authorization"] = "Bearer " + token
    body = {key: args[key] for key in tool.get("body", []) if args.get(key) not in (None, "")}
    if tool.get("transform") == "write":
        body["content"] = base64.b64encode(args["content"].encode("utf-8")).decode("ascii")
        if not body.get("sha"):
            existing = await request(api, {"name": "github_read_file", "method": "GET", "path": "/repos/{repo}/contents/{path}", "parameters": {}}, {"repo": args["repo"], "path": args["path"]})
            if existing.get("sha"):
                body["sha"] = existing["sha"]
    if tool.get("transform") == "draft":
        subject = base64.b64encode(args["subject"].encode("utf-8")).decode("ascii")
        raw = "To: " + args["to"] + "\r\nSubject: =?UTF-8?B?" + subject + "?=\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n" + args["body"]
        body = {"message": {"raw": base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")}}
    if body:
        headers["Content-Type"] = "application/json"
    url = api["base_url"] + path + (("?" + urlencode(query)) if query else "")
    init = {"method": tool["method"], "headers": headers}
    if body:
        init["body"] = json.dumps(body, ensure_ascii=False)
    response = await ecoBridge.fetch(url, js_value(init))
    raw = await response.text()
    try:
        data = json.loads(raw)
    except Exception:
        data = {"text": raw}
    return transform(tool.get("transform"), data) if response.ok else {"error": data, "status": response.status}


def register(registry, config):
    for api in APIS:
        if not config.get(api["id"] + "Enabled", True):
            continue
        for tool in api["herramientas"]:
            async def handler(args, api=api, tool=tool):
                return await request(api, tool, args)
            registry.add(tool["name"], {"description": tool["description"], "parameters": tool["parameters"]}, handler, tool.get("confirmar", False))
