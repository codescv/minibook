# MiniBook v0.2.0 — GPU/NPU & Local Neural TTS Upgrade (implementation spec)

> Author: `tts-architect` · 2026-11-13 · Status: **DRAFT r1 for `tts-arch-critic`**
> Scope: `@minibook/{core,ui,host-node,host-android}` (`~/Developer/minibook`) + Google3 iOS `//experimental/users/chii/ios/minibook`.
> Companion files (same directory): `kokoro-manifest.json` (pinned URLs/sizes/SHA-256 for every model file), `mac-gpu-tts-server.sh`, `g2p-prototype/` (measured pure-JS G2P port + data + misaki references + `REPORT.md`).
> Probe artefacts (reproducible, ephemeral): `/tmp/kokoro_probe/` (models, scripts, logs), `/tmp/kokoro_g2p/` (G2P study incl. Python reference venv).

Every claim below is tagged **[M]** measured by me on 2026-11-13, **[S]** read from primary source (file/URL given), or **[E]** estimate that MUST be re-measured at the gate named next to it. Nothing is asserted without one of the three.

---

## 0. Verdict (read this first)

### 0.1 What ships in v0.2.0

| # | Engine | VoiceRef `kind` | Mac (PC web) | OnePlus 13T (Android) | iPhone 17 (iOS) |
|---|---|---|---|---|---|
| 0 | System native (unchanged; Android still enumerates sherpa-onnx / MultiTTS engines) | `system` | `speechSynthesis` | `TextToSpeech` | `AVSpeechSynthesizer` |
| 1 | Edge neural (unchanged) | `edge` | host-node `ws` | OkHttp WS | URLSession WS |
| 2 | **Built-in Kokoro-82M v1.1-zh (zh + en), 100 % offline** — NEW | `kokoro` | browser Web Worker, `onnxruntime-web` **WebGPU → Metal**, WASM-threads fallback, `onnx/model.onnx` fp32 | **`onnxruntime-android` 1.32.0 inside `ReadAloudService`**, `onnx/model_quantized.onnx` | **Core ML 7-stage chain** (`FluidInference/kokoro-82m-coreml` `ANE-zh/`), native Swift |
| 3 | **Qwen3-TTS / local GPU server** — NEW first-class | `qwen` | via host-node | via plugin HTTP | via plugin HTTP |
| 4 | Generic OpenAI-compatible server (unchanged) | `openai` | ✓ | ✓ | ✓ |

One G2P implementation (pure TS, `@minibook/core`, a faithful port of misaki's jieba + pypinyin pipeline — **not** `pinyin-pro`, which reproduces only 6–13 % of sentences, §4.2) feeds all three Kokoro runtimes with **pre-computed `phonemeIds`**; native code never does text processing.

### 0.2 Brutally honest hardware-acceleration table

| Device | Built-in Kokoro actually runs on | Real GPU / NPU? | Speed | Evidence |
|---|---|---|---|---|
| Apple-Silicon Mac | Chrome/Edge/Safari **WebGPU** (Metal GPU), fp32 | **GPU: yes** | **[E]** RTF 0.05–0.15; WASM fallback **[E]** ≈ 0.3 on M-series (**[M]** 1.35 on a 2016 Broadwell Xeon, 4 threads) | WebGPU could **not** be executed on my GPU-less Linux box (SwiftShader run timed out) → gated by load-time self-test + RTF meter (G-MAC) |
| OnePlus 13T | ORT **CPU EP** (ARM64 NEON/dot-prod), 4 threads on Oryon cores | **No.** NNAPI is deprecated (Android 15) and, like QNN-HTP/GPU, cannot take this graph: dynamic sequence length, data-dependent output length, `Loop`/`If`/`Sequence*`, `LSTM`, `ConvInteger` **[M: op inventory §1 E3]** | **[E]** RTF 0.15–0.30 (**[M]** 0.43 @ 4 threads on Broadwell-EP 2.2 GHz; Oryon ≈ 2.5–3× per core) | gate G-AND on the real phone |
| iPhone 17 | Core ML `.cpuOnly` (BNNS, SME2) | **No ANE in v0.2.0** — iOS 27 needs an app entitlement for background ANE and upstream documents process-killing Core ML bugs on the ANE/GPU routes **[S: FluidAudio `Documentation/TTS/KokoroAne.md`]** | **[E]** RTF 0.1–0.2 (upstream **[S]**: fp32 Vocoder 1.49 s per 23.6 s audio on iPhone 17 Pro Max) | gate G-IOS on the real phone |
| Any device → Mac on LAN | `mlx-audio` on Metal: Qwen3-TTS 0.6B/1.7B (or Kokoro) | **GPU: yes** | **[E]** Qwen3-0.6B RTF 0.3–0.6 on M-series | script verified by reading `mlx-audio` 0.6.5 source only; not executed (no Mac) → G-MLX |

So "GPU/NPU" is true for **Mac in-browser** and for **anything talking to the Mac GPU server**; on the two phones the *built-in* model is CPU-SIMD. A true Hexagon-NPU/ANE path needs a re-exported static-shape bucketed model (what FluidAudio's `ANE-v3` did) and is explicitly out of scope (§9).

### 0.3 Three findings that shaped the design (all measured)

1. **`model_fp16.onnx` / `model_q4f16.onnx` produce NaN audio** on CPU for normal sentence lengths (≥ 55 tokens) in native ORT 1.31.1 *and* ORT-web WASM **[M]**. They are banned.
2. **`model_quantized.onnx` (q8) produces 100 % NaN in `onnxruntime-web` 1.31.1 whenever `numThreads = 1`** (Chrome 148 and Node 22), yet is correct with 4 threads and in native ORT **[M]**. The web runtime therefore uses **fp32 only**; q8 is used only by native ORT on Android, behind a mandatory self-test.
3. **`hf-mirror.com` answers `308 → https://huggingface.co/...` from outside mainland China** **[M]**. The mirror cannot be validated from here, redirects must be followed across hosts, and integrity must never depend on the host: every file is pinned by size + SHA-256 (§3).

---

## 1. Empirical evidence log

| ID | What | Result |
|---|---|---|
| E1 | `GET https://{huggingface.co,hf-mirror.com}/api/models/onnx-community/Kokoro-82M-v1.1-zh-ONNX/tree/main?recursive=1` | Both 200, identical 118 entries. `config.json` is only `{"model_type":"style_text_to_speech_2"}` — **the vocab lives in `tokenizer.json`** (`model.vocab`, 172 symbols, max id 177, pad/unk `$` = 0). `onnx/`: `model.onnx` 339 369 442 B, `model_quantized.onnx` = `model_uint8.onnx` 127 356 597 B, `model_fp16.onnx` 163 630 554 B, `model_q4f16.onnx`, `model_q4.onnx`, `model_bnb4.onnx`, `model_int8.onnx`. `voices/`: **103 files** (55 `zf_*`, 45 `zm_*`, `af_maple`, `af_sol`, `bf_vale`), each exactly **522 240 B**. Repo HEAD `6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3`. |
| E2 | `onnx.load` of all four variants (`/tmp/kokoro_probe/inspect_onnx.py`) | Identical I/O in every variant: inputs **`input_ids` INT64 `[1, N]`**, **`style` FLOAT `[1, 256]`**, **`speed` FLOAT `[1]`**; outputs **`waveform` FLOAT `[num_samples]`**, **`duration` INT64 `[N]`**. Opset 17, IR 8, no external data. q8 adds `com.microsoft:DynamicQuantizeLSTM`, `ConvInteger`, `MatMulInteger`, `DynamicQuantizeLinear`. |
| E3 | Op inventory (fp32, 4 741 nodes) | Uses `LSTM`×6, `Resize`×6, `ScatterND`×7, `ScatterElements`×4, `TopK`×4, `LeakyRelu`×28, `Loop`, `If`×2, `SplitToSequence`/`SequenceAt`/`SequenceEmpty`/`SequenceInsert`/`ConcatFromSequence`, `CumSum`, `RandomUniformLike`, `RandomNormalLike`, `Atan`, `Round`, `Not`, `And` — **none of these 20 op types exist in `miniplayer/Sources/Core/Onnx/OnnxOps.swift`** (which has Add…ConvTranspose, 47 types) **[M: `grep 'case "'`]**. |
| E4 | Voice pack | `np.fromfile(...,float32).reshape(-1,1,256)` → **`(510, 1, 256)`** little-endian float32. Reference row selection **[S: `hexgrad/kokoro` `pipeline.py:242` `pack[len(ps)-1]`]**; `kokoro.js` uses `min(max(N_ids-2,0),509)` (= one row later). Spec uses the Python reference: `row = clamp(len(phonemes) − 1, 0, 509)`. Columns `[0,128)` = timbre (decoder), `[128,256)` = prosody style **[S: FluidAudio `KokoroAneVoicePack.swift`]**. |
| E5 | Native ORT 1.31.1 CPU, Broadwell Xeon 2.2 GHz (`run_ref.py`, `run_ref2.py`), official phonemes of "今天的天气真不错，阳光明媚，微风拂面。" (55 tokens) | q8: 4.85 s audio, synth 2.08 s → **RTF 0.43 @ 4 threads**, 1.14 @ 1 thread, peak 0.42, NaN 0. fp32: RTF 0.44 @ 4 threads. `speed=1.5` → 3.17 s (works). **`samples == 600 × Σ duration` exactly; `len(duration) == N`** (incl. both pads) → 25 ms/frame per-token timing for free. fp16 & q4f16: NaN for 55/66/78-token inputs (fine for 14 tokens). |
| E6 | ORT-web 1.31.1 (`/tmp/kokoro_probe/web/`), Node 22 + Chrome-for-Testing 148 headless | fp32 WASM: correct at 1 thread (RTF 4.4–4.9) and 4 threads (RTF 1.35–1.48). **q8 WASM: NaN at 1 thread (Node, Chrome with and without cross-origin isolation); correct at 4 threads (RTF 0.90)**. fp16 WASM: NaN. WebGPU: no adapter on this box. |
| E7 | CSP (Chrome 148, exact `DESKTOP_CONTENT_SECURITY_POLICY`) | Unmodified CSP: `CompileError: WebAssembly.instantiate() … violates … 'unsafe-eval' is not an allowed source`. With `script-src 'self' 'wasm-unsafe-eval'` + `worker-src 'self'`: module `Worker` + `ort.webgpu.min.mjs` + `ort-wasm-simd-threaded.asyncify.wasm` run with **0 `securitypolicyviolation` events**. Threads need `crossOriginIsolated`: verified with `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. 339 MB model fetched from loopback in ≈ 1.0–1.3 s. |
| E8 | Package facts | `onnxruntime-web` 1.31.1 MIT, **0 `.node` files, no `binding.gyp`** (tarball listing); needed assets: `ort.webgpu.min.mjs` 70 742 B, `ort-wasm-simd-threaded.asyncify.mjs` 53 457 B, `ort-wasm-simd-threaded.asyncify.wasm` 28 747 738 B. `onnxruntime-android` 1.32.0 AAR 59.3 MB; **arm64-v8a `libonnxruntime.so` 36.3 MB (13.7 MB deflated)** + JNI 0.12 MB. |
| E9 | Mirror / resume | `huggingface.co/.../resolve/<rev>/<file>` → `302` to `*.cdn.hf.co` with `x-linked-size` + `x-linked-etag` (= SHA-256 of the LFS object); `Range: bytes=1000-1999` → `206`, `content-range: bytes 1000-1999/127356597`, bytes identical to the local file. `hf-mirror.com/...` → **`308` to `huggingface.co`** from this network, then identical bytes. |
| E10 | Core ML repos | `FluidInference/kokoro-82m-coreml` (Apache-2.0 models, MIT conversion) contains **`ANE-zh/` = v1.1-zh**: `KokoroAlbert`, `KokoroPostAlbert`, `KokoroAlignment`, `KokoroProsody(_v2)`, `KokoroNoise(_v2)`, `KokoroVocoder(_v2)`, `KokoroTail(_v2)` as `.mlmodelc` **and** `.mlpackage`; `metadata.json` says **min iOS 17.0**, RangeDim inputs (tokens 2–512, frames ≤ 2000). Its `vocab.json` equals the ONNX vocab minus `$`; its `voices/*.bin` are **byte-identical** to the ONNX repo's (same LFS oid). `aufklarer/Kokoro-82M-CoreML` = v1.0 only (`af_heart`…, fixed 5 s graph); `mweinbach/Kokoro-82M-Swift` = v1.0 only (MLX + CoreML segments). Neither supports v1.1-zh. |
| E11 | Google3 | `third_party/apple_frameworks/BUILD` defines `CoreML`, `Accelerate`, `CryptoKit` targets **[M: grep]**; `//third_party/onnxruntime` is Linux/Android only **[S: memory topic `ios_blaze_fom_cloudsims.md` l.16]**. |
| E12 | `mlx-audio` 0.6.5 (PyPI, `>=3.10`) `server.py` | `mlx_audio.server --host --port`; `POST /v1/audio/speech` body `{model, input, voice, lang_code="a", instruct, ref_audio, ref_text, speed, response_format="mp3", …}`; **WAV is written with miniaudio, MP3 needs `ffmpeg`** (`audio_io.py`); `GET /v1/audio/voices?model=` → `{data:[{id,name}]}`. Qwen3 `lang_code` ∈ `auto|chinese|english|…` (lower-cased), speakers `Vivian, Serena, Uncle_Fu, Dylan, Eric, Ryan, Aiden`. Repos exist: `mlx-community/Qwen3-TTS-12Hz-{0.6B,1.7B}-CustomVoice-bf16` (2.5 / 4.5 GB), `mlx-community/Kokoro-82M-bf16` (v1.0). |
| E13 | User's `qwen-tts` server (`~/Developer/band/skills/qwen-tts/scripts/tts_server.py`) | `POST /synthesize {text, ref_audio, ref_text?, x_vector_only_mode=false}` → whole `audio/wav`; `GET /health → {status:"healthy", device, dtype, int8_talker, cached_embeddings}`; errors `500 {detail}`; `_INFER_LOCK` (single flight); `max_new_tokens=600` (≈ 48 s cap); `device = cuda if available else cpu` (**never MPS** → useless on a Mac GPU, hence the mlx-audio script). |
| E14 | G2P study (`g2p-prober`; persisted copy `g2p-prototype/` next to this spec: report, runnable JS port, exported data, 498 + 3 857-sentence misaki references) | see §4. |

---

## 2. Contract changes (`packages/core/src/types.ts`) — authoritative

```ts
export type SpeechEngineId = 'edge' | 'openai' | 'qwen' | 'kokoro';

export interface Voice {
  // …unchanged…
  readonly provider?: 'system' | 'edge' | 'openai' | 'qwen' | 'kokoro';
}

export type VoiceRef =
  | SystemVoiceRef
  | { readonly kind: 'edge'; readonly voiceId: string }
  | { readonly kind: 'openai'; readonly voiceId: string; readonly model: string }
  | { readonly kind: 'qwen'; readonly voiceId: string; readonly model: string }   // settings.qwenServer
  | { readonly kind: 'kokoro'; readonly voiceId: string };                        // e.g. 'zf_001'

export interface Utterance {
  // …unchanged fields…
  /**
   * Kokoro v1.1-zh token ids (tokenizer.json vocab), one array per ≤ KOKORO_MAX_CHUNK_TOKENS chunk,
   * WITHOUT the leading/trailing pad id 0 (every runtime adds `[0, …ids, 0]`).
   * Present only while the active voice is `kokoro` and `lang` is zh*/en*; absent ⇒ runtime uses systemFallback.
   */
  readonly phonemeIds?: readonly (readonly number[])[];
  /** Optional word timing skeleton: for chunk c, token range → UTF-16 range in `text`. */
  readonly phonemeSpans?: readonly (readonly KokoroWordSpan[])[];
}
export interface KokoroWordSpan { readonly t0: number; readonly t1: number; readonly c0: number; readonly c1: number; }

export interface SynthRequest {
  readonly engine: SpeechEngineId;            // was 'edge' | 'openai'
  readonly voiceId: string;
  readonly model?: string;
  readonly text: string;
  readonly lang: string;
  readonly baseUrl?: string;
  readonly phonemeIds?: readonly (readonly number[])[];      // engine === 'kokoro' (desktop path only)
  readonly phonemeSpans?: readonly (readonly KokoroWordSpan[])[];
}

export type SpeechEvent = /* …existing… */
  | { readonly type: 'engine-slow'; readonly rtf: number; readonly engine: SpeechEngineId };   // native Kokoro RTF EMA ≥ 0.9

// ---- on-device model management -------------------------------------------------
export type SpeechModelId = 'kokoro-v1.1-zh';
export type SpeechModelVariant = 'onnx-fp32' | 'onnx-q8' | 'coreml';
export type SpeechModelState = 'absent' | 'downloading' | 'paused' | 'verifying' | 'ready' | 'error';
export type SpeechModelBackend = 'webgpu' | 'wasm' | 'ort-cpu' | 'coreml-cpu';

export interface SpeechModelStatus {
  readonly id: SpeechModelId;
  readonly state: SpeechModelState;
  readonly variant: SpeechModelVariant;
  readonly bytesDone: number;                 // across model + requested voices, includes resumed .part bytes
  readonly bytesTotal: number;
  readonly installedBytes: number;
  readonly installedVoices: readonly string[];
  readonly source?: string;                   // host currently/last used, e.g. 'hf-mirror.com'
  readonly backend?: SpeechModelBackend;      // after first successful load
  readonly rtf?: number;                      // EMA of synth time / audio time
  readonly error?: MiniBookErrorShape;        // codes: 'network' | 'model-integrity' | 'storage-full' | 'model-selftest' | 'model-unstable'
}

export interface SpeechModelsApi {
  status(id: SpeechModelId): Promise<SpeechModelStatus>;
  /** Start or resume (idempotent). Resolves once the job is accepted; progress arrives as HostEvent 'speech-model'. */
  download(id: SpeechModelId, opts?: { readonly voices?: readonly string[] }): Promise<SpeechModelStatus>;
  /** Abort the transfer, KEEP `.part` files. */
  pause(id: SpeechModelId): Promise<SpeechModelStatus>;
  /** Unload the runtime and delete every file of the model including `.part`. */
  remove(id: SpeechModelId): Promise<void>;
}

export interface SpeechHostApi {
  synthesize(req: SynthRequest, signal?: AbortSignal): Promise<SynthResult>;
  listRemoteVoices(engine: 'edge' | 'openai' | 'qwen'): Promise<Voice[]>;
  clearCache(): Promise<void>;
  cacheSize(): Promise<number>;
  /** Absent ⇒ this host has no on-device neural engine (UI hides every Kokoro row). */
  readonly models?: SpeechModelsApi;
}

export type HostEvent = /* …existing… */
  | { readonly type: 'speech-model'; readonly status: SpeechModelStatus };

export interface HostCapabilities { /* …existing… */ readonly onDeviceNeuralSpeech: boolean; }
export interface StorageUsage { readonly booksBytes: number; readonly speechCacheBytes: number; readonly modelsBytes?: number; }

export type QwenProtocol = 'mlx-audio' | 'vllm-omni' | 'qwen-native';
export interface QwenServerConfig {
  readonly baseUrl: string;        // 'http://192.168.1.20:8000'
  readonly protocol: QwenProtocol;
  readonly model: string;          // HF repo id (ignored by 'qwen-native')
  readonly voice: string;          // speaker; for 'qwen-native' a display label
  readonly instruct?: string;
  readonly refAudio?: string;      // REQUIRED for 'qwen-native' (server-local path | URL | data: URI)
  readonly refText?: string;
  readonly xVectorOnly?: boolean;
}
export type ModelDownloadSource = 'auto' | 'huggingface' | 'hf-mirror' | 'custom';

export interface AppSettings {
  // …existing…
  readonly qwenServer: QwenServerConfig | null;          // default null
  readonly modelDownloadSource: ModelDownloadSource;     // default 'auto'
  readonly modelMirrorBaseUrl: string | null;            // default null; used when source === 'custom'
}
```

Rules:
- `SynthSchedulerConfig.engine` and `onEngineSlow.engine` widen to `SpeechEngineId`; when `engine === 'kokoro'` the scheduler copies `u.phonemeIds`/`u.phonemeSpans` into the request and uses `maxConcurrency: 1`; `engine === 'qwen'` also `maxConcurrency: 1` (single-flight servers).
- `computeSpeechCacheKey` input `model` for Kokoro = `` `v1.1-zh|${variant}|g2p${KOKORO_G2P_VERSION}` `` so a G2P fix invalidates cached audio.
- `ReadAloudController.resolvePreferredVoice`: a stored `kokoro` voice is honoured only if `host.speech.models` exists **and** the last known status is `ready` **and** the voice is in `installedVoices`; a stored `qwen` voice only if `settings.qwenServer`; otherwise `{kind:'system', voiceId:null}`.
- `ReadAloudController.configureSchedulerForVoice`: `system` → `configure(null)`; `kokoro` on hosts with `capabilities.nativeSpeechQueue` (Android/iOS) → **`configure(null)`** (native synthesises from `phonemeIds`); `kokoro` on desktop → `{engine:'kokoro', voiceId, maxConcurrency:1}`; `qwen` → `{engine:'qwen', voiceId, model, maxConcurrency:1}`.
- `plugin-types.ts` / Java `VoiceSpec` / Swift `SpeechVoiceRef` gain kinds `"kokoro"` and `"qwen"`; `UtteranceItem` gains `phonemeIds` (`long[][]` / `[[Int32]]`) and `phonemeSpans`.
- Speed: the model's `speed` input is the per-chunk pacing correction `phonemeSpeeds[c]` from core (§4.6, upstream `speed_callable`), **never the user rate**; the user rate stays a pitch-preserving playback rate (ExoPlayer / `AVPlayer` / `<audio>`), exactly like v0.1.0, so cached audio survives rate changes.
- `Utterance` / `SynthRequest` / native `UtteranceItem` also carry `phonemeSpeeds?: readonly number[]` (one per chunk, default 1.0).

---

## 3. Kokoro model pack, mirrors and the downloader

### 3.1 Pinned files (full list with SHA-256 in `kokoro-manifest.json`)

URL template: `{base}/{repo}/resolve/{revision}/{path}` with `base ∈ {https://huggingface.co, https://hf-mirror.com, custom}`.

| Variant | Platform | Repo @ revision | Files | Download |
|---|---|---|---|---|
| `onnx-fp32` | desktop (WebGPU + WASM) | `onnx-community/Kokoro-82M-v1.1-zh-ONNX` @ `6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3` | `onnx/model.onnx` 339 369 442 B sha256 `94b973941b1852754f979be5d5e20be666d5c81d9bb886b88ae1dc85c9b895ca` | **≈ 324 MiB** |
| `onnx-q8` | Android | same repo/revision | `onnx/model_quantized.onnx` 127 356 597 B sha256 `a39469be791eeaa3089c1ed5e58b8731d1f2462ea0e7dae2bc44388e58f973d8` | **≈ 121 MiB** |
| `coreml` | iOS | `FluidInference/kokoro-82m-coreml` @ `51c072023b254cd02368102ab88bcfbff6cad4cd` | 34 files under `ANE-zh/{KokoroAlbert,KokoroPostAlbert,KokoroAlignment,KokoroProsody_v2,KokoroNoise_v2,KokoroVocoder_v2,KokoroTail_v2}.mlmodelc/**` = 82 433 451 B | **≈ 79 MiB** |
| voices | all | ONNX repo/revision `voices/<id>.bin`, 522 240 B each | default set downloaded with the model: `zf_001`, `zm_010`, `af_maple`, `af_sol`, `bf_vale` (2.6 MB); the other 98 on demand | 0.5 MiB each |

`_v2` Core ML stages are mandatory (fp32 compute): upstream documents corrupted onsets from the fp16 Vocoder/Prosody on SME chips (A19, M5) **[S: repo README changelog 2026-09-25, 2026-11-08]**.

The vocab (172 entries) is **bundled in core** (`kokoro/vocab.ts`, generated from `tokenizer.json`, 2 KB) — `tokenizer.json`/`config.json` are not downloaded.

`packages/core/src/speech/kokoro/manifest.ts` is generated by `scripts/gen-kokoro-manifest.mjs` (reads the HF tree API for both pinned revisions, emits `{path,size,sha256}`; small non-LFS Core ML files are hashed by downloading them) and committed; `kokoro-manifest.json` next to this spec is its expected output (103 voices, 34 Core ML files).

### 3.2 Source order and the CN fallback

`resolveModelSources(settings, env)` in core returns an ordered list of bases:

| `modelDownloadSource` | Order |
|---|---|
| `auto` (default) | `[huggingface.co, hf-mirror.com]`; reversed when `Intl.DateTimeFormat().resolvedOptions().timeZone` ∈ {`Asia/Shanghai`, `Asia/Chongqing`, `Asia/Harbin`, `Asia/Urumqi`} or the UI locale is `zh-CN` |
| `huggingface` | `[huggingface.co]` |
| `hf-mirror` | `[hf-mirror.com]` |
| `custom` | `[modelMirrorBaseUrl, hf-mirror.com, huggingface.co]` |

The heuristic only saves the first time-out; correctness comes from the per-request fallback below. Redirects are followed (≤ 5 hops, `https` only) **only** to hosts in the allow-list: `huggingface.co`, `hf-mirror.com`, any host ending in `.hf.co`, `.huggingface.co`, `.hf-mirror.com`, plus the host of `modelMirrorBaseUrl`. Any other hop ⇒ treat as source failure. (Needed because HF `resolve` always 302s to a CDN and hf-mirror 308s to HF outside CN — E9.)

### 3.3 Downloader algorithm (identical semantics in Node, Java, Swift)

Storage root: desktop `<dataDir>/models/kokoro-v1.1-zh/`, Android `filesDir/MiniBookData/models/kokoro-v1.1-zh/`, iOS `Library/Application Support/MiniBookData/models/kokoro-v1.1-zh/` (excluded from iCloud backup; Android `allowBackup` excludes `models/` via `dataExtractionRules`). Files keep their repo-relative path (iOS needs the `.mlmodelc` directory layout).

```
download(files):                               # files = model variant + requested voices, in manifest order
  free-space check: need Σremaining + 64 MiB else error 'storage-full'
  for f in files:
    final = root/f.path ; part = final + '.part'
    if exists(final) and size(final) == f.size: continue          # verified when it was renamed
    offset = exists(part) ? size(part) : 0 ; if offset > f.size: delete(part); offset = 0
    for round in 0..4:                                             # back-off 0,1,2,4,8 s between rounds
      for base in sources (starting at lastGoodSource):
        GET {base}/{repo}/resolve/{rev}/{f.path}
            headers: Accept-Encoding: identity ; User-Agent: MiniBook/0.2.0 ; Range: bytes={offset}-   (only if offset > 0)
            time-outs: connect 8 s · first byte 15 s · stall (no bytes) 20 s
        206 and Content-Range start == offset and total == f.size → append
        200 while offset > 0 (Range ignored)                      → truncate part, write from 0
        416                                                       → delete part, offset = 0, retry same base
        401/403/404/429/5xx, disallowed redirect, network error, time-out → next base
        append to part (flush+fsync every 8 MiB); emit progress ≤ 1 event/s
        on EOF: offset = size(part); if offset < f.size → treat as stall (resume next base)
      if size(part) == f.size: break
    state = 'verifying'; sha256(part) streamed over the WHOLE file
      == f.sha256 → atomic rename part → final
      != f.sha256 → delete part; if first integrity failure for f: restart f from 0 with the other base first
                    else state 'error' { code: 'model-integrity' }
  write root/installed.json { revision, variant, files, voices, installedAt } atomically → state 'ready'
pause():   abort the in-flight request, keep .part, state 'paused'
remove():  unload runtime (close ORT session / release MLModels / terminate worker), delete root recursively
startup:   installed.json valid and every listed file present with the right size → 'ready'
           else any file or .part present → 'paused' (bytesDone = Σ sizes) ; else 'absent'
```

A pause/resume or a mid-file switch between `huggingface.co` and `hf-mirror.com` is safe because the final SHA-256 covers the whole file regardless of who served which range.

Honest limits: (a) Android/iOS downloads run in the app process (Android: a dedicated thread holding a partial `WakeLock` + `WifiLock`; iOS: `URLSession` data task inside a `beginBackgroundTask` grace window). If the OS kills or suspends the app the state becomes `paused` and one tap resumes from the `.part` offset — no foreground service / background-session complexity in v0.2.0. (b) `hf-mirror.com` behaviour inside mainland China (direct serve vs. redirect to its own CDN) is unverified from here; the suffix allow-list plus the `custom` base cover both.

---

## 4. G2P — one pure-TS implementation in `@minibook/core`

### 4.1 What the checkpoint was trained on (read from misaki 0.9.4 source + verified)

`hexgrad/Kokoro-82M-v1.1-zh` expects the output of misaki `ZHG2P(version='1.1')`. Its alphabet is **not pinyin**: Zhuyin initials, Zhuyin or single-Hanzi-alias finals, a tone digit, `R` for erhua, `/` between words, ASCII punctuation, and IPA for English spans.

```
text ─ cn2an.transform(text,'an2cn')                       # the only number normalisation misaki does
     ─ punctuation map: 、，→", "  。．→". "  ！→"! "  ：→": "  ；→"; "  ？→"? "  «《「【→' “'  »》」】→'” '  （→" ("  ）→") "
     ─ split into English spans  ([A-Za-z '-]*[A-Za-z][A-Za-z '-]*)  and everything else
        English span → English G2P (IPA, §4.5)
        other span   → jieba.posseg (dict DAG + POS-HMM) → ToneSandhi.pre_merge (不/一/reduplication/3rd-tone/儿 merges)
                       → per word: pypinyin INITIALS + FINALS_TONE3 (strict, neutral = 5; zi/ci/si → 'ii', zhi/chi/shi/ri → 'iii')
                       → 不-sandhi → 一-sandhi → 轻声 (word + POS) → 3rd-tone sandhi → erhua merge
                       → tokens = ZH_MAP[initial] + ZH_MAP[final] (+ 'R') + tone ; words joined by '/'
     ─ ' '.join(spans)
```

Token mapping (complete table in `g2p-prototype/zh-map.json`, ids from `tokenizer.json`):

| pinyin | tokens | ids | | pinyin | tokens | ids |
|---|---|---|---|---|---|---|
| `ni3`→(sandhi)`ni2` | `ㄋ ㄧ 2` | 73 127 172 | | `shi4` | `ㄕ 十 4` (`iii`→`十`) | 95 144 173 |
| `hao3` | `ㄏ ㄠ 3` | 88 108 169 | | `si1` | `ㄙ ㄭ 1` (`ii`→`ㄭ`) | 98 141 171 |
| `jin1` | `ㄐ 阴 1` (`in`→`阴`) | 89 151 171 | | `yue4` | `月 4` (`ve`→`月`) | 99 173 |
| `tian1` | `ㄊ 言 1` (`ian`→`言`) | 49 146 171 | | `guang1` | `ㄍ 王 1` (`uang`→`王`) | 79 163 171 |
| `cuo4` | `ㄘ 我 4` (`uo`→`我`) | 97 168 173 | | `dianr3` (一**点儿**) | `ㄉ 言 R 3` | 40 146 34 169 |
| word boundary | `/` | 7 | | `, ` `. ` | `,`+space, `.`+space | 3 16 / 4 16 |

Finals → alias: `ia 压, ian 言, iang 阳, iao 要, in 阴, ing 应, iong 用, iou 又, ong 中, ua 穵, uai 外, uan 万, uang 王, uei 为, uen 文, ueng 瓮, uo 我, ve 月, van 元, vn 云, iii 十, ii ㄭ`; the rest are plain Zhuyin (`a ㄚ, o ㄛ, e ㄜ, ie ㄝ, ai ㄞ, ei ㄟ, ao ㄠ, ou ㄡ, an ㄢ, en ㄣ, ang ㄤ, eng ㄥ, er ㄦ, i ㄧ, u ㄨ, v ㄩ`). Tones `1..5` → ids `171, 172, 169, 173, 170`.

**Ground truth I checked myself [M]:** the port below turns `今天的天气真不错，阳光明媚，微风拂面。` into `ㄐ阴1ㄊ言1/ㄉㄜ5/ㄊ言1ㄑㄧ4/ㄓㄣ1ㄅㄨ5ㄘ我4, 阳2ㄍ王1ㄇ应2ㄇㄟ4, 为1ㄈㄥ1/ㄈㄨ2ㄇ言4.` — character-for-character the official phoneme string in `FluidInference/kokoro-82m-coreml/ANE-zh/benchmark_data.json` — and that string synthesises to 4.85 s of finite audio in ORT (E5).

### 4.2 Why not `pinyin-pro` / `kokoro-js` (measured by `g2p-prober`, `g2p-prototype/REPORT.md`)

| Variant (vs real misaki, 498 novel-style sentences / 3 857-sentence corpus, 95 230 Hanzi) | exact sentences | syllables correct |
|---|---|---|
| `pinyin-pro` 3.29.5 + `Intl.Segmenter` | **6–13 %** | 95–96.7 % |
| pypinyin tables + `Intl.Segmenter` | 10–15 % | 97–97.7 % |
| **faithful port (JS jieba + posseg-HMM + pypinyin tables + cn2an + sandhi/erhua), pruned phrase list** | **498/498, 3 856/3 857** | **1 wrong syllable in 95 230** |
| faithful port, full phrase list | 498/498, 3 857/3 857 | 100 % |

Root cause: the `/` word-boundary token and every sandhi / 轻声 / erhua rule are scoped by **jieba words + POS**; any other segmenter (boundary F1 88 %) changes the token stream. `pinyin-pro` is therefore **not used** (its neutral tone is 0, its `segment()` is not a word segmenter). `kokoro-js` has no Mandarin G2P and its English path is `phonemizer` = eSpeak NG (GPL-3) → not used.

### 4.3 Module layout — zero dependencies, zero WASM, zero `.node`

`packages/core/src/speech/kokoro/` (ported from `g2p-prototype/js/*.mjs`, 17 KB + 12 KB minified):

| File | Port of | Notes |
|---|---|---|
| `vocab.ts` | `tokenizer.json` `model.vocab` | 172 symbols → ids; `encode(phonemes)` drops chars not in vocab (same as the HF normalizer) |
| `normalize.ts` | new, app-side (§4.4) | runs **before** the faithful pipeline |
| `cn2an.ts` | `cn2an.transform(…,'an2cn')` 0.5.24 | |
| `jieba.ts` | jieba 0.42.1: DAG/route, `cut` (finalseg HMM), `cut_for_search`, `posseg.cut` (POS-HMM) | uses the shipped CPython `log` table — V8 `Math.log` differs from CPython in the last bit for 77 of 5 087 frequencies |
| `pinyin.ts` | pypinyin 0.55.0 `lazy_pinyin` INITIALS / FINALS_TONE3 over exported tables (+ pypinyin-dict 0.9.0, misaki overrides) | emulates pypinyin's phrase-prefix quirk |
| `tone-sandhi.ts`, `zh-g2p.ts` | misaki `ToneSandhi`, `ZHFrontend`, `ZHG2P.__call__` | |
| `en-g2p.ts`, `en-lts.ts` | misaki `en.Lexicon` (POS-free) + last-resort letter-to-sound | §4.5 |
| `chunk.ts`, `speed.ts` | new | §4.6 |
| `index.ts` | `createKokoroG2P({ loadAsset })` → `{ phonemize(text, lang): KokoroG2PResult }` | `loadAsset(name): Promise<Uint8Array>` is injected — core stays platform-neutral |

`KOKORO_G2P_VERSION = 1` (part of every cache key).

**Data pack** `packages/core/assets/kokoro-g2p/v1/` — generated once by `scripts/build-kokoro-g2p-data.py` (`uv run --with jieba==0.42.1 --with pypinyin==0.55.0 --with pypinyin-dict==0.9.0 --with cn2an==0.5.24 --with misaki==0.9.4`, = `g2p-prototype/export_data.py`) and **committed** (CI needs no Python):

| Asset (gzip) | Content | gzip size |
|---|---|---|
| `jieba_dict.txt.gz` | 349 046 × `word freq POS` | 1.90 MB |
| `jieba_posseg.json.gz` / `jieba_finalseg.json.gz` / `jieba_logs.json.gz` | POS-HMM / BMES-HMM / CPython log table | 0.78 / 0.26 / 0.06 MB |
| `py_chars.txt.gz` / `py_phrases_pruned.txt.gz` / `py_syllables.json.gz` / `misaki_tables.json.gz` | pinyin tables, ZH_MAP, erhua & 轻声 lists | 0.16 / 0.36 / 0.004 / 0.003 MB |
| **zh total** | | **3.53 MB** |
| `en_us_gold.tsv.gz` + `en_us_silver.tsv.gz` (lazy, first Latin span only) | 183 562 lexicon entries | 1.37 MB |

They are **bundled as lazily-fetched static assets of the web bundle** (not in the JS chunks, not downloaded from Hugging Face — we host nothing): desktop `dist/web`, Android `www` (APK ≈ 6.6 → ≈ 25 MB with ORT), iOS `Resources/www`. Fetched with `fetch(url)` + `DecompressionStream('gzip')` (Chrome/WebView ≥ 80, Safari ≥ 16.4 — inside the v0.1.0 engine baseline) only when a Kokoro voice is first used.

### 4.4 App-side pre-normaliser (`normalize.ts`) — only changes which Hanzi are fed in

Being faithful to misaki also inherits its gaps (all verified on the Python side: phone numbers read as cardinals, `12:30`/`2024-01-15`/`1,234` garbled, `〇 ‘ ’ 『 』 ～` dropped as `❓`). Rules, each with a unit test, applied in order:

| Rule | Example → fed to G2P |
|---|---|
| NFKC for full-width ASCII digits/letters | `２０２４` → `2024` |
| quotes / dashes / ellipsis | `‘’『』` → `“”`, `...` → `…`, `--` → `——`, `[]{}` → `()` |
| `〇` → `零` | `二〇二四年` → `二零二四年` |
| ISO dates | `2024-01-15`, `2024/1/15` → `2024年1月15日` |
| clock times | `12:30` → `12点30分`, `12:30:45` → `12点30分45秒` |
| thousands separators | `1,234,567.89` → `1234567.89` |
| ranges | `45%～60%`, `3~5` → `45%到60%`, `3到5` |
| phone/ID digit runs (≥ 7 digits, or after 电话/手机/号码/编号/QQ/微信) | `13800138000` → `一三八零零一三八零零零` (digit-by-digit) |
| currency | `$19.99` → `19.99美元`, `¥5`/`￥5` → `5元` |
| everything still outside the vocab after G2P | dropped (as in misaki); never emits an id that is not in `vocab.ts` |

Not in v0.2.0: traditional→simplified conversion (traditional text is readable but segmentation/轻声 degrade), a polyphone override table (hook `overrides.ts` exists, ships empty; misaki's own ≈ 0.3 % polyphone errors are inherited).

### 4.5 English (embedded spans and `lang = en*` utterances)

Lookup `us_gold` → `us_silver` → case folding → `-s / -ed / -ing` stemming with misaki's phonological rules → numbers (cardinal / year / ordinal / decimal) → ALL-CAPS ≤ 5 letters spelled out → ≈ 60-rule letter-to-sound fallback. Post-processing as misaki v1.x (`ɾ→T`, `ʔ→t`). Every emitted symbol ∈ vocab (checked for all 183 562 entries).

Measured (5 408 words of public-domain prose vs misaki + spaCy): **OOV 1.68 %** (identical to misaki's own unknown count without espeak), **99.33 % of words identical**; embedded English inside Chinese sentences: **41/41 exact**. Honest limits: (a) no POS tagger → homographs (`read`, `live`, `use`, stressed/unstressed `that`) take the first lexicon reading; (b) the letter-to-sound fallback is crude (0.79 phoneme similarity to espeak-ng on 38 names/brands: `Starbucks` right, `Huawei`, `Xiaomi` wrong) — it guarantees nothing is dropped, not that names are pronounced well; (c) `bf_vale` (British) is fed the US lexicon in v0.2.0; (d) the gold/silver lexicons are covered only by misaki's repo-level Apache-2.0 notice — provenance of individual entries is undocumented upstream; `NOTICE` says so, and CMUdict (BSD-2) is the fallback plan if that is ever a problem.

### 4.6 Chunking and speed (`chunk.ts`, `speed.ts`)

Measured token cost: **3.60 tokens per Hanzi** (p99 4.33, max 5.11), digits up to 6.5 per char, English 0.99 per char; longest of 3 857 real sentences = 327 tokens. Upstream's own sample (`samples/make_zh.py`) notes the model rushes on long inputs and compensates with a speed curve. Therefore:

- Budget on **post-G2P token count**, never on input length. `KOKORO_TARGET_CHUNK_TOKENS = 150`, `KOKORO_MAX_CHUNK_TOKENS = 400` (model hard limit 510). A phoneme string longer than the target is split at the punctuation token nearest the middle (`, . ! ? ; : — …`), else at the nearest `/`, recursively; never inside a syllable. Most sentences are one chunk.
- `kokoroSpeed(n, voiceId)`: for `z*` voices `1.1 × (n ≤ 83 ? 1 : n < 183 ? 1 − (n − 83)/500 : 0.8)` (port of upstream `speed_callable`); for `a*/b*` voices `1.0`. Computed in core and shipped with the ids so no runtime re-implements it.

Result type:
```ts
export interface KokoroG2PResult {
  readonly phonemes: string;                          // for tests/debugging
  readonly phonemeIds: readonly (readonly number[])[]; // per chunk, no pads
  readonly phonemeSpeeds: readonly number[];           // per chunk, model `speed` input
}
```
`Utterance` and `SynthRequest` therefore carry `phonemeIds` **and** `phonemeSpeeds` (same length; a runtime that receives no speeds uses 1.0). `phonemeSpans` (word timing) stays reserved in the contract but is **not populated in v0.2.0** — offsets through number normalisation are not worth the risk now; Kokoro gets sentence-level highlight, like the `openai` engine. Runtimes emit marks only when spans are present.

### 4.7 Where it runs

A dedicated **module Web Worker in `@minibook/ui`** (`speech/kokoro-g2p.worker.ts`, client `KokoroG2PClient`): data load is ≈ 0.9 s and ≈ 54 MB heap on desktop V8 (expect 2–4× on phones; English lexicon +45 MB on first Latin span) — too much for the UI thread. No CSP change on any host: a same-origin module worker is covered by the existing `script-src 'self'` (desktop gets the explicit `worker-src 'self'` of §5.1). If `new Worker()` throws (unknown WebView quirk), the same module runs on the main thread, time-sliced per 20 sentences.

Throughput **[M, desktop V8]**: ≈ 52 ms per 1 000 Hanzi (≈ 1.3 ms per sentence) — a 1 000-sentence chapter takes ≈ 1.3 s in the background while the first sentences are already playing (§7.5 ordering). Not measured on JavaScriptCore / Android WebView → part of gates G-AND / G-IOS (budget: first sentence phonemised < 3 s after cold start, < 50 ms warm).

### 4.8 Licences

misaki Apache-2.0 (zh frontend / tone sandhi derived from PaddleSpeech, Apache-2.0) · jieba MIT · pypinyin MIT · pypinyin-dict MIT · cn2an MIT · lexicon data see §4.5(d). All are data/algorithm ports; nothing GPL enters the tree.

### 4.9 Tests (core, hermetic)

- Golden corpus committed as `packages/core/src/__tests__/fixtures/kokoro-g2p-ref.jsonl` (the 498 misaki reference sentences from `g2p-prototype/ref/ref.jsonl` + the 6 official `benchmark_data.json` cases): **100 % exact** required.
- Invariants over the corpus: every id ∈ `vocab.ts`; every chunk ≤ 400 tokens; chunks concatenate to the unsplit stream; no chunk starts with a tone digit or `R`.
- `normalize.ts` table above; `kokoroSpeed` values (83 → 1.1, 133 → 0.99, 183 → 0.88); English: 200 lexicon words + embedded-span cases + OOV fallback emits only vocab symbols.
- Assets load through an injected `fs` loader in Vitest; a size-budget test fails if the zh pack exceeds 4 MB gzip.

---

## 5. Runtime backends

Shared runtime contract (all three):

```
synthesizeUtterance(u, voiceId):
  pcm = [] ; marks = [] ; tOffsetMs = 0
  for c, ids in enumerate(u.phonemeIds):                     # 1 chunk for almost every sentence (§4.6)
    row   = clamp(len(ids) - 1, 0, 509)
    style = voice[row*256 : row*256+256]                      # float32 LE, file = 510×256
    (wave, dur) = MODEL(input_ids=[0, …ids, 0], style, speed=u.phonemeSpeeds?[c] ?? 1.0)   # dur: len(ids)+2 entries × 600 samples
    if u.phonemeSpans: marks += spans(u.phonemeSpans[c], dur, tOffsetMs)   # reserved; not populated in v0.2.0 (§4.6)
    pcm += wave ; tOffsetMs += len(wave) / 24
  reject if any sample is non-finite or max|pcm| < 1e-3       # → treated as synth failure → system fallback
  → 24 kHz mono PCM16 WAV file + durationMs + marks
```

**Self-test** (every platform, once per `(variant, runtime version, OS build)`, result cached in `installed.json`): synthesise `ㄋㄧ2ㄏㄠ3.` (ids `[73,127,172,88,108,169,4]`) with `zf_001`; pass ⇔ all samples finite ∧ `max|x| ≥ 0.01` ∧ `0.5 s ≤ duration ≤ 4 s`. Failure ⇒ `state:'error', code:'model-selftest'`, the voice falls back to system, Settings shows the one-line reason. This exists because silent-NaN failures are real (§0.3).

### 5.1 Mac / desktop — `onnxruntime-web` in a Web Worker (host-node client)

**Where the code lives:** `packages/host-node/src/client/kokoro/` (browser side of `RestHost`), *not* in `@minibook/ui`, so the 28.7 MB ORT WASM never enters the Android/iOS `www` bundle.

| File | Role |
|---|---|
| `src/models/model-store.ts` (server) | §3.3 downloader with `fetch` + `node:fs` + `node:crypto` (zero deps), status machine, SSE `speech-model` |
| `src/server/routes/api.ts` (server) | `GET /api/models/:id` · `POST /api/models/:id/download {variant, voices?}` · `POST /api/models/:id/pause` · `DELETE /api/models/:id` · `GET|HEAD /api/models/:id/file/*` (Range via `range-file.ts`, jail = model root, only names in the manifest) · `POST /api/speech/cache {key, mime, durationMs, marks?, audioBase64}` (same `SAFE key` regex as the cache, ≤ 32 MiB) |
| `src/client/kokoro/kokoro-web-engine.ts` | owns the worker, serialises jobs, voice-pack cache, WAV encoding, self-test, RTF EMA |
| `src/client/kokoro/kokoro.worker.ts` | loads ORT, creates the session, runs inference |
| `src/client/rest-host.ts` | `speech.models` (REST) and the `engine === 'kokoro'` branch of `speech.synthesize` |
| `scripts/copy-ort-assets.mjs` | copies exactly `ort.webgpu.min.mjs`, `ort-wasm-simd-threaded.asyncify.mjs`, `ort-wasm-simd-threaded.asyncify.wasm` from `node_modules/onnxruntime-web/dist/` to `packages/host-node/web/public/ort/` (git-ignored); run by `build:web` and `dev:web` |

`onnxruntime-web@1.31.1` is a **devDependency of `@minibook/host-node`** (types + asset source; pinned exactly). It has no `.node` binaries (E8); `scripts/check-native-deps.mjs` additionally gets `'onnxruntime-node'` in `NATIVE_NAMES` and scans **all** workspace packages' prod+dev trees for `*.node`/`binding.gyp` under `onnxruntime-*` so nobody can swap in the native binding.

**CSP / isolation (the only CSP change in v0.2.0; Android & iOS CSP are untouched):**

```ts
// packages/host-node/src/server/app.ts
"script-src 'self' 'wasm-unsafe-eval'",      // was "script-src 'self'" — needed for WebAssembly.instantiate (E7)
"worker-src 'self'",                         // new, explicit
// connect-src stays "'self' blob: data:" — the browser never talks to Hugging Face; host-node downloads.
```
plus on **every** response (static, API, SSE): `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin` (enables WASM threads; all app resources are already same-origin/blob/data, so nothing else changes — the existing Playwright suite is the regression gate). `STATIC_MIME['.wasm'] = 'application/wasm'`. Same two CSP tokens + headers in `packages/ui/index.html` (dev) and `web/vite.config.ts` `server.headers`. `'wasm-unsafe-eval'` permits WASM compilation only — not `eval`/`new Function`.

**Worker:**

```ts
// kokoro.worker.ts (module worker, built by Vite; ORT loaded as an un-bundled same-origin module)
const ort = await import(/* @vite-ignore */ `${self.location.origin}/ort/ort.webgpu.min.mjs`);
ort.env.wasm.wasmPaths = '/ort/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(2, Math.min(4, navigator.hardwareConcurrency - 2)) : 1;
const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter().catch(() => null) : null;
const bytes = new Uint8Array(await (await fetch('/api/models/kokoro-v1.1-zh/file/onnx/model.onnx')).arrayBuffer());
for (const ep of adapter ? ['webgpu', 'wasm'] : ['wasm']) {
  try { session = await ort.InferenceSession.create(bytes, { executionProviders: [ep], graphOptimizationLevel: 'all' });
        if (await selfTest(session)) { backend = ep; break; } await session.release(); } catch { /* next EP */ }
}
// run(): feeds = { input_ids: Tensor('int64', BigInt64Array, [1,N]), style: Tensor('float32', Float32Array(256), [1,256]),
//                  speed: Tensor('float32', [1], [1]) }  → { waveform, duration }
```
- **Variant is always `onnx-fp32`** on desktop: WebGPU needs float weights, and q8 is NaN under single-thread WASM (§0.3). One file serves both EPs.
- One job at a time (`maxConcurrency: 1`); an aborted request is not interrupted mid-run — its result is dropped by generation check.
- Worker is created lazily on first Kokoro synth, terminated on `models.remove()` and after 10 min idle.
- Memory **[E]**: 324 MiB weights + ORT arenas ≈ 0.8–1.2 GB in the worker; acceptable on the target Macs, shown nowhere on phones.

**`RestHost.speech.synthesize` (`engine:'kokoro'`):** `key = computeSpeechCacheKey(...)` → `HEAD /api/speech/audio/:key` hit ⇒ `{ref, cached:true}`; miss ⇒ engine → WAV → `POST /api/speech/cache` ⇒ `{ref:'/api/speech/audio/<key>', mime:'audio/wav', durationMs, marks, synthMs, bytes, cached:false}`. Playback, 8 s/2 s sticky fallback, rate and Media Session are the unchanged `WebSpeechPlayer` paths. `offline` no longer shortens the fallback timer for `kokoro` (local engine): `WebSpeechPlayer` uses 8 s for `kokoro` regardless of `navigator.onLine`.

**Screen-off / background (PC):** unchanged v0.1.0 rule — the tab must stay open; `SynthScheduler` keeps 120 s ahead when hidden and uses no timers. Gate **G-MAC**: on an Apple-Silicon Mac in Chrome and Safari — backend reported `webgpu`, self-test passes, RTF ≤ 0.3, 30 min continuous playback in a background tab without fallback.

### 5.2 Android (OnePlus 13T) — `onnxruntime-android` inside `ReadAloudService`

**Gradle (`android/app/build.gradle`):**
```gradle
defaultConfig { versionCode 2; versionName "0.2.0" }
buildTypes {
  release { ndk { abiFilters "arm64-v8a" } }               // +13.9 MB APK (36.4 MB installed) — E8
  debug   { ndk { abiFilters "arm64-v8a", "x86_64" } }     // emulator
}
dependencies { implementation "com.microsoft.onnxruntime:onnxruntime-android:1.32.0" }
```
`proguard-rules.pro`: `-keep class ai.onnxruntime.** { *; }` (minify is off today; future-proof). Release check: `zipalign -c -P 16 -v 4 app-release.apk` must pass (16 KB page compatibility of the bundled `.so`). `capabilities.onDeviceNeuralSpeech = Build.SUPPORTED_ABIS contains "arm64-v8a" || "x86_64"` (32-bit devices: rows hidden).

**New Java classes (`dev.minibook.app`)** — pure-Java logic stays unit-testable, ORT is behind an interface:

| Class | Responsibility |
|---|---|
| `ModelDownloader` | §3.3 with OkHttp (`followRedirects(true)`, network interceptor enforcing the host allow-list on every hop, per-call time-outs), `MessageDigest` SHA-256, `AtomicFiles` rename; dedicated single thread; partial `WakeLock` + `WifiLock` while active |
| `KokoroModelStore` | paths, `installed.json`, `float[] styleRow(voiceId, tokenCount)` via `RandomAccessFile` (`ByteOrder.LITTLE_ENDIAN`, offset `row*1024`), self-test cache |
| `KokoroInference` (interface) | `Result synthesize(long[] inputIds, float[] style) throws Exception; void cancel(); void close();` |
| `OrtKokoroInference` | `OrtEnvironment` + `OrtSession`; options: `setIntraOpNumThreads(min(4, max(2, cores-2)))`, `setInterOpNumThreads(1)`, `setExecutionMode(SEQUENTIAL)`, `setOptimizationLevel(ALL_OPT)`, `addConfigEntry("session.intra_op.allow_spinning","0")` (no busy-spin between sentences); **CPU EP only** — no `addNnapi()` / `addXnnpack()` (§0.2). Inputs `OnnxTensor.createTensor(env, LongBuffer, {1,N})`, `FloatBuffer {1,256}`, `FloatBuffer {1}`; outputs by name `waveform` (`float[]`), `duration` (`long[]`). `cancel()` = `RunOptions.setTerminate(true)`. Session closed after 5 min without playback. |
| `KokoroSynthQueue` | the lookahead worker (below) on `HandlerThread("kokoro-synth")`; writes `cacheDir/speech/kokoro-<sha256>.wav` (same LRU as the speech cache), posts `engine.attachAudio(id, path, durationMs, marks)` to the main looper |

**`ReadAloudQueueEngine` changes (still pure Java):**
- `VoiceSpec.kind` accepts `"kokoro"`, `"qwen"`; `UtteranceItem` parses `phonemeIds` (`long[][]`) and `phonemeSpans`; `enqueue()` upsert already preserves `audio` for a replaced id (JS re-enqueues the same ids when it adds `phonemeIds`).
- New collaborator `interface LocalSynth { void onPlan(List<UtteranceItem> queue, int currentIndex, VoiceSpec voice, int generation); void cancelAll(); }`, invoked on `enqueue`, `seekTo`, `setVoice`, utterance advance, `pause`→`play`, `stop`.
- `startCurrentUtterance()` for `kind == "kokoro"`: (a) `item.phonemeIds == null` ⇒ speak this utterance with `systemFallback` immediately (`usingFallback = true`, **not** sticky; if `systemFallback == null` skip it); (b) `item.audio != null` ⇒ `playAttachedAudio`; (c) else `buffering` + keep-alive silence + fallback timer **`LOCAL_SYNTH_FALLBACK_TIMEOUT_MS = 8 000` independent of `NetworkChecker`** (reason `"local-synth-timeout"`), then the existing paragraph-sticky system fallback.
- `kind == "qwen"` behaves exactly like `"openai"` (JS attaches audio).

**Lookahead policy (`KokoroSynthQueue.onPlan`)** — runs entirely natively, so nothing depends on WebView JS between sentences:
```
target: Σ durationMs of consecutive ready items from currentIndex ≥ 45 000 ms, at most 12 items ahead
order : currentIndex first (alone), then strictly forward; items without phonemeIds are skipped
on new generation (seek / voice change / stop): RunOptions.setTerminate on the in-flight run, drop its result
cache : key = sha256(variant | voiceId | g2pVersion | ids) → existing file ⇒ attach immediately (no inference)
RTF   : EMA over 8 runs; when ≥ 3 samples and EMA ≥ 0.9 → emit plugin event 'engine-slow' {rtf}
failure (exception, NaN, silent): mark item failed → engine falls back for that paragraph (existing onError path)
```
**Screen-off survival:** `ReadAloudService` is already a `mediaPlayback` foreground service holding a partial `WakeLock` while `playing|buffering` (v0.1.0). Synthesis happens on `kokoro-synth` + ORT's pool — **never the main looper**. The native queue holds the whole current + next section (v0.1.0 `stockAheadUntilHorizon`), each item carrying its `phonemeIds`; JS is only needed for `queue-low` top-ups, exactly as for the system voice. Memory **[E]** 250–400 MB RSS while loaded (12–16 GB device).

Bridge additions (`plugin-types.ts`, flat names): `modelStatus({id})`, `modelDownload({id, variant, files:[{path,size,sha256}], repo, revision, sources:[base…], allowHosts:[…]})`, `modelPause({id})`, `modelRemove({id})`; events `speech-model` (status) and `engine-slow`. Core passes the manifest; native stays URL-agnostic but **enforces** `https`, the suffix allow-list, the `models/<id>/` jail (`AtomicFiles.resolveInJail`), a safe-path regex `^[A-Za-z0-9._/-]+$` without `..`, and the SHA-256.

Gate **G-AND** (OnePlus 13T, release APK): self-test passes; RTF ≤ 0.5 at 1.0× (else the existing slow-voice line appears and the README recommends the Mac server); 2 h screen-off playback of a zh novel with 0 fallbacks, 0 ANR, and < 12 %/h battery **[E]**.

### 5.3 iOS (iPhone 17) — Core ML chain in native Swift

**Decision and the alternatives I rejected (evidence in §1):**

| Option | Verdict |
|---|---|
| **A. Core ML 7-stage `ANE-zh` chain, `.cpuOnly`, native Swift** | **Chosen.** Only option that exists today for v1.1-zh (E10), needs only Apple frameworks that Google3 exposes (E11), runs natively in the background, min iOS 17 = our minimum, ≈ 79 MiB. Risk: Apple Core ML runtime bugs (below) — contained by routing, padding, `_v2` stages, crash sentinel. |
| B. Extend `miniplayer` pure-Swift `OnnxExecutor` (Accelerate) | Rejected for v0.2.0: 20 missing op types incl. `LSTM`, `Loop`/`If` sub-graphs and 5 sequence ops (E3), a 325 MiB fp32 model, unmeasured speed. Kept as the documented contingency if gate G-IOS fails (§9). |
| C. `onnxruntime-web` inside `WKWebView`, pre-synthesising into the `AVQueuePlayer` file queue | Rejected: WKWebView JS cannot be relied on with the screen locked (v0.1.0 already assumes that), WASM q8 is NaN single-threaded and threads need cross-origin isolation that `capacitor://localhost` cannot give; fp32 would hold ≈ 1 GB in the WebContent process (Jetsam). Only "pre-synthesise while awake" would work — not "hours with the screen off". |
| D. `//third_party/onnxruntime` / sherpa-onnx | Not buildable for `ios_arm64` in Google3 (memory topic l.16). |
| `aufklarer/…-CoreML`, `mweinbach/…-Swift` | v1.0 only — no Chinese v1.1 vocab/weights (E10). |

**Honest risk statement [S: FluidAudio `KokoroAne.md` §constraints]:** upstream reports (1) `libBNNS` segfaults on iOS 26.4–26.5, (2) MPSGraph aborts whenever a stage runs on GPU on iOS 27, (3) an fp16 input over-read in the Vocoder (fixed by padding inputs), (4) "robotic onset" from fp16 Vocoder/Prosody on SME chips (fixed by `_v2` fp32 stages), (5) iOS 27 needs entitlement `com.apple.developer.background-tasks.continued-processing.inference` to use the **ANE** in the background, and concludes that *no iOS routing is yet demonstrated safe for long sessions*. v0.2.0 therefore: **`.cpuOnly` for all seven stages** (no ANE ⇒ no entitlement, no 20 s ANE compile; no GPU ⇒ no MPSGraph), `_v2` stages, page-padded inputs, and a **crash sentinel** that turns the engine off after two crashes on the same OS build. The feature is labelled **Beta** on iOS. If G-IOS fails, v0.2.0 ships iOS with the Kokoro rows hidden (`models` absent) and option B is scheduled — everything else in this spec is unaffected.

**BUILD (`//experimental/users/chii/ios/minibook`):**
```python
swift_library(
    name = "MiniBookKokoro",
    srcs = glob(["Sources/Kokoro/*.swift"]),
    deps = [
        ":MiniBookCore",
        "//third_party/apple_frameworks:Accelerate",
        "//third_party/apple_frameworks:CoreML",
        "//third_party/apple_frameworks:CryptoKit",
        "//third_party/apple_frameworks:Foundation",
    ],
)
# :MiniBookSpeech and :MiniBookCapacitor add ":MiniBookKokoro"; :MiniBookTestsLib adds Tests/MiniBookKokoroTests.swift
```
No `module_name`, no `sdk_frameworks`, no third-party code: the glue is written from the published model I/O (`metadata.json`), not copied from FluidAudio. `Info.plist`: `CFBundleShortVersionString 0.2.0`, `CFBundleVersion 2`; `NSLocalNetworkUsageDescription` text extended to mention the local GPU speech server. `UIBackgroundModes: [audio]` unchanged; **no new entitlement**.

**Sources/Kokoro/**

| File | Content |
|---|---|
| `ModelDownloader.swift` | §3.3 with one `URLSession` (delegate `willPerformHTTPRedirection` enforces the allow-list; `Range` header; `FileHandle` append; `CryptoKit.SHA256` streaming), `final class … : NSObject, URLSessionDataDelegate, @unchecked Sendable` with an internal lock (same pattern as `MiniBookHttpClient`) |
| `KokoroModelStore.swift` | paths, `installed.json`, `styleRow(voice:tokenCount:) -> (timbre:[Float], style:[Float])` (`row = clamp(n-1,0,509)`; timbre = `[0,128)`, style = `[128,256)`), `isExcludedFromBackup` |
| `KokoroCoreMLChain.swift` | the 7 `MLModel`s + inference (below); `final class … : @unchecked Sendable`, all work on one serial `DispatchQueue(label:"kokoro.synth", qos:.userInitiated)`, **synchronous** `model.prediction(from:)`; `@preconcurrency import CoreML` |
| `KokoroSynthQueue.swift` | same lookahead policy as Android §5.2; delivers `(id, fileURL.path, durationMs, [SpeechWordMark])` to the `@MainActor` engine via `Task { @MainActor in … }` (all payload types `Sendable`) |
| `KokoroHealth.swift` | crash sentinel + self-test cache |

**Chain (names/dtypes/ranges verified from each stage's `metadata.json`, E10):**

```
T = len(ids)+2 (≤ 512) ; input_ids Int32 [1,T] = [0, …ids, 0] ; attention_mask Int32 [1,T] = 1
1 KokoroAlbert      (input_ids, attention_mask)                                   → bert_dur  F16 [1,T,768]
2 KokoroPostAlbert  (bert_dur, input_ids, style_s F16 [1,128], speed F16 [1]=phonemeSpeeds[c], attention_mask)
                                                                                  → duration F16 [1,T], d F16 [1,T,640], t_en F16 [1,512,T]
  pred_dur[i] = Int32(clamp(round(duration[i]), 1, 2000)) ; reject non-finite ; F = Σ pred_dur
  if F > 1000: split ids at the word boundary nearest the middle and run both halves separately (bounds memory, model cap is 2000)
3 KokoroAlignment   (pred_dur Int32 [1,T], d, t_en)                               → en F16 [1,640,F], asr F16 [1,512,F]
4 KokoroProsody_v2  (en, style_s)                                                 → F0 [1,2F], N [1,2F]
5 KokoroNoise_v2    (F0_curve F32 [1,2F], style_timbre F32 [1,128])               → x_source_0 [1,256,20F], x_source_1 [1,128,120F+1]
6 KokoroVocoder_v2  (asr, F0_curve F16, N_pred F16, x_source_0 F16, x_source_1 F16, style_timbre F16 [1,128])
                                                                                  → x_pre F32 [1,128,·]  (ignore 'anchor')
7 KokoroTail_v2     (x_pre F32)                                                   → audio F32 [600·F]
```
- `MLModelConfiguration().computeUnits = .cpuOnly` for every stage; models loaded with `MLModel(contentsOf: <root>/ANE-zh/<Stage>.mlmodelc, configuration:)` (compiled bundles load from any file URL — no on-device compilation).
- Every input `MLMultiArray` is created with `MLMultiArray(dataPointer:shape:dataType:strides:deallocator:)` over a page-aligned, zero-filled `posix_memalign` buffer that is **one page longer** than the data (over-read mitigation); outputs are copied into such buffers before being fed to the next stage (also converts F16↔F32 with `vImageConvert_Planar16FtoPlanarF`/`…FtoPlanar16F`).
- Per-token timing for marks comes from `pred_dur` (same 25 ms frames as the ONNX `duration`).
- Models are loaded on first use (≈ 0.3 s warm **[S]**) and released after 5 min without playback or on a memory warning.
- Memory **[E]**: ≤ 1000 frames per run bounds the largest tensors (128 × 240 000 × 4 B ≈ 123 MB each) to roughly 0.5 GB peak on an 8 GB phone; upstream's only Jetsam report is a 3 GB iPhone XR.

**Crash sentinel (`KokoroHealth`)**: before each chain run write `models/…/inflight` (OS build + timestamp), delete it after. At launch: if present ⇒ `crashes[osBuild] += 1`; at 2 ⇒ status `error {code:'model-unstable'}` until the OS build changes or the user taps *Try again*. `SpeechJournal` already persists the position per utterance, so a crash loses at most the current sentence.

**Engine integration (`MiniBookSpeechEngine`)** mirrors Android: `SpeechVoiceRef.kokoro(voiceId)`, `.qwen(voiceId, model)`; `SpeechUtteranceItem.phonemeIds: [[Int32]]?`; `kokoro` without ids ⇒ immediate non-sticky system fallback; with audio ⇒ `AVQueuePlayerSpeechBackend`; else buffering + silent keep-alive + **8 s** local-synth fallback timer. Because the queue, the synthesis and the playback are all native and the app holds an active `.playback` audio session, **screen-off playback does not depend on WKWebView**. WKWebView CSP is unchanged (no WASM, no new origins).

Tests (`ios_unit_test`, hostless-safe): chain glue behind `protocol KokoroStageRunning` with a fake (duration rounding, >1000-frame split, voice row/half selection, mark timing, non-finite rejection); downloader against `URLProtocol` stubs (206 resume, 200-ignored-range, 416, redirect allow-list, SHA mismatch, pause keeps `.part`, remove deletes all); sentinel logic; engine state machine with a fake `LocalSynth`. Real Core ML inference is **not** unit-tested (79 MiB download is not hermetic) — it is covered by gate **G-IOS** (CloudSims simulator smoke with the model side-loaded for functional correctness, then Dogfoody build on a physical iPhone 17: self-test, RTF ≤ 0.5, **60 min screen-locked playback with 0 crashes / 0 fallbacks**, peak footprint < 1.2 GB in Xcode-less `os_proc_available_memory` logging).

---

## 6. First-class Qwen3-TTS / local GPU server

### 6.1 `QwenSpeechProvider` (`packages/core/src/speech/providers/QwenSpeechProvider.ts`)

Platform-neutral like the other providers (injected `HttpTransport`). One class, three wire protocols selected by `QwenServerConfig.protocol`:

| | `mlx-audio` (Mac GPU script, §6.3) | `vllm-omni` | `qwen-native` (the user's `qwen-tts` service, E13) |
|---|---|---|---|
| Synthesis | `POST {base}/v1/audio/speech` | `POST {base}/v1/audio/speech` | `POST {base}/synthesize` |
| JSON body | `{model, input, voice, lang_code, response_format:"wav", speed:1.0, instruct?, ref_audio?, ref_text?}` | `{model, input, voice: lower(voice), language, response_format:"wav", instructions?}` | `{text, ref_audio, ref_text?, x_vector_only_mode}` |
| Language field | Qwen models: `lang_code` = `chinese` \| `english` \| `japanese` \| `korean` \| `auto`; model id matching `/kokoro/i`: `z` (zh), `j` (ja), `b` (voice `b?_*`), else `a` | `language` = `Chinese` \| `English` \| … \| `Auto` | none (server uses `Auto`) |
| Response | `audio/wav` (miniaudio; **never ask mlx-audio for mp3 — needs ffmpeg**, E12) | `audio/wav` | `audio/wav` 24 kHz mono |
| Voices | Qwen3 CustomVoice: static `Vivian, Serena, Uncle_Fu, Dylan, Eric` (zh) · `Ryan, Aiden` (en); Kokoro: `GET /v1/audio/voices?model=` → `{data:[{id,name}]}` | `GET /v1/audio/voices` → `{voices:[…]}` | one pseudo-voice (label = `config.voice` or "Cloned voice") |
| Health / Test | `GET /v1/models` | `GET /v1/models` | `GET /health` → `status == "healthy"` |
| Time-out | 60 s | 60 s | 150 s (server is single-flight; CPU RTF ≈ 4.5 per TTS_RESEARCH) |
| Concurrency | 1 | 1 (scheduler probes up as today) | 1 |

Implementation notes:
- `mlx-audio`/`vllm-omni` delegate to `OpenAiSpeechProvider.synthesize`, which gains `extraBody?: Readonly<Record<string, unknown>>` (shallow-merged into the JSON body) and already supports `responseFormat: 'wav'`. `OpenAiSpeechProvider.listVoices` additionally accepts `{data:[…]}` and an optional `model` query parameter.
- `qwen-native` guard for the 48 s server cap: `splitForQwen(text)` — if the estimated duration (CJK 5.5 chars/s, otherwise 14 chars/s) exceeds 30 s, split at `，、；：,;:` / whitespace into ≤ 25 s pieces, synthesise sequentially, merge with `concatWav()` (`core/src/speech/wav.ts`: RIFF parse, identical `fmt ` required, new header). `ref_audio` is mandatory; missing ⇒ `MiniBookError('invalid-argument')` surfaced by the Test button. The server's `clean_text()` still drops bracketed text — documented, not fixable client-side.
- Errors: 401/403 → `speech-auth`; other non-2xx / empty body → `speech-unavailable` (FastAPI `{detail}` appended to the message).
- Cache key `model` component: `` `${protocol}|${model}|${instruct ?? ''}|${sha256(refAudio + '\n' + (refText ?? '')).slice(0,16)}` ``.
- Optional bearer secret name `qwen-api-key` (sent only when set).

### 6.2 Host wiring

- **host-node** `SynthService`: `engine === 'qwen'` branch (requires `settings.qwenServer`, same caller-`baseUrl` rejection rule as `openai`); `assertAllowedOutboundSpeechUrl` / `createNodeHttpTransport` accept the origins of **both** `customSpeechServer.baseUrl` and `qwenServer.baseUrl`. `listRemoteVoices('qwen')`.
- **Android / iOS** (`capacitor-host.ts`): same branch through the plugin HTTP transport; wherever native code derives the allowed custom-server origin from persisted settings (iOS `readConfiguredCustomSpeechOrigin`, Android equivalent), also accept `qwenServer.baseUrl`. Android already has `usesCleartextTraffic="true"`; iOS already has `NSAllowsArbitraryLoads` + `NSLocalNetworkUsageDescription` (text updated).
- Audio is attached exactly like `openai` today (`speech.cachePut` → `attachAudio`), so background behaviour, the 8 s/2 s sticky fallback and the RTF warning (`onEngineSlow`) are inherited unchanged. This is the path that puts a real GPU behind the iPhone 17 and the OnePlus 13T.

### 6.3 `scripts/mac-gpu-tts-server.sh` (full file next to this spec)

```
scripts/mac-gpu-tts-server.sh [qwen-0.6b | qwen-1.7b | kokoro]        # default qwen-0.6b
  → uv tool run --python 3.12 --prerelease=allow --from "mlx-audio[server]==0.6.5" [--with "misaki[zh,en]" --with pip]
        mlx_audio.server --host 0.0.0.0 --port 8000
```
- Checks Apple Silicon + `uv`; exports `HF_ENDPOINT=https://hf-mirror.com` when `huggingface.co` is unreachable (honoured by `huggingface_hub`); prints the exact **URL / Model / Voice** to enter in Books; waits for `GET /v1/models`, then sends one warm-up `POST /v1/audio/speech` (`response_format:"wav"`) so the multi-GB first-run download and Metal warm-up happen before the first page is read; prints `READY`.
- Written for macOS `/bin/bash` 3.2 (`${ARR[@]+"${ARR[@]}"}`), `bash -n` clean **[M]**. Presets: `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16` (Vivian), `…-1.7B-CustomVoice-bf16`, `mlx-community/Kokoro-82M-bf16` (v1.0 voices, e.g. `zf_xiaoxiao`; needs `misaki[zh,en]` + `pip` for misaki's spaCy download).
- No authentication → banner says "trusted LAN only".
- **[M]** On Linux the exact command resolves and installs (53 packages; `webrtcvad` is compiled from sdist ⇒ the script checks for Xcode Command Line Tools) and reaches the `mlx_audio.server` entry point, which then stops at `import mlx.core` (`libmlx.so` is Apple-only) — so dependency resolution and the entry-point name are verified, **execution on a Mac is not**. Flags, body fields and repo ids are verified against `mlx-audio` 0.6.5 source and the HF API (E12). Gate **G-MLX**: run on the user's Mac, `Test` from Mac + iPhone + OnePlus → RTF < 1.

---

## 7. UI (`@minibook/ui`) — Apple-Books calm, E-Ink 1-bit safe

No new colours, icons, radii, shadows, transitions or animations. Every new rule uses existing `var(--mb-*)` tokens only, so the CSS-AST lint (`css-lint.test.ts`) and the `:root[data-eink="1"]` 2-colour guard hold by construction. All new lists are `PagedList`s; all new controls are existing components (`Toggle`, `Segmented`, `Stepper`, `mb-list-row`, `mb-link-btn`, text inputs).

### 7.1 Settings → READ ALOUD (6 rows, was 4)

```
READ ALOUD
  Voice                                   System default ▸
  On-device neural voice                    Not downloaded ▸      ← hidden when host.speech.models is undefined
  Edge neural voices                                  [ Off ]
  Local GPU server                                 Not set ▸      ← NEW (Qwen3-TTS · mlx-audio)
  Custom speech server                             Not set ▸
  Fall back to system voice                           [ On  ]
```
Row meta for "On-device neural voice": `Not downloaded` · `45%` · `Paused 45%` · `Ready` · `Needs attention`.
"Storage" row (ABOUT) total now includes `modelsBytes`; its **Clear** button still clears only the speech cache.

### 7.2 Sheet "On-device neural voice" (`openSheet('kokoro-model')`)

```
Kokoro · 中文 + English                                (iOS adds: Beta)
Runs on this device. Works offline.

<status line>                                          [ <action> ]
Download from          [ Auto | Hugging Face | Mirror ]
Custom mirror          ( https://…  optional )
More voices                                                     ▸      ← only when Ready
```

| State | Status line | Action |
|---|---|---|
| `absent` | `121 MB download` (desktop `324 MB`, iOS `79 MB`) | **Download** |
| `downloading` | `Downloading 45% · 54 / 121 MB` (source host in the caption line after the first fallback: `via hf-mirror.com`) | **Pause** |
| `paused` | `Paused · 45%` | **Resume** |
| `verifying` | `Checking…` | — |
| `ready` | `Ready · 121 MB · 4.2× real-time` (`1/rtf`, shown once measured) | **Delete** → label becomes **Delete?** for 4 s; second tap deletes (no modal) |
| `error` | one line: `No connection` / `Not enough storage` / `Download damaged — retry` / `Not supported on this device` / `Turned off after a crash` | **Retry** (or **Try again**) |

**Progress rendering**
- Normal mode: the status text plus the existing 2 px `.mb-progress-track`/`.mb-progress-fill` under it; width and text change at most **once per second**; no CSS transition.
- **E-Ink (`data-eink="1"`)**: the bar is `display: none`; progress is the stepped text **`[ 45% ]`**, repainted only when the value crosses a multiple of **5 %** *and* ≥ 3 s passed since the previous repaint (≤ 20 partial refreshes per download, never more than 1 update/s); state changes repaint immediately. No spinner, no dots animation ("Checking…" is static text).
- Status events arrive via `HostEvent 'speech-model'` (hosts emit ≤ 1/s); `useSpeechModelStatus()` keeps the last status in a tiny zustand store shared by Settings and `VoiceSheet`.

"More voices" → `PagedList` (`layer="sheet"`, 48 px rows) of the 103 voices filtered by the UI language first: `Kokoro 女声 001 … ✓` (installed) or a right-aligned **Get** link (`models.download(id, {voices:[v]})`, 0.5 MB; the link text becomes `…` then `✓`). Names: `zf_NNN` → `Kokoro 女声 NNN` / `Kokoro Female NNN`; `zm_NNN` → `男声` / `Male`; `af_maple` → `Kokoro Maple (US)`, `af_sol` → `Kokoro Sol (US)`, `bf_vale` → `Kokoro Vale (UK)`.

### 7.3 `VoiceSheet` (reader)

- Entry order: system voices → **Kokoro voices** (installed voices whose language matches the book: `zf_*`/`zm_*` for `zh`, `af_*`/`bf_*` for `en`; engine label `On-device`) → Edge → **Local GPU server** (`settings.qwenServer`: its voice, label `Local GPU`) → custom server. `voiceMatchesRef` already compares `kind` + `voiceId`.
- When `host.speech.models` exists, the book language is `zh`/`en` and the model is not `ready`, the list ends with **one** extra row: `On-device neural voice · 121 MB` with a right-aligned **Get** link. Tapping it starts the download in place; the row text follows §7.2 (`Downloading 45%` / `[ 45% ]`); when `ready` the row is replaced by the Kokoro voices (PagedList re-measures through `itemsRevision`). This is the "1-tap in-app download".
- Selecting a Kokoro voice: `controller.setVoice({kind:'kokoro', voiceId})`. The existing slow-voice line now also appears for Kokoro (fed by `engine-slow` on native hosts, by `onEngineSlow` on desktop) with the same 1-tap **Use system voice**.
- Books in other languages (ja, ko, ru …): no Kokoro rows.

### 7.4 Sheet "Local GPU server" (`openSheet('qwen-server')`)

```
Preset        ‹  Mac · mlx-audio · Qwen3-TTS 0.6B  ›        (Stepper cycling 5 presets — one row, E-Ink friendly)
Server URL    ( http://192.168.1.20:8000 )
Voice         ( Vivian )
Reference audio / Reference text                            ← only for preset "qwen-tts · /synthesize"
Model         ( mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16 )   prefilled by the preset, editable
Style         ( optional instruction )
[ Test ]   [ Save ]   [ Clear ]
Run scripts/mac-gpu-tts-server.sh on your Mac, then enter the URL it prints.
```
Presets: `Mac · mlx-audio · Qwen3-TTS 0.6B` / `… 1.7B` / `Mac · mlx-audio · Kokoro-82M` (`mlx-audio`); `vLLM-Omni · Qwen3-TTS` (`Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`, voice `vivian`); `qwen-tts · /synthesize` (`qwen-native`). **Test** synthesises `你好，世界。`/`Hello, world.` through `host.speech.synthesize({engine:'qwen', …})` and prints one line: `OK · 1.1 s for 1.6 s of audio` or the error message. Saving sets `settings.qwenServer` and (if the user has no explicit preference for the UI language) nothing else — the voice is picked in `VoiceSheet` like any other.

### 7.5 `ReadAloudController` changes

- `annotateForVoice(utterances)`: when the active voice is `kokoro`, ask `KokoroG2PClient` (worker, §4.7) to fill `phonemeIds`/`phonemeSpeeds` for utterances with `lang` zh*/en* (memoised per utterance id). Applied in `loadAndAppendSection` (so every `enqueue` already carries ids) and in `setVoice()` for the already-queued slice: first the current + next 3 utterances synchronously → `player.enqueue(upsert)` → `player.setVoice(voice)`; the rest in batches of 50 per macrotask → `player.enqueue(upsert)`.
- `engine-slow` events set `slowVoiceRtf`.
- New i18n keys in `en.ts`, `zh-CN.ts`, `ja.ts`: `onDeviceNeuralVoice`, `kokoroTitle`, `kokoroCaption`, `beta`, `download`, `pause`, `resume`, `delete`, `deleteConfirm`, `retry`, `tryAgain`, `get`, `checking`, `downloadingPct`, `pausedPct`, `readySize`, `timesRealTime`, `downloadFrom`, `sourceAuto`, `sourceHf`, `sourceMirror`, `customMirror`, `moreKokoroVoices`, `kokoroFemale`, `kokoroMale`, `onDevice`, `localGpuServer`, `localGpu`, `preset`, `referenceAudio`, `referenceText`, `styleInstruction`, `test`, `testOk`, `macScriptHint`, `errNoConnection`, `errStorage`, `errDamaged`, `errUnsupported`, `errUnstable`.

---

## 8. Version, build, tests, milestones

### 8.1 Version bump
- `pnpm bump:version 0.2.0` **once** (sets all five `package.json`, `MINIBOOK_VERSION`, `CAPACITOR_HOST_VERSION`, mock-host default, Gradle `versionName "0.2.0"` and `versionCode 1 → 2`). Build the APK with **`pnpm build:apk:ci`** (the plain `build:apk` script would bump again to 0.2.1 / 3).
- iOS `Info.plist`: `CFBundleShortVersionString` `0.2.0`, `CFBundleVersion` `2`; `Resources/www` re-synced from `packages/host-android/www`.
- `NOTICE` / licences sheet: Kokoro-82M v1.1-zh (hexgrad, Apache-2.0), ONNX export (onnx-community, Apache-2.0), Core ML conversion (FluidInference, Apache-2.0 / MIT), ONNX Runtime (MIT), G2P ports/data per §4.8 (misaki, jieba, pypinyin, pypinyin-dict, cn2an). `README` gains "On-device neural voice" and "Mac GPU server" sections with the honesty table of §0.2.

### 8.2 Tests that must exist (CI, hermetic — no model download)
- **core**: vocab = `tokenizer.json` snapshot (172 entries, ids); G2P golden corpus + invariants (§4.9); chunker limits; `resolveModelSources`; manifest shape (sizes, 64-hex SHA, 103 voices, 34 Core ML files); `QwenSpeechProvider` × 3 protocols (body, language mapping, wav default, error mapping, >30 s split + `concatWav`); scheduler passes `phonemeIds`, `maxConcurrency 1`.
- **host-node**: `ModelStore` against a local HTTP fixture: fresh download; pause → resume issues `Range` and gets 206; server ignoring Range (200); 416; primary 503/time-out → mirror; cross-host 302/308 inside the allow-list followed, outside rejected; SHA mismatch → one clean retry → `model-integrity`; `remove` deletes `.part`; restart reconciliation. Routes: jail + manifest-name check on `/file/*`, `POST /api/speech/cache` key validation. `SynthService` qwen branch + allow-list. Header test: CSP string contains `'wasm-unsafe-eval'` and `worker-src 'self'`; COOP/COEP/CORP present on HTML, static, API, SSE. `pnpm check:native` green.
- **ui**: Settings rows (with/without `models`), Kokoro sheet state table, E-Ink stepped `[ 45% ]` throttling (fake timers: 100 progress events → ≤ 20 text changes), `VoiceSheet` Get-row → voices replacement, voice-name formatting, `annotateForVoice` ordering in `setVoice`, css-lint still green, Playwright: full existing suite under the new headers + a mock-host download flow in E-Ink mode (screenshot is pure `#000/#fff`).
- **android (JUnit, pure Java)**: `ReadAloudQueueEngine` with fake `LocalSynth` (missing ids → immediate non-sticky fallback; 8 s local time-out ignores `NetworkChecker`; upsert keeps audio; plan callbacks on seek/setVoice/stop), `KokoroSynthQueue` policy with fake `KokoroInference` (45 s / 12 items window, generation cancel, NaN rejection, RTF event), `ModelDownloader` with OkHttp `MockWebServer` (same cases as host-node), voice row maths.
- **ios (XCTest)**: §5.3 list.

### 8.3 Milestones (each lands green on its own)
1. **M1 core** — types, vocab, manifest, G2P, providers, wav utils, scheduler.
2. **M2 host-node** — model store + routes, web worker engine, CSP/COOP/COEP, qwen branch.
3. **M3 ui** — settings/sheets/VoiceSheet/controller/i18n.
4. **M4 android** — Gradle, downloader, ORT, synth queue, engine changes, plugin methods.
5. **M5 ios** — `MiniBookKokoro`, engine changes, plugin methods, www sync.
6. **M6 release** — script, README/NOTICE, version bump, APK + iOS build.

### 8.4 Device gates (cannot be automated here; results recorded in the PR)
| Gate | Pass criteria |
|---|---|
| G-MAC | Chrome + Safari on Apple Silicon: backend `webgpu`, self-test ok, RTF ≤ 0.3, 30 min background-tab playback, 0 CSP violations |
| G-AND | OnePlus 13T release APK: self-test ok, RTF ≤ 0.5, 2 h screen-off, 0 fallbacks/ANR |
| G-IOS | iPhone 17 (Dogfoody): self-test ok, RTF ≤ 0.5, 60 min screen-locked, 0 crashes; else ship iOS with Kokoro hidden |
| G-MLX | script on the user's Mac: `READY`, Test passes from all three devices |
| G-CN | from a mainland-China network (or `modelDownloadSource:'hf-mirror'`): full download + pause/resume through `hf-mirror.com`; record the redirect hosts seen |

---

## 9. Risks, rejected alternatives, out of scope

| Topic | Decision |
|---|---|
| NPU on phones (Hexagon HTP / ANE) | Out of scope. Needs a static-shape bucketed re-export + QDQ quantisation (Android) or the `ANE-v3` buckets (iOS ≥ 18, "physical iOS inference unvalidated" upstream). Revisit in v0.3 with measured CPU numbers in hand. |
| WebGPU inside the Android WebView | Rejected: foreground-only (WebView JS is throttled with the screen off), 324 MiB fp32 in the renderer; native ORT is the screen-off-safe path. |
| `kokoro-js` / `@huggingface/transformers` | Not used: pulls espeak-ng WASM (`phonemizer`, English only, GPL-3 engine) and has no Mandarin G2P; we only need `onnxruntime-web` + our own G2P. |
| fp16 / q4f16 ONNX | Banned (NaN, E5/E6). |
| q8 on the web | Banned (NaN with 1 thread, E6). |
| iOS pure-Swift ONNX executor | Contingency only (20 missing op types, E3). |
| Kokoro `speed` input as user rate | Not used for the user rate (playback time-stretch keeps the cache valid, v0.1.0 rule); used only for the upstream length-dependent pacing correction (§4.6). |
| Background download services | Not in v0.2.0; resume-from-`.part` is the recovery path. |
| Voice cloning UI for Qwen | Only via `qwen-native` reference path / mlx-audio `ref_audio`; no recording UI. |
| Unverified items (explicit) | WebGPU execution; ORT q8 on ARM64; Core ML chain on a physical iPhone; `hf-mirror.com` from inside CN; the Mac script end-to-end. Each has a gate in §8.4 and a safe failure mode (self-test → system voice; rows hidden; source fallback). |
