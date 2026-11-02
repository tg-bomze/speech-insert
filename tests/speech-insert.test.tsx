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
const world = (on: On) => {
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

    return <Text>prompt</Text>
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

test('the gear shows all four settings, one of them a field', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ key: 'mic' })).toBeDefined()
    expect(await ui.find({ key: 'value-baseUrl' })).toBeUndefined()

    await ui.press({ key: 'settings' })
    expect(await ui.find({ key: 'value-baseUrl' })).toBeDefined()
    for (const label of ['Base URL', 'API token', 'Model', 'Language']) {
      expect(await ui.find({ type: 'Text', text: label })).toBeDefined()
    }
    expect(await ui.find({ key: 'edit-model' })).toBeDefined()

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
  expect(commands[0]).toBe('kill -INT 42')
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
