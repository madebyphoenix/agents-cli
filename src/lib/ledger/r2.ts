/**
 * R2 (S3-compatible) Ledger implementation.
 *
 * Layout mirrors LocalDiskLedger — objects are keyed as:
 *   teams/<team_id>/registry.json
 *   teams/<team_id>/team.md
 *   teams/<team_id>/sessions/<task_id>-<teammate>.jsonl
 *   teams/<team_id>/artifacts/<task_id>/<filename>
 *   teams/<team_id>/bugs/<task_id>.md
 *
 * Credentials come from the AGENTS_R2_* env vars (or `agents.yaml.ledger`
 * when we add that later). Two patterns are supported:
 *
 *   1. Cloudflare R2:  set endpoint to https://<account>.r2.cloudflarestorage.com
 *                       and AGENTS_R2_ACCESS_KEY_ID / AGENTS_R2_SECRET_ACCESS_KEY.
 *   2. Plain S3:       omit endpoint; region picks up from AGENTS_R2_REGION.
 *
 * The ledger degrades gracefully: `resolveLedger()` only returns an R2Ledger
 * when credentials + bucket are present. Otherwise it falls back to
 * LocalDiskLedger so non-cloud workflows never touch the network.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import type {
  ArtifactKind,
  LedgerArtifact,
  LedgerRegistry,
  LedgerSearchHit,
  LedgerStore,
  LedgerTaskView,
} from './types.js';

function artifactFilename(kind: ArtifactKind): string {
  switch (kind) {
    case 'diff': return 'diff.patch';
    case 'test-output': return 'test-output.txt';
    case 'notes': return 'notes.md';
    default: return `${String(kind)}.txt`;
  }
}

function kindFromFilename(filename: string): ArtifactKind {
  if (filename === 'diff.patch') return 'diff';
  if (filename === 'test-output.txt') return 'test-output';
  if (filename === 'notes.md') return 'notes';
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

export interface R2LedgerConfig {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Prefix inside the bucket (defaults to ""). Useful for per-env scoping. */
  prefix?: string;
}

/**
 * Read R2 config from environment. Returns null when required fields are
 * missing so `resolveLedger()` can fall back to local disk without crashing.
 *
 * Required: AGENTS_R2_BUCKET. Optional: endpoint, region, access key pair.
 */
export function r2ConfigFromEnv(): R2LedgerConfig | null {
  const bucket = process.env.AGENTS_R2_BUCKET?.trim();
  if (!bucket) return null;
  return {
    bucket,
    endpoint: process.env.AGENTS_R2_ENDPOINT?.trim() || undefined,
    region: process.env.AGENTS_R2_REGION?.trim() || 'auto',
    accessKeyId: process.env.AGENTS_R2_ACCESS_KEY_ID?.trim() || undefined,
    secretAccessKey: process.env.AGENTS_R2_SECRET_ACCESS_KEY?.trim() || undefined,
    prefix: process.env.AGENTS_R2_PREFIX?.trim() || '',
  };
}

export class R2Ledger implements LedgerStore {
  readonly kind = 'r2' as const;
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(config: R2LedgerConfig) {
    this.bucket = config.bucket;
    this.prefix = (config.prefix ?? '').replace(/^\/+|\/+$/g, '');

    const clientConfig: S3ClientConfig = {
      region: config.region ?? 'auto',
      forcePathStyle: true,  // R2 and most S3-compatible stores need this
    };
    if (config.endpoint) clientConfig.endpoint = config.endpoint;
    if (config.accessKeyId && config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      };
    }
    this.client = new S3Client(clientConfig);
  }

  private key(...parts: string[]): string {
    const joined = parts.filter(Boolean).join('/').replace(/\/+/g, '/');
    return this.prefix ? `${this.prefix}/${joined}` : joined;
  }

  private teamKey(team_id: string, ...rest: string[]): string {
    return this.key('teams', team_id, ...rest);
  }

  private async putText(key: string, content: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentType: 'text/plain; charset=utf-8',
      })
    );
  }

  private async getText(key: string): Promise<{ content: string; lastModified: string } | null> {
    try {
      const r = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      );
      const content = await r.Body?.transformToString('utf-8') ?? '';
      const lastModified = r.LastModified?.toISOString() ?? new Date().toISOString();
      return { content, lastModified };
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NoSuchKey') return null;
      throw err;
    }
  }

  private async listKeys(prefix: string): Promise<Array<{ key: string; lastModified: string }>> {
    const out: Array<{ key: string; lastModified: string }> = [];
    let continuationToken: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const obj of r.Contents ?? []) {
        if (obj.Key) {
          out.push({
            key: obj.Key,
            lastModified: obj.LastModified?.toISOString() ?? new Date().toISOString(),
          });
        }
      }
      continuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (continuationToken);
    return out;
  }

  private async appendText(key: string, chunk: string): Promise<void> {
    // S3 has no native append; read-modify-write is the canonical workaround
    // and fine for small artifacts like notes.md and session jsonl lines.
    const existing = (await this.getText(key))?.content ?? '';
    await this.putText(key, existing + chunk);
  }

  async putArtifact(
    team_id: string,
    task_id: string,
    kind: ArtifactKind,
    content: string,
    _teammate?: string
  ): Promise<void> {
    if (kind === 'bug') {
      await this.putText(this.teamKey(team_id, 'bugs', `${task_id}.md`), content);
      return;
    }
    await this.putText(
      this.teamKey(team_id, 'artifacts', task_id, artifactFilename(kind)),
      content
    );
  }

  async appendSession(
    team_id: string,
    task_id: string,
    teammate: string,
    line: string
  ): Promise<void> {
    const safe = teammate.replace(/[/\\]/g, '_');
    const key = this.teamKey(team_id, 'sessions', `${task_id}-${safe}.jsonl`);
    await this.appendText(key, line.endsWith('\n') ? line : line + '\n');
  }

  async putRegistry(registry: LedgerRegistry): Promise<void> {
    await this.putText(
      this.teamKey(registry.team_id, 'registry.json'),
      JSON.stringify(registry, null, 2)
    );
  }

  async getRegistry(team_id: string): Promise<LedgerRegistry | null> {
    const got = await this.getText(this.teamKey(team_id, 'registry.json'));
    if (!got) return null;
    try { return JSON.parse(got.content) as LedgerRegistry; } catch { return null; }
  }

  async appendNarrative(team_id: string, text: string): Promise<void> {
    await this.appendText(
      this.teamKey(team_id, 'team.md'),
      text.endsWith('\n') ? text : text + '\n'
    );
  }

  async getNarrative(team_id: string): Promise<string | null> {
    const got = await this.getText(this.teamKey(team_id, 'team.md'));
    return got?.content ?? null;
  }

  async note(
    team_id: string,
    task_id: string,
    teammate: string,
    text: string
  ): Promise<void> {
    const key = this.teamKey(team_id, 'artifacts', task_id, 'notes.md');
    const ts = new Date().toISOString();
    const entry = `\n### ${ts} — ${teammate}\n\n${text.endsWith('\n') ? text : text + '\n'}`;
    await this.appendText(key, entry);
  }

  async read(
    team_id: string,
    task_id: string,
    kind?: ArtifactKind
  ): Promise<LedgerTaskView> {
    const artifacts: LedgerArtifact[] = [];

    if (kind && kind !== 'session' && kind !== 'bug') {
      const key = this.teamKey(team_id, 'artifacts', task_id, artifactFilename(kind));
      const got = await this.getText(key);
      if (got) {
        artifacts.push({
          team_id, task_id, kind, content: got.content,
          created_at: got.lastModified, updated_at: got.lastModified,
        });
      }
    } else if (kind === 'bug') {
      const key = this.teamKey(team_id, 'bugs', `${task_id}.md`);
      const got = await this.getText(key);
      if (got) {
        artifacts.push({
          team_id, task_id, kind: 'bug', content: got.content,
          created_at: got.lastModified, updated_at: got.lastModified,
        });
      }
    } else if (kind === 'session') {
      const prefix = this.teamKey(team_id, 'sessions') + '/';
      for (const { key, lastModified } of await this.listKeys(prefix)) {
        const name = key.slice(prefix.length);
        if (!name.startsWith(`${task_id}-`) || !name.endsWith('.jsonl')) continue;
        const got = await this.getText(key);
        const teammate = name.slice(task_id.length + 1, -'.jsonl'.length);
        artifacts.push({
          team_id, task_id, teammate, kind: 'session',
          content: got?.content ?? '',
          created_at: lastModified, updated_at: lastModified,
        });
      }
    } else {
      // No kind — gather everything for the task.
      const artPrefix = this.teamKey(team_id, 'artifacts', task_id) + '/';
      for (const { key, lastModified } of await this.listKeys(artPrefix)) {
        const name = key.slice(artPrefix.length);
        const got = await this.getText(key);
        artifacts.push({
          team_id, task_id, kind: kindFromFilename(name),
          content: got?.content ?? '',
          created_at: lastModified, updated_at: lastModified,
        });
      }
      const sessionPrefix = this.teamKey(team_id, 'sessions') + '/';
      for (const { key, lastModified } of await this.listKeys(sessionPrefix)) {
        const name = key.slice(sessionPrefix.length);
        if (!name.startsWith(`${task_id}-`) || !name.endsWith('.jsonl')) continue;
        const got = await this.getText(key);
        const teammate = name.slice(task_id.length + 1, -'.jsonl'.length);
        artifacts.push({
          team_id, task_id, teammate, kind: 'session',
          content: got?.content ?? '',
          created_at: lastModified, updated_at: lastModified,
        });
      }
      const bugKey = this.teamKey(team_id, 'bugs', `${task_id}.md`);
      const bug = await this.getText(bugKey);
      if (bug) {
        artifacts.push({
          team_id, task_id, kind: 'bug', content: bug.content,
          created_at: bug.lastModified, updated_at: bug.lastModified,
        });
      }
    }

    const reg = await this.getRegistry(team_id);
    const entry = reg?.teammates.find((t) => t.agent_id === task_id);
    return {
      team_id, task_id,
      teammate: entry?.name ?? null,
      task_type: entry?.task_type ?? null,
      status: entry?.status ?? null,
      artifacts,
      completed_at: entry?.completed_at ?? null,
    };
  }

  async recent(team_id: string, n: number = 5): Promise<LedgerTaskView[]> {
    const reg = await this.getRegistry(team_id);
    if (!reg) return [];
    const done = reg.teammates
      .filter((t) => t.status === 'completed' || t.status === 'failed')
      .sort((a, b) => {
        const at = a.completed_at ?? a.started_at;
        const bt = b.completed_at ?? b.started_at;
        return new Date(bt).getTime() - new Date(at).getTime();
      })
      .slice(0, n);
    const views: LedgerTaskView[] = [];
    for (const t of done) views.push(await this.read(team_id, t.agent_id));
    return views;
  }

  async search(
    team_id: string,
    query: string,
    limit: number = 50
  ): Promise<LedgerSearchHit[]> {
    const hits: LedgerSearchHit[] = [];
    const needle = query.toLowerCase();
    const teamPrefix = this.teamKey(team_id) + '/';
    for (const { key } of await this.listKeys(teamPrefix)) {
      if (hits.length >= limit) break;
      const got = await this.getText(key);
      if (!got) continue;
      const lines = got.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= limit) break;
        if (!lines[i].toLowerCase().includes(needle)) continue;
        // Infer metadata from the key shape.
        const rel = key.slice(teamPrefix.length);
        let kind: ArtifactKind = 'narrative';
        let task_id = '_team';
        let teammate: string | null = null;
        if (rel.startsWith('sessions/') && rel.endsWith('.jsonl')) {
          kind = 'session';
          const name = rel.slice('sessions/'.length, -'.jsonl'.length);
          const dash = name.lastIndexOf('-');
          if (dash > 0) {
            task_id = name.slice(0, dash);
            teammate = name.slice(dash + 1);
          } else {
            task_id = name;
          }
        } else if (rel.startsWith('artifacts/')) {
          const parts = rel.split('/');
          task_id = parts[1] ?? '_';
          kind = kindFromFilename(parts[2] ?? '');
        } else if (rel.startsWith('bugs/') && rel.endsWith('.md')) {
          kind = 'bug';
          task_id = rel.slice('bugs/'.length, -'.md'.length);
        } else if (rel === 'team.md') {
          kind = 'narrative';
          task_id = '_team';
        } else if (rel === 'registry.json') {
          continue; // skip registry — not meaningful for text search
        }
        hits.push({
          team_id, task_id, teammate, kind,
          line_number: i + 1,
          line: lines[i].slice(0, 500),
          path: key,
        });
      }
    }
    return hits.slice(0, limit);
  }
}
