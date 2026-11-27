/**
 * Voice input for the chat: the browser's Web Speech API, through Astryx's
 * `useSpeechRecognition`, turns what the person says into text that joins their draft. Chrome
 * has it on desktop and Android; where the browser has none, `isSupported` is false and the
 * chat shows no microphone. Chrome recognizes speech on a server, so voice input needs a
 * connection; the text it gives is sent like a typed message, through the chat outbox (see
 * `chat-outbox.ts`).
 */
import { useState, type Dispatch, type SetStateAction } from "react";
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
      return "No microphone was found.";
    case "network":
      return "Voice input needs a connection to the browser's speech service.";
    case "language-not-supported":
      return `Voice input does not support ${navigator.language}.`;
    default:
      return `Voice input stopped (${error}).`;
  }
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
  const speech = useSpeechRecognition({
    lang: navigator.language,
    onStart: () => setError(null),
    // One recognition event can finish several phrases, so each builds on the draft before it.
    onResult: (spoken) => setDraft((draft) => appendSpoken(draft, spoken)),
    onError: ({ error: code }) => setError(voiceErrorMessage(code)),
  });
  return { speech, error };
}
