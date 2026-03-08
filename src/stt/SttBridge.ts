/**
 * Bridges WebSocket audio streams to @magi/common STT engine.
 * One SttBridge instance per coordinator; creates per-PTT-cycle streams.
 */
import type { SttConfig } from './types.js';

export interface SttStreamHandle {
  write(pcm: Buffer): void;
  end(): void;
}

export type TranscriptCallback = (
  text: string,
  confidence: number,
  isFinal: boolean,
) => void;

export class SttBridge {
  private engine: any = null;
  private streamSeq = 0;

  constructor(private readonly config: SttConfig) {}

  async init(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[stt] STT disabled');
      return;
    }

    try {
      // Dynamic import — @magi/common may not be installed
      const { acquireSttEngine } = await import('@magi/common');
      this.engine = acquireSttEngine(this.config, false);
      console.log('[stt] STT engine initialized');
    } catch (e: any) {
      console.warn(`[stt] Failed to init STT engine: ${e.message}`);
      console.warn('[stt] Voice input will be unavailable');
    }
  }

  get available(): boolean {
    return this.engine !== null;
  }

  createStream(
    sampleRate: number,
    encoding: string,
    onTranscript: TranscriptCallback,
  ): SttStreamHandle {
    if (!this.engine) {
      throw new Error('STT engine not available');
    }

    const seq = ++this.streamSeq;
    const stream = this.engine.createStream(
      'glasses-user',
      seq,
      (event: any) => {
        onTranscript(
          event.transcript ?? '',
          event.confidence ?? 0,
          event.isFinal ?? false,
        );
      },
    );

    return {
      write(pcm: Buffer) {
        if (stream.open) {
          stream.write(pcm);
        }
      },
      end() {
        if (stream.open) {
          stream.close();
        }
      },
    };
  }

  async dispose(): Promise<void> {
    if (this.engine && this.config.enabled) {
      try {
        const { releaseSttEngine } = await import('@magi/common');
        releaseSttEngine(this.config, false);
      } catch {
        // Best effort
      }
    }
    this.engine = null;
  }
}
