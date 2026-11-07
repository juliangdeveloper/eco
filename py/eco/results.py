import json
from .registry import schema

COMPACT_CHAR_LIMIT = 6000
MAX_LIST_ITEMS = 20
MAX_STRING_CHARS = 600
READ_DEFAULT_LIMIT = 6000
READ_MAX_LIMIT = 20000
SEARCH_CONTEXT_CHARS = 300
MAX_SEARCH_MATCHES = 20
NOISE_KEYS = {"node_id", "avatar_url", "gravatar_id", "_links", "etag", "url", "events_url", "received_events_url", "followers_url", "following_url", "gists_url", "starred_url", "subscriptions_url", "organizations_url", "repos_url", "labels_url", "comments_url", "timeline_url", "performed_via_github_app", "reactions", "permissions", "sha_url", "git_url", "ssh_url", "svn_url", "clone_url", "mirror_url", "keys_url", "collaborators_url", "teams_url", "hooks_url", "issue_events_url", "assignees_url", "branches_url", "tags_url", "blobs_url", "git_tags_url", "git_refs_url", "trees_url", "statuses_url", "languages_url", "stargazers_url", "contributors_url", "subscribers_url", "subscription_url", "commits_url", "git_commits_url", "merges_url", "archive_url", "downloads_url", "issues_url", "pulls_url", "milestones_url", "notifications_url", "releases_url", "deployments_url", "compare_url", "contents_url", "review_comments_url", "review_comment_url", "statuses_url", "diff_url", "patch_url", "issue_url", "commit_url", "repository_url", "user_view_type", "site_admin", "type_url"}
KEEP_URL_KEYS = {"html_url"}

store = {"items": {}, "next": 1}


def load(items):
    store["items"] = dict(items or {})
    numbers = [int(key[1:]) for key in store["items"] if key[1:].isdigit()]
    store["next"] = max(numbers, default=0) + 1


def dump():
    return store["items"]


def save(name, text):
    key = "r" + str(store["next"])
    store["next"] += 1
    store["items"][key] = {"tool": name, "content": text}
    return key


def is_noise(key, value):
    if value is None or value == "" or value == [] or value == {}:
        return True
    if key in KEEP_URL_KEYS:
        return False
    return key in NOISE_KEYS or key.endswith("_url") and isinstance(value, str) and "api." in value


def clean(value):
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items() if not is_noise(key, item)}
    if isinstance(value, list):
        return [clean(item) for item in value]
    return value


def cap(value, items, chars):
    if isinstance(value, dict):
        return {key: cap(item, items, chars) for key, item in value.items()}
    if isinstance(value, list):
        result = [cap(item, items, chars) for item in value[:items]]
        if len(value) > items:
            result.append("… " + str(len(value) - items) + " elementos más")
        return result
    if isinstance(value, str) and len(value) > chars:
        return value[:chars] + "… (" + str(len(value)) + " caracteres)"
    return value


def unwrap(value):
    if isinstance(value, str):
        try:
            return json.loads(value), True
        except Exception:
            return value, False
    if isinstance(value, dict):
        return {key: unwrap(item)[0] for key, item in value.items()}, True
    if isinstance(value, list):
        return [unwrap(item)[0] for item in value], True
    return value, True


def dumps(value):
    return json.dumps(value, ensure_ascii=False)


def compact(name, result, args=None):
    full = dumps(result)
    reading = name == "leer_resultado"
    key = result.get("id", "") if reading else save(name, full)
    if reading and "limit" in (args or {}):
        return full, key
    if len(full) <= COMPACT_CHAR_LIMIT:
        return full, key
    value, _ = unwrap(result)
    small = dumps(clean(value))
    items, chars = MAX_LIST_ITEMS, MAX_STRING_CHARS
    shown = clean(value)
    while len(small) > COMPACT_CHAR_LIMIT and items > 1:
        shown = cap(clean(value), items, chars)
        small = dumps(shown)
        items, chars = items // 2, max(chars // 2, 80)
    if len(small) > COMPACT_CHAR_LIMIT:
        shown = small[:COMPACT_CHAR_LIMIT]
    note = "[resultado resumido; completo en historial id=" + key + ", " + str(len(full)) + " caracteres; usa leer_resultado para ver más]"
    return dumps({"resumen": shown, "nota": note}), key


def select(value, path):
    for part in [item for item in path.replace("[", ".").replace("]", "").split(".") if item]:
        if isinstance(value, list) and part.lstrip("-").isdigit():
            value = value[int(part)]
        elif isinstance(value, dict):
            value = value[part]
        else:
            raise KeyError(part)
    return value


async def leer_resultado(args):
    key = str(args.get("id", ""))
    item = store["items"].get(key)
    if not item:
        return {"error": "No existe el resultado " + key, "disponibles": list(store["items"].keys())[-MAX_SEARCH_MATCHES:]}
    text = item["content"]
    try:
        value = unwrap(json.loads(text))[0]
        text = dumps(value)
    except Exception:
        value = None
    if args.get("path"):
        try:
            text = dumps(select(value, args["path"]))
        except Exception:
            return {"error": "Ruta no encontrada: " + args["path"]}
    search = args.get("buscar")
    if search:
        lower, needle, matches, start = text.lower(), search.lower(), [], 0
        while len(matches) < MAX_SEARCH_MATCHES:
            index = lower.find(needle, start)
            if index < 0:
                break
            matches.append({"offset": index, "texto": text[max(0, index - SEARCH_CONTEXT_CHARS):index + len(needle) + SEARCH_CONTEXT_CHARS]})
            start = index + len(needle)
        return {"id": key, "total": len(text), "coincidencias": matches}
    offset = max(0, int(args.get("offset") or 0))
    limit = min(READ_MAX_LIMIT, max(1, int(args.get("limit") or READ_DEFAULT_LIMIT)))
    end = offset + limit
    return {"id": key, "herramienta": item["tool"], "total": len(text), "offset": offset, "texto": text[offset:end], "siguiente_offset": end if end < len(text) else None}


def register(registry):
    properties = {
        "id": {"type": "string", "description": "Id del historial, por ejemplo r3"},
        "path": {"type": "string", "description": "Ruta JSON opcional, por ejemplo items.0.title"},
        "buscar": {"type": "string", "description": "Texto a buscar dentro del resultado"},
        "offset": {"type": "integer"},
        "limit": {"type": "integer", "minimum": 1, "maximum": READ_MAX_LIMIT, "description": "Caracteres por página; si se indica, devuelve el fragmento sin resumir"},
    }
    registry.add("leer_resultado", schema("Lee el resultado completo de una herramienta guardado en el historial: por partes con offset y limit, una ruta JSON o buscando texto.", properties, ["id"]), leer_resultado)
