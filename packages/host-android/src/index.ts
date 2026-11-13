export {
  CAPACITOR_HOST_VERSION,
  createCapacitorPlatformHost,
  type CapacitorHostOptions,
} from './capacitor-host.js';
export * from './plugin-types.js';
export { NativeSpeechPlayer } from './speech/NativeSpeechPlayer.js';
export {
  createPluginHttpTransport,
  createPluginSocketTransport,
} from './speech/plugin-transports.js';
export {
  FileLibraryStore,
  type PersistedBookIndexFile,
  type PersistedBookStateFile,
} from './storage/FileLibraryStore.js';
export {
  PLUGIN_MAX_CACHE_BYTES,
  PLUGIN_MAX_READ_BYTES,
  PLUGIN_WINDOW_BYTES,
  PluginByteSource,
  type PluginByteSourceOptions,
} from './storage/PluginByteSource.js';
export { base64ToBytes, bytesToBase64 } from './storage/base64.js';
