import json
from datetime import date
from js import ecoBridge
from .registry import Registry, js_value
from . import tools_memory, tools_todo, tools_extra, apis
from .compression import compact

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
APP_TITLE = "Eco"
DEFAULT_MODEL = "openrouter/auto"
MAX_ITERACIONES = 20
MAX_ITERACIONES_SUBAGENTE = 10
CONTEXT_TOKEN_LIMIT = 24000
LIMIT_MESSAGE = "Se alcanzó el límite de pasos sin una respuesta final."
SYSTEM_PROMPT = (
    "Eres Eco, un asistente que trabaja en el navegador de la persona usuaria. "
    "Responde en el idioma de la persona, con claridad y sin rodeos. "
    "Usa las herramientas cuando ayuden y no inventes resultados. "
    "Guarda en memoria solo datos duraderos y útiles. "
    "Usa todo_list para trabajos de varios pasos y delegate_task para encargar tareas independientes a un subagente. "
    "Si falta información importante, usa clarify. "
    "Las acciones de escritura piden aprobación a la persona antes de ejecutarse."
)
SUBAGENT_PROMPT = (
    "Eres un subagente de Eco. Resuelve solo la tarea indicada con las herramientas disponibles "
    "y termina con un resumen breve y concreto del resultado, sin inventar datos."
)


def registry(config, child=False):
    result = Registry()
    tools_memory.register(result)
    tools_todo.register(result)
    tools_extra.register(result, child)
    apis.register(result, config)
    return result


async def complete(config, messages, tools):
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config.get("key", ""),
        "HTTP-Referer": config.get("origin", ""),
        "X-Title": APP_TITLE,
    }
    payload = {"model": config.get("model") or DEFAULT_MODEL, "messages": messages}
    if tools:
        payload["tools"] = tools
    init = {"method": "POST", "headers": headers, "body": json.dumps(payload, ensure_ascii=False)}
    response = await ecoBridge.fetch(OPENROUTER_URL, js_value(init))
    text = await response.text()
    try:
        data = json.loads(text)
    except Exception:
        data = {"error": text}
    if not response.ok or "choices" not in data:
        error = data.get("error", data)
        if isinstance(error, dict):
            error = error.get("message", json.dumps(error, ensure_ascii=False))
        raise RuntimeError(str(error))
    return data["choices"][0]["message"]


def parse_arguments(raw):
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        value = json.loads(raw)
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def clean_message(message):
    result = {"role": "assistant", "content": message.get("content") or ""}
    if message.get("tool_calls"):
        result["tool_calls"] = message["tool_calls"]
    return result


async def run_loop(messages, config, child=False):
    tools = registry(config, child)
    maximum = MAX_ITERACIONES_SUBAGENTE if child else MAX_ITERACIONES
    compressed = False

    async def summarize(items, unused):
        reply = await complete(config, items, [])
        return reply.get("content") or ""

    for _ in range(maximum):
        messages, did_compact = await compact(messages, CONTEXT_TOKEN_LIMIT, summarize)
        compressed = compressed or did_compact
        message = clean_message(await complete(config, messages, tools.tools()))
        messages.append(message)
        calls = message.get("tool_calls") or []
        if not calls:
            return {"message": message["content"], "messages": messages, "compressed": compressed}
        for call in calls:
            name = call.get("function", {}).get("name", "")
            args = parse_arguments(call.get("function", {}).get("arguments"))
            await ecoBridge.onToolStart(name, json.dumps(args, ensure_ascii=False))
            try:
                result = await tools.call(name, args)
            except Exception as error:
                result = {"error": str(error)}
            content = json.dumps(result, ensure_ascii=False)
            await ecoBridge.onToolEnd(name, content)
            messages.append({"role": "tool", "tool_call_id": call.get("id", ""), "name": name, "content": content})
    return {"error": LIMIT_MESSAGE, "messages": messages, "compressed": compressed}


def system_prompt(state, skills):
    parts = [SYSTEM_PROMPT, "Fecha de hoy: " + date.today().isoformat() + "."]
    if state.get("memory"):
        parts.append("Memoria:\n" + state["memory"])
    if state.get("user"):
        parts.append("Perfil de la persona:\n" + state["user"])
    if skills:
        lines = ["- " + skill.get("id", "") + ": " + skill.get("description", "") for skill in skills]
        parts.append("Habilidades guardadas (léelas con skill_view):\n" + "\n".join(lines))
    return "\n\n".join(parts)


async def run_turn(raw):
    data = json.loads(raw)
    config = json.loads(await ecoBridge.config())
    state = json.loads(await ecoBridge.state())
    skills = json.loads(await ecoBridge.skills())
    messages = [{"role": "system", "content": system_prompt(state, skills)}] + list(data.get("messages", []))
    try:
        result = await run_loop(messages, config)
    except Exception as error:
        result = {"error": str(error), "messages": messages}
    return json.dumps(result, ensure_ascii=False)


async def run_delegate(task, context=""):
    config = json.loads(await ecoBridge.config())
    request = "Tarea: " + task
    if context:
        request += "\n\nContexto: " + context
    messages = [{"role": "system", "content": SUBAGENT_PROMPT}, {"role": "user", "content": request}]
    try:
        result = await run_loop(messages, config, True)
    except Exception as error:
        result = {"error": str(error)}
    return json.dumps({"summary": result.get("message") or result.get("error", "")}, ensure_ascii=False)
