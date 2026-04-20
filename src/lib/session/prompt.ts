const WHOLE_MESSAGE_SKIP_PATTERNS = [
  /<permissions instructions>/i,
  /<collaboration_mode>/i,
  /^# AGENTS\.md instructions for\b/im,
  /<local-command-caveat>/i,
];

const NOISE_LINE_PATTERNS = [
  /^(cwd|shell|current_date|timezone|os|platform|arch|home|user)\b\s*:/i,
  /^\/[\w/.-]+$/,
  /^(bash|zsh|fish|sh|dash)$/i,
  /^\d{4}-\d{2}-\d{2}$/,
  /^[A-Z][A-Za-z]+\/[A-Z][\w+-]+$/,
  /^Caveat:/i,
];

const LOCAL_COMMAND_PREFIX = '<local-command-caveat>';

// Prefix prepended to every Claude-in-plan-mode team spawn prompt.
// Ends at a blank line before the real user task.
export const HEADLESS_PLAN_MODE_PREFIX = 'You are running in HEADLESS PLAN MODE.';

export function cleanSessionPrompt(raw: string): string {
  let text = raw.replace(/\r/g, '').trim();
  if (!text) return '';

  text = text.replace(/<\/?[a-z_]+>/gi, '');

  const meaningful = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !NOISE_LINE_PATTERNS.some(pattern => pattern.test(line)));

  return meaningful.join('\n').trim();
}

export function extractSessionTopic(raw: string): string | undefined {
  if (!raw.trim()) return undefined;

  // Strip the HEADLESS PLAN MODE header so team sessions show their real task.
  // The header ends at the first blank line (\n\n) before the actual prompt.
  let text = raw;
  if (text.trimStart().startsWith(HEADLESS_PLAN_MODE_PREFIX)) {
    const blankLine = text.indexOf('\n\n');
    if (blankLine === -1) return undefined;
    text = text.slice(blankLine + 2);
  }

  if (WHOLE_MESSAGE_SKIP_PATTERNS.some(pattern => pattern.test(text))) {
    return undefined;
  }

  const cleaned = cleanSessionPrompt(text);
  if (!cleaned) return undefined;
  if (WHOLE_MESSAGE_SKIP_PATTERNS.some(pattern => pattern.test(cleaned))) {
    return undefined;
  }

  const firstLine = cleaned.split('\n').map(line => line.trim()).find(Boolean);
  return firstLine || undefined;
}
