/**
 * MiniBook CLI entry (`minibook [files...]`, `ARCHITECTURE.md` §12).
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from './start.js';

export const MINIBOOK_VERSION = '0.2.8';

export interface ParsedCliArgs {
  readonly port: number;
  readonly dataDir?: string;
  readonly openBrowser: boolean;
  readonly appWindow: boolean;
  readonly dev: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly files: readonly string[];
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  let port = 0;
  let dataDir: string | undefined;
  let openBrowser = true;
  let appWindow = false;
  let dev = false;
  let help = false;
  let version = false;
  const files: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--version' || arg === '-v') {
      version = true;
    } else if (arg === '--no-open') {
      openBrowser = false;
    } else if (arg === '--new-browser' || arg === '--app') {
      appWindow = true;
    } else if (arg === '--dev') {
      dev = true;
      if (port === 0) port = 47822;
      openBrowser = false;
    } else if (arg === '--port' || arg === '-p') {
      const next = argv[++i];
      if (next !== undefined) {
        const parsed = Number.parseInt(next, 10);
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 65535) {
          port = parsed;
        }
      }
    } else if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 65535) {
        port = parsed;
      }
    } else if (arg === '--data-dir') {
      const next = argv[++i];
      if (next) dataDir = resolve(next);
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = resolve(arg.slice('--data-dir='.length));
    } else if (!arg.startsWith('-')) {
      files.push(resolve(arg));
    }
  }

  return {
    port,
    ...(dataDir !== undefined ? { dataDir } : {}),
    openBrowser,
    appWindow,
    dev,
    help,
    version,
    files,
  };
}

function launchBrowserWindow(url: string, appMode: boolean): void {
  if (process.env['CI'] || process.env['VITEST']) return;
  if (appMode) {
    const chromiumBins = [
      'google-chrome',
      'chromium',
      'chromium-browser',
      'microsoft-edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    for (const bin of chromiumBins) {
      try {
        const child = spawn(bin, [`--app=${url}`], { stdio: 'ignore', detached: true });
        child.on('error', () => undefined);
        child.unref();
        return;
      } catch {
        // try next
      }
    }
  }

  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // ignore headless environment
  }
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (parsed.version) {
    process.stdout.write(`minibook ${MINIBOOK_VERSION}\n`);
    return;
  }
  if (parsed.help) {
    process.stdout.write(
      [
        `MiniBook (Books) v${MINIBOOK_VERSION}`,
        '',
        'Usage: minibook [options] [files...]',
        '',
        'Options:',
        '  -p, --port <port>       Port on 127.0.0.1 (default: ephemeral free port)',
        '  --data-dir <dir>        Storage directory (default: ~/.minibook)',
        '  --new-browser           Launch standalone Chromium/Chrome --app window',
        '  --no-open               Do not open a browser automatically',
        '  -v, --version           Print version',
        '  -h, --help              Show this help',
        '',
      ].join('\n'),
    );
    return;
  }

  const running = await startServer({
    port: parsed.port,
    appVersion: MINIBOOK_VERSION,
    ...(parsed.dataDir ? { dataDir: parsed.dataDir } : {}),
    ...(parsed.dev ? { extraAllowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'] } : {}),
  });

  for (const filePath of parsed.files) {
    try {
      const imported = await running.context.importLocalFile(filePath);
      process.stdout.write(`[minibook] Imported "${imported.title}" (${imported.id})\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[minibook] Failed to import ${filePath}: ${msg}\n`);
    }
  }

  process.stdout.write(`[minibook] Books running at ${running.url}\n`);

  if (parsed.openBrowser) {
    launchBrowserWindow(running.url, parsed.appWindow);
  }

  const shutdown = () => {
    void running.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const isDirectEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectEntry) {
  void runCli();
}
