import json
from .runtime import bridge as ecoBridge
from .registry import schema


async def skills_list(args):
    return {"skills": json.loads(await ecoBridge.skills())}


async def skill_view(args):
    skills = json.loads(await ecoBridge.skills())
    found = next((skill for skill in skills if skill.get("id") == args.get("name")), None)
    if found:
        return found
    return json.loads(await ecoBridge.passiveTopic(str(args.get("name", "")))) or {"error": "Skill not found"}


async def skill_manage(args):
    return json.loads(await ecoBridge.skillManage(json.dumps(args, ensure_ascii=False)))


async def session_search(args):
    return json.loads(await ecoBridge.sessionSearch(args.get("query", ""), args.get("limit", 10)))


async def clarify(args):
    result = await ecoBridge.clarify(args.get("question", "How should we continue?"), json.dumps(args.get("options", [])))
    return {"answer": str(result)}


async def upload_file(args):
    return json.loads(await ecoBridge.uploadAttachment(json.dumps(args, ensure_ascii=False)))


async def face_mode(args):
    action = str(args.get("action", "estado"))
    return json.loads(await ecoBridge.faceMode(action if action in ("on", "off") else "estado"))


def register(registry, child=False):
    registry.add("skills_list", schema("Lists skills.", {}), skills_list)
    registry.add("skill_view", schema("Shows a skill.", {"name": {"type": "string"}}, ["name"]), skill_view)
    registry.add("skill_manage", schema("Creates, edits or deletes a skill.", {"action": {"type": "string", "enum": ["create", "edit", "delete"]}, "name": {"type": "string"}, "description": {"type": "string"}, "content": {"type": "string"}}, ["action", "name"]), skill_manage)
    registry.add("session_search", schema("Searches previous sessions.", {"query": {"type": "string"}, "limit": {"type": "integer"}}, ["query"]), session_search)
    if child:
        registry.add("subir_archivo", schema("Uploads a conversation attachment to Google Drive with a multipart upload. Images that tools return (for example device.capture photos) are kept on the device, shown to the person and reach you as a ref such as img-0123456789. Needs the Google Drive memory connected. Optional name and parents (Drive folder ids). Returns id, name and webViewLink.", {"ref": {"type": "string"}, "name": {"type": "string"}, "parents": {"type": "array", "items": {"type": "string"}}}, ["ref"]), upload_file)
    if not child:
        registry.add("clarify", schema("Asks for a clarification.", {"question": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}}}, ["question"]), clarify)
