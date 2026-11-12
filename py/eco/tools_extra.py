import json
from .runtime import bridge as ecoBridge
from .registry import schema


async def skills_list(args):
    return {"skills": json.loads(await ecoBridge.skills())}


async def skill_view(args):
    skills = json.loads(await ecoBridge.skills())
    found = next((skill for skill in skills if skill.get("id") == args.get("name")), None)
    if found:
        return found
    return json.loads(await ecoBridge.passiveTopic(str(args.get("name", "")))) or {"error": "Skill not found"}


async def skill_manage(args):
    return json.loads(await ecoBridge.skillManage(json.dumps(args, ensure_ascii=False)))


async def session_search(args):
    return json.loads(await ecoBridge.sessionSearch(args.get("query", ""), args.get("limit", 10)))


async def clarify(args):
    result = await ecoBridge.clarify(args.get("question", "How should we continue?"), json.dumps(args.get("options", [])))
    return {"answer": str(result)}


async def upload_file(args):
    return json.loads(await ecoBridge.uploadAttachment(json.dumps(args, ensure_ascii=False)))


async def voice_state(args):
    return json.loads(await ecoBridge.voiceState())


SPEAK_DESCRIPTION = "Says text aloud with this device's voice, even when listening is off. Use it when the person or a shared-memory message asks you to say something aloud. interrupt stops what is being said first. If Speak is off in Settings it says nothing and returns status disabled; tell the requester. Before the first tap on the device it returns status queued and plays on that tap."


async def speak_text(args):
    payload = {"text": str(args.get("text", ""))[:4000], "interrupt": bool(args.get("interrupt", False))}
    return json.loads(await ecoBridge.speakText(json.dumps(payload, ensure_ascii=False)))


LISTEN_DESCRIPTION = "Turns the microphone on or off so Eco can listen. action=on starts listening; action=off stops it. Optional follow_up (seconds, 0-60) opens a window after Eco finishes speaking, or immediately if it is not speaking, where a reply is accepted without the wake name; if omitted, the Settings › Voice follow-up window is used. After hablar asks a question, call this with action=on to hear the answer. If the browser needs a tap, it returns status queued and starts on the next tap."


async def listen_mic(args):
    payload = {"action": str(args.get("action", ""))}
    if "follow_up" in args and args.get("follow_up") is not None:
        payload["follow_up"] = args.get("follow_up")
    elif "listen_for" in args and args.get("listen_for") is not None:
        payload["follow_up"] = args.get("listen_for")
    return json.loads(await ecoBridge.listenMic(json.dumps(payload, ensure_ascii=False)))


async def refresh_speech(registry):
    try:
        supported = bool(json.loads(await ecoBridge.speechSupported()).get("supported"))
    except Exception:
        supported = False
    if supported:
        registry.add("hablar", schema(SPEAK_DESCRIPTION, {"text": {"type": "string"}, "interrupt": {"type": "boolean"}}, ["text"]), speak_text)
    else:
        registry.items.pop("hablar", None)
    try:
        can_listen = bool(json.loads(await ecoBridge.listenSupported()).get("supported"))
    except Exception:
        can_listen = False
    if can_listen:
        registry.add("escuchar", schema(LISTEN_DESCRIPTION, {"action": {"type": "string", "enum": ["on", "off"]}, "follow_up": {"type": "number"}}, ["action"]), listen_mic)
    else:
        registry.items.pop("escuchar", None)


DREAMING_DESCRIPTION = "Dreaming consolidates memory. It runs by itself when Eco is idle or when there is a lot to summarize; use action run when the person asks to dream now and status to read the settings and the last result. It programmatically selects shared-memory threads (messages and their acks) and local conversations without recent activity, writes one summary per thread or conversation, verifies it and only then deletes the originals; if anything fails nothing is deleted. The shared part needs a connected Google Sheets memory; otherwise local conversation summaries go to local memory."


async def refresh_dreaming(registry):
    try:
        enabled = bool(json.loads(await ecoBridge.dreamingEnabled()).get("enabled"))
    except Exception:
        enabled = False
    if enabled:
        registry.add("dreaming", schema(DREAMING_DESCRIPTION, {"action": {"type": "string", "enum": ["run", "status"]}}), dreaming)
    else:
        registry.items.pop("dreaming", None)


async def dreaming(args):
    action = "run" if args.get("action") == "run" else "status"
    return json.loads(await ecoBridge.dreaming(json.dumps({"action": action})))


async def face_mode(args):
    action = str(args.get("action", "estado"))
    return json.loads(await ecoBridge.faceMode(action if action in ("on", "off") else "estado"))


def register(registry, child=False):
    registry.add("skills_list", schema("Lists skills.", {}), skills_list)
    registry.add("skill_view", schema("Shows a skill.", {"name": {"type": "string"}}, ["name"]), skill_view)
    registry.add("skill_manage", schema("Creates, edits or deletes a skill.", {"action": {"type": "string", "enum": ["create", "edit", "delete"]}, "name": {"type": "string"}, "description": {"type": "string"}, "content": {"type": "string"}}, ["action", "name"]), skill_manage)
    registry.add("session_search", schema("Searches previous sessions.", {"query": {"type": "string"}, "limit": {"type": "integer"}}, ["query"]), session_search)
    registry.add("voz_estado", schema("Reads voice state without changing anything, with listening and speaking reported separately. listen: whether this device has a usable microphone, whether Listen is on, whether it is listening now, phase (attentive, turn or off), whether voice detection and the transcriber are loaded, the transcriber model, the wake words, the last transcriptions with their times and the last error. speak: whether this device has voice output, whether Speak is on, the voice, whether it is speaking, what is queued (including until the first tap) and the last error.", {}), voice_state)
    if child:
        registry.add("subir_archivo", schema("Uploads a conversation attachment to Google Drive with a multipart upload. Images that tools return (for example device.capture photos) are kept on the device, shown to the person and reach you as a ref such as img-0123456789. Needs the Google Drive memory connected. Optional name and parents (Drive folder ids). Returns id, name and webViewLink.", {"ref": {"type": "string"}, "name": {"type": "string"}, "parents": {"type": "array", "items": {"type": "string"}}}, ["ref"]), upload_file)
    if not child:
        registry.add("clarify", schema("Asks for a clarification.", {"question": {"type": "string"}, "options": {"type": "array", "items": {"type": "string"}}}, ["question"]), clarify)
