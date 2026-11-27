/**
 * Voice input for the chat: the browser's Web Speech API, through Astryx's
 * `useSpeechRecognition`, turns what the person says into text that joins their draft. Chrome
 * has it on desktop and Android; where the browser has none, `isSupported` is false and the
 * chat shows no microphone. Chrome recognizes speech on a server, so voice input needs a
 * connection; the text it gives is sent like a typed message, through the chat outbox (see
 * `chat-outbox.ts`).
 */
import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useSpeechRecognition, type UseSpeechRecognitionReturn } from "@astryxdesign/core/Chat";

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
  // Counts the attempts, so a message worked out for an earlier one never replaces a later one's.
  const attempt = useRef(0);
  const speech = useSpeechRecognition({
    lang: navigator.language,
    onStart: () => {
      attempt.current += 1;
      setError(null);
    },
    // One recognition event can finish several phrases, so each builds on the draft before it.
    onResult: (spoken) => setDraft((draft) => appendSpoken(draft, spoken)),
    onError: ({ error: code }) => {
      const failed = attempt.current;
      void recognitionErrorMessage(code).then((message) => {
        if (attempt.current === failed) setError(message);
      });
    },
  });
  return { speech, error };
}
