/**
 * Strict outbound URL allowlist for the desktop speech synthesis proxy
 * (`ARCHITECTURE.md` §12, §13, `TTS_V2_SPEC.md` §6.2: "Outbound requests are allowed only
 * to the Edge endpoints and the configured custom / Qwen server base URLs — no open proxy").
 */
import { MiniBookError } from '@minibook/core';

const EDGE_ALLOWED_ENDPOINTS: ReadonlyArray<{
  readonly protocol: 'wss:' | 'https:';
  readonly hostname: string;
  readonly pathname: string;
}> = [
  {
    protocol: 'wss:',
    hostname: 'speech.platform.bing.com',
    pathname: '/consumer/speech/synthesize/readaloud/edge/v1',
  },
  {
    protocol: 'https:',
    hostname: 'speech.platform.bing.com',
    pathname: '/consumer/speech/synthesize/readaloud/voices/list',
  },
  {
    protocol: 'https:',
    hostname: 'api.msedgeservices.com',
    pathname: '/tts/cognitiveservices/voices/list',
  },
];

const CUSTOM_SPEECH_SUFFIXES = new Set([
  '/audio/speech',
  '/v1/audio/speech',
  '/audio/voices',
  '/v1/audio/voices',
  '/voices',
  '/v1/voices',
  '/models',
  '/v1/models',
]);

const QWEN_SPEECH_SUFFIXES = new Set([
  ...CUSTOM_SPEECH_SUFFIXES,
  '/synthesize',
  '/health',
]);

function normalizePathPrefix(pathname: string): string {
  const clean = pathname.replace(/\/+$/, '');
  return clean === '' ? '' : clean;
}

export function isAllowedEdgeUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  return EDGE_ALLOWED_ENDPOINTS.some(
    (rule) =>
      parsed.protocol === rule.protocol &&
      host === rule.hostname &&
      parsed.pathname === rule.pathname,
  );
}

function matchesConfiguredBaseUrl(
  rawUrl: string,
  configuredBaseUrl: string | null | undefined,
  allowedSuffixes: ReadonlySet<string>,
): boolean {
  if (!configuredBaseUrl || !configuredBaseUrl.trim()) return false;
  let target: URL;
  let base: URL;
  try {
    target = new URL(rawUrl);
    base = new URL(configuredBaseUrl.trim());
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (target.origin !== base.origin) return false;
  if (target.username || target.password) return false;

  const basePrefix = normalizePathPrefix(base.pathname);
  const targetPath = target.pathname;
  if (!targetPath.startsWith(basePrefix)) return false;
  const suffix = targetPath.slice(basePrefix.length);
  return allowedSuffixes.has(suffix);
}

export function isAllowedCustomSpeechUrl(
  rawUrl: string,
  configuredBaseUrl: string | null | undefined,
): boolean {
  return matchesConfiguredBaseUrl(rawUrl, configuredBaseUrl, CUSTOM_SPEECH_SUFFIXES);
}

export function isAllowedQwenSpeechUrl(
  rawUrl: string,
  configuredQwenBaseUrl: string | null | undefined,
): boolean {
  if (!configuredQwenBaseUrl || !configuredQwenBaseUrl.trim()) return false;
  // Allow stripping trailing `/synthesize` when building `/health` against a full `/synthesize` baseUrl
  const normalizedBase = configuredQwenBaseUrl.trim().replace(/\/synthesize\/?$/i, '');
  return (
    matchesConfiguredBaseUrl(rawUrl, configuredQwenBaseUrl, QWEN_SPEECH_SUFFIXES) ||
    matchesConfiguredBaseUrl(rawUrl, normalizedBase, QWEN_SPEECH_SUFFIXES)
  );
}

export function assertAllowedOutboundSpeechUrl(
  rawUrl: string,
  options: {
    readonly allowEdge: boolean;
    readonly configuredCustomBaseUrl?: string | null;
    readonly configuredQwenBaseUrl?: string | null;
  },
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new MiniBookError('invalid-argument', `Malformed speech URL: ${rawUrl}`);
  }

  if (options.allowEdge && isAllowedEdgeUrl(rawUrl)) {
    return parsed;
  }
  if (isAllowedCustomSpeechUrl(rawUrl, options.configuredCustomBaseUrl)) {
    return parsed;
  }
  if (isAllowedQwenSpeechUrl(rawUrl, options.configuredQwenBaseUrl)) {
    return parsed;
  }

  throw new MiniBookError(
    'invalid-argument',
    `Blocked outbound speech request to disallowed URL: ${parsed.origin}${parsed.pathname}`,
  );
}
