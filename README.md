# Books (`minibook`)

**Books** (`codescv/minibook`) is a calm, Apple Books-inspired minimalist cross-platform ebook reader with **Read Aloud (TTS)** and **Android E-Ink Mode (`墨水屏模式`)**. It ships as a **standalone Android APK (`dev.minibook.app`)**, a **cross-platform PC Web App (`minibook`)** for macOS, Linux, and Windows, and a **native iOS Capacitor 8 host** — built on a **100% pure TypeScript core** with **zero native `.node` C++/Rust addons**, **zero accounts**, and **zero cloud lock-in**.

- **GitHub Repository**: <https://github.com/codescv/minibook>
- **Latest Release (`v0.2.0`)**: <https://github.com/codescv/minibook/releases/tag/v0.2.0>
  - **Android APK (`dev.minibook.app`, `application-label: 'Books'`, `minSdk 26` / `targetSdk 36`, `versionCode 2`)**: [`minibook-v0.2.0.apk`](https://github.com/codescv/minibook/releases/download/v0.2.0/minibook-v0.2.0.apk)

---

## Highlights

### 1. Six Ebook Formats, Lazy Ranged I/O & 4-Layer Sandboxed Typography
- **Supported Formats** (detected by magic bytes, never extracted to disk):
  - **EPUB 2 & EPUB 3 (`.epub`)**: Lazy Central Directory indexing (`0` archive reads on reopen, `<= 2` ranged reads per chapter), OPF spine/guide, EPUB 3 `<nav>` & EPUB 2 NCX TOC with exact `#fragment` character offsets, IDPF/Adobe font de-obfuscation, RTL progression, `<ruby>`/`<rt>` furigana, and footnote skip markers.
  - **Kindle KF8 / AZW3 (`.azw3`, `.azw`) & MOBI (`.mobi`, `.prc`)**: Pure-TS PDB container reader, PalmDOC LZ77 & HUFF/CDIC decompression in coalesced `<= 1 MiB` windows into derived `text.bin`, byte-exact KF8 `skel` + `frag` XHTML assembly preserving 3-byte CJK & 4-byte UTF-8 offsets, `INDX`/`CNCX` TOC, `kindle:pos:fid:off` / `kindle:flow` / `kindle:embed` & `FONT` resource resolution, and automatic Combo MOBI 7 + KF8 handling.
  - **FictionBook (`.fb2`, `.fb2.zip`)**: UTF-8 & Windows-1251/Cyrillic decoding, nested `<section>` hierarchy, `<section id="notes">` footnotes, and ranged `<binary>` cover/illustration slicing.
  - **Plain Text (`.txt`) & CommonMark Markdown (`.md`)**: Automatic BOM + statistical encoding detection (**UTF-8**, **UTF-16LE/BE**, **GB18030 / GBK**, **Big5**, **Shift_JIS**, **EUC-KR**, **Windows-1252**), streaming CJK (`第…章/回/卷/节/篇`) & English (`Chapter` / `Part` / `Book`) chapter heading detection on multi-megabyte web novels, and CommonMark structure.
- **Editorial Pagination & 4-Layer Security**:
  - Bundled variable **Literata** serif + CJK serif/sans stacks, integer CSS multicol geometry (`Cw <= 34em`, even gutter `G`, exact `n * (Cw + G) == Vw`), responsive **2-column desktop spread** at `>= 1100px`, constant-geometry 1-tap chrome (zero text reflow when opening toolbars), virtual render units for `> 40,000`-char chapters, and sticky character re-anchoring across font/margin/rotation changes.
  - **4-Layer Isolation**: DOM-free allowlist XHTML/SVG/CSS sanitizer (decoding CSS hex escapes & blocking `image-set` remote URLs) -> app CSP -> per-frame `script-src 'none'; connect-src 'none'` CSP -> sandboxed `about:blank` `SectionFrame` iframes without native bridge objects.

### 2. Multi-Tier Read Aloud (TTS) Architecture (On-Device Neural, Local GPU, Edge & System)
- **Built-In On-Device Neural Voice (`Kokoro-82M v1.1-zh`, Offline, 103 Voices)**:
  - **Pure-TS Multilingual G2P**: Zero-dependency Chinese & English grapheme-to-phoneme engine (`@minibook/core` `createKokoroG2P`: `jieba` + `pypinyin` + `cn2an` + `ToneSandhi` + US English lexicon/LTS) with bundled `.gz` dictionaries, WordMark timing spans, and `<= 400`-token chunking.
  - **Cross-Platform Local Neural Runtimes**:
    - **Mac / PC Web App (`@minibook/host-node`)**: `onnxruntime-web` in a Web Worker (`kokoro.worker.ts`) trying WebGPU first and falling back to multi-threaded WASM SIMD (`model.onnx` fp32), served with COOP/COEP/CORP isolation and `'wasm-unsafe-eval'` CSP.
    - **Android (`@minibook/host-android`)**: `com.microsoft.onnxruntime:onnxruntime-android:1.32.0` (`KokoroOnnxBackend` + `KokoroSynthQueue` on a dedicated `HandlerThread` inside `ReadAloudService` over `model_quantized.onnx`) with a 45 s / 12-utterance lookahead queue.
    - **iOS (`//experimental/users/chii/ios/minibook`)**: 7-stage `FluidInference/kokoro-82m-coreml` (`ANE-zh`) Core ML pipeline on a serial background `DispatchQueue` with 16 KB page-padded `MLMultiArray` buffers.
  - **CN-Resilient Resumable Model Downloader**: Automatic `huggingface.co` <-> `hf-mirror.com` (plus custom mirror) fallback, strict redirect host-suffix allowlist (`huggingface.co`, `hf-mirror.com`, `*.hf.co`, `*.huggingface.co`, `*.hf-mirror.com`), HTTP 206 `Range` `.part` pause/resume/cancel, and streaming SHA-256 verification against `kokoro-manifest.json`.
- **Local / LAN GPU Server (`QwenSpeechProvider` — `Qwen3-TTS` & `mlx-audio`)**:
  - Connects to local or LAN GPU speech servers across `mlx-audio` (`/v1/audio/speech`), `vllm-omni`, and `qwen-native` (`/synthesize` with `>30s` sentence splitting and WAV concatenation), with 1-tap `Test` and optional `qwen-api-key` host secret storage.
  - Apple Silicon Macs can start a LAN Metal GPU server in one command:
    ```bash
    bash scripts/mac-gpu-tts-server.sh [qwen-0.6b|qwen-1.7b|kokoro]
    ```
    (automatically sets `HF_ENDPOINT=https://hf-mirror.com` if `huggingface.co` is unreachable).
- **Tier 0 — System Voices (Default, Offline, Zero Setup)**:
  - Browser `speechSynthesis` on Desktop, `AVSpeechSynthesizer` on iOS, and native Android `TextToSpeech` enumerating **all installed TTS engines** — including Google TTS, **MultiTTS**, and **sherpa-onnx** (Kokoro / Piper / Matcha / VITS local neural voices), respecting engine `getMaxSpeechInputLength()`.
- **Tier 1 — Edge Neural Voices (Opt-In)**:
  - Natural multilingual neural voices (`zh-CN-XiaoxiaoNeural`, `en-US-AvaMultilingualNeural`, etc.) with word-boundary marks, synthesized through the host WebSocket transport (`ws` on Node, `OkHttp` on Android, `URLSessionWebSocketTask` on iOS) and cached on disk.
- **Tier 2 — Custom OpenAI-Compatible Speech Server**:
  - Connects to any `/v1/audio/speech` endpoint (OpenAI, self-hosted Kokoro-FastAPI, OpenedAI-Speech, or LAN TTS servers). API keys live exclusively in the host secret store (`0600` `secrets.json` on PC, `EncryptedSharedPreferences` / Keystore on Android, Keychain on iOS) and are substituted natively via `{{secret:openai-api-key}}` only for the configured server origin.
- **Seamless Continuity**:
  - **RTF-Adaptive `SynthScheduler`** pre-synthesizes utterances ahead of playback, surfaces slow-engine warnings (`RTF >= 0.9`), and triggers an automatic **8-second online / 2-second offline paragraph-sticky fallback** to the system voice so reading never stalls.
  - **Background Media Session**: Foreground `MediaSessionService` (`ReadAloudService` + Media3 `SimpleBasePlayer` on Android; `AVAudioSession(.playback, mode: .spokenAudio)` + `MPNowPlayingInfoCenter` on iOS) with lock-screen/headset sentence skip, sleep timer (finishing the current sentence cleanly), atomic `SpeechJournal` position checkpoints, non-DOM-mutating sentence/word highlight overlays, and auto page-turn.

### 3. First-Class Android E-Ink Mode (`墨水屏模式`)
- **Automatic Detection + Manual Override (`Auto · On · Off`)**:
  - `EinkDetector` + `assets/eink-devices.json` detects Onyx Boox, Boyue/Meebook, Bigme, Hisense E-Ink models (`A5`/`A6`/`A7`/`A9`/`Hi Reader` allowlist — never false-firing on Hisense LCD phones/TVs), Moaan, iReader, Dasung, Supernote, and PocketBook devices.
- **Strict 1-Bit `#000000` / `#FFFFFF` Rendering**:
  - Zero grey fills, zero shadows/blur/gradients, zero `border-radius`, `0ms` transitions, `[On]/[Off]` 2px-bordered toggles, stepped chapter/`Go to %` bar, 2px solid `#000000` Read-Aloud sentence underline (word highlight suppressed to avoid ~3 Hz panel flashing), **zero scrolling** (`PagedList` across Library, Settings, Contents, Bookmarks, Search, and Voice sheets), **Text Boldness** (`0..3` `-webkit-text-stroke`), **Full Refresh** (`Off / Every 5 / 10 / 20 pages` + manual `⟳` button via Onyx `EpdController` reflection or pre-swap `#000 -> #FFF` flash), and **Hardware Volume-Key Paging** (`MainActivity.dispatchKeyEvent`, automatically yielding to media volume while Read Aloud is audible).

---

## Monorepo Architecture

```text
minibook/
├── .github/workflows/ci.yml # GitHub Actions CI (typecheck, test, check:native, build, E2E, APK & Release)
├── ARCHITECTURE.md          # Complete system, format parser, security, TTS & host specification
├── DESIGN.md                # Product scope, anti-bloat rules, wireframes & E-Ink specification
├── TTS_RESEARCH.md          # Cross-platform TTS engine & protocol research
├── UI_SPEC.md               # Visual tokens, typography & adaptive app icon specification
├── fixtures/                # Redistributable EPUB 2/3, KF8/AZW3, MOBI 6/Combo/HUFF, FB2, CJK TXT, MD & adversarial fixtures
├── e2e/                     # Playwright Chromium E2E suite (multicol geometry, 4-layer CSP, 2-colour E-Ink histogram)
├── scripts/
│   ├── check-native-deps.mjs # Verifies 0 native .node / node-gyp addons in runtime dependency tree
│   ├── bump-version.mjs      # Synchronizes package versions + Android versionCode/versionName
│   └── mac-gpu-tts-server.sh # One-command Apple Silicon Metal GPU mlx-audio TTS server launcher
└── packages/
    ├── core/                # @minibook/core — Pure TypeScript (0 DOM / Node / platform globals):
    │                        #   EPUB/KF8/MOBI/FB2/TXT/MD parsers, sanitizer, locator math, segmenter & TTS providers
    ├── ui/                  # @minibook/ui — Shared React 19 + Zustand UI, iframe SectionFrame paginator,
    │                        #   ReadAloudController, WebSpeechPlayer, E-Ink PagedList/RefreshController, EN/zh-CN/JA i18n
    ├── host-node/           # @minibook/host-node — Loopback Hono server (127.0.0.1), built-in node:sqlite (WAL),
    │                        #   HTTP 206 Partial Content Range streaming, allowlisted TTS proxy & RestPlatformHost
    └── host-android/        # @minibook/host-android — Capacitor 8 Android APK (dev.minibook.app, Books),
                             #   bounded RandomAccessFile fs.read, Media3 ReadAloudService, EinkDetector & KeyPolicy
```

*(Internal Google3 iOS Capacitor 8 host lives at `//experimental/users/chii/ios/minibook`, pairing `:MiniBookCore`, `:MiniBookSpeech`, `:MiniBookCapacitor`, and `:MiniBookApp` over `capacitor://localhost` with the exact production `packages/host-android/www` bundle.)*

---

## Quick Start — PC Web App (macOS / Linux / Windows)

### Prerequisites
- **Node.js `>= 22.5.0`** (uses built-in `node:sqlite` — zero native addons)
- **pnpm `>= 10`**

### Install, Build & Run

```bash
pnpm install
pnpm build
pnpm start
```

Or launch in a standalone chromeless `--app` window (Chrome / Chromium / Edge):

```bash
pnpm start:app
```

### CLI Usage (`minibook [options] [files...]`)

```bash
# Import books from the command line and open Books in your browser
node packages/host-node/bin/minibook.mjs ~/Books/a-tale-of-two-cities.epub ~/Books/novel.azw3

# Run headless on a fixed loopback port with a custom data directory
node packages/host-node/bin/minibook.mjs --port 47822 --data-dir ~/.minibook --no-open
```

Options:
- `-p, --port <port>` — Port on `127.0.0.1` (default: `0` ephemeral free port; `47822` with `--dev`)
- `--data-dir <dir>` — Storage directory (default: `~/.minibook`, or `$MINIBOOK_DATA_DIR`)
- `--new-browser` — Launch standalone Chromium/Chrome/Edge `--app=<url>` window
- `--no-open` — Start loopback server without opening a browser window
- `-v, --version` / `-h, --help` — Print version or CLI usage

---

## Building the Standalone Android APK (`Books`)

### Prerequisites
- **JDK 21** (`JAVA_HOME`)
- **Android SDK** (`ANDROID_HOME`, `compileSdk 36`, `minSdk 26`, `targetSdk 36`)

### Build Signed Release APK

```bash
pnpm build:apk:ci
# or bump version + build release APK:
pnpm build:apk
```

Output APK:
```text
packages/host-android/android/app/build/outputs/apk/release/app-release.apk
```

Run Android JVM unit tests (`KeyPolicyTest`, `EinkDetectorTest`, `BoundedReadTest`, `ReadAloudQueueTest`, `ModelDownloadManagerTest`, `KokoroVoicePackTest`, `KokoroSynthQueueTest`):
```bash
cd packages/host-android/android && ./gradlew testDebugUnitTest
```

---

## Development & Verification Commands

```bash
# Type-check all workspace packages (strict TypeScript, 0 errors)
pnpm typecheck

# Verify 0 native .node / node-gyp dependencies
pnpm check:native

# Run full Vitest unit & cross-package fixture integration suite
pnpm test

# Build production bundles (host-node server + web, host-android www)
pnpm build

# Run Playwright Chromium E2E suite (pagination math, CSP, E-Ink 2-colour histogram)
pnpm test:e2e
```

---

## License

MIT (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).
