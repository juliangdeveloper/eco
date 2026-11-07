import json
from .runtime import bridge as ecoBridge
from .registry import schema


async def skills_list(args):
    return {"skills": json.loads(await ecoBridge.skills())}


async def skill_view(args):
    skills = json.loads(await ecoBridge.skills())
    return next((skill for skill in skills if skill.get("id") == args.get("name")), {"error": "Habilidad no encontrada"})


async def skill_manage(args):
    return json.loads(await ecoBridge.skillManage(json.dumps(args, ensure_ascii=False)))


async def session_search(args):
    return json.loads(await ecoBridge.sessionSearch(args.get("query", ""), args.get("limit", 10)))


async def clarify(args):
    result = await ecoBridge.clarify(args.get("question", "¿Cómo seguimos?"), json.dumps(args.get("options", [])))
    return {"answer": str(result)}


def register(registry, child=False):
    registry.add("skills_list", schema("Lista habilidades.", {}), skills_list)
    registry.add("skill_view", schema("Muestra una habilidad.", {"name": {"type": "string"}}, ["name"]), skill_view)
    registry.add("skill_manage", schema("Crea, edita o borra una habilidad.", {"action": {"type": "string", "enum": ["create", "edit", "delete"]}, "name": {"type": "string"}, "description": {"type": "string"}, "content": {"type": "string"}}, ["action", "name"]), skill_manage, True)
    registry.add("session_search", schema("Busca sesiones anteriores.", {"query": {"type": "string"}, "limit": {"type": "integer"}}, ["query"]), session_search)
    registry.add("clarify", schema("Pide una aclaración.", {"question": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}}}, ["question"]), clarify)
