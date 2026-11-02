export type SpeechInsertConfig = {
  baseUrl: string
  model: string
  language: string
  // The last four characters of the saved token, '' when none is saved. The
  // token itself stays in $.store, which other plugins cannot read.
  tokenHint: string
}

export type SpeechInsertField = 'baseUrl' | 'token' | 'model' | 'language'

export type SpeechInsertPhase = 'idle' | 'recording' | 'transcribing'

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
      elapsed: number
      levels: number[]
      error: string | null
    }
  }
}
