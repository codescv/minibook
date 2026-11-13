// Authoritative shared types & errors
export * from './types.js';
export * from './errors.js';

// I/O, ZIP, Binary & Multi-Encoding
export {
  WindowedByteSource,
  type WindowedByteSourceOptions,
  computeBookId,
  memoryByteSource,
  sliceByteSource,
} from './io/ByteSource.js';
export {
  BinaryReader,
  concatBytes,
  readMobiVarIntBackward,
  readMobiVarIntForward,
} from './io/binary.js';
export {
  MAX_ENTRY_BYTES_BINARY,
  MAX_ENTRY_BYTES_MARKUP,
  MAX_ZIP_RATIO,
  ZipArchive,
  type ZipBuilderFile,
  type ZipReadEntryOptions,
  buildZipArchive,
  crc32,
} from './io/zip.js';
export {
  type DetectedEncoding,
  type SupportedTextEncoding,
  decodeBytesWithEncoding,
  detectEncodingFromBytes,
  detectTextEncoding,
  normalizeEncodingLabel,
} from './io/encoding.js';

// Markup, Sanitizer, CSS, Text Model, Locator & Search
export {
  type MElement,
  type MNamespace,
  type MNode,
  type MText,
  childElements,
  el,
  findAll,
  findFirst,
  getAttr,
  localName,
  textContent,
  txt,
} from './markup/mnode.js';
export {
  decodeEntities,
  escapeXmlAttr,
  escapeXmlText,
  sanitizeXmlChars,
} from './markup/entities.js';
export {
  type XmlParseOptions,
  parseXml,
  sniffXmlDeclarationEncoding,
} from './markup/xml-tokenizer.js';
export {
  parseHtmlDocument,
  parseHtmlFragment,
  parseXhtmlOrHtml,
} from './markup/html.js';
export {
  serializeXhtmlElement,
  serializeXhtmlNodes,
} from './markup/serialize.js';
export {
  type CssSanitizeOptions,
  sanitizeInlineStyle,
  sanitizeStylesheet,
} from './book/css.js';
export {
  type SanitizeDocumentOptions,
  type SanitizedDocumentResult,
  sanitizeDocument,
} from './book/sanitize.js';
export {
  type BuiltSectionUnits,
  MAX_RENDER_UNIT_CHARS,
  buildSectionRenderUnits,
  buildSectionText,
} from './book/text-model.js';
export {
  createSavedPosition,
  fractionForLocator,
  locatorForFraction,
  reanchorLocator,
} from './book/locator.js';
export {
  search,
  searchBook,
} from './book/search.js';
export {
  inspectBook,
  openBook,
} from './book/BookSession.js';

// Format Parsers & Low-level Helpers
export {
  type DetectedContainerKind,
  type DetectionResult,
  detectBookFormat,
} from './formats/detect.js';
export {
  deobfuscateEpubFont,
  deriveAdobeFontKeyHex,
  deriveIdpfFontKeyHex,
  parseEpubEncryptionXml,
} from './formats/epub/obfuscation.js';
export {
  compressPalmDoc,
  decompressPalmDoc,
  stripMobiTrailingEntries,
} from './formats/mobi/palmdoc.js';
export { HuffCdicDecoder } from './formats/mobi/huffcdic.js';
export {
  assembleKf8SectionBytes,
  snapToSafeUtf8TagBoundary,
} from './formats/mobi/kf8.js';
export {
  MAX_TXT_SECTION_CHARS,
  TXT_HEADING_REGEX,
  buildStreamingTxtChapterIndex,
  isTxtHeadingCandidate,
} from './formats/txt/chapters.js';
export { renderMarkdownToNodes } from './formats/md/markdown.js';

// Read Aloud (TTS): Segmentation, Scheduler, Cache Keys & Providers
export {
  containsCjkCharacters,
  normalizeBcp47,
  resolveUtteranceLang,
} from './speech/lang.js';
export {
  PAUSE_HEADING_MS,
  PAUSE_PARAGRAPH_MS,
  PAUSE_SECTION_END_MS,
  PAUSE_SENTENCE_MS,
  type SegmentOptions,
  segmentSection,
} from './speech/segmenter.js';
export {
  findAdjacentParagraphUtterance,
  findUtteranceAtOffset,
  parseUtteranceId,
} from './speech/utterance.js';
export {
  computeSpeechCacheKey,
  computeSpeechCacheKeySync,
} from './speech/cache-key.js';
export { estimateAudioDurationMs } from './speech/transports.js';
export {
  SynthScheduler,
  type SynthSchedulerConfig,
  type SynthSchedulerOptions,
} from './speech/SynthScheduler.js';
export * from './speech/providers/edge-constants.js';
export {
  EdgeSpeechProvider,
  type EdgeSpeechProviderDeps,
  type EdgeSynthOutput,
  alignWordBoundariesToText,
  computeSecMsGecToken,
} from './speech/providers/EdgeSpeechProvider.js';
export {
  OpenAiSpeechProvider,
  type OpenAiSpeechProviderDeps,
  type OpenAiSynthOutput,
  resolveOpenAiSpeechUrl,
  resolveOpenAiVoicesUrl,
} from './speech/providers/OpenAiSpeechProvider.js';

// Utilities
export {
  bytesToHexLower,
  sha1Bytes,
  sha1Hex,
  sha256Bytes,
  sha256HexUpper,
} from './util/sha1.js';
export {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  decodeKindleBase32,
  encodeKindleBase32,
  hexToBytes,
} from './util/base32.js';
export { LruCache } from './util/lru.js';
export {
  dirnameArchivePath,
  isRemoteOrExternalScheme,
  isSafeDataImageUri,
  mimeFromMagic,
  mimeFromPath,
  normalizeArchivePath,
  resolveArchiveHref,
} from './util/path.js';
