/**
 * STT configuration for the coordinator.
 * Maps to @magi/common SttConfig shape.
 */
export interface SttConfig {
  enabled: boolean;
  engine: 'google-cloud-stt' | 'whisper' | 'gemini';
  googleCloud: {
    projectId: string;
    keyFile: string;
    model: string;
    languageCode: string;
    enableAutomaticPunctuation: boolean;
    sampleRateHertz: number;
    streamRotationMinutes: number;
    streamOverlapSeconds: number;
    phraseHints: string[];
  };
  diarization: {
    minSpeakers: number;
    maxSpeakers: number;
  };
  silenceTimeoutSeconds: number;
  connectionCooldownSeconds: number;
  whisper: {
    modelPath: string;
    language: string;
  };
  costWarningPerSessionUsd: number;
  maxConcurrentStreams: number;
  interimThrottlePerSecond: number;
}

export function defaultSttConfig(): SttConfig {
  return {
    enabled: false,
    engine: 'google-cloud-stt',
    googleCloud: {
      projectId: '',
      keyFile: '',
      model: 'latest_long',
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
      sampleRateHertz: 16000,
      streamRotationMinutes: 4,
      streamOverlapSeconds: 2,
      phraseHints: [],
    },
    diarization: {
      minSpeakers: 1,
      maxSpeakers: 1,
    },
    silenceTimeoutSeconds: 30,
    connectionCooldownSeconds: 5,
    whisper: {
      modelPath: '',
      language: 'en',
    },
    costWarningPerSessionUsd: 1.0,
    maxConcurrentStreams: 4,
    interimThrottlePerSecond: 5,
  };
}
