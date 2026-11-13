/**
 * Mode-0600 file-backed secret store (`~/.minibook/secrets.json`, `ARCHITECTURE.md` §7.1, §13).
 *
 * Secrets (such as OpenAI-compatible API keys) are never returned to the web layer and
 * never stored in SQLite settings. They are substituted server-side into outbound headers
 * via `{{secret:<name>}}` placeholders.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MiniBookError } from '@minibook/core';

const SECRET_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const SECRET_PLACEHOLDER_RE = /\{\{secret:([a-zA-Z0-9._-]{1,64})\}\}/g;

export function assertValidSecretName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) {
    throw new MiniBookError('invalid-argument', `Invalid secret name: ${name}`);
  }
}

export class FileSecretStore {
  private readonly filePath: string;
  private cache: Record<string, string> | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'secrets.json');
  }

  private loadMap(): Record<string, string> {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.filePath)) {
      this.cache = {};
      return this.cache;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      const out: Record<string, string> = {};
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v.length > 0) {
            out[k] = v;
          }
        }
      }
      this.cache = out;
      return out;
    } catch {
      this.cache = {};
      return this.cache;
    }
  }

  private persist(map: Record<string, string>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    const payload = Buffer.from(JSON.stringify(map, null, 2), 'utf8');
    const fd = openSync(tmpPath, 'w', 0o600);
    try {
      writeSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // ignore on platforms without POSIX mode bits
    }
  }

  set(name: string, value: string | null): void {
    assertValidSecretName(name);
    const map = { ...this.loadMap() };
    if (value === null || value.length === 0) {
      delete map[name];
    } else {
      map[name] = value;
    }
    this.cache = map;
    this.persist(map);
  }

  has(name: string): boolean {
    assertValidSecretName(name);
    const val = this.loadMap()[name];
    return typeof val === 'string' && val.length > 0;
  }

  getRaw(name: string): string | null {
    assertValidSecretName(name);
    return this.loadMap()[name] ?? null;
  }

  substituteHeaders(
    headers: Readonly<Record<string, string>> | undefined,
  ): Record<string, string> {
    if (!headers) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      out[key] = value.replace(SECRET_PLACEHOLDER_RE, (_full, secretName: string) => {
        const resolved = this.getRaw(secretName);
        if (!resolved) {
          throw new MiniBookError('speech-auth', `Missing secret "${secretName}" for speech request`);
        }
        return resolved;
      });
    }
    return out;
  }
}
