import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ResolveInput, Timer } from 'claude-code'

import type {
  SpeechInsertConfig,
  SpeechInsertDevice,
  SpeechInsertField,
  SpeechInsertHistoryItem,
  SpeechInsertPhase,
  SpeechInsertTest,
} from '../types'

const DEFAULTS: SpeechInsertConfig = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'whisper-1',
  language: '',
  tokenHint: '',
  microphone: '',
  microphoneName: '',
}

const HISTORY_SIZE = 10

const config = atom({ plugin: 'speech-insert', key: 'config' } as const, DEFAULTS, {
  shape: 'config-2',
})
const phase = atom({ plugin: 'speech-insert', key: 'phase' } as const, 'idle' as SpeechInsertPhase)
const isSettingsOpen = atom({ plugin: 'speech-insert', key: 'isSettingsOpen' } as const, false)
const settingsField = atom({ plugin: 'speech-insert', key: 'settingsField' } as const, 'baseUrl' as SpeechInsertField)
const devices = atom({ plugin: 'speech-insert', key: 'devices' } as const, null as SpeechInsertDevice[] | null, {
  shape: 'devices-1',
})
const devicesError = atom({ plugin: 'speech-insert', key: 'devicesError' } as const, null as string | null)
const test = atom({ plugin: 'speech-insert', key: 'test' } as const, null as SpeechInsertTest | null, {
  shape: 'test-1',
})
const isEnabled = atom({ plugin: 'speech-insert', key: 'isEnabled' } as const, true)
const isChatEnabled = atom({ plugin: 'speech-insert', key: 'isChatEnabled' } as const, true)
const isConfirmingCancel = atom({ plugin: 'speech-insert', key: 'isConfirmingCancel' } as const, false)
const elapsed = atom({ plugin: 'speech-insert', key: 'elapsed' } as const, 0)
const levels = atom({ plugin: 'speech-insert', key: 'levels' } as const, [] as number[])
const error = atom({ plugin: 'speech-insert', key: 'error' } as const, null as string | null)
const canRetry = atom({ plugin: 'speech-insert', key: 'canRetry' } as const, false)
const isHistoryOpen = atom({ plugin: 'speech-insert', key: 'isHistoryOpen' } as const, false)
const history = atom({ plugin: 'speech-insert', key: 'history' } as const, [] as SpeechInsertHistoryItem[], {
  shape: 'history-1',
})

type Platform = 'mac' | 'linux' | 'windows'

// Found at session.start: Windows names itself in OS, uname tells the rest.
let platform: Platform = 'mac'

const detectPlatform = async ($: EngineInterface): Promise<Platform> => {
  const os = await $.env.get('OS').catch(() => undefined)
  if (os === 'Windows_NT') {
    return 'windows'
  }
  const uname = await $.process.run(['uname', '-s']).catch(() => undefined)

  return /linux/i.test(uname?.stdout ?? '') ? 'linux' : 'mac'
}

const exe = (name: string) => (platform === 'windows' ? `${name}.exe` : name)

// Homebrew's folders join the PATH, as an app started from the Dock has
// neither; Windows keeps its own.
const toolEnv = async ($: EngineInterface) => {
  if (platform === 'windows') {
    return undefined
  }
  const path = (await $.env.get('PATH')) ?? '/usr/bin:/bin'

  return { PATH: `/opt/homebrew/bin:/usr/local/bin:${path}` }
}

const tempFile = async ($: EngineInterface, name: string) => {
  if (platform === 'windows') {
    const dir = (await $.env.get('TEMP')) ?? (await $.env.get('TMP')) ?? 'C:\\Windows\\Temp'

    return `${dir.replace(/[\\/]+$/, '')}\\${name}`
  }
  const dir = (await $.env.get('TMPDIR')) ?? '/tmp'

  return `${dir.replace(/\/+$/, '')}/${name}`
}

const removeFile = ($: EngineInterface, file: string) =>
  $.process.run(platform === 'windows' ? ['cmd.exe', '/d', '/c', 'del', '/f', '/q', file] : ['rm', '-f', file]).then(
    () => undefined,
    () => undefined,
  )

// The input ffmpeg records from: AVFoundation on macOS, PulseAudio (and
// PipeWire, which speaks it) on Linux, DirectShow on Windows.
const inputOf = (microphone: string) => {
  if (platform === 'linux') {
    return ['-f', 'pulse', '-i', microphone || 'default']
  }
  if (platform === 'windows') {
    return ['-f', 'dshow', '-i', `audio=${microphone}`]
  }

  return ['-f', 'avfoundation', '-i', `:${microphone || 'default'}`]
}

// Beside the file, ffmpeg prints the loudness of every tenth of a second to
// stdout (`direct=1`, unbuffered) for the meter. Each packet is written as it
// is made, so a recording killed rather than stopped keeps all but the last.
const recordArgs = (microphone: string, file: string) => [
  '-nostdin',
  '-hide_banner',
  '-loglevel',
  'error',
  ...inputOf(microphone),
  '-filter_complex',
  '[0:a]aresample=16000,aformat=channel_layouts=mono,asplit=2[rec][meter];' +
    '[meter]asetnsamples=n=1600,astats=metadata=1:reset=1,' +
    'ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-:direct=1,anullsink',
  '-map',
  '[rec]',
  '-c:a',
  'libmp3lame',
  '-b:a',
  '64k',
  '-flush_packets',
  '1',
  '-y',
  file,
]

// The shell prints its pid first, and `exec` keeps that pid for ffmpeg, which
// SIGINT then stops cleanly. Windows has no SIGINT to send, so there ffmpeg
// runs bare and is killed.
const recordArgv = (microphone: string, file: string) =>
  platform === 'windows'
    ? [exe('ffmpeg'), ...recordArgs(microphone, file)]
    : ['/bin/sh', '-c', 'echo "pid:$$"; exec ffmpeg "$@"', 'sh', ...recordArgs(microphone, file)]

// The microphones ffmpeg can record from, each as ffmpeg names it; on Linux,
// PulseAudio's sources by their descriptions, monitors of outputs left out.
const listDevices = async ($: EngineInterface): Promise<SpeechInsertDevice[]> => {
  const env = await toolEnv($)
  if (platform === 'linux') {
    const ran = await $.process.run(['pactl', 'list', 'sources'], {
      env: { ...env, LC_ALL: 'C' },
      timeoutMs: 15_000,
    })

    return ran.stdout
      .split(/^Source #/m)
      .slice(1)
      .map(block => {
        const id = /^\s*Name: (.+)$/m.exec(block)?.[1]?.trim() ?? ''

        return { id, name: /^\s*Description: (.+)$/m.exec(block)?.[1]?.trim() || id }
      })
      .filter(device => device.id && !device.id.endsWith('.monitor'))
  }

  const argv =
    platform === 'windows'
      ? [exe('ffmpeg'), '-nostdin', '-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']
      : [exe('ffmpeg'), '-nostdin', '-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']
  // Listing ends in an error by design: the list is on stderr all the same.
  const { stderr } = await $.process.run(argv, { env, timeoutMs: 15_000 })
  const names: string[] = []
  if (platform === 'mac') {
    const audio = stderr.split('AVFoundation audio devices:')[1] ?? ''
    for (const match of audio.matchAll(/\] \[\d+\] (.+)$/gm)) {
      names.push((match[1] ?? '').trim())
    }
  } else {
    // Older builds head each kind with a line; newer ones tag each device.
    let isAudio = false
    for (const line of stderr.split(/\r?\n/)) {
      if (/DirectShow (audio|video) devices/.test(line)) {
        isAudio = line.includes('audio devices')
        continue
      }
      const match = /\]\s+"(.+)"(?:\s+\((\w+)[^)]*\))?\s*$/.exec(line)
      if (match?.[1] && !line.includes('Alternative name') && (match[2] ? match[2] === 'audio' : isAudio)) {
        names.push(match[1])
      }
    }
  }

  return names.filter(Boolean).map(name => ({ id: name, name }))
}

const defaultDevice = (): SpeechInsertDevice => ({
  id: '',
  name: platform === 'windows' ? 'First microphone found' : 'System default',
})

const METER_BARS = 12
const SILENT_DB = -60
const LOUD_DB = -20

// An RMS level in dB as a bar's height, 0 at a quiet room to 1 at loud speech.
const levelOf = (db: number) =>
  Number.isFinite(db) ? Math.min(1, Math.max(0, (db - SILENT_DB) / (LOUD_DB - SILENT_DB))) : 0

type Recorder = {
  file: string
  pid: Promise<string | null>
  done: Promise<{ code: number | null; stderr: string }>
  kill: () => void
}

// A reload kills the child with the old environment, and session.start then
// sets the phase back to idle, so this living in the module is enough.
let recorder: Recorder | null = null
// Counts the recording's seconds into `elapsed` while it runs.
let ticker: Timer | null = null
// A recording whose transcription failed, kept for ↻ until it succeeds, is
// thrown away, or a new recording starts.
let failed: string | null = null

const stopTicker = () => {
  ticker?.cancel()
  ticker = null
}

const transcriptionUrl = (baseUrl: string) => {
  const base = baseUrl.trim().replace(/\/+$/, '')

  return base.endsWith('/audio/transcriptions') ? base : `${base}/audio/transcriptions`
}

const hintOf = (token: string) => (token ? token.slice(-4) : '')

const fail = async ($: EngineInterface, message: string) => {
  await update($, error, () => message)
  await update($, phase, () => 'idle')
  $.ui.toast(`Speech: ${message}`)
}

type Api = { baseUrl: string; token: string; model: string; language: string }

// $.store is one file for every session of this person, so settings saved in
// one chat hold in all of them. Each use reads it afresh, and copies what the
// form draws into this session's state.
const loadSettings = async ($: EngineInterface) => {
  const stored = async (key: string, fallback: string) => {
    const value = await $.store.get(key)

    return typeof value === 'string' ? value : fallback
  }
  const token = await stored('token', '')
  const loaded: SpeechInsertConfig = {
    baseUrl: await stored('baseUrl', DEFAULTS.baseUrl),
    model: await stored('model', DEFAULTS.model),
    language: await stored('language', DEFAULTS.language),
    tokenHint: hintOf(token),
    microphone: await stored('microphone', DEFAULTS.microphone),
    microphoneName: await stored('microphoneName', DEFAULTS.microphoneName),
  }
  await update($, config, () => loaded)

  return { ...loaded, token }
}

// The desktop draws a submit button beside every text field, so of the rows
// only the one being edited holds a field, and that field's own button is the
// one Save for all of them; the other rows show their value. The microphone
// row opens a list instead, and a pick there is saved at once.
const FIELDS: readonly { value: SpeechInsertField; label: string }[] = [
  { value: 'baseUrl', label: 'Base URL' },
  { value: 'token', label: 'API token' },
  { value: 'model', label: 'Model' },
  { value: 'language', label: 'Language' },
  { value: 'microphone', label: 'Microphone' },
]

// What the person typed in the settings form and has not saved yet. Typing
// writes here alone, so no keystroke redraws the form under the cursor.
let draft: Partial<Record<Exclude<SpeechInsertField, 'microphone'>, string>> = {}

const openSettings = async ($: EngineInterface) => {
  draft = {}
  await loadSettings($)
  await update($, settingsField, () => 'baseUrl')
  await update($, test, () => null)
  await update($, isHistoryOpen, () => false)
  await update($, isSettingsOpen, () => true)
}

const closeSettings = async ($: EngineInterface) => {
  draft = {}
  await update($, test, () => null)
  await update($, isSettingsOpen, () => false)
}

const saveSettings = async ($: EngineInterface) => {
  const saved = { ...draft }
  for (const field of ['baseUrl', 'model', 'language'] as const) {
    const value = saved[field]
    if (value !== undefined) {
      await $.store.set(field, value.trim())
    }
  }
  const token = saved.token?.trim()
  if (token) {
    await $.store.set('token', token)
  }
  await loadSettings($)
  await update($, error, () => null)
  await closeSettings($)
  $.ui.toast('Speech: settings saved')
}

const chooseMicrophone = async ($: EngineInterface) => {
  await update($, settingsField, () => 'microphone')
  await update($, devices, () => null)
  await update($, devicesError, () => null)
  try {
    const found = await listDevices($)
    await update($, devices, () => found)
  } catch (thrown) {
    const reason = thrown instanceof Error ? thrown.message : String(thrown)
    await update($, devicesError, () => `could not list microphones: ${reason}`)
  }
}

const pickMicrophone = async ($: EngineInterface, device: SpeechInsertDevice) => {
  if (device.id) {
    await $.store.set('microphone', device.id)
    await $.store.set('microphoneName', device.name)
  } else {
    await $.store.delete('microphone')
    await $.store.delete('microphoneName')
  }
  await loadSettings($)
  await update($, settingsField, () => 'baseUrl')
}

const transcribe = async ($: EngineInterface, api: Api, file: string) => {
  const argv = [
    exe('curl'),
    '-sS',
    '--max-time',
    '120',
    '-X',
    'POST',
    transcriptionUrl(api.baseUrl),
    // The token goes in on stdin, so it never shows in a process listing.
    '-H',
    '@-',
    '-F',
    `file=@${file};type=audio/mpeg`,
    '--form-string',
    `model=${api.model.trim() || DEFAULTS.model}`,
    ...(api.language.trim() ? ['--form-string', `language=${api.language.trim()}`] : []),
    '--form-string',
    'response_format=json',
    '-w',
    '\n%{http_code}',
  ]
  const ran = await $.process.run(argv, {
    stdin: `Authorization: Bearer ${api.token}\n`,
    timeoutMs: 130_000,
  })
  if (ran.exitCode !== 0) {
    throw new Error(ran.stderr.trim() || `curl exited with code ${ran.exitCode}`)
  }

  const cut = ran.stdout.lastIndexOf('\n')
  const body = ran.stdout.slice(0, cut)
  const status = Number(ran.stdout.slice(cut + 1))
  let parsed: { text?: unknown; error?: { message?: unknown } | string } = {}
  try {
    parsed = JSON.parse(body)
  } catch {
    // Not JSON: the status and the raw body say what happened.
  }
  if (status < 200 || status >= 300) {
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
    throw new Error(`HTTP ${status}: ${String(message ?? body).slice(0, 300)}`)
  }
  if (typeof parsed.text !== 'string') {
    throw new Error(`no text field in the response: ${body.slice(0, 300)}`)
  }

  return parsed.text.trim()
}

// Sends a second of silence with what the form holds, saved or not, so a
// wrong URL, token or model shows before anything is recorded.
const testSettings = async ($: EngineInterface) => {
  if ((await read($, test))?.state === 'running') {
    return
  }
  const saved = await loadSettings($)
  const api: Api = {
    baseUrl: draft.baseUrl ?? saved.baseUrl,
    token: draft.token?.trim() || saved.token,
    model: draft.model ?? saved.model,
    language: draft.language ?? saved.language,
  }
  if (!api.token || !api.baseUrl.trim()) {
    await update($, test, () => ({ state: 'failed', message: 'set the base URL and API token first' }))

    return
  }

  await update($, test, () => ({ state: 'running', message: 'Testing…' }))
  const file = await tempFile($, `speech-insert-test-${await $.clock.now()}.mp3`)
  try {
    const made = await $.process.run(
      [
        exe('ffmpeg'),
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=16000:cl=mono',
        '-t',
        '1',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '64k',
        '-y',
        file,
      ],
      { env: await toolEnv($), timeoutMs: 15_000 },
    )
    if (made.exitCode !== 0) {
      throw new Error(`ffmpeg: ${made.stderr.trim().split('\n').pop() || `exit code ${made.exitCode}`}`)
    }
    await transcribe($, api, file)
    await update($, test, () => ({ state: 'passed', message: 'Works: the API took the token and the model' }))
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    await update($, test, () => ({ state: 'failed', message }))
  } finally {
    await removeFile($, file)
  }
}

const loadHistory = async ($: EngineInterface) => {
  const value = await $.store.get('history')
  const items = (Array.isArray(value) ? value : [])
    .filter(
      (item): item is SpeechInsertHistoryItem =>
        typeof item?.text === 'string' && typeof item?.at === 'number' && item.text !== '',
    )
    .slice(0, HISTORY_SIZE)
  await update($, history, () => items)

  return items
}

// The newest first, in the store every chat shares; a repeat moves to the top.
const remember = async ($: EngineInterface, text: string) => {
  const now = await $.clock.now()
  const items = [{ text, at: now }, ...(await loadHistory($)).filter(item => item.text !== text)].slice(0, HISTORY_SIZE)
  await $.store.set('history', items)
  await update($, history, () => items)
}

const openHistory = async ($: EngineInterface) => {
  await closeSettings($)
  await loadHistory($)
  await update($, isHistoryOpen, () => true)
}

const insertAtCursor = async ($: EngineInterface, text: string) => {
  const box = await $.prompt.read()
  const before = box.text.slice(0, box.cursor)
  const after = box.text.slice(box.cursor)
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  const filled = await $.prompt.fill({ text: lead + text + trail, mode: 'insert' })
  if (!filled.isFilled) {
    await $.ui.copy({ text })
    $.ui.toast('Speech: no prompt box to fill, the text was copied to the clipboard')
  }
}

const pickHistory = async ($: EngineInterface, item: SpeechInsertHistoryItem) => {
  await update($, isHistoryOpen, () => false)
  await insertAtCursor($, item.text)
}

const discardFailed = async ($: EngineInterface) => {
  const file = failed
  failed = null
  await update($, canRetry, () => false)
  await update($, error, () => null)
  if (file) {
    await removeFile($, file)
  }
}

const startRecording = async ($: EngineInterface) => {
  const { token, baseUrl, microphone } = await loadSettings($)
  if (!token || !baseUrl.trim()) {
    await openSettings($)
    await fail($, 'set the base URL and API token in settings (⚙)')

    return
  }
  await discardFailed($)

  let device = microphone
  if (platform === 'windows' && !device) {
    device = (await listDevices($).catch(() => []))[0]?.id ?? ''
    if (!device) {
      await fail($, 'no microphone found')

      return
    }
  }

  const file = await tempFile($, `speech-insert-${await $.clock.now()}.mp3`)
  const stream = $.process.spawn({ argv: recordArgv(device, file), env: await toolEnv($) })

  let foundPid: (pid: string | null) => void = () => {}
  const pid = new Promise<string | null>(resolve => {
    foundPid = resolve
  })
  if (platform === 'windows') {
    foundPid(null)
  }
  const done = (async () => {
    let stderr = ''
    let code: number | null = null
    let pending = ''
    try {
      for (;;) {
        const step = await stream.next()
        if (step.done) {
          code = step.value.code
          break
        }
        if (step.value.stream === 'stderr') {
          stderr += step.value.text
        } else {
          pending += step.value.text
          const lines = pending.split('\n')
          pending = lines.pop() ?? ''
          for (const line of lines) {
            const pidMatch = /^pid:(\d+)/.exec(line)
            if (pidMatch?.[1]) {
              foundPid(pidMatch[1])
            }
            const level = /RMS_level=(\S+)/.exec(line)
            if (level?.[1]) {
              const height = levelOf(Number(level[1]))
              void update($, levels, bars => [...bars, height].slice(-METER_BARS))
            }
          }
        }
      }
    } catch (thrown) {
      stderr += String(thrown)
    }
    foundPid(null)

    return { code, stderr }
  })()

  const own: Recorder = { file, pid, done, kill: () => void stream.return(undefined as never) }
  recorder = own
  await update($, error, () => null)
  await update($, elapsed, () => 0)
  await update($, levels, () => [])
  await update($, phase, () => 'recording')
  stopTicker()
  ticker = $.clock.every(1000, () => void update($, elapsed, seconds => seconds + 1))

  // ffmpeg ending by itself while still recording means it could not record.
  void done.then(async ({ stderr }) => {
    if (recorder === own && (await read($, phase)) === 'recording') {
      recorder = null
      stopTicker()
      await removeFile($, file)
      const reason = stderr.trim().split('\n').pop() || 'ffmpeg exited'
      const hint = microphone ? '. Pick another microphone in ⚙' : ''
      await fail($, `recording failed: ${reason}${hint}`)
    }
  })
}

// SIGINT lets ffmpeg finish the file; one that has not exited in five
// seconds, or that has no pid to signal (Windows), is killed.
const endRecorder = async ($: EngineInterface, own: Recorder) => {
  const pid = await own.pid
  if (pid) {
    await $.process.run(['kill', '-INT', pid])
    const stopped = await Promise.race([own.done.then(() => true), $.clock.sleep(5000).then(() => false)])
    if (stopped) {
      return
    }
  }
  own.kill()
  await Promise.race([own.done, $.clock.sleep(2000)])
}

const cancelRecording = async ($: EngineInterface) => {
  const own = recorder
  recorder = null
  stopTicker()
  await update($, isConfirmingCancel, () => false)
  await update($, phase, () => 'idle')
  if (!own) {
    return
  }
  try {
    await endRecorder($, own)
  } finally {
    await removeFile($, own.file)
  }
  $.ui.toast('Speech: recording discarded')
}

// A failed transcription keeps the file and offers ↻; the rest end with it
// deleted.
const sendRecording = async ($: EngineInterface, file: string) => {
  await update($, phase, () => 'transcribing')
  await update($, error, () => null)
  await update($, canRetry, () => false)
  failed = null
  let text: string
  try {
    text = await transcribe($, await loadSettings($), file)
  } catch (thrown) {
    failed = file
    await update($, canRetry, () => true)
    await fail($, thrown instanceof Error ? thrown.message : String(thrown))

    return
  }
  await removeFile($, file)
  if (text) {
    await insertAtCursor($, text)
    await remember($, text)
  } else {
    $.ui.toast('Speech: no speech recognized')
  }
  await update($, phase, () => 'idle')
}

const stopRecording = async ($: EngineInterface) => {
  const own = recorder
  recorder = null
  stopTicker()
  await update($, isConfirmingCancel, () => false)
  await update($, phase, () => 'transcribing')
  if (!own) {
    await fail($, 'the recording was lost, start again')

    return
  }

  try {
    await endRecorder($, own)
    const stat = await $.fs.stat(own.file).catch(() => undefined)
    if (!stat || stat.size < 1000) {
      await removeFile($, own.file)
      await fail($, 'the recording is empty: check microphone access')

      return
    }
  } catch (thrown) {
    await removeFile($, own.file)
    await fail($, thrown instanceof Error ? thrown.message : String(thrown))

    return
  }
  await sendRecording($, own.file)
}

const retry = async ($: EngineInterface) => {
  if (failed && (await read($, phase)) === 'idle') {
    await sendRecording($, failed)
  }
}

const toggleRecording = async ($: EngineInterface) => {
  const now = await read($, phase)
  if (now === 'idle') {
    await startRecording($)
  } else if (now === 'recording') {
    await stopRecording($)
  }
}

const microphonePicker = async ($: EngineInterface, e: ResolveInput, chosen: string) => {
  const { Box, Button, Text } = $.ui.resolve(e)
  const problem = await read($, devicesError)
  if (problem) {
    return <Text color="red">{problem}</Text>
  }
  const found = await read($, devices)
  if (found === null) {
    return <Text dimColor>Looking for microphones…</Text>
  }

  return (
    <Box flexDirection="column">
      {[defaultDevice(), ...found].map((device, index) => (
        <Button key={`device-${index}`} plain onPress={() => void pickMicrophone($, device)}>
          {device.id === chosen ? '● ' : '○ '}
          {device.name}
        </Button>
      ))}
    </Box>
  )
}

const settingsForm = async ($: EngineInterface, e: ResolveInput) => {
  const { Box, Button, Text } = $.ui.resolve(e)
  if (e.surface === 'mobile') {
    return <Text dimColor>Settings are available on desktop or in the terminal.</Text>
  }

  const { Input } = $.ui.resolve(e)
  const settings = await read($, config)
  const editing = await read($, settingsField)
  const tested = await read($, test)
  const saved: Record<SpeechInsertField, string> = {
    baseUrl: settings.baseUrl,
    token: '',
    model: settings.model,
    language: settings.language,
    microphone: settings.microphoneName || settings.microphone,
  }
  const placeholders: Record<SpeechInsertField, string> = {
    baseUrl: DEFAULTS.baseUrl,
    token: settings.tokenHint ? `saved …${settings.tokenHint}` : 'sk-…',
    model: DEFAULTS.model,
    language: 'auto-detect',
    microphone: defaultDevice().name,
  }
  const shown = (field: SpeechInsertField) => {
    if (field === 'token') {
      return draft.token ? 'new token, not saved yet' : placeholders.token
    }
    if (field === 'microphone') {
      return saved.microphone
    }

    return draft[field] ?? saved[field]
  }
  const value = async (field: SpeechInsertField) => {
    if (field !== editing) {
      return (
        <Button
          key={`edit-${field}`}
          plain
          onPress={() => void (field === 'microphone' ? chooseMicrophone($) : update($, settingsField, () => field))}
        >
          {shown(field) || <Text dimColor>{placeholders[field]}</Text>}
        </Button>
      )
    }
    if (field === 'microphone') {
      return microphonePicker($, e, settings.microphone)
    }

    return (
      <Input
        key={`value-${field}`}
        value={draft[field] ?? saved[field]}
        placeholder={placeholders[field]}
        submitLabel="Save"
        autoFocus
        onInput={typed => {
          draft = { ...draft, [field]: typed }
        }}
        onSubmit={() => void saveSettings($)}
      />
    )
  }
  const rows = await Promise.all(FIELDS.map(async field => ({ ...field, element: await value(field.value) })))

  return (
    <Box flexDirection="column" rowGap={1}>
      {rows.map(({ label, element }) => (
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Box width={10} flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
          <Box flexGrow={1}>{element}</Box>
        </Box>
      ))}
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Box width={10} flexShrink={0} />
        <Button key="test" label="Test" dimColor={tested?.state === 'running'} onPress={() => void testSettings($)} />
        {tested !== null && (
          <Text
            color={tested.state === 'passed' ? 'green' : tested.state === 'failed' ? 'red' : undefined}
            dimColor={tested.state === 'running'}
            wrap="truncate-end"
          >
            {tested.state === 'passed'
              ? `✓ ${tested.message}`
              : tested.state === 'failed'
                ? `✗ ${tested.message}`
                : tested.message}
          </Text>
        )}
      </Box>
    </Box>
  )
}

const ageOf = (ms: number) => {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) {
    return 'now'
  }
  if (minutes < 60) {
    return `${minutes}m`
  }

  return minutes < 24 * 60 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / (24 * 60))}d`
}

// One line per transcription, cut to the band's width; a press puts it at the
// cursor, as a new one would go.
const historyList = async ($: EngineInterface, e: ResolveInput, columns: number) => {
  const { Box, Button, Text } = $.ui.resolve(e)
  const items = await read($, history)
  if (items.length === 0) {
    return <Text dimColor>Nothing transcribed yet.</Text>
  }

  const now = await $.clock.now()
  const width = Math.max(20, columns - 8)
  const clip = (text: string) => {
    const line = text.replace(/\s+/g, ' ')

    return line.length > width ? `${line.slice(0, width - 1)}…` : line
  }

  return (
    <Box flexDirection="column">
      {items.map((item, index) => (
        <Box flexDirection="row" columnGap={1}>
          <Box width={4} flexShrink={0}>
            <Text dimColor>{ageOf(now - item.at)}</Text>
          </Box>
          <Button key={`history-${index}`} plain onPress={() => void pickHistory($, item)}>
            {clip(item.text)}
          </Button>
        </Box>
      ))}
    </Box>
  )
}

const BLOCKS = '▁▂▃▄▅▆▇█'

// The last second of loudness as bars, newest at the right: an Svg where the
// surface has one, block characters on the terminal.
const meter = ($: EngineInterface, e: ResolveInput, heights: readonly number[]) => {
  const bars = [...Array<number>(METER_BARS - heights.length).fill(0), ...heights]
  if (e.surface === 'terminal') {
    const { Text } = $.ui.resolve(e)
    const glyphs = bars.map(height => BLOCKS[Math.round(height * (BLOCKS.length - 1))]).join('')

    return <Text color="red">{glyphs}</Text>
  }

  const { Svg } = $.ui.resolve(e)
  const width = METER_BARS * 5 - 2
  const rects = bars
    .map((height, index) => {
      const tall = Math.max(3, Math.round(3 + height * 15))

      return `<rect x="${index * 5}" y="${(18 - tall) / 2}" width="3" height="${tall}" rx="1.5"/>`
    })
    .join('')

  return (
    <Svg
      source={`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="18" viewBox="0 0 ${width} 18" fill="#ef4444">${rects}</svg>`}
      alt="microphone level"
      width={width}
      height={18}
    />
  )
}

// On or off: `enabled` in $.store for every chat (on unless turned off), and
// `chat:<session id>` set to false for a chat turned off alone. The mod shows
// where it is on everywhere and not turned off in that chat.
const chatKey = async ($: EngineInterface) => `chat:${await $.session.id()}`

const loadSwitches = async ($: EngineInterface) => {
  const everywhere = (await $.store.get('enabled')) !== false
  const here = (await $.store.get(await chatKey($))) !== false
  await update($, isEnabled, () => everywhere)
  await update($, isChatEnabled, () => here)

  return everywhere && here
}

// What the mod was doing stops with it: a recording is discarded unsent.
const hide = async ($: EngineInterface) => {
  if ((await read($, phase)) === 'recording') {
    await cancelRecording($)
  }
  if (failed) {
    await discardFailed($)
  }
  await closeSettings($)
  await update($, isHistoryOpen, () => false)
}

type Switch = 'speech-on' | 'speech-off' | 'speech-chat-on' | 'speech-chat-off'

const runSwitch = async ($: EngineInterface, name: Switch) => {
  const key = await chatKey($)
  if (name === 'speech-on') {
    await $.store.set('enabled', true)
    await $.store.delete(key)
    await loadSwitches($)

    return 'Speech insert is on in every chat, except chats turned off with /speech-chat-off.'
  }
  if (name === 'speech-off') {
    await $.store.set('enabled', false)
    await loadSwitches($)
    await hide($)

    return 'Speech insert is off in every chat. /speech-on turns it back on.'
  }
  if (name === 'speech-chat-on') {
    await $.store.delete(key)
    const isShown = await loadSwitches($)

    return isShown
      ? 'Speech insert is on in this chat.'
      : 'Speech insert is off in every chat; /speech-on turns it on everywhere.'
  }
  await $.store.set(key, false)
  await loadSwitches($)
  await hide($)

  return 'Speech insert is off in this chat. /speech-chat-on turns it back on here.'
}

const toolbar = async ($: EngineInterface, e: ResolveInput) => {
  const now = await read($, phase)
  const isOpen = await read($, isSettingsOpen)
  const isListed = await read($, isHistoryOpen)
  const problem = await read($, error)
  const isRetryable = now === 'idle' && (await read($, canRetry))
  const seconds = now === 'recording' ? await read($, elapsed) : 0
  const heights = now === 'recording' ? await read($, levels) : []
  const isConfirming = now === 'recording' && (await read($, isConfirmingCancel))
  const { Box, Button, Text } = $.ui.resolve(e)

  const status = now === 'recording' ? 'Recording… press again to stop' : now === 'transcribing' ? 'Transcribing…' : ''

  return (
    <Box flexDirection="row" alignItems="center" columnGap={1}>
      <Button
        key="settings"
        label="⚙"
        dimColor={!isOpen}
        onPress={() => void (isOpen ? closeSettings($) : openSettings($))}
      />
      <Button
        key="history"
        label="🕘"
        dimColor={!isListed}
        onPress={() => void (isListed ? update($, isHistoryOpen, () => false) : openHistory($))}
      />
      {now === 'recording' ? (
        <Button key="mic" variant="primary" onPress={() => void toggleRecording($)}>
          <Text color="red">●</Text> {seconds}s
        </Button>
      ) : (
        <Button key="mic" label={now === 'transcribing' ? '⏳' : '🎙'} onPress={() => void toggleRecording($)} />
      )}
      {now === 'recording' && !isConfirming && (
        <Button key="cancel" label="✕" dimColor onPress={() => update($, isConfirmingCancel, () => true)} />
      )}
      {now === 'recording' && meter($, e, heights)}
      {isConfirming && <Text>Discard this recording?</Text>}
      {isConfirming && <Button key="discard" label="Yes" onPress={() => void cancelRecording($)} />}
      {isConfirming && (
        <Button key="keep" label="No" variant="primary" onPress={() => update($, isConfirmingCancel, () => false)} />
      )}
      {status !== '' && !isConfirming && <Text dimColor>{status}</Text>}
      {isRetryable && <Button key="retry" label="↻ Retry" onPress={() => void retry($)} />}
      {isRetryable && <Button key="dismiss" label="✕" dimColor onPress={() => void discardFailed($)} />}
      {status === '' && problem !== null && (
        <Text color="red" wrap="truncate-end">
          {problem}
        </Text>
      )}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    platform = await detectPlatform($)
    await loadSettings($)
    await loadSwitches($)
    await update($, phase, () => 'idle')
    await update($, isConfirmingCancel, () => false)
    await update($, isSettingsOpen, () => false)
    await update($, isHistoryOpen, () => false)
    await update($, canRetry, () => false)
    await $.command.register({
      name: 'speech-on',
      description: 'Show the speech-insert mic in every chat',
      immediate: true,
    })
    await $.command.register({
      name: 'speech-off',
      description: 'Hide the speech-insert mic in every chat',
      immediate: true,
    })
    await $.command.register({
      name: 'speech-chat-on',
      description: 'Show the speech-insert mic in this chat',
      immediate: true,
    })
    await $.command.register({
      name: 'speech-chat-off',
      description: 'Hide the speech-insert mic in this chat only',
      immediate: true,
    })
    // Another chat's /speech-on or /speech-off reaches this one within seconds.
    $.clock.every(3000, () => {
      void loadSwitches($).then(isShown => (isShown ? undefined : hide($)))
    })

    return next(e)
  })

  on('command.run', { command: 'speech-on' }, async $ => ({
    text: await runSwitch($, 'speech-on'),
  }))
  on('command.run', { command: 'speech-off' }, async $ => ({
    text: await runSwitch($, 'speech-off'),
  }))
  on('command.run', { command: 'speech-chat-on' }, async $ => ({
    text: await runSwitch($, 'speech-chat-on'),
  }))
  on('command.run', { command: 'speech-chat-off' }, async $ => ({
    text: await runSwitch($, 'speech-chat-off'),
  }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const isShown = (await read($, isEnabled)) && (await read($, isChatEnabled))
    if (e.props.hasSurvey || !isShown) {
      return next(e)
    }

    // The band is one for every plugin: what the hooks beneath draw (another
    // mod's band) stays on top, and the mic sits right above the prompt.
    const { Box } = $.ui.resolve(e)
    const beneath = await next(e)
    const bar = await toolbar($, e)
    const panel = (await read($, isSettingsOpen))
      ? await settingsForm($, e)
      : (await read($, isHistoryOpen))
        ? await historyList($, e, e.props.bodyColumns)
        : null

    return (
      <Box flexDirection="column">
        {beneath}
        {panel === null ? (
          bar
        ) : (
          <Box flexDirection="column" rowGap={1}>
            {panel}
            {bar}
          </Box>
        )}
      </Box>
    )
  })
}
