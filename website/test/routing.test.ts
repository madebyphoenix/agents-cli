import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { LANDING_HTML } from '../src/landing';
import { INSTALL_SH } from '../src/install-script';

const req = (headers: Record<string, string> = {}, method = 'GET') =>
  new Request('https://agents-cli.sh/', { method, headers });

async function fetchWith(headers: Record<string, string> = {}, method = 'GET') {
  // Workers runtime signature — env + ctx aren't used by this worker.
  return worker.fetch(req(headers, method), {} as any, {} as any);
}

describe('UA-sniff routing', () => {
  it('curl UA → plain-text install script', async () => {
    const res = await fetchWith({ 'user-agent': 'curl/8.4.0' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(INSTALL_SH);
  });

  it('wget UA → plain-text install script', async () => {
    const res = await fetchWith({ 'user-agent': 'Wget/1.21.4' });
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(INSTALL_SH);
  });

  it('browser UA → HTML landing', async () => {
    const res = await fetchWith({
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 Chrome/120.0',
      accept: 'text/html,application/xhtml+xml',
    });
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe(LANDING_HTML);
  });

  it('empty UA → HTML landing (safer default)', async () => {
    const res = await fetchWith({});
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('link-preview bot (Slackbot) → HTML landing', async () => {
    const res = await fetchWith({
      'user-agent': 'Slackbot-LinkExpanding 1.0',
      accept: 'text/html',
    });
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('curl with Accept: text/html → HTML landing (Accept overrides)', async () => {
    // Rare but legitimate — someone wrapping curl in a headless flow.
    const res = await fetchWith({
      'user-agent': 'curl/8.4.0',
      accept: 'text/html,*/*',
    });
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('HEAD request → headers only, empty body', async () => {
    const res = await fetchWith({ 'user-agent': 'curl/8.4.0' }, 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('');
  });

  it('OPTIONS request → 204 no body', async () => {
    const res = await fetchWith({}, 'OPTIONS');
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });
});
