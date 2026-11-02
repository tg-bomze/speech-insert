import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ResolveInput, Timer } from 'claude-code'

import type { SpeechInsertConfig, SpeechInsertField, SpeechInsertPhase } from '../types'

const DEFAULTS: SpeechInsertConfig = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'whisper-1',
  language: '',
  tokenHint: '',
}

const config = atom({ plugin: 'speech-insert', key: 'config' } as const, DEFAULTS, {
  shape: 'config-1',
})
const phase = atom({ plugin: 'speech-insert', key: 'phase' } as const, 'idle' as SpeechInsertPhase)
const isSettingsOpen = atom({ plugin: 'speech-insert', key: 'isSettingsOpen' } as const, false)
const settingsField = atom({ plugin: 'speech-insert', key: 'settingsField' } as const, 'baseUrl' as SpeechInsertField)
const isEnabled = atom({ plugin: 'speech-insert', key: 'isEnabled' } as const, true)
const isChatEnabled = atom({ plugin: 'speech-insert', key: 'isChatEnabled' } as const, true)
const isConfirmingCancel = atom({ plugin: 'speech-insert', key: 'isConfirmingCancel' } as const, false)
const elapsed = atom({ plugin: 'speech-insert', key: 'elapsed' } as const, 0)
const levels = atom({ plugin: 'speech-insert', key: 'levels' } as const, [] as number[])
const error = atom({ plugin: 'speech-insert', key: 'error' } as const, null as string | null)

// The shell prints its pid first, and `exec` keeps that pid for ffmpeg, which
// SIGINT then stops cleanly. Beside the file, ffmpeg prints the loudness of
// every tenth of a second to stdout (`direct=1`, unbuffered) for the meter.
const RECORD_SCRIPT =
  'echo "pid:$$"; exec ffmpeg -nostdin -hide_banner -loglevel error ' +
  '-f avfoundation -i :default -filter_complex "' +
  '[0:a]aresample=16000,aformat=channel_layouts=mono,asplit=2[rec][meter];' +
  '[meter]asetnsamples=n=1600,astats=metadata=1:reset=1,' +
  'ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=-:direct=1,anullsink" ' +
  '-map "[rec]" -c:a libmp3lame -b:a 64k -y "$1"'

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
  }
  await update($, config, () => loaded)

  return { ...loaded, token }
}

// The desktop draws a submit button beside every text field, so of the four
// rows only the one being edited holds a field, and that field's own button
// is the one Save for all of them; the other rows show their value.
const FIELDS: readonly { value: SpeechInsertField; label: string }[] = [
  { value: 'baseUrl', label: 'Base URL' },
  { value: 'token', label: 'API token' },
  { value: 'model', label: 'Model' },
  { value: 'language', label: 'Language' },
]

// What the person typed in the settings form and has not saved yet. Typing
// writes here alone, so no keystroke redraws the form under the cursor.
let draft: Partial<Record<SpeechInsertField, string>> = {}

const openSettings = async ($: EngineInterface) => {
  draft = {}
  await loadSettings($)
  await update($, settingsField, () => 'baseUrl')
  await update($, isSettingsOpen, () => true)
}

const closeSettings = async ($: EngineInterface) => {
  draft = {}
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

const startRecording = async ($: EngineInterface) => {
  const { token, baseUrl } = await loadSettings($)
  if (!token || !baseUrl.trim()) {
    await openSettings($)
    await fail($, 'set the base URL and API token in settings (⚙)')

    return
  }

  const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
  const file = `${tmp}/speech-insert-${await $.clock.now()}.mp3`
  const path = (await $.env.get('PATH')) ?? '/usr/bin:/bin'
  const stream = $.process.spawn({
    argv: ['/bin/sh', '-c', RECORD_SCRIPT, 'sh', file],
    env: { PATH: `/opt/homebrew/bin:/usr/local/bin:${path}` },
  })

  let foundPid: (pid: string | null) => void = () => {}
  const pid = new Promise<string | null>(resolve => {
    foundPid = resolve
  })
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
      const reason = stderr.trim().split('\n').pop() || 'ffmpeg exited'
      await fail($, `recording failed: ${reason}`)
    }
  })
}

const transcribe = async ($: EngineInterface, file: string) => {
  const { token, baseUrl, model, language } = await loadSettings($)
  const argv = [
    'curl',
    '-sS',
    '--max-time',
    '120',
    '-X',
    'POST',
    transcriptionUrl(baseUrl),
    // The token goes in on stdin, so it never shows in a process listing.
    '-H',
    '@-',
    '-F',
    `file=@${file};type=audio/mpeg`,
    '--form-string',
    `model=${model.trim() || DEFAULTS.model}`,
    ...(language.trim() ? ['--form-string', `language=${language.trim()}`] : []),
    '--form-string',
    'response_format=json',
    '-w',
    '\n%{http_code}',
  ]
  const ran = await $.process.run(argv, {
    stdin: `Authorization: Bearer ${token}\n`,
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

// SIGINT lets ffmpeg finish the file; one that has not exited in five
// seconds is killed.
const endRecorder = async ($: EngineInterface, own: Recorder) => {
  const pid = await own.pid
  if (pid) {
    await $.process.run(['kill', '-INT', pid])
  }
  const stopped = await Promise.race([own.done.then(() => true), $.clock.sleep(5000).then(() => false)])
  if (!stopped) {
    own.kill()
  }
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
    await $.process.run(['rm', '-f', own.file]).catch(() => undefined)
  }
  $.ui.toast('Speech: recording discarded')
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
      await fail($, 'the recording is empty: check microphone access')

      return
    }

    const text = await transcribe($, own.file)
    if (text) {
      await insertAtCursor($, text)
    } else {
      $.ui.toast('Speech: no speech recognized')
    }
    await update($, phase, () => 'idle')
  } catch (thrown) {
    await fail($, thrown instanceof Error ? thrown.message : String(thrown))
  } finally {
    await $.process.run(['rm', '-f', own.file]).catch(() => undefined)
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

const settingsForm = async ($: EngineInterface, e: ResolveInput) => {
  const { Box, Button, Text } = $.ui.resolve(e)
  if (e.surface === 'mobile') {
    return <Text dimColor>Settings are available on desktop or in the terminal.</Text>
  }

  const { Input } = $.ui.resolve(e)
  const settings = await read($, config)
  const editing = await read($, settingsField)
  const saved: Record<SpeechInsertField, string> = {
    baseUrl: settings.baseUrl,
    token: '',
    model: settings.model,
    language: settings.language,
  }
  const placeholders: Record<SpeechInsertField, string> = {
    baseUrl: DEFAULTS.baseUrl,
    token: settings.tokenHint ? `saved …${settings.tokenHint}` : 'sk-…',
    model: DEFAULTS.model,
    language: 'auto-detect',
  }
  const shown = (field: SpeechInsertField) => {
    if (field === 'token') {
      return draft.token ? 'new token, not saved yet' : placeholders.token
    }

    return draft[field] ?? saved[field]
  }

  return (
    <Box flexDirection="column" rowGap={1}>
      {FIELDS.map(({ value: field, label }) => (
        <Box flexDirection="row" alignItems="center" columnGap={1}>
          <Box width={10} flexShrink={0}>
            <Text dimColor>{label}</Text>
          </Box>
          <Box flexGrow={1}>
            {field === editing ? (
              <Input
                key={`value-${field}`}
                value={draft[field] ?? saved[field]}
                placeholder={placeholders[field]}
                submitLabel="Save"
                autoFocus
                onInput={value => {
                  draft = { ...draft, [field]: value }
                }}
                onSubmit={() => void saveSettings($)}
              />
            ) : (
              <Button key={`edit-${field}`} plain onPress={() => update($, settingsField, () => field)}>
                {shown(field) || <Text dimColor>{placeholders[field]}</Text>}
              </Button>
            )}
          </Box>
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
  await closeSettings($)
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
  const problem = await read($, error)
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
    await loadSettings($)
    await loadSwitches($)
    await update($, phase, () => 'idle')
    await update($, isConfirmingCancel, () => false)
    await update($, isSettingsOpen, () => false)
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

    const { Box } = $.ui.resolve(e)
    const bar = await toolbar($, e)
    if (!(await read($, isSettingsOpen))) {
      return bar
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        {await settingsForm($, e)}
        {bar}
      </Box>
    )
  })
}
