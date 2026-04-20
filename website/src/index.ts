import { LANDING_HTML } from './landing';
import { INSTALL_SH } from './install-script';

const CLI_UA = /(curl|wget|fetch|httpie|libcurl)/i;

export default {
  async fetch(req: Request): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }

    // UA-sniff: CLI fetchers get the bash installer so `curl agents-cli.sh | sh`
    // keeps working. Browsers and everything else get the HTML landing. Accept
    // header acts as a tiebreaker when a CLI tool explicitly asks for HTML
    // (e.g. a headless browser wrapping curl).
    const ua = req.headers.get('user-agent') ?? '';
    const accept = (req.headers.get('accept') ?? '').toLowerCase();
    const wantsScript = CLI_UA.test(ua) && !accept.startsWith('text/html');

    const body = wantsScript ? INSTALL_SH : LANDING_HTML;
    const contentType = wantsScript
      ? 'text/plain; charset=utf-8'
      : 'text/html; charset=utf-8';

    const headers = {
      'content-type': contentType,
      'cache-control': 'public, max-age=300',
    };

    if (req.method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }

    return new Response(body, { status: 200, headers });
  },
};
