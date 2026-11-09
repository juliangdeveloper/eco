# 🌱 eco

An AI agent that lives in your browser: it talks with you, builds its own tools and remembers what matters.

[App](https://juliangdeveloper.github.io/eco/) · Version 0.20.0

<img src="assets/screenshot.png?v=0.20.0" alt="Eco home screen on a phone" width="320">

## Get started

Open Eco, connect a model provider in **Settings** (OpenRouter for now) and ask for what you need. If you ask it to connect to a service, Eco figures out how and asks for the key in a card. Your keys are stored encrypted in the browser and the model never sees them.

Your conversations, tools and routines stay on your device. Routines only run while Eco is open.

## Shared memory

If you want Eco to remember across devices and talk with other Ecos or with agents like Grok or Claude, ask it to connect to a Google Sheet, a database or an Obsidian vault; it walks you through it. You can connect several and Eco keeps a copy in each. Each Eco records its public IP along with its activity. Eco adapts to your structure as it is: if you rename or move columns, it keeps working without you fixing anything.

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
| Face mode ([#6](https://github.com/juliangdeveloper/eco/issues/6)) | Design |
| Voice chat ([#7](https://github.com/juliangdeveloper/eco/issues/7)) | Design |
| Vault ([#8](https://github.com/juliangdeveloper/eco/issues/8)) | Design |
| Local LLM ([#9](https://github.com/juliangdeveloper/eco/issues/9)) | Design |
| Magic ([#10](https://github.com/juliangdeveloper/eco/issues/10)) | Design |

## Before using it

Eco is experimental: it acts without asking for confirmation and has not had a security audit. Use it with accounts and data you are willing to risk.

It works in any modern browser and needs internet. To run it locally: `python3 -m http.server`. MIT license, see [LICENSE](LICENSE).
