import { performance } from 'perf_hooks';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDB, getScanStampsForPaths } from '../src/lib/session/db.js';
import { getAgentSessionDirs } from '../src/lib/session/discover.js';

const HOME = os.homedir();

function t<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const r = fn();
  console.log(`${(performance.now() - t0).toFixed(0)}ms  ${label}`);
  return r;
}

getDB();

// Mimic scanGeminiIncremental enumeration
const gPaths: Array<{ filePath: string; hashDir: string }> = [];
t('enumerate gemini files', () => {
  for (const tmpDir of getAgentSessionDirs('gemini', 'tmp')) {
    let hashDirs: string[];
    try {
      hashDirs = fs.readdirSync(tmpDir);
    } catch {
      continue;
    }
    for (const hashDir of hashDirs) {
      const chatsDir = path.join(tmpDir, hashDir, 'chats');
      if (!fs.existsSync(chatsDir)) continue;
      let chatFiles: string[];
      try {
        chatFiles = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const file of chatFiles) {
        gPaths.push({ filePath: path.join(chatsDir, file), hashDir });
      }
    }
  }
});
console.log('  gemini files:', gPaths.length);

const stamps = t('bulk ledger lookup', () => getScanStampsForPaths(gPaths.map(g => g.filePath)));
console.log('  stamps found:', stamps.size);

let changed = 0;
let unchanged = 0;
t('stat+compare all gemini', () => {
  for (const { filePath } of gPaths) {
    try {
      const stat = fs.statSync(filePath);
      const scan = { fileMtimeMs: Math.floor(stat.mtimeMs), fileSize: stat.size };
      const prev = stamps.get(filePath);
      if (prev && prev.fileMtimeMs === scan.fileMtimeMs && prev.fileSize === scan.fileSize) unchanged++;
      else changed++;
    } catch {}
  }
});
console.log(`  gemini changed=${changed} unchanged=${unchanged}`);

// Same for OpenCode
console.log('---');
const OPENCODE_DB = path.join(HOME, '.local', 'share', 'opencode', 'opencode.db');
const stat = fs.statSync(OPENCODE_DB);
console.log('opencode.db mtime:', stat.mtimeMs, 'size:', stat.size);
const openStamps = getScanStampsForPaths([OPENCODE_DB]);
console.log('opencode stamp:', openStamps.get(OPENCODE_DB));
