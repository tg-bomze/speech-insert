export type SpeechInsertConfig = {
  baseUrl: string
  model: string
  language: string
  // The last four characters of the saved token, '' when none is saved. The
  // token itself stays in $.store, which other plugins cannot read.
  tokenHint: string
  // The input ffmpeg records from and the name it is shown by; '' for the
  // system's default (on Windows, the first microphone found).
  microphone: string
  microphoneName: string
}

export type SpeechInsertField = 'baseUrl' | 'token' | 'model' | 'language' | 'microphone'

export type SpeechInsertPhase = 'idle' | 'recording' | 'transcribing'

export type SpeechInsertDevice = { id: string; name: string }

export type SpeechInsertTest = { state: 'running' | 'passed' | 'failed'; message: string }

export type SpeechInsertHistoryItem = { text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'speech-insert': {
      config: Shaped<SpeechInsertConfig>
      isEnabled: boolean
      isChatEnabled: boolean
      phase: SpeechInsertPhase
      isConfirmingCancel: boolean
      isSettingsOpen: boolean
      settingsField: SpeechInsertField
      devices: Shaped<SpeechInsertDevice[] | null>
      devicesError: string | null
      test: Shaped<SpeechInsertTest | null>
      elapsed: number
      levels: number[]
      error: string | null
      canRetry: boolean
      isHistoryOpen: boolean
      history: Shaped<SpeechInsertHistoryItem[]>
    }
  }
}
