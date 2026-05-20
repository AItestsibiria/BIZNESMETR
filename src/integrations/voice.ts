import { logger } from '../logger'
import { config } from '../config'

export interface VoiceTranscriptionInput {
  audio: Buffer
  mimeType?: string | undefined
  /** Telegram filename or original filename; helps the provider sniff format. */
  filename?: string | undefined
  /** ISO 639-1 language hint (e.g. "ru"). Boosts Russian accuracy a lot. */
  languageHint?: string | undefined
}

export interface VoiceTranscriptionResult {
  text: string
  language?: string | undefined
  durationSec?: number | undefined
  provider: string
}

export interface VoiceTranscriber {
  readonly name: string
  isConfigured(): boolean
  transcribe(input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResult>
}

// ---------- OpenAI Whisper (default) -----------------------------------------
//
// TODO(muziai/voice): MuziAI has voice dialog wired in production. If their
// STT choice differs (whisper.cpp self-hosted, Yandex SpeechKit, Salute,
// AssemblyAI, etc.), add another transcriber that implements this interface
// and swap via STT_PROVIDER. Keep this class as the fallback.

export class WhisperTranscriber implements VoiceTranscriber {
  readonly name = 'openai-whisper'

  isConfigured(): boolean {
    return !!config.OPENAI_API_KEY
  }

  async transcribe(input: VoiceTranscriptionInput): Promise<VoiceTranscriptionResult> {
    if (!config.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set — Whisper transcription is unavailable')
    }
    const filename = input.filename ?? guessFilename(input.mimeType)
    const blob = new Blob([new Uint8Array(input.audio)], {
      type: input.mimeType ?? 'audio/ogg',
    })

    const form = new FormData()
    form.append('file', blob, filename)
    form.append('model', config.STT_MODEL)
    form.append('response_format', 'verbose_json')
    if (input.languageHint) form.append('language', input.languageHint)

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.OPENAI_API_KEY}`,
      },
      body: form,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Whisper HTTP ${res.status}: ${body.slice(0, 200)}`)
    }

    const data = (await res.json()) as {
      text: string
      language?: string
      duration?: number
    }
    logger.info(
      { chars: data.text.length, lang: data.language, dur: data.duration },
      'Voice transcribed',
    )
    return {
      text: data.text.trim(),
      ...(data.language ? { language: data.language } : {}),
      ...(typeof data.duration === 'number' ? { durationSec: data.duration } : {}),
      provider: this.name,
    }
  }
}

function guessFilename(mime?: string | undefined): string {
  if (!mime) return 'audio.ogg'
  if (mime.includes('ogg')) return 'audio.ogg'
  if (mime.includes('mpeg')) return 'audio.mp3'
  if (mime.includes('wav')) return 'audio.wav'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'audio.m4a'
  return 'audio.bin'
}

// ---------- Registry --------------------------------------------------------

const whisper = new WhisperTranscriber()

export function getTranscriber(): VoiceTranscriber {
  // TODO(muziai/voice): when STT_PROVIDER === 'muziai', return their adapter.
  return whisper
}

export { whisper }
