import { describe, expect, it } from 'vitest';
import { extractSessionTopic } from '../prompt.js';

describe('extractSessionTopic', () => {
  it('strips the HEADLESS PLAN MODE prefix and summary suffix', () => {
    const raw = `You are running in HEADLESS PLAN MODE. This mode works like normal plan mode with one exception: you cannot write to ~/.claude/plans/ directory. Instead of writing a plan file, output your complete plan/response as your final message.

Build the auth refactor

When you're done, provide a brief summary of:
1. What you did (1-2 sentences)
2. Key files modified and why`;
    expect(extractSessionTopic(raw)).toBe('Build the auth refactor');
  });

  it('returns undefined when the wrapper has no inner prompt', () => {
    const raw = `You are running in HEADLESS PLAN MODE. This mode works like normal plan mode...

When you're done, provide a brief summary of:`;
    expect(extractSessionTopic(raw)).toBeUndefined();
  });

  it('skips slash-command invocation messages so the topic falls through to the next message', () => {
    const raw = `<command-message>continue</command-message>
<command-name>/continue</command-name>
<command-args>some context dump</command-args>`;
    expect(extractSessionTopic(raw)).toBeUndefined();
  });

  it('strips hyphenated XML-ish tags but keeps the surrounding text', () => {
    expect(extractSessionTopic('<inline-tag>fix the bug</inline-tag>')).toBe('fix the bug');
  });

  it('returns the first meaningful line of an ordinary prompt', () => {
    expect(extractSessionTopic('  Refactor the picker\nDetails follow...  ')).toBe('Refactor the picker');
  });
});
