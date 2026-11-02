import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'speech-insert',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// The plugin's store, toasts and clock, answered from memory beneath it, and
// the prompt band a hidden mod leaves to whoever draws beneath.
const world = (on: On, beneath = 'prompt') => {
  const stored = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: stored.get(e.key) }))
  on('store.set', (_, e) => {
    stored.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    stored.delete(e.key)

    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{beneath}</Text>
  })

  return { stored, clock: mock.clock(on) }
}

// A slash command the person typed, bare.
const typed = (command: string) => ({
  command,
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
})

type Ran = { exitCode?: number; stdout?: string; stderr?: string }

// The host's programs: ffmpeg records until `kill -INT` reaches it (bare on
// Windows, until it is killed), stat finds a recording, and `answer` answers
// every other command.
const host = (on: On, answer: (argv: readonly string[]) => Ran | undefined = () => undefined) => {
  const commands: string[][] = []
  const spawned: string[][] = []
  let interrupt = () => {}
  on('process.spawn', async function* (_, e) {
    spawned.push([...e.argv])
    if (e.argv[0] === '/bin/sh') {
      yield { stream: 'stdout' as const, text: 'pid:42\n' }
    }
    await new Promise<void>(resolve => {
      interrupt = resolve
    })

    return { value: { code: 255, signal: null } }
  })
  on('process.run', (_, e) => {
    commands.push([...e.argv])
    if (e.argv[0] === 'kill') {
      interrupt()
    }

    return {
      value: {
        exitCode: 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
        ...answer(e.argv),
      },
    }
  })
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 8000, mtimeMs: 0, isLink: false } }))
  on('session.id', () => ({ value: 'chat-a' }))

  return { commands, spawned }
}

// What curl prints for an answer: the body, then the status on its own line.
const answered = (text: string): Ran => ({ stdout: `${JSON.stringify({ text })}\n200` })

// The prompt box: its text, and a cursor at its end.
const promptBox = (on: On, text: string) => {
  const box = { text, cursor: text.length }
  on('prompt.read', () => ({ value: { ...box } }))
  on('prompt.fill', (_, e) => {
    box.text = box.text.slice(0, box.cursor) + e.text + box.text.slice(box.cursor)
    box.cursor += e.text.length

    return { isFilled: true }
  })

  return box
}

test('the gear shows all five settings, one of them a field', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'mic' })).toBeDefined()
    expect(await ui.find({ key: 'value-baseUrl' })).toBeUndefined()

    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'value-baseUrl' })).toBeDefined()
    for (const label of ['Base URL', 'API token', 'Model', 'Language', 'Microphone']) {
      expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    }
    expect(await ui.find({ key: 'edit-model' })).toBeDefined()
    expect((await ui.find({ key: 'edit-microphone' }))?.text).toBe('System default')
    expect(await ui.find({ key: 'test' })).toBeDefined()

    await ui.press({ key: 'edit-model' })
    expect(await ui.find({ key: 'value-model' })).toBeDefined()
    expect(await ui.find({ key: 'value-baseUrl' })).toBeUndefined()

    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'value-model' })).toBeUndefined()
    await ui.unmount()
  }
})

test('one Save keeps every field typed, and only then', async ($, on) => {
  const { stored } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    await ui.press({ key: 'settings' })
    await ui.input({ key: 'value-baseUrl', text: 'https://example.test/v1', kind: 'change' })
    await ui.press({ key: 'edit-model' })
    await ui.input({ key: 'value-model', text: 'whisper-large-v3', kind: 'change' })
    await ui.press({ key: 'edit-language' })
    await ui.input({ key: 'value-language', text: 'ru', kind: 'change' })
    await ui.press({ key: 'edit-token' })
    await ui.input({ key: 'value-token', text: 'test-token-abcd', kind: 'change' })
    expect(stored.get('baseUrl')).toBeUndefined()

    await ui.input({ key: 'value-token', text: 'test-token-abcd' })
    expect(stored.get('baseUrl')).toBe('https://example.test/v1')
    expect(stored.get('model')).toBe('whisper-large-v3')
    expect(stored.get('language')).toBe('ru')
    expect(stored.get('token')).toBe('test-token-abcd')
    expect(await ui.find({ key: 'mic' })).toBeDefined()
    expect(await ui.find({ key: 'edit-model' })).toBeUndefined()
    await ui.unmount()
    stored.clear()
  }
})

test('settings another chat saved show up when the form opens', async ($, on) => {
  const { stored } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // Another session writes the shared store after this one started.
  stored.set('baseUrl', 'https://other.test/v1')
  stored.set('token', 'test-token-wxyz')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'settings' })
  expect((await ui.find({ key: 'value-baseUrl' }))?.props.value).toBe('https://other.test/v1')
  await ui.press({ key: 'edit-token' })
  expect((await ui.find({ key: 'value-token' }))?.props.placeholder).toBe('saved …wxyz')
  await ui.unmount()
})

test('the mic without a token opens settings instead of recording', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'mic' })

  expect(await ui.find({ key: 'value-baseUrl' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /set the base URL/ }))?.text).toContain('settings')
  await ui.unmount()
})

test('the mic counts the recording seconds', async ($, on) => {
  const { stored, clock } = world(on)
  stored.set('token', 'test-token-abcd')
  mock.env(on, { TMPDIR: '/tmp', PATH: '/usr/bin' })
  // ffmpeg stands here: it says its pid and records until it is stopped.
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'pid:42\n' }
    await new Promise(() => {})
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'mic' })
  expect((await ui.find({ key: 'mic' }))?.text).toContain('0s')

  for (const second of [1, 2, 3]) {
    await clock.advance(1000)
    expect((await ui.find({ key: 'mic' }))?.text).toContain(`${second}s`)
  }
  await ui.unmount()
})

test('the meter rises with the loudness ffmpeg reports', async ($, on) => {
  const { stored, clock } = world(on)
  stored.set('token', 'test-token-abcd')
  mock.env(on, { TMPDIR: '/tmp', PATH: '/usr/bin' })
  // ffmpeg stands here: its pid, then a silent tenth of a second and a loud one.
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'pid:42\nframe:0 pts:0\n' }
    yield { stream: 'stdout' as const, text: 'lavfi.astats.Overall.RMS_level=-70.0\n' }
    yield { stream: 'stdout' as const, text: 'lavfi.astats.Overall.RMS_level=-20.0\n' }
    await new Promise(() => {})
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await desktop.press({ key: 'mic' })
  await clock.advance(0)
  const svg = await desktop.find({ type: 'Svg' })
  expect(svg?.props.alt).toBe('microphone level')
  // The loud tenth is the newest bar, at the right, full height.
  expect(String(svg?.props.source)).toContain('x="55" y="0" width="3" height="18"')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /▁+█$/ }))?.text).toBe('▁'.repeat(11) + '█')
  await terminal.unmount()
})

test('the cross asks first, and Yes discards without transcribing', async ($, on) => {
  const { stored } = world(on)
  stored.set('token', 'test-token-abcd')
  mock.env(on, { TMPDIR: '/tmp', PATH: '/usr/bin' })
  const commands: string[] = []
  let interrupt = () => {}
  const interrupted = new Promise<void>(resolve => {
    interrupt = resolve
  })
  // ffmpeg stands here: it records until `kill -INT` reaches it.
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: 'pid:42\n' }
    await interrupted

    return { value: { code: 255, signal: null } }
  })
  on('process.run', (_, e) => {
    commands.push(e.argv.join(' '))
    if (e.argv[0] === 'kill') {
      interrupt()
    }

    return {
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    if (surface === 'terminal') {
      await ui.press({ key: 'mic' })
    }

    await ui.press({ key: 'cancel' })
    expect(await ui.find({ type: 'Text', text: 'Discard this recording?' })).toBeDefined()
    await ui.press({ key: 'keep' })
    expect(await ui.find({ key: 'discard' })).toBeUndefined()
    expect(await ui.find({ key: 'cancel' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'cancel' })
  await ui.press({ key: 'discard' })
  expect((await ui.find({ key: 'mic' }))?.text).toBe('🎙')
  expect(commands.includes('kill -INT 42')).toBe(true)
  expect(commands.some(command => command.startsWith('rm -f /tmp/speech-insert-'))).toBe(true)
  expect(commands.some(command => command.startsWith('curl'))).toBe(false)
  await ui.unmount()
})

test('a survey keeps the band for itself', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>survey</Text>
  })

  const ui = await $.ui.mount({
    ...BAND,
    props: { ...BAND.props, hasSurvey: true },
    surface: 'terminal',
  })
  expect(await ui.find({ key: 'mic' })).toBeUndefined()
  await ui.unmount()
})

test("another mod's band stays, above the mic", async ($, on) => {
  world(on, "Claude's edits")
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: "Claude's edits" })).toBeDefined()
  expect(await ui.find({ key: 'mic' })).toBeDefined()
  await ui.press({ key: 'settings' })
  expect(await ui.find({ type: 'Text', text: "Claude's edits" })).toBeDefined()
  expect(await ui.find({ key: 'value-baseUrl' })).toBeDefined()
  await ui.unmount()
})

test('a chat turned off stays off alone, and a new chat starts on', async ($, on) => {
  const { stored } = world(on)
  let chat = 'chat-a'
  on('session.id', () => ({ value: chat }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ key: 'mic' })).toBeDefined()

  const { text } = await $.command.run(typed('speech-chat-off'))
  expect(text).toContain('off in this chat')
  expect(stored.get('chat:chat-a')).toBe(false)
  expect(await ui.find({ key: 'mic' })).toBeUndefined()
  await ui.unmount()

  chat = 'chat-b'
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const other = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await other.find({ key: 'mic' })).toBeDefined()
  await other.unmount()

  chat = 'chat-a'
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const back = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await back.find({ key: 'mic' })).toBeUndefined()
  await $.command.run(typed('speech-chat-on'))
  expect(stored.has('chat:chat-a')).toBe(false)
  expect(await back.find({ key: 'mic' })).toBeDefined()
  await back.unmount()
})

test('off everywhere hides every chat until it is turned on again', async ($, on) => {
  const { stored } = world(on)
  let chat = 'chat-a'
  on('session.id', () => ({ value: chat }))
  stored.set('chat:chat-a', false)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.command.run(typed('speech-off'))
  expect(stored.get('enabled')).toBe(false)

  chat = 'chat-b'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ key: 'mic' })).toBeUndefined()

  const chatOn = await $.command.run(typed('speech-chat-on'))
  expect(chatOn.text).toContain('off in every chat')
  expect(await ui.find({ key: 'mic' })).toBeUndefined()

  const allOn = await $.command.run(typed('speech-on'))
  expect(allOn.text).toContain('on in every chat')
  expect(stored.get('enabled')).toBe(true)
  expect(await ui.find({ key: 'mic' })).toBeDefined()
  await ui.unmount()

  // /speech-on clears only the chat it runs in.
  expect(stored.get('chat:chat-a')).toBe(false)
})

test('an open chat hides within seconds when another turns it off', async ($, on) => {
  const { stored, clock } = world(on)
  on('session.id', () => ({ value: 'chat-a' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'settings' })
  expect(await ui.find({ key: 'value-baseUrl' })).toBeDefined()

  // /speech-off typed in another chat writes the shared store.
  stored.set('enabled', false)
  await clock.advance(3000)
  expect(await ui.find({ key: 'mic' })).toBeUndefined()

  stored.delete('enabled')
  await clock.advance(3000)
  expect(await ui.find({ key: 'mic' })).toBeDefined()
  expect(await ui.find({ key: 'value-baseUrl' })).toBeUndefined()
  await ui.unmount()
})

test('a failed transcription keeps the recording for Retry', async ($, on) => {
  const { stored } = world(on)
  stored.set('token', 'test-token-abcd')
  mock.env(on, { TMPDIR: '/tmp', PATH: '/usr/bin' })
  const box = promptBox(on, 'fix the')
  let calls = 0
  const { commands } = host(on, argv => {
    if (argv[0] !== 'curl') {
      return undefined
    }
    calls += 1

    return calls === 1 ? { stdout: '{"error":{"message":"upstream down"}}\n502' } : answered('bug now')
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'mic' })
  await ui.press({ key: 'mic' })
  expect((await ui.find({ type: 'Text', text: /HTTP 502/ }))?.text).toContain('upstream down')
  expect(await ui.find({ key: 'retry' })).toBeDefined()
  expect(commands.some(argv => argv[0] === 'rm')).toBe(false)

  await ui.press({ key: 'retry' })
  expect(box.text).toBe('fix the bug now')
  expect(await ui.find({ key: 'retry' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /HTTP 502/ })).toBeUndefined()
  // The same file went twice, and was deleted once it was transcribed.
  const sent = commands.filter(argv => argv[0] === 'curl').map(argv => argv.find(arg => arg.startsWith('file=@')))
  expect(sent).toHaveLength(2)
  expect(sent[0]).toBe(sent[1])
  expect(commands.some(argv => argv[0] === 'rm' && sent[0]?.includes(argv[2] ?? '-'))).toBe(true)
  await ui.unmount()
})

test('the cross beside Retry throws the failed recording away', async ($, on) => {
  const { stored } = world(on)
  stored.set('token', 'test-token-abcd')
  mock.env(on, { TMPDIR: '/tmp', PATH: '/usr/bin' })
  promptBox(on, '')
  const { commands } = host(on, argv =>
    argv[0] === 'curl' ? { exitCode: 6, stderr: 'Could not resolve host' } : undefined,
  )
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'mic' })
  await ui.press({ key: 'mic' })
  expect(await ui.find({ type: 'Text', text: 'Could not resolve host' })).toBeDefined()

  await ui.press({ key: 'dismiss' })
  expect(await ui.find({ key: 'retry' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Could not resolve host' })).toBeUndefined()
  expect(commands.some(argv => argv[0] === 'rm' && (argv[2] ?? '').startsWith('/tmp/speech-insert-'))).toBe(true)
  await ui.unmount()
})

test('history keeps the last ten for every chat, and a press inserts one', async ($, on) => {
  const { stored, clock } = world(on)
  stored.set('token', 'test-token-abcd')
  mock.env(on, { TMPDIR: '/tmp', PATH: '/usr/bin' })
  const box = promptBox(on, '')
  host(on, argv => (argv[0] === 'curl' ? answered('run the tests') : undefined))
  // Ten transcriptions another chat made, the newest first.
  await clock.advance(10 * 60_000)
  stored.set(
    'history',
    Array.from({ length: 10 }, (_, index) => ({
      text: index === 4 ? 'run the tests' : `note ${index}`,
      at: (10 - index) * 60_000 - 60_000,
    })),
  )
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'history' })
  expect((await ui.find({ key: 'history-0' }))?.text).toBe('note 0')
  expect((await ui.find({ type: 'Text', text: '2m' }))?.text).toBe('2m')
  expect(await ui.find({ key: 'history-9' })).toBeDefined()

  await ui.press({ key: 'history-1' })
  expect(box.text).toBe('note 1')
  expect(await ui.find({ key: 'history-0' })).toBeUndefined()

  // A new transcription goes on top; its repeat further down leaves.
  await ui.press({ key: 'mic' })
  await ui.press({ key: 'mic' })
  const kept = stored.get('history') as { text: string }[]
  expect(kept).toHaveLength(10)
  expect(kept.map(item => item.text)).toEqual([
    'run the tests',
    ...Array.from({ length: 10 }, (_, index) => `note ${index}`).filter(text => text !== 'note 4'),
  ])
  await ui.unmount()
})

test('Test sends a second of silence with what the form holds', async ($, on) => {
  const { stored } = world(on)
  stored.set('token', 'test-token-abcd')
  mock.env(on, { TMPDIR: '/tmp', PATH: '/usr/bin' })
  let status = 401
  const { commands } = host(on, argv =>
    argv[0] !== 'curl'
      ? undefined
      : status === 200
        ? answered('')
        : { stdout: `{"error":{"message":"bad key"}}\n${status}` },
  )
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'settings' })
  await ui.input({ key: 'value-baseUrl', text: 'https://draft.test/v1', kind: 'change' })
  await ui.press({ key: 'test' })
  expect((await ui.find({ type: 'Text', text: /^✗/ }))?.text).toBe('✗ HTTP 401: bad key')

  const silence = commands.find(argv => argv[0] === 'ffmpeg')
  expect(silence?.includes('anullsrc=r=16000:cl=mono')).toBe(true)
  const curl = commands.find(argv => argv[0] === 'curl')
  expect(curl?.includes('https://draft.test/v1/audio/transcriptions')).toBe(true)
  expect(commands.some(argv => argv[0] === 'rm' && (argv[2] ?? '').startsWith('/tmp/speech-insert-test-'))).toBe(true)

  status = 200
  await ui.press({ key: 'test' })
  expect((await ui.find({ type: 'Text', text: /^✓/ }))?.text).toContain('Works')
  // Testing saves nothing; the field still holds what was typed.
  expect(stored.get('baseUrl')).toBeUndefined()
  expect((await ui.find({ key: 'value-baseUrl' }))?.props.value).toBe('https://draft.test/v1')
  await ui.unmount()
})

test('macOS lists AVFoundation microphones, and records from the one picked', async ($, on) => {
  const { stored } = world(on)
  stored.set('token', 'test-token-abcd')
  mock.env(on, { TMPDIR: '/tmp', PATH: '/usr/bin' })
  const listing = [
    '[AVFoundation indev @ 0x1] AVFoundation video devices:',
    '[AVFoundation indev @ 0x1] [0] FaceTime HD Camera',
    '[AVFoundation indev @ 0x1] AVFoundation audio devices:',
    '[AVFoundation indev @ 0x1] [0] MacBook Air Microphone',
    '[AVFoundation indev @ 0x1] [1] AirPods Pro',
    'Error opening input file .',
  ].join('\n')
  const { spawned } = host(on, argv => {
    if (argv[0] === 'uname') {
      return { stdout: 'Darwin\n' }
    }

    return argv.includes('-list_devices') ? { exitCode: 251, stderr: listing } : undefined
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'edit-microphone' })
  expect((await ui.find({ key: 'device-0' }))?.text).toBe('● System default')
  expect((await ui.find({ key: 'device-2' }))?.text).toBe('○ AirPods Pro')
  expect(await ui.find({ key: 'device-3' })).toBeUndefined()

  await ui.press({ key: 'device-2' })
  expect(stored.get('microphone')).toBe('AirPods Pro')
  expect((await ui.find({ key: 'edit-microphone' }))?.text).toBe('AirPods Pro')
  expect(await ui.find({ key: 'value-baseUrl' })).toBeDefined()

  await ui.press({ key: 'mic' })
  expect(spawned[0]?.slice(0, 2)).toEqual(['/bin/sh', '-c'])
  expect(spawned[0]?.join(' ')).toContain('-f avfoundation -i :AirPods Pro')
  await ui.unmount()
})

test('Linux records from PulseAudio and lists its sources by description', async ($, on) => {
  const { stored } = world(on)
  stored.set('token', 'test-token-abcd')
  mock.env(on, { TMPDIR: '/tmp', PATH: '/usr/bin' })
  const sources = [
    'Source #0',
    '\tState: SUSPENDED',
    '\tName: alsa_output.pci-0000_00_1f.3.analog-stereo.monitor',
    '\tDescription: Monitor of Built-in Audio Analog Stereo',
    '',
    'Source #1',
    '\tState: RUNNING',
    '\tName: alsa_input.pci-0000_00_1f.3.analog-stereo',
    '\tDescription: Built-in Audio Analog Stereo',
  ].join('\n')
  const { commands, spawned } = host(on, argv => {
    if (argv[0] === 'uname') {
      return { stdout: 'Linux\n' }
    }

    return argv[0] === 'pactl' ? { stdout: sources } : undefined
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'mic' })
  expect(spawned[0]?.join(' ')).toContain('-f pulse -i default')
  await ui.press({ key: 'cancel' })
  await ui.press({ key: 'discard' })

  await ui.press({ key: 'settings' })
  await ui.press({ key: 'edit-microphone' })
  expect((await ui.find({ key: 'device-1' }))?.text).toBe('○ Built-in Audio Analog Stereo')
  expect(await ui.find({ key: 'device-2' })).toBeUndefined()
  await ui.press({ key: 'device-1' })
  expect(stored.get('microphone')).toBe('alsa_input.pci-0000_00_1f.3.analog-stereo')

  await ui.press({ key: 'mic' })
  expect(spawned[1]?.join(' ')).toContain('-f pulse -i alsa_input.pci-0000_00_1f.3.analog-stereo')
  expect(commands.some(argv => argv.join(' ') === 'kill -INT 42')).toBe(true)
  await ui.unmount()
})

test('Windows records the first DirectShow microphone, and kills ffmpeg to stop', async ($, on) => {
  const { stored, clock } = world(on)
  stored.set('token', 'test-token-abcd')
  mock.env(on, { OS: 'Windows_NT', TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp' })
  const box = promptBox(on, '')
  const listing = [
    '[dshow @ 000001] "Integrated Camera" (video)',
    '[dshow @ 000001]   Alternative name "@device_pnp_\\\\?\\usb#vid"',
    '[dshow @ 000001] "Microphone (Realtek(R) Audio)" (audio)',
    '[dshow @ 000001]   Alternative name "@device_cm_{33D9A762}\\wave_{1}"',
    '[dshow @ 000001] "Headset (Jabra)" (audio)',
    'dummy: Immediate exit requested',
  ].join('\r\n')
  const { commands, spawned } = host(on, argv => {
    if (argv.includes('-list_devices')) {
      return { exitCode: 1, stderr: listing }
    }

    return argv[0] === 'curl.exe' ? answered('hello from windows') : undefined
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'mic' })
  const argv = spawned[0] ?? []
  expect(argv[0]).toBe('ffmpeg.exe')
  expect(argv.join(' ')).toContain('-f dshow -i audio=Microphone (Realtek(R) Audio)')
  const file = argv[argv.length - 1] ?? ''
  expect(file.startsWith('C:\\Users\\me\\AppData\\Local\\Temp\\speech-insert-')).toBe(true)

  await ui.press({ key: 'mic' })
  await clock.advance(2000)
  expect(box.text).toBe('hello from windows')
  expect(commands.some(command => command[0] === 'kill')).toBe(false)
  expect(commands.some(command => command[0] === 'uname')).toBe(false)
  expect(commands.some(command => command.join(' ') === `cmd.exe /d /c del /f /q ${file}`)).toBe(true)

  await ui.press({ key: 'settings' })
  await ui.press({ key: 'edit-microphone' })
  expect((await ui.find({ key: 'device-0' }))?.text).toBe('● First microphone found')
  expect((await ui.find({ key: 'device-2' }))?.text).toBe('○ Headset (Jabra)')
  expect(await ui.find({ key: 'device-3' })).toBeUndefined()
  await ui.unmount()
})
