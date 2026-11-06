import json
from js import ecoBridge
from .registry import schema

VALID_STATUS = {"pending", "in_progress", "completed", "cancelled"}
MAX_TODOS = 100


def valid(items):
    if not isinstance(items, list) or len(items) > MAX_TODOS:
        return False
    return all(isinstance(item, dict) and isinstance(item.get("id"), str) and isinstance(item.get("content"), str) and item.get("status") in VALID_STATUS for item in items)


async def todo_list(args):
    state = json.loads(await ecoBridge.state())
    incoming = args.get("todos")
    if incoming is not None:
        if not valid(incoming):
            return {"error": "Lista de tareas inválida"}
        if args.get("merge"):
            indexed = {item["id"]: item for item in state.get("todos", [])}
            indexed.update({item["id"]: item for item in incoming})
            state["todos"] = list(indexed.values())
        else:
            state["todos"] = incoming
        await ecoBridge.saveState(json.dumps(state, ensure_ascii=False))
    return {"todos": state.get("todos", [])}


def register(registry):
    properties = {"todos": {"type": "array", "items": {"type": "object", "properties": {"id": {"type": "string"}, "content": {"type": "string"}, "status": {"type": "string", "enum": list(VALID_STATUS)}}}}, "merge": {"type": "boolean"}}
    registry.add("todo_list", schema("Consulta o actualiza las tareas de esta sesión.", properties), todo_list)
