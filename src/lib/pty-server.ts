/**
 * PTY Sidecar Server
 *
 * Lightweight unix socket server that manages persistent PTY sessions.
 * Started as a detached process by `agents pty` commands. Sessions survive
 * across multiple CLI invocations. Each session holds a real PTY (via node-pty)
 * and a headless terminal emulator (via @xterm/headless) for screen rendering.
 *
 * Protocol: newline-delimited JSON over ~/.agents/pty.sock
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getAgentsDir } from './state.js';

// --- Constants ---

const SENTINEL = '__AGENTS_PTY_DONE__';
const SOCKET_NAME = 'pty.sock';
const PID_FILE = 'pty.pid';
const LOG_FILE = 'pty.log';
const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 min
const SERVER_IDLE_MS = 60 * 60 * 1000;  // 1 hour

// --- Types ---

interface Session {
  id: string;
  pty: any;
  terminal: any;
  rows: number;
  cols: number;
  shell: string;
  cwd: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  pendingOutput: string;
  appActive: boolean;
  activeCommand: string;
  exited: boolean;
  exitCode: number | null;
}

// --- Path helpers ---

export function getSocketPath(): string {
  return path.join(getAgentsDir(), SOCKET_NAME);
}

export function getPtyPidPath(): string {
  return path.join(getAgentsDir(), PID_FILE);
}

export function getPtyLogPath(): string {
  return path.join(getAgentsDir(), LOG_FILE);
}

export function isPtyServerRunning(): boolean {
  const pidPath = getPtyPidPath();
  if (!fs.existsSync(pidPath)) return false;
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    try { fs.unlinkSync(pidPath); } catch {}
    return false;
  }
}

// --- Logging ---

function log(level: string, message: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(getPtyLogPath(), line, 'utf-8');
  } catch {}
}

// --- Server ---

export async function runPtyServer(): Promise<void> {
  // Dynamic imports for optional native deps
  let nodePty: any;
  let XtermTerminal: any;

  try {
    nodePty = await import('node-pty');
    // Handle ESM default export
    if (nodePty.default?.spawn) nodePty = nodePty.default;

    // Ensure spawn-helper is executable (bun install doesn't set +x on prebuilds)
    try {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const ptyBase = path.resolve(__dirname, '..', '..', 'node_modules', 'node-pty');
      const helpers = [
        path.join(ptyBase, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
        path.join(ptyBase, 'build', 'Release', 'spawn-helper'),
      ];
      for (const h of helpers) {
        if (fs.existsSync(h)) {
          fs.chmodSync(h, 0o755);
        }
      }
    } catch {}
  } catch (err) {
    console.error('node-pty is required for PTY support.');
    console.error('Install: cd ' + getAgentsDir() + '/../agents-cli && bun add node-pty');
    process.exit(1);
  }

  try {
    const xterm = await import('@xterm/headless');
    // Handle ESM default export wrapping
    XtermTerminal = (xterm as any).Terminal || (xterm as any).default?.Terminal;
  } catch {
    console.error('@xterm/headless is required for PTY support.');
    console.error('Install: cd ' + getAgentsDir() + '/../agents-cli && bun add @xterm/headless');
    process.exit(1);
  }

  const sessions = new Map<string, Session>();
  const socketPath = getSocketPath();

  // Remove stale socket
  if (fs.existsSync(socketPath)) {
    try { fs.unlinkSync(socketPath); } catch {}
  }

  let lastActivityTime = Date.now();

  function generateId(): string {
    return crypto.randomBytes(4).toString('hex');
  }

  function killSession(session: Session): void {
    if (!session.exited) {
      try {
        session.pty.kill();
      } catch {}
      session.exited = true;
    }
    if (session.terminal) {
      try { session.terminal.dispose(); } catch {}
    }
  }

  function getScreenLines(session: Session): string[] {
    const lines: string[] = [];
    const buf = session.terminal.buffer.active;
    for (let y = 0; y < session.rows; y++) {
      const line = buf.getLine(y);
      const text = line ? line.translateToString(true) : '';
      // Strip lines containing the sentinel pattern
      if (text.includes(SENTINEL)) continue;
      lines.push(text);
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines;
  }

  // Session idle cleanup + server auto-exit
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_IDLE_MS) {
        log('INFO', `Cleaning up idle session ${id}`);
        killSession(session);
        sessions.delete(id);
      }
    }
    if (sessions.size === 0 && now - lastActivityTime > SERVER_IDLE_MS) {
      log('INFO', 'No sessions, server idle timeout reached. Shutting down.');
      shutdown();
    }
  }, 60_000);

  // --- Request handlers ---

  async function handleRequest(req: any): Promise<any> {
    lastActivityTime = Date.now();

    switch (req.action) {
      case 'start': {
        const rows = req.params?.rows || 24;
        const cols = req.params?.cols || 120;
        const shell = req.params?.shell || process.env.SHELL || 'zsh';
        const cwd = req.params?.cwd || process.env.HOME || '/';
        const id = generateId();

        let ptyProcess: any;
        try {
          ptyProcess = nodePty.spawn(shell, [], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env: { ...process.env } as Record<string, string>,
          });
        } catch (err: any) {
          return { ok: false, error: `Failed to spawn PTY: ${err.message}` };
        }

        const terminal = new XtermTerminal({ rows, cols, allowProposedApi: true });

        const session: Session = {
          id,
          pty: ptyProcess,
          terminal,
          rows,
          cols,
          shell,
          cwd,
          pid: ptyProcess.pid,
          startedAt: Date.now(),
          lastActivity: Date.now(),
          pendingOutput: '',
          appActive: false,
          activeCommand: '',
          exited: false,
          exitCode: null,
        };

        ptyProcess.onData((data: string) => {
          session.pendingOutput += data;
          terminal.write(data);
          session.lastActivity = Date.now();

          // Check for sentinel to detect command completion
          if (session.appActive && session.pendingOutput.includes(SENTINEL + ':')) {
            session.appActive = false;
            session.activeCommand = '';
          }
        });

        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          session.exited = true;
          session.exitCode = exitCode;
          session.appActive = false;
        });

        // Wait for shell to initialize, then clear init output
        await new Promise(r => setTimeout(r, 300));
        session.pendingOutput = '';

        sessions.set(id, session);
        log('INFO', `Session started: ${id} (pid=${ptyProcess.pid}, shell=${shell}, ${cols}x${rows})`);

        return { ok: true, id, pid: ptyProcess.pid, rows, cols, shell };
      }

      case 'exec': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };
        if (session.exited) return { ok: false, error: 'Session has exited' };
        if (session.appActive) {
          return { ok: false, error: `Command already active: ${session.activeCommand}. Use write to interact or signal to interrupt.` };
        }

        const command = req.params?.command;
        if (!command) return { ok: false, error: 'command is required' };

        session.appActive = true;
        session.activeCommand = command;
        session.pendingOutput = '';

        session.pty.write(`${command}; echo "${SENTINEL}:$?"\n`);
        session.lastActivity = Date.now();

        return { ok: true, submitted: true };
      }

      case 'read': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };

        const waitMs = Math.min(Math.max(req.params?.ms || 100, 50), 5000);

        // Wait for output to accumulate
        if (session.pendingOutput.length === 0) {
          await new Promise(r => setTimeout(r, waitMs));
        }

        const output = session.pendingOutput;
        session.pendingOutput = '';

        // Strip sentinel lines from output
        const cleaned = output
          .split('\n')
          .filter(line => !line.includes(SENTINEL))
          .join('\n');

        return {
          ok: true,
          output: cleaned,
          bytes: output.length,
          app_active: session.appActive,
          active_command: session.activeCommand || undefined,
          exited: session.exited,
          exit_code: session.exitCode,
        };
      }

      case 'write': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };
        if (session.exited) return { ok: false, error: 'Session has exited' };

        let input = req.params?.input ?? '';
        if (input === '') input = '\n';

        session.pty.write(input);
        session.lastActivity = Date.now();

        return { ok: true };
      }

      case 'screen': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };

        const lines = getScreenLines(session);
        const buf = session.terminal.buffer.active;

        return {
          ok: true,
          screen: lines.join('\n'),
          rows: session.rows,
          cols: session.cols,
          cursor: { x: buf.cursorX, y: buf.cursorY },
          app_active: session.appActive,
          active_command: session.activeCommand || undefined,
          exited: session.exited,
        };
      }

      case 'signal': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };
        if (session.exited) return { ok: false, error: 'Session has exited' };

        const sig = (req.params?.signal || 'INT').toUpperCase();
        if (!['INT', 'TERM', 'KILL', 'HUP'].includes(sig)) {
          return { ok: false, error: `Unsupported signal: ${sig}` };
        }

        try {
          // node-pty kill accepts signal number; use process.kill for named signals
          process.kill(session.pid, `SIG${sig}` as NodeJS.Signals);
        } catch (err: any) {
          return { ok: false, error: `Failed to send signal: ${err.message}` };
        }

        return { ok: true };
      }

      case 'resize': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };
        if (session.exited) return { ok: false, error: 'Session has exited' };

        const rows = req.params?.rows || session.rows;
        const cols = req.params?.cols || session.cols;

        session.pty.resize(cols, rows);
        session.terminal.resize(cols, rows);
        session.rows = rows;
        session.cols = cols;

        return { ok: true, rows, cols };
      }

      case 'list': {
        const list = [];
        for (const [, session] of sessions) {
          list.push({
            id: session.id,
            pid: session.pid,
            shell: session.shell,
            cwd: session.cwd,
            rows: session.rows,
            cols: session.cols,
            started_at: session.startedAt,
            last_activity: session.lastActivity,
            app_active: session.appActive,
            active_command: session.activeCommand || undefined,
            exited: session.exited,
            exit_code: session.exitCode,
          });
        }
        return { ok: true, sessions: list };
      }

      case 'stop': {
        const session = sessions.get(req.id);
        if (!session) return { ok: false, error: `Session not found: ${req.id}` };

        killSession(session);
        sessions.delete(req.id);
        log('INFO', `Session stopped: ${req.id}`);

        return { ok: true };
      }

      case 'ping': {
        return { ok: true, sessions: sessions.size, pid: process.pid };
      }

      default:
        return { ok: false, error: `Unknown action: ${req.action}` };
    }
  }

  // --- Socket server ---

  const server = net.createServer((conn) => {
    let buf = '';

    conn.on('data', async (chunk) => {
      buf += chunk.toString();
      const nlIndex = buf.indexOf('\n');
      if (nlIndex === -1) return;

      const line = buf.slice(0, nlIndex);
      buf = '';

      try {
        const req = JSON.parse(line);
        const res = await handleRequest(req);
        conn.write(JSON.stringify(res) + '\n');
      } catch (err: any) {
        conn.write(JSON.stringify({ ok: false, error: err.message || String(err) }) + '\n');
      }

      conn.end();
    });

    conn.on('error', () => {});
  });

  await new Promise<void>((resolve) => {
    server.listen(socketPath, () => resolve());
  });

  // Write PID
  fs.writeFileSync(getPtyPidPath(), String(process.pid), 'utf-8');
  log('INFO', `PTY server started (PID: ${process.pid}, socket: ${socketPath})`);

  // Shutdown handler
  function shutdown(): void {
    log('INFO', 'PTY server shutting down');
    for (const session of sessions.values()) {
      killSession(session);
    }
    sessions.clear();
    clearInterval(cleanupInterval);
    server.close();
    try { fs.unlinkSync(socketPath); } catch {}
    try { fs.unlinkSync(getPtyPidPath()); } catch {}
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Keep alive
  await new Promise(() => {});
}
