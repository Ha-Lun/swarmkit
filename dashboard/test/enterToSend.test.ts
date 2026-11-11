// Tests for the Enter-to-send pure helpers (keydown + beforeinput paths).
import { describe, expect, it } from 'vitest';
import { isLineBreakInput, isSendKey } from '../src/client/enterToSend.ts';

describe('isSendKey', () => {
  it('sends on plain Enter', () => {
    expect(isSendKey({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
  });
  it('does not send on Shift+Enter (newline instead)', () => {
    expect(isSendKey({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
  });
  it('does not send while IME composing', () => {
    expect(isSendKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
  });
  it('does not send for Unidentified IME keys', () => {
    expect(isSendKey({ key: 'Unidentified', shiftKey: false, isComposing: false })).toBe(false);
  });
  it('does not send for other keys', () => {
    expect(isSendKey({ key: 'a', shiftKey: false, isComposing: false })).toBe(false);
    expect(isSendKey({ key: 'Tab', shiftKey: false, isComposing: false })).toBe(false);
    expect(isSendKey({ key: 'Escape', shiftKey: false, isComposing: false })).toBe(false);
  });
});

describe('isLineBreakInput', () => {
  it('sends on insertLineBreak without Shift', () => {
    expect(isLineBreakInput('insertLineBreak', false)).toBe(true);
  });
  it('sends on insertParagraph without Shift', () => {
    expect(isLineBreakInput('insertParagraph', false)).toBe(true);
  });
  it('does not send when Shift is held', () => {
    expect(isLineBreakInput('insertLineBreak', true)).toBe(false);
    expect(isLineBreakInput('insertParagraph', true)).toBe(false);
  });
  it('ignores other input types', () => {
    expect(isLineBreakInput('insertText', false)).toBe(false);
    expect(isLineBreakInput('insertFromPaste', false)).toBe(false);
    expect(isLineBreakInput('insertCompositionText', false)).toBe(false);
    expect(isLineBreakInput('deleteContentBackward', false)).toBe(false);
    expect(isLineBreakInput('', false)).toBe(false);
  });
});
