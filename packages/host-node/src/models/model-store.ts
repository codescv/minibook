/**
 * Server-side on-device neural model downloader & storage manager (`TTS_V2_SPEC.md` §3.3, §5.1).
 *
 * Manages `<dataDir>/models/kokoro-v1.1-zh/` with:
 *   - CN-resilient mirror ordering & automatic fallback (`huggingface.co` <-> `hf-mirror.com` / custom)
 *   - Manual redirect follower (<= 5 hops, HTTPS-only, strict host suffix allow-list)
 *   - HTTP 206 Range `.part` pause/resume, 200-ignored-Range & 416 recovery
 *   - Streaming SHA-256 verification against `KOKORO_MANIFEST` (with 1 clean mirror-rotated retry)
 *   - Atomic `installed.json` persistence & startup reconciliation
 *   - Throttled (`<= 1/s`) `speech-model` SSE status events
 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import {
  KOKORO_DEFAULT_VOICES,
  KOKORO_MANIFEST,
  KOKORO_MODEL_ID,
  KOKORO_VOICE_IDS,
  MiniBookError,
  buildModelResolveUrl,
  isAllowedModelRedirectUrl,
  isSafeManifestRelativePath,
  resolveAllowedModelHosts,
  resolveManifestFilesForVariant,
  resolveModelSources,
  totalManifestBytesForVariant,
  type AppSettings,
  type HostEvent,
  type KokoroManifestFile,
  type MiniBookErrorShape,
  type ModelDownloadSource,
  type ResolvedKokoroDownloadFile,
  type SpeechModelBackend,
  type SpeechModelId,
  type SpeechModelState,
  type SpeechModelStatus,
  type SpeechModelVariant,
} from '@minibook/core';

const FSYNC_INTERVAL_BYTES = 8 * 1024 * 1024;
const MIN_FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 5;
const PROGRESS_EMIT_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000] as const;

const KNOWN_ONNX_MANIFEST_PATHS = new Set<string>([
  KOKORO_MANIFEST.onnx.models.fp32.path,
  KOKORO_MANIFEST.onnx.models.q8.path,
  ...KOKORO_MANIFEST.onnx.voices.map((v) => v.path),
]);

interface InstalledMetadata {
  readonly revision: string;
  readonly variant: SpeechModelVariant;
  readonly files: readonly KokoroManifestFile[];
  readonly voices: readonly string[];
  readonly installedAt: number;
  readonly source?: string;
}

export interface ModelStoreOptions {
  readonly dataDir: string;
  readonly getSettings: () => AppSettings;
  readonly emit: (event: HostEvent) => void;
  readonly fetchImpl?: typeof fetch;
  readonly retryDelaysMs?: readonly number[];
  readonly connectTimeoutMs?: number;
  readonly firstByteTimeoutMs?: number;
  readonly stallTimeoutMs?: number;
  readonly minFreeMarginBytes?: number;
  readonly getFreeBytesImpl?: (dir: string) => number | null;
  readonly now?: () => number;
  /** Test-only: allows local HTTP fixture servers & custom localhost allow-list in Vitest. */
  readonly allowInsecureHttpForTests?: boolean;
  readonly extraAllowedHostsForTests?: readonly string[];
  readonly resolveFilesForTests?: (
    variant: SpeechModelVariant,
    voices: readonly string[],
  ) => ResolvedKokoroDownloadFile[];
  readonly sourcesOverrideForTests?: readonly string[];
  readonly sourceEnvForTests?: { readonly timeZone?: string; readonly locale?: string };
}

function defaultGetFreeBytes(dir: string): number | null {
  try {
    mkdirSync(dir, { recursive: true });
    const st = statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

function writeAtomicJson(targetPath: string, data: unknown): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmpPath, 'w', 0o644);
  try {
    writeSync(fd, JSON.stringify(data, null, 2), 0, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, targetPath);
}

function sumDirectoryBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.includes('.tmp.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += sumDirectoryBytes(full);
    } else if (entry.isFile()) {
      try {
        total += statSync(full).size;
      } catch {
        // ignore concurrent deletion
      }
    }
  }
  return total;
}

async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (err) => rejectPromise(err));
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

function parseContentRange(
  header: string | null,
): { readonly start: number; readonly end: number; readonly total: number | null } | null {
  if (!header) return null;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!m) return null;
  const start = Number.parseInt(m[1]!, 10);
  const end = Number.parseInt(m[2]!, 10);
  const total = m[3] === '*' ? null : Number.parseInt(m[3]!, 10);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if (total !== null && !Number.isFinite(total)) return null;
  return { start, end, total };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolvePromise, rejectPromise) => {
    if (signal.aborted) {
      rejectPromise(new MiniBookError('cancelled', 'Download aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(new MiniBookError('cancelled', 'Download aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class ModelStore {
  private readonly modelsRoot: string;
  private readonly kokoroRoot: string;
  private readonly getSettings: () => AppSettings;
  private readonly emitEvent: (event: HostEvent) => void;
  private readonly fetchFn: typeof fetch;
  private readonly retryDelaysMs: readonly number[];
  private readonly firstByteTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  private readonly minFreeMarginBytes: number;
  private readonly getFreeBytes: (dir: string) => number | null;
  private readonly now: () => number;
  private readonly allowInsecureHttpForTests: boolean;
  private readonly extraAllowedHostsForTests: readonly string[];
  private readonly resolveFilesForTests:
    | ((variant: SpeechModelVariant, voices: readonly string[]) => ResolvedKokoroDownloadFile[])
    | undefined;
  private readonly sourcesOverrideForTests: readonly string[] | undefined;
  private readonly sourceEnvForTests:
    | { readonly timeZone?: string; readonly locale?: string }
    | undefined;

  private statusState: SpeechModelStatus;
  private activeAbort: AbortController | null = null;
  private activeJobPromise: Promise<void> | null = null;
  private jobGeneration = 0;
  private pauseRequested = false;
  private lastProgressEmitMs = 0;
  private lastEmittedState: SpeechModelState | null = null;
  private lastEmittedSource: string | undefined = undefined;
  private lastGoodSource: string | null = null;
  private activeSources: string[] = [];
  private activeVariant: SpeechModelVariant = 'onnx-fp32';
  private requestedVoices = new Set<string>();

  constructor(options: ModelStoreOptions) {
    this.modelsRoot = resolve(options.dataDir, 'models');
    this.kokoroRoot = join(this.modelsRoot, KOKORO_MODEL_ID);
    this.getSettings = options.getSettings;
    this.emitEvent = options.emit;
    this.fetchFn = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.firstByteTimeoutMs = options.firstByteTimeoutMs ?? Math.max(8_000, options.connectTimeoutMs ?? 15_000);
    this.stallTimeoutMs = options.stallTimeoutMs ?? 20_000;
    this.minFreeMarginBytes = options.minFreeMarginBytes ?? MIN_FREE_SPACE_MARGIN_BYTES;
    this.getFreeBytes = options.getFreeBytesImpl ?? defaultGetFreeBytes;
    this.now = options.now ?? Date.now;
    this.allowInsecureHttpForTests = options.allowInsecureHttpForTests ?? false;
    this.extraAllowedHostsForTests = options.extraAllowedHostsForTests ?? [];
    this.resolveFilesForTests = options.resolveFilesForTests;
    this.sourcesOverrideForTests = options.sourcesOverrideForTests;
    this.sourceEnvForTests = options.sourceEnvForTests;

    this.statusState = this.reconcileFromDisk();
  }

  private assertSupportedModelId(id: SpeechModelId): void {
    if (id !== KOKORO_MODEL_ID) {
      throw new MiniBookError('invalid-argument', `Unsupported speech model id: ${String(id)}`);
    }
  }

  private detectInstalledVoicesOnDisk(): string[] {
    const out: string[] = [];
    for (const voiceId of KOKORO_VOICE_IDS) {
      const voiceFile = KOKORO_MANIFEST.onnx.voices.find((v) => v.path === `voices/${voiceId}.bin`);
      if (!voiceFile) continue;
      const p = join(this.kokoroRoot, voiceFile.path);
      if (existsSync(p)) {
        try {
          if (statSync(p).size === voiceFile.size) {
            out.push(voiceId);
          }
        } catch {
          // ignore
        }
      }
    }
    return out;
  }

  private readInstalledMetadata(): InstalledMetadata | null {
    const metaPath = join(this.kokoroRoot, 'installed.json');
    if (!existsSync(metaPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as Partial<InstalledMetadata>;
      if (
        !parsed ||
        typeof parsed.revision !== 'string' ||
        (parsed.variant !== 'onnx-fp32' && parsed.variant !== 'onnx-q8') ||
        !Array.isArray(parsed.files) ||
        !Array.isArray(parsed.voices)
      ) {
        return null;
      }
      if (parsed.revision !== KOKORO_MANIFEST.onnx.revision) {
        return null;
      }
      for (const f of parsed.files) {
        if (!f || typeof f.path !== 'string' || typeof f.size !== 'number') return null;
        if (!isSafeManifestRelativePath(f.path)) return null;
        const full = resolve(this.kokoroRoot, f.path);
        if (!full.startsWith(this.kokoroRoot + sep) || !existsSync(full)) return null;
        if (statSync(full).size !== f.size) return null;
      }
      return parsed as InstalledMetadata;
    } catch {
      return null;
    }
  }

  private reconcileFromDisk(): SpeechModelStatus {
    const meta = this.readInstalledMetadata();
    if (meta) {
      const installedBytes = meta.files.reduce((sum, f) => sum + f.size, 0);
      return {
        id: KOKORO_MODEL_ID,
        state: 'ready',
        variant: meta.variant,
        bytesDone: installedBytes,
        bytesTotal: installedBytes,
        installedBytes,
        installedVoices: [...meta.voices],
        ...(meta.source ? { source: meta.source } : {}),
      };
    }

    const diskBytes = sumDirectoryBytes(this.kokoroRoot);
    const installedVoices = this.detectInstalledVoicesOnDisk();
    const defaultVariant: SpeechModelVariant = 'onnx-fp32';
    const expectedVoices =
      installedVoices.length > 0 ? installedVoices : [...KOKORO_DEFAULT_VOICES];
    const bytesTotal = totalManifestBytesForVariant(defaultVariant, expectedVoices);

    if (diskBytes > 0) {
      return {
        id: KOKORO_MODEL_ID,
        state: 'paused',
        variant: defaultVariant,
        bytesDone: Math.min(diskBytes, bytesTotal),
        bytesTotal,
        installedBytes: 0,
        installedVoices,
      };
    }

    return {
      id: KOKORO_MODEL_ID,
      state: 'absent',
      variant: defaultVariant,
      bytesDone: 0,
      bytesTotal,
      installedBytes: 0,
      installedVoices: [],
    };
  }

  totalBytes(): number {
    return sumDirectoryBytes(this.modelsRoot);
  }

  status(id: SpeechModelId): SpeechModelStatus {
    this.assertSupportedModelId(id);
    return this.statusState;
  }

  updateRuntimeTelemetry(
    id: SpeechModelId,
    telemetry: {
      readonly backend?: SpeechModelBackend;
      readonly rtf?: number;
      readonly error?: MiniBookErrorShape;
    },
  ): SpeechModelStatus {
    this.assertSupportedModelId(id);
    this.statusState = {
      ...this.statusState,
      ...(telemetry.backend !== undefined ? { backend: telemetry.backend } : {}),
      ...(telemetry.rtf !== undefined ? { rtf: telemetry.rtf } : {}),
      ...(telemetry.error !== undefined ? { state: 'error', error: telemetry.error } : {}),
    };
    this.emitStatusImmediate();
    return this.statusState;
  }

  resolveModelFilePath(id: SpeechModelId, relPath: string): string | null {
    this.assertSupportedModelId(id);
    const cleanRel = relPath.replace(/^\/+/, '');
    if (!isSafeManifestRelativePath(cleanRel)) return null;
    if (!KNOWN_ONNX_MANIFEST_PATHS.has(cleanRel)) return null;
    const candidate = resolve(this.kokoroRoot, cleanRel);
    if (!candidate.startsWith(this.kokoroRoot + sep)) return null;
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      return null;
    }
    return null;
  }

  private resolveTargetFiles(
    variant: SpeechModelVariant,
    voices: readonly string[],
  ): ResolvedKokoroDownloadFile[] {
    return this.resolveFilesForTests
      ? this.resolveFilesForTests(variant, voices)
      : resolveManifestFilesForVariant(variant, voices);
  }

  private static sourcesEqual(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  private static hostnameForUrl(base: string | undefined): string | undefined {
    if (!base) return undefined;
    try {
      const host = new URL(base).hostname;
      return host || undefined;
    } catch {
      return undefined;
    }
  }

  private resolveSourcesAndAllowHosts(opts?: {
    readonly source?: ModelDownloadSource;
    readonly mirrorBaseUrl?: string | null;
  }): { readonly sources: string[]; readonly allowHosts: string[] } {
    const settings = this.getSettings();
    const effectiveSettings = {
      modelDownloadSource: opts?.source ?? settings.modelDownloadSource,
      modelMirrorBaseUrl:
        opts?.mirrorBaseUrl !== undefined ? opts.mirrorBaseUrl : settings.modelMirrorBaseUrl,
    };
    let sources = this.sourcesOverrideForTests
      ? [...this.sourcesOverrideForTests]
      : resolveModelSources(effectiveSettings, this.sourceEnvForTests);
    if (
      !this.sourcesOverrideForTests &&
      this.allowInsecureHttpForTests &&
      effectiveSettings.modelMirrorBaseUrl
    ) {
      const custom = effectiveSettings.modelMirrorBaseUrl.trim().replace(/\/+$/, '');
      if (/^http:\/\//i.test(custom) && !sources.includes(custom)) {
        sources = [custom, ...sources];
      }
    }
    const allowHosts = [
      ...resolveAllowedModelHosts(effectiveSettings.modelMirrorBaseUrl),
      ...this.extraAllowedHostsForTests,
    ];
    if (this.allowInsecureHttpForTests && effectiveSettings.modelMirrorBaseUrl) {
      try {
        const h = new URL(effectiveSettings.modelMirrorBaseUrl).hostname.toLowerCase();
        if (h && !allowHosts.includes(h)) allowHosts.push(h);
      } catch {
        // ignore
      }
    }
    return { sources, allowHosts };
  }

  async download(
    id: SpeechModelId,
    opts?: {
      readonly variant?: SpeechModelVariant;
      readonly voices?: readonly string[];
      readonly source?: ModelDownloadSource;
      readonly mirrorBaseUrl?: string | null;
    },
  ): Promise<SpeechModelStatus> {
    this.assertSupportedModelId(id);
    const variant: SpeechModelVariant = opts?.variant === 'onnx-q8' ? 'onnx-q8' : 'onnx-fp32';
    const { sources, allowHosts } = this.resolveSourcesAndAllowHosts(opts);

    const existingVoices = this.detectInstalledVoicesOnDisk();
    const voiceSet = new Set<string>(existingVoices);
    const requested = opts?.voices && opts.voices.length > 0 ? opts.voices : KOKORO_DEFAULT_VOICES;
    for (const v of requested) {
      if (KOKORO_VOICE_IDS.includes(v)) {
        voiceSet.add(v);
      }
    }

    const sourcesChanged = !ModelStore.sourcesEqual(sources, this.activeSources);
    let myGen: number | null = null;

    if (this.activeJobPromise && (this.statusState.state === 'downloading' || this.statusState.state === 'verifying')) {
      for (const v of voiceSet) {
        this.requestedVoices.add(v);
      }
      if (!sourcesChanged && variant === this.activeVariant) {
        return this.statusState;
      }
      // Sources (or variant) changed while active: interrupt current HTTP transfer, clear incompatible lastGoodSource,
      // and launch a new generation from sources[0] while keeping verified files and `.part` progress.
      myGen = ++this.jobGeneration;
      this.pauseRequested = false;
      this.activeAbort?.abort();
      this.activeAbort = null;
      const prevJob = this.activeJobPromise;
      this.activeJobPromise = null;
      await prevJob.catch(() => undefined);
      if (this.jobGeneration !== myGen || this.pauseRequested) {
        return this.statusState;
      }
      for (const v of this.requestedVoices) {
        voiceSet.add(v);
      }
    }

    if (sourcesChanged || (this.lastGoodSource && !sources.includes(this.lastGoodSource))) {
      this.lastGoodSource = null;
    }

    this.requestedVoices = voiceSet;
    const targetVoices = [...this.requestedVoices];
    const files = this.resolveTargetFiles(variant, targetVoices);
    const bytesTotal = files.reduce((s, f) => s + f.size, 0);

    // Check remaining bytes & free disk space (`TTS_V2_SPEC.md` §3.3)
    let bytesDone = 0;
    let remainingBytes = 0;
    for (const f of files) {
      const finalPath = join(this.kokoroRoot, f.path);
      const partPath = `${finalPath}.part`;
      if (existsSync(finalPath) && statSync(finalPath).size === f.size) {
        bytesDone += f.size;
      } else if (existsSync(partPath)) {
        const partSize = statSync(partPath).size;
        if (partSize <= f.size) {
          bytesDone += partSize;
          remainingBytes += f.size - partSize;
        } else {
          remainingBytes += f.size;
        }
      } else {
        remainingBytes += f.size;
      }
    }

    const freeBytes = this.getFreeBytes(this.kokoroRoot);
    if (freeBytes !== null && freeBytes < remainingBytes + this.minFreeMarginBytes) {
      this.statusState = {
        id: KOKORO_MODEL_ID,
        state: 'error',
        variant,
        bytesDone,
        bytesTotal,
        installedBytes: this.statusState.installedBytes,
        installedVoices: existingVoices,
        error: {
          code: 'storage-full',
          message: `Insufficient storage: need ${Math.ceil((remainingBytes + this.minFreeMarginBytes) / (1024 * 1024))} MiB free`,
        },
      };
      this.emitStatusImmediate();
      return this.statusState;
    }

    this.pauseRequested = false;
    if (myGen === null) {
      myGen = ++this.jobGeneration;
    }
    const gen = myGen;
    const controller = new AbortController();
    this.activeAbort = controller;
    this.activeSources = [...sources];
    this.activeVariant = variant;

    const preferredBase =
      this.lastGoodSource && sources.includes(this.lastGoodSource)
        ? this.lastGoodSource
        : sources[0];
    const initialSourceHost = ModelStore.hostnameForUrl(preferredBase);

    this.statusState = {
      id: KOKORO_MODEL_ID,
      state: 'downloading',
      variant,
      bytesDone,
      bytesTotal,
      installedBytes: this.statusState.installedBytes,
      installedVoices: existingVoices,
      ...(initialSourceHost ? { source: initialSourceHost } : {}),
    };
    this.emitStatusImmediate();

    this.activeJobPromise = this.runDownloadLoop(
      gen,
      variant,
      sources,
      allowHosts,
      controller.signal,
    ).finally(() => {
      if (this.jobGeneration === gen) {
        this.activeAbort = null;
        this.activeJobPromise = null;
      }
    });

    return this.statusState;
  }

  async pause(id: SpeechModelId): Promise<SpeechModelStatus> {
    this.assertSupportedModelId(id);
    this.pauseRequested = true;
    this.jobGeneration += 1;
    this.activeAbort?.abort();
    this.activeAbort = null;
    if (this.activeJobPromise) {
      await this.activeJobPromise.catch(() => undefined);
    }
    const reconciled = this.reconcileFromDisk();
    this.statusState = {
      ...reconciled,
      state: reconciled.state === 'ready' ? 'ready' : reconciled.bytesDone > 0 ? 'paused' : 'paused',
    };
    this.emitStatusImmediate();
    return this.statusState;
  }

  async remove(id: SpeechModelId): Promise<void> {
    this.assertSupportedModelId(id);
    this.pauseRequested = false;
    this.jobGeneration += 1;
    this.activeAbort?.abort();
    this.activeAbort = null;
    if (this.activeJobPromise) {
      await this.activeJobPromise.catch(() => undefined);
    }
    this.lastGoodSource = null;
    this.activeSources = [];
    rmSync(this.kokoroRoot, { recursive: true, force: true });
    this.statusState = this.reconcileFromDisk();
    this.emitStatusImmediate();
  }

  /** Wait hook for deterministic unit tests. */
  async waitForIdle(): Promise<void> {
    if (this.activeJobPromise) {
      await this.activeJobPromise.catch(() => undefined);
    }
  }

  private isAllowedRedirect(targetUrl: string, allowHosts: readonly string[]): boolean {
    if (this.allowInsecureHttpForTests) {
      try {
        const parsed = new URL(targetUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          const host = parsed.hostname.toLowerCase();
          return allowHosts.some((rule) => {
            const r = rule.toLowerCase();
            if (r.startsWith('*.')) {
              const suffix = r.slice(1);
              return host.endsWith(suffix) && host.length > suffix.length;
            }
            if (r.startsWith('.')) {
              return host.endsWith(r) && host.length > r.length;
            }
            return host === r;
          });
        }
      } catch {
        return false;
      }
    }
    return isAllowedModelRedirectUrl(targetUrl, allowHosts);
  }

  private async runDownloadLoop(
    myGen: number,
    variant: SpeechModelVariant,
    sources: readonly string[],
    allowHosts: readonly string[],
    signal: AbortSignal,
  ): Promise<void> {
    try {

      const completedBytesByPath = new Map<string, number>();
      let lastSourceHost = this.statusState.source;
      const completedFiles: KokoroManifestFile[] = [];

      // Process files dynamically in case extra voices were requested mid-download
      const processedPaths = new Set<string>();
      while (true) {
        if (signal.aborted || this.jobGeneration !== myGen) return;

        const targetVoices = [...this.requestedVoices];
        const manifestFiles = this.resolveTargetFiles(variant, targetVoices);
        const bytesTotal = manifestFiles.reduce((s, f) => s + f.size, 0);

        // Seed already completed sizes
        for (const mf of manifestFiles) {
          if (!completedBytesByPath.has(mf.path)) {
            const fp = join(this.kokoroRoot, mf.path);
            const pp = `${fp}.part`;
            if (existsSync(fp) && statSync(fp).size === mf.size) {
              completedBytesByPath.set(mf.path, mf.size);
            } else if (existsSync(pp)) {
              const psz = statSync(pp).size;
              completedBytesByPath.set(mf.path, psz <= mf.size ? psz : 0);
            } else {
              completedBytesByPath.set(mf.path, 0);
            }
          }
        }

        const nextFile = manifestFiles.find((f) => !processedPaths.has(f.path));
        if (!nextFile) {
          // All requested files done! Emit `verifying` at most ONCE right before manifest commit.
          const installedBytes = manifestFiles.reduce((s, f) => s + f.size, 0);
          const installedVoices = targetVoices.filter((v) =>
            existsSync(join(this.kokoroRoot, `voices/${v}.bin`)),
          );
          this.statusState = {
            id: KOKORO_MODEL_ID,
            state: 'verifying',
            variant,
            bytesDone: installedBytes,
            bytesTotal: installedBytes,
            installedBytes: 0,
            installedVoices,
            ...(lastSourceHost ? { source: lastSourceHost } : {}),
          };
          this.emitStatusImmediate();
          const meta: InstalledMetadata = {
            revision: KOKORO_MANIFEST.onnx.revision,
            variant,
            files: manifestFiles.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
            voices: installedVoices,
            installedAt: this.now(),
            ...(lastSourceHost ? { source: lastSourceHost } : {}),
          };
          writeAtomicJson(join(this.kokoroRoot, 'installed.json'), meta);
          this.statusState = {
            id: KOKORO_MODEL_ID,
            state: 'ready',
            variant,
            bytesDone: installedBytes,
            bytesTotal: installedBytes,
            installedBytes,
            installedVoices,
            ...(lastSourceHost ? { source: lastSourceHost } : {}),
          };
          this.emitStatusImmediate();
          return;
        }

        const result = await this.downloadAndVerifySingleFile({
          myGen,
          file: nextFile,
          sources,
          allowHosts,
          signal,
          onBytesProgress: (fileBytes) => {
            if (signal.aborted || this.jobGeneration !== myGen) return;
            completedBytesByPath.set(nextFile.path, fileBytes);
            let sum = 0;
            for (const mf of manifestFiles) {
              sum += completedBytesByPath.get(mf.path) ?? 0;
            }
            this.statusState = {
              ...this.statusState,
              state: 'downloading',
              variant,
              bytesDone: Math.min(sum, bytesTotal),
              bytesTotal,
              ...(lastSourceHost ? { source: lastSourceHost } : {}),
            };
            this.emitStatusThrottled();
          },
          onSourceUsed: (host) => {
            if (signal.aborted || this.jobGeneration !== myGen) return;
            if (lastSourceHost !== host) {
              lastSourceHost = host;
              if (this.statusState.source !== host) {
                this.statusState = {
                  ...this.statusState,
                  source: host,
                };
                this.emitStatusImmediate();
              }
            }
          },
          onVerifying: () => {
            if (signal.aborted || this.jobGeneration !== myGen) return;
            // Keep state = 'downloading' continuously across per-file SHA-256 checks
            // so multi-file downloads never oscillate `downloading <-> verifying`.
            completedBytesByPath.set(nextFile.path, nextFile.size);
            let sum = 0;
            for (const mf of manifestFiles) {
              sum += completedBytesByPath.get(mf.path) ?? 0;
            }
            this.statusState = {
              ...this.statusState,
              state: 'downloading',
              variant,
              bytesDone: Math.min(sum, bytesTotal),
              bytesTotal,
              ...(lastSourceHost ? { source: lastSourceHost } : {}),
            };
            this.emitStatusThrottled();
          },
        });

        if (signal.aborted || this.jobGeneration !== myGen) return;

        if (!result.ok) {
          this.statusState = {
            ...this.statusState,
            state: 'error',
            variant,
            bytesTotal,
            installedVoices: this.detectInstalledVoicesOnDisk(),
            ...(lastSourceHost ? { source: lastSourceHost } : {}),
            error: result.error,
          };
          this.emitStatusImmediate();
          return;
        }

        completedBytesByPath.set(nextFile.path, nextFile.size);
        completedFiles.push({
          path: nextFile.path,
          size: nextFile.size,
          sha256: nextFile.sha256,
        });
        processedPaths.add(nextFile.path);
      }
    } catch (err) {
      if (this.pauseRequested || signal.aborted || this.jobGeneration !== myGen) {
        return;
      }
      const mb = MiniBookError.wrap(err, 'network');
      this.statusState = {
        ...this.statusState,
        state: 'error',
        error: mb.toShape(),
      };
      this.emitStatusImmediate();
    }
  }

  private async downloadAndVerifySingleFile(params: {
    readonly myGen: number;
    readonly file: ResolvedKokoroDownloadFile;
    readonly sources: readonly string[];
    readonly allowHosts: readonly string[];
    readonly signal: AbortSignal;
    readonly onBytesProgress: (fileBytes: number) => void;
    readonly onSourceUsed: (host: string) => void;
    readonly onVerifying: () => void;
  }): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: MiniBookErrorShape }> {
    const { file, sources, allowHosts, signal } = params;
    const finalPath = join(this.kokoroRoot, file.path);
    const partPath = `${finalPath}.part`;
    mkdirSync(dirname(finalPath), { recursive: true });

    if (existsSync(finalPath)) {
      try {
        if (statSync(finalPath).size === file.size) {
          params.onBytesProgress(file.size);
          return { ok: true };
        }
      } catch {
        // re-download
      }
    }

    let integrityRetried = false;
    let startSourceOffset = 0;
    if (this.lastGoodSource) {
      const idx = sources.indexOf(this.lastGoodSource);
      if (idx >= 0) {
        startSourceOffset = idx;
      } else {
        this.lastGoodSource = null;
      }
    }

    while (true) {
      if (signal.aborted || this.jobGeneration !== params.myGen) {
        return { ok: false, error: { code: 'cancelled', message: 'Aborted' } };
      }

      let offset = 0;
      if (existsSync(partPath)) {
        const psz = statSync(partPath).size;
        if (psz > file.size) {
          unlinkSync(partPath);
          offset = 0;
        } else {
          offset = psz;
        }
      }
      params.onBytesProgress(offset);

      for (let round = 0; round < this.retryDelaysMs.length && offset < file.size; round++) {
        const delayMs = this.retryDelaysMs[round] ?? 0;
        if (round > 0 && delayMs > 0) {
          await abortableSleep(delayMs, signal);
        }

        for (let i = 0; i < sources.length && offset < file.size; i++) {
          if (signal.aborted || this.jobGeneration !== params.myGen) {
            return { ok: false, error: { code: 'cancelled', message: 'Aborted' } };
          }
          const srcIdx = (startSourceOffset + i) % sources.length;
          const base = sources[srcIdx]!;
          const url = buildModelResolveUrl(base, file.repo, file.revision, file.path);
          const baseHost = ModelStore.hostnameForUrl(base);
          if (baseHost) {
            params.onSourceUsed(baseHost);
          }

          const attemptRes = await this.downloadFromSingleSource({
            url,
            partPath,
            initialOffset: offset,
            expectedTotalSize: file.size,
            allowHosts,
            signal,
            onProgress: params.onBytesProgress,
            onHost: params.onSourceUsed,
          });

          offset = attemptRes.offset;
          if (attemptRes.completed) {
            this.lastGoodSource = base;
            break;
          }
        }
      }

      if (signal.aborted || this.jobGeneration !== params.myGen) {
        return { ok: false, error: { code: 'cancelled', message: 'Aborted' } };
      }

      if (offset !== file.size) {
        return {
          ok: false,
          error: {
            code: 'network',
            message: `Failed to download ${file.path} (got ${offset} of ${file.size} bytes)`,
          },
        };
      }

      params.onVerifying();
      const digest = await computeFileSha256(partPath);
      if (digest.toLowerCase() === file.sha256.toLowerCase()) {
        renameSync(partPath, finalPath);
        return { ok: true };
      }

      try {
        unlinkSync(partPath);
      } catch {
        // ignore
      }
      if (!integrityRetried) {
        integrityRetried = true;
        this.lastGoodSource = null;
        // Rotate so the other mirror is tried first on integrity retry (`TTS_V2_SPEC.md` §3.3)
        if (sources.length > 1) {
          startSourceOffset = (startSourceOffset + 1) % sources.length;
        }
        continue;
      }

      return {
        ok: false,
        error: {
          code: 'model-integrity',
          message: `SHA-256 verification failed for ${file.path} (expected ${file.sha256}, got ${digest})`,
        },
      };
    }
  }

  private async downloadFromSingleSource(params: {
    readonly url: string;
    readonly partPath: string;
    readonly initialOffset: number;
    readonly expectedTotalSize: number;
    readonly allowHosts: readonly string[];
    readonly signal: AbortSignal;
    readonly onProgress: (bytes: number) => void;
    readonly onHost: (host: string) => void;
  }): Promise<{ readonly completed: boolean; readonly offset: number }> {
    let offset = params.initialOffset;
    let retried416 = false;

    while (true) {
      const attemptController = new AbortController();
      let timedOut = false;
      const onParentAbort = () => attemptController.abort();
      if (params.signal.aborted) {
        return { completed: false, offset };
      }
      params.signal.addEventListener('abort', onParentAbort, { once: true });

      let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        timedOut = true;
        attemptController.abort();
      }, this.firstByteTimeoutMs);

      const resetStallTimer = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timedOut = true;
          attemptController.abort();
        }, this.stallTimeoutMs);
      };

      try {
        let currentUrl = params.url;
        let resp: Response | null = null;

        for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
          const reqHeaders: Record<string, string> = {
            'Accept-Encoding': 'identity',
            'User-Agent': 'MiniBook/0.2.3',
          };
          if (offset > 0) {
            reqHeaders['Range'] = `bytes=${offset}-`;
          }

          resp = await this.fetchFn(currentUrl, {
            method: 'GET',
            headers: reqHeaders,
            redirect: 'manual',
            signal: attemptController.signal,
          });

          if (resp.status >= 300 && resp.status < 400) {
            const loc = resp.headers.get('location');
            await resp.body?.cancel().catch(() => undefined);
            if (!loc || hop === MAX_REDIRECT_HOPS) {
              return { completed: false, offset };
            }
            const nextUrl = new URL(loc, currentUrl).toString();
            if (!this.isAllowedRedirect(nextUrl, params.allowHosts)) {
              return { completed: false, offset };
            }
            currentUrl = nextUrl;
            continue;
          }
          break;
        }

        if (!resp) {
          return { completed: false, offset };
        }

        try {
          params.onHost(new URL(params.url).hostname);
        } catch {
          // ignore
        }

        if (resp.status === 416) {
          await resp.body?.cancel().catch(() => undefined);
          try {
            if (existsSync(params.partPath)) unlinkSync(params.partPath);
          } catch {
            // ignore
          }
          offset = 0;
          params.onProgress(0);
          if (!retried416) {
            retried416 = true;
            continue;
          }
          return { completed: false, offset: 0 };
        }

        let appendMode = false;
        if (resp.status === 206) {
          const cr = parseContentRange(resp.headers.get('content-range'));
          if (!cr || cr.start !== offset || (cr.total !== null && cr.total !== params.expectedTotalSize)) {
            await resp.body?.cancel().catch(() => undefined);
            return { completed: false, offset };
          }
          appendMode = offset > 0;
        } else if (resp.status === 200) {
          // If server ignored Range while offset > 0, restart `.part` cleanly from 0 (`TTS_V2_SPEC.md` §3.3)
          if (offset > 0) {
            offset = 0;
            params.onProgress(0);
          }
          appendMode = false;
        } else {
          await resp.body?.cancel().catch(() => undefined);
          return { completed: false, offset };
        }

        const fd = openSync(params.partPath, appendMode ? 'a' : 'w', 0o644);
        let bytesSinceSync = 0;
        try {
          if (!resp.body) {
            const buf = new Uint8Array(await resp.arrayBuffer());
            if (buf.byteLength > 0) {
              writeSync(fd, buf);
              offset += buf.byteLength;
              params.onProgress(offset);
            }
          } else {
            const reader = resp.body.getReader();
            try {
              while (true) {
                resetStallTimer();
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength > 0) {
                  writeSync(fd, value);
                  offset += value.byteLength;
                  bytesSinceSync += value.byteLength;
                  if (bytesSinceSync >= FSYNC_INTERVAL_BYTES) {
                    fsyncSync(fd);
                    bytesSinceSync = 0;
                  }
                  params.onProgress(offset);
                }
              }
            } finally {
              reader.releaseLock();
            }
          }
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }

        if (timedOut || params.signal.aborted) {
          return { completed: false, offset };
        }

        return {
          completed: offset === params.expectedTotalSize,
          offset,
        };
      } catch {
        return { completed: false, offset };
      } finally {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        params.signal.removeEventListener('abort', onParentAbort);
      }
    }
  }

  private emitStatusImmediate(): void {
    this.lastProgressEmitMs = this.now();
    this.lastEmittedState = this.statusState.state;
    this.lastEmittedSource = this.statusState.source;
    this.emitEvent({ type: 'speech-model', status: this.statusState });
  }

  private emitStatusThrottled(): void {
    const t = this.now();
    const stateChanged = this.statusState.state !== this.lastEmittedState;
    const sourceChanged = this.statusState.source !== this.lastEmittedSource;
    if (stateChanged || sourceChanged || t - this.lastProgressEmitMs >= PROGRESS_EMIT_INTERVAL_MS) {
      this.lastProgressEmitMs = t;
      this.lastEmittedState = this.statusState.state;
      this.lastEmittedSource = this.statusState.source;
      this.emitEvent({ type: 'speech-model', status: this.statusState });
    }
  }
}
