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
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { UseSpeechRecognitionReturn } from "@astryxdesign/core/Chat";

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

/** The level meter's bands, at rest: measuring them would take the microphone from recognition. */
const restingBands: number[] = [0, 0, 0, 0, 0];

/** `spoken` added to the end of `draft`, with a space between them unless one is there. */
export function appendSpoken(draft: string, spoken: string): string {
  const words = spoken.trim();
  if (words === "") return draft;
  return draft === "" || /\s$/.test(draft) ? draft + words : `${draft} ${words}`;
}

/** What to tell the person when recognition fails, from its error code; nothing for a stop they asked for. */
export function voiceErrorMessage(error: string): string | null {
  switch (error) {
    case "aborted":
      return null;
    case "no-speech":
      return "No speech was heard. Try again closer to the microphone.";
    case "not-allowed":
    case "service-not-allowed":
      return "The browser blocked the microphone. Allow it for this site to use voice input.";
    case "audio-capture":
      return "No microphone was found on this device. Connect one to use voice input.";
    case "network":
      return "Voice input needs a connection to the browser's speech service.";
    case "language-not-supported":
      return `Voice input does not support ${navigator.language}.`;
    default:
      return `Voice input stopped (${error}).`;
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

/**
 * `voiceErrorMessage` for a failed recognition, after telling a missing microphone from a
 * blocked one: Chrome reports `not-allowed` for both, with no permission prompt to answer.
 */
export async function recognitionErrorMessage(error: string): Promise<string | null> {
  if (error === "not-allowed" && (await lacksMicrophone())) return voiceErrorMessage("audio-capture");
  return voiceErrorMessage(error);
}

/**
 * Voice input into a draft, in the browser's language: each phrase recognized in full is added
 * to the end of it. `error` tells why the last attempt failed, until the next one starts.
 */
export function useVoiceInput(setDraft: Dispatch<SetStateAction<string>>): {
  speech: UseSpeechRecognitionReturn;
  error: string | null;
} {
  const [error, setError] = useState<string | null>(null);
  const [isListening, setListening] = useState(false);
  const [isSpeaking, setSpeaking] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  // The recognition in progress; one that a newer one replaced no longer changes the state.
  const current = useRef<Recognition | null>(null);
  // Counts the attempts, so a message worked out for an earlier one never replaces a later one's.
  const attempt = useRef(0);
  const Recognition = recognitionConstructor();

  useEffect(() => () => current.current?.abort(), []);

  const fail = (code: string) => {
    const failed = attempt.current;
    void recognitionErrorMessage(code).then((message) => {
      if (attempt.current === failed) setError(message);
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
      setError(null);
      setListening(true);
    };
    recognition.onend = () => {
      if (current.current !== recognition) return;
      current.current = null;
      setListening(false);
      setSpeaking(false);
      setInterimTranscript("");
    };
    recognition.onspeechstart = () => setSpeaking(true);
    recognition.onspeechend = () => setSpeaking(false);
    recognition.onresult = ({ resultIndex, results }) => {
      let interim = "";
      for (let index = resultIndex; index < results.length; index++) {
        const result = results[index];
        const spoken = result[0].transcript;
        // One recognition event can finish several phrases, so each builds on the draft before it.
        if (result.isFinal) setDraft((draft) => appendSpoken(draft, spoken));
        else interim += spoken;
      }
      setInterimTranscript(interim);
    };
    recognition.onerror = ({ error: code }) => fail(code);
    recognition.onnomatch = () => fail("no-speech");
    current.current = recognition;
    recognition.start();
  };
  const stop = () => current.current?.stop();
  const abort = () => current.current?.abort();

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
  return { speech, error };
}
