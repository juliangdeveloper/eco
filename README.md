# 🌱 eco

An AI agent that lives in your browser: it talks with you, builds its own tools and remembers what matters.

[App](https://juliangdeveloper.github.io/eco/) · Version 0.26.8

<img src="assets/screenshot.png?v=0.26.8" alt="Eco home screen on a phone" width="320">

## Get started

Open Eco, connect a model provider in **Settings** (OpenRouter for now) and ask for what you need. If you ask it to connect to a service, Eco figures out how and asks for the key in a card. Your keys are stored encrypted in the browser and the model never sees them.

Your conversations, tools and routines stay on your device. Routines only run while Eco is open.

## Shared memory

If you want Eco to remember across devices and talk with other Ecos or with agents like Grok or Claude, ask it to connect to a Google Sheet, a database or an Obsidian vault; it walks you through it. You can connect several and Eco keeps a copy in each. When a visible error appears and shared memory is connected, Eco itself writes a help record with the exact notice, its version and a short browser and OS summary; the model is not called, and the same notice is not written again within an hour. Each Eco records its public IP along with its activity and keeps the last known one on the device. Eco adapts to your structure as it is: if you rename or move columns, it keeps working without you fixing anything.

## Dreaming

Dreaming is off by default; turn it on in **Settings › Dreaming** on each Eco that should take part. While you are away, an Eco with Dreaming on consolidates its memory. Old shared-memory threads and conversations you have not touched in a while are summarized, keeping decisions, facts, pending items, dates and people. Each summary is saved and checked before the originals are deleted, and if anything fails nothing is deleted. Without shared memory, conversation summaries go to local memory. Only one Eco dreams at a time. Once it is on, the same section has every threshold and a Run now button.

## Subagents

The subagents button only counts work that is running or finished and not yet seen. Finished subagents keep their full detail for a day and then only their summary; the Agent panel keeps the history.

## Photos and images

Photos a Magic command or a device tool takes, and any image a tool returns, appear in the chat and stay on your device with the conversation; the model only gets a short reference. With the Google Drive memory connected, Eco can upload them to your Drive and share the link.

## Name

In **Settings › Name** you give this Eco its own name (Eco by default). It is the word you say to talk to it, the header title, how it introduces itself and how other Ecos see it in shared memory, so give each Eco in the same room a different name.

## Face and voice

The face button shows Eco's animated face over the chat: it fills the area below the header, scales with the window, reacts to what Eco is doing and each running subagent appears as a small character. **Settings › Voice** has two separate switches. **Listen** turns on the microphone for hands-free listening: detection and transcription run on your device, and Eco only gets what you say after its name, or a Magic phrase. You can set the speech language there (Automatic uses the device language). **Speak** lets Eco answer aloud when you spoke to it, and say things aloud when asked, even while listening is off. Each switch only appears when the device has a usable microphone or voice output. If Listen was on and the microphone is already allowed, Eco starts listening again after a reload without a tap when the browser allows it; otherwise it starts on the next tap. On iPhone and iPad, Safari often returns the microphone permission to prompt after a reload (it is granted per page, including inside an iframe or in standalone); Eco still auto-starts when the permission is already granted. When Listen is on, Eco sets the audio session to play-and-record before it speaks and before it opens the microphone, including on the first tap. After that tap, Eco starts speaking and then opens the microphone, so you can interrupt it by talking (barge-in, on by default in Settings › Voice; raise the barge-in threshold if Eco hears itself). After Eco speaks, a follow-up window (set in Settings › Voice) lets you reply without saying its name. Eco can also turn the microphone on or off itself when it needs to listen. If voice stops working, a notice stays on screen until it works again or you dismiss it, with the reason when the system voice does not start, fails or ends immediately, or when listening cannot start, including the literal error when the transcriber cannot load. Eco retries and falls back on its own first, and writes that same notice to shared memory as a help record only after those retries fail. A device tool can use one shared runtime capability to read any component's status and last error, change its config and reload it (the transcriber, speech, listening, the camera and later ones), without a separate tool for each. **Settings › Voice** has a Test voice button that speaks a short sentence in that same tap. **Settings › Face mode** and **Settings › Voice** have every timing with Reset to defaults. Face mode includes a Default pack and a Spaceship pack, and you can export and import packs to share looks.

To embed Eco in another page, put it in an iframe with `allow="autoplay; microphone; camera"` (add `clipboard-write` and `fullscreen` if you need them) and set the iframe `src` to Eco's URL. Speech, the microphone and what Eco stores stay in that embedded context, so the person should keep using the same frame. A tap on the embedded Eco starts the voice; when Eco is in a same-origin frame, a tap on that frame also flushes queued speech.

## Magic

In **Settings › Magic** you add short phrases that run a command. While Listen is on, saying the phrase is enough; you can also type the exact phrase in the chat. A local command runs on the device without calling the model, for example a front or rear photo, speaking a line, stopping speech, toggling face mode, running a routine or calling a device tool. Other commands start a turn with an instruction you saved. Photos stay with the conversation on your device.

## Secure wipe

In **Settings › Secure wipe** you choose a word that erases everything Eco stores on the device. If you use shared memory, Eco also erases itself if it stays closed or unable to connect for too long. Before erasing, it warns you with a skull and a countdown. You can change those times in the same place.

## Passive skills

| Skill | Status |
| --- | --- |
| Google Drive memory | Functional |
| Database memory (Supabase) | Untested |
| Obsidian memory | Untested |
| Multiple memories | Untested |
| Containers ([#5](https://github.com/juliangdeveloper/eco/issues/5)) | Design |
| Face mode ([#6](https://github.com/juliangdeveloper/eco/issues/6)) | Functional |
| Voice chat ([#7](https://github.com/juliangdeveloper/eco/issues/7)) | Untested |
| Vault ([#8](https://github.com/juliangdeveloper/eco/issues/8)) | Design |
| Local LLM ([#9](https://github.com/juliangdeveloper/eco/issues/9)) | Design |
| Magic ([#10](https://github.com/juliangdeveloper/eco/issues/10)) | Functional |

## Before using it

Eco is experimental: it acts without asking for confirmation and has not had a security audit. Use it with accounts and data you are willing to risk.

It works in any modern browser and needs internet. To run it locally: `python3 -m http.server`. MIT license, see [LICENSE](LICENSE).

---

More projects: https://juliangdeveloper.github.io/

Made with ❤️ and 🌱
