/**
 * Isolated Microsoft Edge Read-Aloud protocol constants (`ARCHITECTURE.md` §8.4, Risk R4).
 * Keeping all endpoint URLs, version strings, and token parameters in one file makes
 * protocol maintenance a single-file update.
 */

export const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
export const EDGE_CHROMIUM_FULL_VERSION = '130.0.2849.68';
export const EDGE_CHROMIUM_MAJOR_VERSION = '130';
export const EDGE_SEC_MS_GEC_VERSION = `1-${EDGE_CHROMIUM_FULL_VERSION}`;

export const EDGE_WSS_BASE_URL =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

export const EDGE_VOICES_LIST_URL =
  `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${EDGE_TRUSTED_CLIENT_TOKEN}`;

export const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';

export const EDGE_USER_AGENT =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${EDGE_CHROMIUM_MAJOR_VERSION}.0.0.0`;

export const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/** Seconds between 1601-01-01T00:00:00Z (Windows FILETIME epoch) and 1970-01-01T00:00:00Z. */
export const WIN_FILETIME_EPOCH_OFFSET_SEC = 11_644_473_600;

/** 7-day TTL for the cached remote Edge voice list (`§8.4`). */
export const EDGE_VOICE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
