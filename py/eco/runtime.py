from contextvars import ContextVar
from js import ecoBridge as js_bridge

execution = ContextVar("execution", default=None)


def scope():
    return execution.get() or {}


class Bridge:
    def __getattr__(self, name):
        async def call(*args):
            current = scope()
            return await getattr(js_bridge, name)(*args, current.get("session", ""), current.get("job", ""))
        return call


bridge = Bridge()
