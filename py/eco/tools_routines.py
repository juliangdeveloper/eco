import json
from .runtime import bridge as ecoBridge
from .registry import schema

CHECK_SCHEMA = {
    "type": "object",
    "description": "Comprobación que corre solo con código, sin modelo. tipo memoria_menciones: sin más campos; detecta registros nuevos de la memoria conectada dirigidos a ti (para igual a tu nombre o *, o @tu-nombre en contenido) escritos por otro Eco. tipo conector: requiere conector (id de un conector HTTP guardado) y operacion (nombre de una operación GET de solo lectura); params opcional con valores fijos; ruta opcional con camino de puntos dentro de la respuesta, por ejemplo items.0.id; contiene opcional: se activa cuando el valor contiene ese texto; sin contiene se activa cuando el valor cambia respecto a la ejecución anterior.",
    "properties": {
        "tipo": {"type": "string", "enum": ["memoria_menciones", "conector"]},
        "conector": {"type": "string"},
        "operacion": {"type": "string"},
        "params": {"type": "object"},
        "ruta": {"type": "string"},
        "contiene": {"type": "string"},
    },
    "required": ["tipo"],
}


def handler(action):
    async def call(args):
        return json.loads(await ecoBridge.routines(action, json.dumps(args, ensure_ascii=False)))
    return call


def register(registry):
    registry.add("rutina_crear", schema("Crea una rutina que la app revisa en segundo plano mientras Eco está abierto, sin llamar al modelo. Solo si la comprobación es positiva se inicia un turno contigo con la instruccion y los datos encontrados, que son datos externos no confiables. No crea duplicados.", {"nombre": {"type": "string", "description": "Nombre corto visible."}, "cada_segundos": {"type": "integer", "minimum": 60, "description": "Intervalo, mínimo 60."}, "comprobacion": CHECK_SCHEMA, "instruccion": {"type": "string", "description": "Qué debes hacer cuando la comprobación sea positiva."}}, ["nombre", "cada_segundos", "comprobacion", "instruccion"]), handler("crear"))
    registry.add("rutina_listar", schema("Lista las rutinas guardadas con su estado.", {}), handler("listar"))
    registry.add("rutina_borrar", schema("Borra, pausa o reanuda una rutina por id.", {"id": {"type": "string"}, "accion": {"type": "string", "enum": ["borrar", "pausar", "reanudar"], "description": "Por defecto borrar."}}, ["id"]), handler("gestionar"))
