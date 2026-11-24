// Web Speech API dictation hook and mic button for prompt composers.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './dictation.css';

export interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionResultEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionResultEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor: SpeechRecognitionCtor | undefined = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  return typeof ctor === 'function' ? ctor : null;
}

function mapSpeechError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone blocked';
    case 'audio-capture':
      return 'No microphone';
    case 'network':
      return 'Speech service unreachable';
    case 'no-speech':
      return 'No speech heard';
    case 'aborted':
      return '';
    default:
      return 'Dictation failed';
  }
}

/** Append a dictated chunk to `text`, inserting a single space unless `text` is empty or ends with whitespace. */
export function appendTranscript(text: string, chunk: string): string {
  const trimmed = chunk.trim();
  if (!trimmed) return text;
  if (text === '' || /\s$/.test(text)) return `${text}${trimmed}`;
  return `${text} ${trimmed}`;
}

/** Extract newly finalized transcripts starting at `resultIndex`, recording emitted indices to avoid duplicates. */
export function finalChunks(
  results: ArrayLike<SpeechRecognitionResultLike>,
  resultIndex: number,
  emitted: Set<number>,
): string[] {
  const out: string[] = [];
  for (let i = Math.max(0, resultIndex); i < results.length; i++) {
    const entry = results[i];
    if (!entry?.isFinal || emitted.has(i)) continue;
    emitted.add(i);
    if (entry[0]) out.push(entry[0].transcript);
  }
  return out;
}

/** Speech-to-text dictation controller backed by the browser's Web Speech API. */
export function useDictation(onFinal: (chunk: string) => void) {
  const supported = getSpeechRecognitionCtor() !== null;
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const listeningRef = useRef(false);
  listeningRef.current = listening;
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  const abort = useCallback(() => {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        // ignore if already stopped
      }
    }
    listeningRef.current = false;
    setListening(false);
  }, []);

  useEffect(() => abort, [abort]);

  const toggle = useCallback(() => {
    if (listeningRef.current) {
      const rec = recRef.current;
      if (rec) {
        try {
          rec.stop();
        } catch {
          recRef.current = null;
          listeningRef.current = false;
          setListening(false);
        }
      } else {
        listeningRef.current = false;
        setListening(false);
      }
      return;
    }

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;

    abort();
    setError(null);

    const rec = new Ctor();
    rec.lang = typeof navigator !== 'undefined' ? navigator.language : '';
    rec.continuous = true;
    rec.interimResults = false;

    const emitted = new Set<number>();
    rec.onresult = (ev) => {
      if (recRef.current !== rec) return;
      for (const chunk of finalChunks(ev.results, ev.resultIndex, emitted)) {
        onFinalRef.current(chunk);
      }
    };
    rec.onerror = (ev) => {
      if (recRef.current !== rec) return;
      const msg = mapSpeechError(ev.error);
      if (msg) setError(msg);
    };
    rec.onend = () => {
      if (recRef.current !== rec) return;
      recRef.current = null;
      listeningRef.current = false;
      setListening(false);
    };

    recRef.current = rec;
    listeningRef.current = true;
    setListening(true);
    try {
      rec.start();
    } catch (err) {
      if (recRef.current === rec) {
        recRef.current = null;
        listeningRef.current = false;
        setListening(false);
        setError(err instanceof Error && err.name === 'NotAllowedError' ? 'Microphone blocked' : 'Dictation failed');
      }
    }
  }, [abort]);

  return useMemo(
    () => ({ supported, listening, error, toggle, abort }),
    [supported, listening, error, toggle, abort],
  );
}

function MicIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3M8.5 21h7" />
    </svg>
  );
}

/** Microphone toggle button for prompt composers; hidden when Web Speech API is unavailable. */
export function MicButton({ dictation, disabled }: { dictation: ReturnType<typeof useDictation>; disabled?: boolean }) {
  useEffect(() => {
    if (disabled && dictation.listening) dictation.abort();
  }, [disabled, dictation.listening, dictation.abort]);

  if (!dictation.supported) return null;

  const label = dictation.listening ? 'Stop dictation' : 'Dictate';
  return (
    <>
      <button
        type="button"
        className={dictation.listening ? 'dictate-btn is-listening' : 'dictate-btn'}
        aria-pressed={dictation.listening}
        aria-label={label}
        title={dictation.error || label}
        disabled={disabled}
        onClick={dictation.toggle}
      >
        <MicIcon />
      </button>
      <span className={dictation.error ? 'dictate-error' : 'sr-only'} aria-live="polite">
        {dictation.error ?? ''}
      </span>
    </>
  );
}
