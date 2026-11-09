from pyodide.ffi import to_js
from js import Object


class Registry:
    def __init__(self):
        self.items = {}

    def add(self, name, definition, handler):
        self.items[name] = {"definition": definition, "handler": handler}

    def tools(self):
        return [{"type": "function", "function": {"name": name, "description": item["definition"]["description"], "parameters": item["definition"]["parameters"]}} for name, item in self.items.items()]

    async def call(self, name, args):
        item = self.items.get(name)
        if not item:
            return {"error": "Tool not available"}
        return await item["handler"](args)


def schema(description, properties, required=None):
    return {"description": description, "parameters": {"type": "object", "properties": properties, "required": required or []}}


def js_value(value):
    return to_js(value, dict_converter=Object.fromEntries)
