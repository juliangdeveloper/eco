import json
from .runtime import bridge as ecoBridge
from .registry import schema

ACTION_SCHEMA = {
    "type": "object",
    "description": "Local action. kind: foto_frontal, foto_trasera, hablar, callar, modo_cara, rutina or herramienta. hablar needs texto; rutina needs rutina (id); herramienta needs herramienta (device tool name) and optional params.",
    "properties": {
        "kind": {"type": "string", "enum": ["foto_frontal", "foto_trasera", "hablar", "callar", "modo_cara", "rutina", "herramienta"]},
        "texto": {"type": "string"},
        "rutina": {"type": "string"},
        "herramienta": {"type": "string"},
        "params": {"type": "object"},
    },
    "required": ["kind"],
}


def handler(action):
    async def call(args):
        return json.loads(await ecoBridge.magic(action, json.dumps(args, ensure_ascii=False)))
    return call


def register(registry):
    registry.add(
        "magia_listar",
        schema("Lists this Eco's Magic commands.", {}),
        handler("listar"),
    )
    registry.add(
        "magia_crear",
        schema(
            "Creates a Magic command. A phrase said while Listen is on, or typed exactly in the chat, runs it. tipo local runs on the device without the model: foto_frontal, foto_trasera, hablar, callar, modo_cara, rutina or herramienta. tipo model starts a turn with instruccion; words after the phrase are attached as data. Optional respuesta is said aloud after a successful local run. origen is user by default; use shared_memory when creating it because of a shared-memory message.",
            {
                "frases": {"type": "array", "items": {"type": "string"}, "description": "Phrases that trigger the command."},
                "tipo": {"type": "string", "enum": ["local", "model"]},
                "accion": ACTION_SCHEMA,
                "instruccion": {"type": "string"},
                "respuesta": {"type": "string"},
                "origen": {"type": "string", "enum": ["user", "shared_memory"]},
                "activa": {"type": "boolean"},
            },
            ["frases", "tipo"],
        ),
        handler("crear"),
    )
    registry.add(
        "magia_editar",
        schema(
            "Updates a Magic command by id. Only the fields you send are changed.",
            {
                "id": {"type": "string"},
                "frases": {"type": "array", "items": {"type": "string"}},
                "tipo": {"type": "string", "enum": ["local", "model"]},
                "accion": ACTION_SCHEMA,
                "instruccion": {"type": "string"},
                "respuesta": {"type": "string"},
                "origen": {"type": "string", "enum": ["user", "shared_memory"]},
                "activa": {"type": "boolean"},
            },
            ["id"],
        ),
        handler("editar"),
    )
    registry.add(
        "magia_borrar",
        schema("Deletes a Magic command by id.", {"id": {"type": "string"}}, ["id"]),
        handler("borrar"),
    )
