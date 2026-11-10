# 🌱 eco

An AI agent that lives in your browser: it talks with you, builds its own tools and remembers what matters.

[App](https://juliangdeveloper.github.io/eco/) · Version 0.23.1

<img src="assets/screenshot.png?v=0.23.1" alt="Eco home screen on a phone" width="320">

## Get started

Open Eco, connect a model provider in **Settings** (OpenRouter for now) and ask for what you need. If you ask it to connect to a service, Eco figures out how and asks for the key in a card. Your keys are stored encrypted in the browser and the model never sees them.

Your conversations, tools and routines stay on your device. Routines only run while Eco is open.

## Shared memory

If you want Eco to remember across devices and talk with other Ecos or with agents like Grok or Claude, ask it to connect to a Google Sheet, a database or an Obsidian vault; it walks you through it. You can connect several and Eco keeps a copy in each. Each Eco records its public IP along with its activity and keeps the last known one on the device. Eco adapts to your structure as it is: if you rename or move columns, it keeps working without you fixing anything.

## Photos and images

Photos a device tool takes, and any image a tool returns, appear in the chat and stay on your device with the conversation; the model only gets a short reference. With the Google Drive memory connected, Eco can upload them to your Drive and share the link.

## Name

In **Settings › Name** you give this Eco its own name (Eco by default). It is the word you say to talk to it, the header title, how it introduces itself and how other Ecos see it in shared memory, so give each Eco in the same room a different name.

## Face and voice

The face button shows Eco's animated face over the chat: it fills the area below the header, scales with the window, reacts to what Eco is doing and each running subagent appears as a small character. The microphone turns on hands-free listening: detection and transcription run on your device, and Eco only gets what you say after its name. It answers aloud when you spoke to it, and only its own name wakes it. If voice stops working, a notice stays on screen until it works again or you dismiss it. **Settings › Face mode** and **Settings › Voice** have every timing with Reset to defaults. Face mode includes a Default pack and a Spaceship pack, and you can export and import packs to share looks.

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
| Magic ([#10](https://github.com/juliangdeveloper/eco/issues/10)) | Design |

## Before using it

Eco is experimental: it acts without asking for confirmation and has not had a security audit. Use it with accounts and data you are willing to risk.

It works in any modern browser and needs internet. To run it locally: `python3 -m http.server`. MIT license, see [LICENSE](LICENSE).

---

More projects: https://juliangdeveloper.github.io/

Made with ❤️ and 🌱
