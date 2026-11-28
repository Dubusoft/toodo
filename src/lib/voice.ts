/**
 * Voice input for the chat: the browser's Web Speech API turns what the person says into text
 * that joins their draft, driving Astryx's `ChatDictationButton`. Chrome has it on desktop and
 * Android; where the browser has none, `isSupported` is false and the chat shows no microphone.
 * Chrome recognizes speech on a server, so voice input needs a connection; the text it gives is
 * sent like a typed message, through the chat outbox (see `chat-outbox.ts`).
 *
 * Recognition is the only thing that opens the microphone. Astryx's `useSpeechRecognition` also
 * opens it with `getUserMedia` to draw a level meter, and on Android, where the microphone serves
 * one capture at a time, that second capture leaves recognition hearing nothing; so the meter
 * stays at rest here.
 *
 * Once the person stops speaking, the chat can send what they said by itself: after
 * `silenceMs` without speech it counts down `countdownSeconds` seconds, during which more
 * speech or a cancel keeps the draft unsent. A setting per device turns this off.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import type { UseSpeechRecognitionReturn } from "@astryxdesign/core/Chat";
import { en, type Messages } from "@/locales/en";

/** The part of the Web Speech API's `SpeechRecognition` used here; TypeScript's DOM types lack it. */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onnomatch: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

type RecognitionConstructor = new () => Recognition;

/** The browser's speech recognition, under its standard or its prefixed name, if it has one. */
function recognitionConstructor(): RecognitionConstructor | undefined {
  const scope = window as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/** Whether this browser has speech recognition, so voice input and its settings apply. */
export function voiceInputSupported(): boolean {
  return recognitionConstructor() !== undefined;
}

/**
 * How long the person stays silent after a phrase before the countdown starts. Chrome finishes a
 * phrase after a short pause, so a pause inside a sentence ends well within this.
 */
const silenceMs = 1500;
/** The countdown shown before a dictated message goes out, in seconds. */
const countdownSeconds = 2;

const autoSendKey = "toodo-voice-auto-send";
const autoSendListeners = new Set<() => void>();

/** Whether dictated messages send themselves after a silence on this device; on unless turned off. */
function getVoiceAutoSend(): boolean {
  return localStorage.getItem(autoSendKey) !== "off";
}

export function setVoiceAutoSend(on: boolean) {
  if (on) localStorage.removeItem(autoSendKey);
  else localStorage.setItem(autoSendKey, "off");
  autoSendListeners.forEach((listener) => listener());
}

function subscribeAutoSend(listener: () => void) {
  autoSendListeners.add(listener);
  return () => autoSendListeners.delete(listener);
}

export function useVoiceAutoSend(): boolean {
  return useSyncExternalStore(subscribeAutoSend, getVoiceAutoSend);
}

/** The level meter's bands, at rest: measuring them would take the microphone from recognition. */
const restingBands: number[] = [0, 0, 0, 0, 0];

/** `spoken` added to the end of `draft`, with a space between them unless one is there. */
export function appendSpoken(draft: string, spoken: string): string {
  const words = spoken.trim();
  if (words === "") return draft;
  return draft === "" || /\s$/.test(draft) ? draft + words : `${draft} ${words}`;
}

/** What to tell the person when recognition fails, from its error code; nothing for a stop they asked for. */
export function voiceErrorMessage(error: string, m: Messages = en): string | null {
  switch (error) {
    case "aborted":
      return null;
    case "no-speech":
      return m.chat.voiceErrors.noSpeech;
    case "not-allowed":
    case "service-not-allowed":
      return m.chat.voiceErrors.blockedMicrophone;
    case "audio-capture":
      return m.chat.voiceErrors.missingMicrophone;
    case "network":
      return m.chat.voiceErrors.network;
    case "language-not-supported":
      return m.chat.voiceErrors.unsupportedLanguage(navigator.language);
    default:
      return m.chat.voiceErrors.stopped(error);
  }
}

/** Whether the device has no microphone at all; when that cannot be read, it counts as having one. */
async function lacksMicrophone(): Promise<boolean> {
  if (navigator.mediaDevices?.enumerateDevices === undefined) return false;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return !devices.some((device) => device.kind === "audioinput");
  } catch {
    // The device list is only a hint here: without it, the browser's own code stands.
    return false;
  }
}

/** Chrome reports `not-allowed` for both a missing microphone and a blocked one. */
async function recognitionErrorCode(error: string): Promise<string | null> {
  if (error === "aborted") return null;
  return error === "not-allowed" && (await lacksMicrophone()) ? "audio-capture" : error;
}

export async function recognitionErrorMessage(error: string, m: Messages = en): Promise<string | null> {
  const code = await recognitionErrorCode(error);
  return code === null ? null : voiceErrorMessage(code, m);
}

/**
 * Voice input into a draft, in the browser's language: each phrase recognized in full is added
 * to the end of it. `error` tells why the last attempt failed, until the next one starts.
 *
 * With auto-send on, `send` is called once the person has been silent for `silenceMs` and a
 * countdown of `countdownSeconds` ran out; `countdown` is the seconds left while it runs.
 * More speech starts the wait over, and `cancelAutoSend` stops listening and keeps the draft.
 * Stopping the microphone by hand never sends.
 */
export function useVoiceInput(
  setDraft: Dispatch<SetStateAction<string>>,
  m: Messages,
  send: () => void,
): {
  speech: UseSpeechRecognitionReturn;
  error: string | null;
  countdown: number | null;
  cancelAutoSend: () => void;
} {
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [isListening, setListening] = useState(false);
  const [isSpeaking, setSpeaking] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  // The recognition in progress; one that a newer one replaced no longer changes the state.
  const current = useRef<Recognition | null>(null);
  // Counts the attempts, so a message worked out for an earlier one never replaces a later one's.
  const attempt = useRef(0);
  const Recognition = recognitionConstructor();
  const autoSend = useVoiceAutoSend();
  const [countdown, setCountdown] = useState<number | null>(null);
  // Whether the draft holds dictated text that has not been sent or cancelled yet.
  const dictated = useRef(false);
  // The silence wait or the countdown's next tick, whichever runs.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestSend = useRef(send);
  latestSend.current = send;
  const latestAutoSend = useRef(autoSend);
  latestAutoSend.current = autoSend;

  const clearPending = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    setCountdown(null);
  };
  const tick = (left: number) => {
    if (left === 0) {
      timer.current = null;
      setCountdown(null);
      dictated.current = false;
      latestSend.current();
      return;
    }
    setCountdown(left);
    timer.current = setTimeout(() => tick(left - 1), 1000);
  };
  const startCountdown = () => {
    clearPending();
    if (latestAutoSend.current && dictated.current) tick(countdownSeconds);
  };
  const waitForSilence = () => {
    clearPending();
    if (latestAutoSend.current && dictated.current) timer.current = setTimeout(startCountdown, silenceMs);
  };
  /** Forgets the dictated text's pending send, without touching recognition. */
  const forget = () => {
    dictated.current = false;
    clearPending();
  };

  useEffect(() => {
    if (!autoSend) forget();
  }, [autoSend]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      current.current?.abort();
    },
    [],
  );

  const fail = (code: string) => {
    const failed = attempt.current;
    void recognitionErrorCode(code).then((error) => {
      if (attempt.current === failed) setErrorCode(error);
    });
  };

  const start = () => {
    if (Recognition === undefined) return;
    current.current?.abort();
    const recognition = new Recognition();
    recognition.lang = navigator.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onstart = () => {
      attempt.current += 1;
      setErrorCode(null);
      setListening(true);
    };
    recognition.onend = () => {
      if (current.current !== recognition) return;
      current.current = null;
      setListening(false);
      setSpeaking(false);
      setInterimTranscript("");
      // The browser stopped listening by itself, as Android does after a silence: no more speech can come.
      startCountdown();
    };
    recognition.onspeechstart = () => setSpeaking(true);
    recognition.onspeechend = () => setSpeaking(false);
    recognition.onresult = ({ resultIndex, results }) => {
      let interim = "";
      for (let index = resultIndex; index < results.length; index++) {
        const result = results[index];
        const spoken = result[0].transcript;
        // One recognition event can finish several phrases, so each builds on the draft before it.
        if (result.isFinal) {
          setDraft((draft) => appendSpoken(draft, spoken));
          if (spoken.trim() !== "") dictated.current = true;
        } else interim += spoken;
      }
      setInterimTranscript(interim);
      // A phrase still being heard holds the send; the silence counts from the last finished one.
      if (interim.trim() === "") waitForSilence();
      else clearPending();
    };
    recognition.onerror = ({ error: code }) => fail(code);
    recognition.onnomatch = () => fail("no-speech");
    current.current = recognition;
    recognition.start();
  };
  // Ending recognition by hand, or for a sent message, forgets the pending send first, so its end sends nothing.
  const stop = () => {
    forget();
    current.current?.stop();
  };
  const abort = () => {
    forget();
    current.current?.abort();
  };

  const speech: UseSpeechRecognitionReturn = {
    isSupported: Recognition !== undefined,
    isListening,
    isSpeaking,
    volume: 0,
    bands: restingBands,
    rawBands: restingBands,
    interimTranscript,
    start,
    stop,
    abort,
    toggle: () => (isListening ? stop() : start()),
  };
  return {
    speech,
    error: errorCode === null ? null : voiceErrorMessage(errorCode, m),
    countdown,
    cancelAutoSend: stop,
  };
}
