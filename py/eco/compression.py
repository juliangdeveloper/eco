import json

KEEP_RECENT_MESSAGES = 6


def estimate(messages):
    return sum(len(json.dumps(message, ensure_ascii=False)) for message in messages) // 4


def tail(messages):
    start = max(1, len(messages) - KEEP_RECENT_MESSAGES)
    while start > 1 and messages[start].get("role") == "tool":
        start -= 1
    return messages[start:]


async def compact(messages, limit, ask):
    if estimate(messages) <= limit:
        return messages, False
    recent = tail(messages)
    middle = messages[1:len(messages) - len(recent)]
    if not middle:
        return messages, False
    prompt = "Resume el contexto. Conserva decisiones, resultados de herramientas con su id de historial (rN) y pendientes sin inventar datos."
    summary = await ask([{"role": "system", "content": prompt}, {"role": "user", "content": json.dumps(middle, ensure_ascii=False)}], [])
    return [messages[0], {"role": "system", "content": "Contexto resumido:\n" + summary}] + recent, True
