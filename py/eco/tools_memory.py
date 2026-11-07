import asyncio
import json
from .runtime import bridge as ecoBridge
from .registry import schema

MEMORY_LIMIT = 6000
USER_LIMIT = 3000
ENTRY_INDEX_START = 0
MEMORY_LOCK = asyncio.Lock()


def describe_entries(entries):
    return [{"index": index, "text": entry, "chars": len(entry)} for index, entry in enumerate(entries, start=ENTRY_INDEX_START)]


def mutate(text, action, content, old_text, limit, index=None):
    entries = [entry for entry in text.split("\n") if entry]
    current = describe_entries(entries)
    if action == "add":
        if content.strip():
            entries.append(content.strip())
    elif action in ("replace", "remove"):
        if index is not None:
            if type(index) is not int or not ENTRY_INDEX_START <= index < len(entries):
                return {"error": "Índice inválido", "entries": current}
        else:
            matches = [item for item in current if old_text and old_text in item["text"]]
            if not matches:
                return {"error": "Texto no encontrado", "entries": current}
            if len(matches) > 1:
                return {"error": "Varias entradas coinciden; elige un index", "entries": matches}
            index = matches[0]["index"]
        if action == "replace":
            entries[index] = content.strip()
        else:
            entries.pop(index)
    else:
        return {"error": "Acción inválida"}
    result = "\n".join(entries).strip()
    if len(result) > limit:
        over = len(result) - limit
        return {"error": "Se superó el límite de memoria por " + str(over) + " caracteres", "over_chars": over, "limit": limit, "entries": current}
    return result


async def memory(args):
    async with MEMORY_LOCK:
        state = json.loads(await ecoBridge.state())
        target = args.get("target", "memory")
        if target not in ("memory", "user"):
            return {"error": "Destino inválido"}
        limit = MEMORY_LIMIT if target == "memory" else USER_LIMIT
        result = mutate(state.get(target, ""), args.get("action", "add"), args.get("content", ""), args.get("old_text", ""), limit, args.get("index"))
        if isinstance(result, dict):
            return result
        await ecoBridge.saveMemory(target, result)
        return {"ok": True, "target": target, "entries": result.split("\n") if result else [], "used_chars": len(result), "free_chars": limit - len(result)}


def register(registry):
    registry.add("memory", schema("Gestiona entradas de memoria persistente. Para reemplazar o borrar, usa old_text o index.", {"target": {"type": "string", "enum": ["memory", "user"]}, "action": {"type": "string", "enum": ["add", "replace", "remove"]}, "content": {"type": "string"}, "old_text": {"type": "string", "description": "Fragmento de una sola entrada; si coincide con varias, devuelve sus índices"}, "index": {"type": "integer", "minimum": ENTRY_INDEX_START, "description": "Índice de entrada desde 0; alternativa a old_text, tiene prioridad si se indican ambos"}}, ["target", "action"]), memory)
