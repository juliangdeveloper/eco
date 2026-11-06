import json
from js import ecoBridge
from .registry import schema

MEMORY_LIMIT = 6000
USER_LIMIT = 3000


def mutate(text, action, content, old_text, limit):
    entries = [entry for entry in text.split("\n") if entry]
    if action == "add":
        if content.strip():
            entries.append(content.strip())
    elif action == "replace":
        if old_text not in entries:
            return None
        entries[entries.index(old_text)] = content.strip()
    elif action == "remove":
        if old_text not in entries:
            return None
        entries.remove(old_text)
    else:
        return None
    result = "\n".join(entries).strip()
    return result if len(result) <= limit else False


async def memory(args):
    state = json.loads(await ecoBridge.state())
    target = args.get("target", "memory")
    if target not in ("memory", "user"):
        return {"error": "Destino inválido"}
    result = mutate(state.get(target, ""), args.get("action", "add"), args.get("content", ""), args.get("old_text", ""), MEMORY_LIMIT if target == "memory" else USER_LIMIT)
    if result is None:
        return {"error": "Texto no encontrado o acción inválida"}
    if result is False:
        return {"error": "Se superó el límite de memoria"}
    state[target] = result
    await ecoBridge.saveState(json.dumps(state, ensure_ascii=False))
    return {"ok": True, "target": target, "entries": result.split("\n") if result else []}


def register(registry):
    registry.add("memory", schema("Gestiona entradas de memoria persistente.", {"target": {"type": "string", "enum": ["memory", "user"]}, "action": {"type": "string", "enum": ["add", "replace", "remove"]}, "content": {"type": "string"}, "old_text": {"type": "string"}}, ["target", "action"]), memory)
