// Enter-to-send shared by every message box (composer, continue, start prompts).
// Two paths: a React keydown fast-path, plus a native `beforeinput` listener that
// catches Android IMEs (Gboard/SwiftKey) where Enter arrives as key 'Unidentified' /
// keyCode 229 or while isComposing, surfacing only as insertLineBreak/insertParagraph.
// Shift+Enter always inserts a newline. The keydown path preventDefaults, so the
// browser never emits beforeinput afterwards — no double-send.
import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent, RefObject } from 'react';

export interface SendKeyState {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}

/** Pure: does this keydown mean "send"? Plain Enter outside IME composition. */
export function isSendKey({ key, shiftKey, isComposing }: SendKeyState): boolean {
  return key === 'Enter' && !shiftKey && !isComposing;
}

/** Pure: does this beforeinput event mean "send"? A line-break insert without Shift. */
export function isLineBreakInput(inputType: string, shiftHeld: boolean): boolean {
  return (inputType === 'insertLineBreak' || inputType === 'insertParagraph') && !shiftHeld;
}

export interface EnterToSendOptions {
  /**
   * Return false to let the key/beforeinput through untouched — e.g. while the
   * slash-command menu is open so Enter picks the highlighted command instead.
   */
  shouldSend?: () => boolean;
}

/**
 * Wire Enter-to-send onto a textarea. Returns `onKeyDown` for the React keydown
 * path (true when it consumed the key); the beforeinput path installs itself in
 * an effect. `onSend` is read through a ref so the effect never re-binds.
 */
export function useEnterToSend(
  ref: RefObject<HTMLTextAreaElement | null>,
  onSend: () => void,
  opts?: EnterToSendOptions,
): { onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean } {
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  const guardRef = useRef(opts?.shouldSend);
  guardRef.current = opts?.shouldSend;

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!isSendKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) {
      return false;
    }
    if (guardRef.current && !guardRef.current()) return false;
    e.preventDefault();
    sendRef.current();
    return true;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Shift state for the beforeinput path (InputEvent carries no shiftKey).
    let shiftHeld = false;
    const onNativeKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Shift') shiftHeld = true;
    };
    const onNativeKeyUp = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Shift') shiftHeld = false;
    };
    const onBlur = () => {
      shiftHeld = false;
    };
    const onBeforeInput = (e: Event) => {
      if (!isLineBreakInput((e as InputEvent).inputType, shiftHeld)) return;
      if (guardRef.current && !guardRef.current()) return;
      e.preventDefault();
      sendRef.current();
    };
    el.addEventListener('keydown', onNativeKeyDown);
    el.addEventListener('keyup', onNativeKeyUp);
    el.addEventListener('blur', onBlur);
    el.addEventListener('beforeinput', onBeforeInput);
    return () => {
      el.removeEventListener('keydown', onNativeKeyDown);
      el.removeEventListener('keyup', onNativeKeyUp);
      el.removeEventListener('blur', onBlur);
      el.removeEventListener('beforeinput', onBeforeInput);
    };
  }, [ref]);

  return { onKeyDown };
}
