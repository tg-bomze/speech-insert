# speech-insert

A [Claude Code](https://claude.com/claude-code) mod that puts a microphone above the prompt. Press it, say what you want, press it again: the recording goes to a speech-to-text API of your choice, and the text lands in the prompt at the cursor.

It works with any OpenAI-compatible transcription endpoint: OpenAI, Groq, a self-hosted Whisper server, and so on. You bring the API key.

## Install

In Claude Code:

```
/plugin install speech-insert --marketplace tg-bomze/speech-insert
```

From a shell:

```bash
claude plugin install speech-insert --marketplace tg-bomze/speech-insert
```

In the desktop app: **+** next to the prompt → **Plugins** → **Add marketplace** `tg-bomze/speech-insert` → **Add plugin**.

### Requirements

- **ffmpeg** with the mp3 encoder (libmp3lame), which the usual builds have:

  | System | Install | Records from |
  | --- | --- | --- |
  | macOS | `brew install ffmpeg` | AVFoundation |
  | Linux | `sudo apt install ffmpeg pulseaudio-utils`, or your distribution's packages | PulseAudio, or PipeWire through its PulseAudio server |
  | Windows | `winget install ffmpeg` | DirectShow |

  On macOS the mod also looks in `/opt/homebrew/bin` and `/usr/local/bin`, so an app started from the Dock finds Homebrew's ffmpeg. Elsewhere ffmpeg has to be on the `PATH`.

- **curl**, which macOS, Windows 10 and later, and most Linux systems ship.
- **Microphone access** for the app that runs Claude Code (Claude, or your terminal). macOS asks the first time you record. If it never asked, or you said no, turn it on in **System Settings → Privacy & Security → Microphone**. On Windows it is **Settings → Privacy & security → Microphone**. Without it the recording comes out empty and the mod says so.

## Set up

1. Press **⚙** above the prompt.
2. Fill in the fields. Click a row to edit it:

   | Field | What goes there | Default |
   | --- | --- | --- |
   | **Base URL** | The API root, the part before `/audio/transcriptions` | `https://api.openai.com/v1` |
   | **API token** | Your key for that API | none |
   | **Model** | The transcription model | `whisper-1` |
   | **Language** | An ISO-639-1 code such as `en`, `ru` or `de`. Leave it empty to auto-detect | auto-detect |
   | **Microphone** | Click it for the list of microphones, and click one. A pick is saved at once | the system's default input; on Windows, the first microphone found |

3. Press **Test** to check the URL, token and model before you record. It sends one second of silence with what the form holds, saved or not, and shows **✓ Works** or the API's error.
4. Press **Save**. The settings apply to every chat, open or new.

Examples:

| Provider | Base URL | Model |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` |
| Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3`, `whisper-large-v3-turbo` |
| Self-hosted (faster-whisper-server, LocalAI, …) | `http://localhost:8000/v1` | whatever the server serves |

A Base URL that already ends in `/audio/transcriptions` is used as is.

After saving, the token field shows only its last four characters (`saved …abcd`). Leave the field empty when you save, and the saved token stays.

## Use

| Action | How |
| --- | --- |
| Start recording | **🎙** |
| Stop and transcribe | **● 5s**, the same button while it records |
| Throw the recording away | **✕**, then **Yes** (**No** keeps recording) |
| Send a failed recording again | **↻ Retry** |
| Throw a failed recording away | **✕** beside **↻ Retry** |
| Insert an earlier transcription | **🕘**, then click it |
| Open or close the settings | **⚙** |

While it records, the button turns red and counts the seconds, and a level meter beside it moves with your voice. If the bars stay flat, the mic is not getting sound.

When the text comes back it goes in at the cursor, not at the end. If the cursor sits in the middle of a word or right after one, a space is added on that side, so `fix the|bug` becomes `fix the <your words> bug`. If there is no prompt box to fill, the text is copied to the clipboard instead.

### When the transcription fails

If the API cannot be reached or answers with an error, the recording is kept and **↻ Retry** appears beside the error. Fix the settings if they were the problem, and press it to send the same recording again. A new recording, or **✕**, throws the failed one away.

### History

**🕘** lists the last 10 transcriptions, newest first, one line each with its age (`5m`, `2h`, `3d`). Click one to insert it at the cursor again. The history is shared by every chat: what you dictated in one chat can be inserted in another.

### Turning it off

| Command | Does |
| --- | --- |
| `/speech-off` | Hides the mic in every chat, open ones included |
| `/speech-on` | Shows it again in every chat, and in this chat even if `/speech-chat-off` hid it here |
| `/speech-chat-off` | Hides the mic in this chat only, and it stays hidden when the chat is reopened |
| `/speech-chat-on` | Shows it again in this chat |

The mic shows in a chat when it is on everywhere and this chat has not hidden it. A new chat starts with it shown. Hiding it while it records throws the recording away, and a failed recording waiting for **↻ Retry** with it.

## How it works

- **Recording.** ffmpeg records the chosen microphone into a 16 kHz mono MP3 in the temporary folder (`$TMPDIR`, or `%TEMP%` on Windows). In parallel it prints the loudness of every tenth of a second, and that drives the meter.
  - On macOS and Linux it runs through `/bin/sh` so the mod learns its pid. Stop sends ffmpeg `SIGINT`, which finishes the file cleanly. If ffmpeg has not exited 5 seconds later, it is killed.
  - On Windows there is no `SIGINT` to send, so stop kills ffmpeg. It writes every packet as soon as it is encoded, so the file keeps everything but the last fraction of a second.
- **Microphones.** The list comes from `ffmpeg -list_devices` on macOS and Windows, and from `pactl list sources` on Linux, where the monitors of outputs are left out.
- **Transcription.** `curl` posts the file to `<Base URL>/audio/transcriptions` as `multipart/form-data`, with `model`, `language` (when set) and `response_format=json`. The `text` field of the answer is what gets inserted. An HTTP error shows its status and the API's message above the prompt.
- **Cleanup.** The temporary file is deleted after a successful transcription, after a cancel, when a failed one is thrown away, and when the recording itself fails.
- **Settings, history and switches** live in the mod's store, which Claude Code shares between all sessions on your machine. Each chat reads it when the settings or the history open and before each recording. It also reads the on/off switches every 3 seconds, so a `/speech-off` in one chat reaches the others.

## What it does on your machine

The mod is plain TypeScript in `hooks/`. It has no dependencies, and nothing is built or downloaded.

- **Network:** one request per recording or **Test**, to the Base URL you set, with your token and the audio. Nothing else is sent anywhere.
- **Records** from the chosen microphone only between your press on 🎙 and your second press, a ✕ → Yes, or a hide command.
- **Runs** these programs:
  - `ffmpeg`: to record (on macOS and Linux through `/bin/sh -c` with a fixed script, every argument passed as an argument, nothing pasted into the script), to list microphones, and to make the second of silence for **Test**;
  - `curl`;
  - `uname -s`, once per session, to tell macOS from Linux;
  - `pactl list sources` on Linux, to list microphones;
  - `kill -INT <ffmpeg pid>` on macOS and Linux;
  - `rm -f <its temporary file>`, or `cmd.exe /c del` on Windows.
- **Keeps your token off the command line.** curl reads the `Authorization` header from stdin, so the token never shows in `ps` or a process list.
- **Writes** only its temporary recordings and the mod's store.
- **Stores** the Base URL, model, language, microphone, API token, the last 10 transcriptions and the on/off switches in the mod's store. That is a JSON file Claude Code keeps in your Claude configuration folder (`~/.claude`), outside this repository, and the token and the transcriptions are kept there in plain text. A chat hidden with `/speech-chat-off` is recorded there by its session id.
- **Types** into the prompt box only the text the API returned, or a history entry you clicked. It never sends a message by itself. You review the text and press Enter.

## Limitations

- Linux and Windows support is new. It follows ffmpeg's and pactl's documented output and is covered by tests with those programs stubbed, but has seen less real use than macOS.
- On Linux it needs PulseAudio or PipeWire's PulseAudio server; bare ALSA is not supported.
- The settings form is drawn in the desktop app and the terminal. The mobile app shows the mic, but a recording from there uses the microphone of the computer running Claude Code, not the phone.
- The desktop app draws the band above the prompt at full width. The buttons sit at its left.
- One recording is limited by your API's file size limit (25 MB on OpenAI, roughly 50 minutes at 64 kbit/s), and the request times out after 2 minutes.

## Development

Load the mod from a checkout:

```bash
claude --plugin-dir .
```

Validate, type-check and test:

```bash
claude plugin validate .
```

```bash
npx -y -p typescript@5.6.3 tsc -p . --noEmit --noUnusedLocals
```

```bash
claude plugin test .
```

Claude Code generates the type definitions in `.claude-plugin/types/` when the mod loads.

| File | Role |
| --- | --- |
| `hooks/register.tsx` | The band above the prompt, settings, microphones, recording, transcription, retry, history, insertion and the on/off commands |
| `tests/speech-insert.test.tsx` | Tests, with ffmpeg, pactl, curl, the prompt box and the store stubbed, on all three systems |
| `types/index.d.ts` | The mod's state types |

## License

[MIT](LICENSE)
