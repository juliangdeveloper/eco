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
                return {"error": "Invalid index", "entries": current}
        else:
            matches = [item for item in current if old_text and old_text in item["text"]]
            if not matches:
                return {"error": "Text not found", "entries": current}
            if len(matches) > 1:
                return {"error": "Several entries match; choose an index", "entries": matches}
            index = matches[0]["index"]
        if action == "replace":
            entries[index] = content.strip()
        else:
            entries.pop(index)
    else:
        return {"error": "Invalid action"}
    result = "\n".join(entries).strip()
    if len(result) > limit:
        over = len(result) - limit
        return {"error": "Memory limit exceeded by " + str(over) + " characters", "over_chars": over, "limit": limit, "entries": current}
    return result


async def memory(args):
    async with MEMORY_LOCK:
        state = json.loads(await ecoBridge.state())
        target = args.get("target", "memory")
        if target not in ("memory", "user"):
            return {"error": "Invalid destination"}
        limit = MEMORY_LIMIT if target == "memory" else USER_LIMIT
        result = mutate(state.get(target, ""), args.get("action", "add"), args.get("content", ""), args.get("old_text", ""), limit, args.get("index"))
        if isinstance(result, dict):
            return result
        await ecoBridge.saveMemory(target, result)
        return {"ok": True, "target": target, "entries": result.split("\n") if result else [], "used_chars": len(result), "free_chars": limit - len(result)}


def register(registry):
    registry.add("memory", schema("Manages persistent memory entries. To replace or delete, use old_text or index.", {"target": {"type": "string", "enum": ["memory", "user"]}, "action": {"type": "string", "enum": ["add", "replace", "remove"]}, "content": {"type": "string"}, "old_text": {"type": "string", "description": "Fragment of a single entry; if it matches several, returns their indexes"}, "index": {"type": "integer", "minimum": ENTRY_INDEX_START, "description": "Entry index from 0; an alternative to old_text, it takes priority if both are given"}}, ["target", "action"]), memory)
