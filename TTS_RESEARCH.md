# MiniBook — TTS Research, Local-Model Evaluation & Verdict

> **Revision V2** (resolves design-critic review #5).
> Stage-1 research for Read Aloud in MiniBook (`Books`). Companion to [PRODUCT_DESIGN.md](PRODUCT_DESIGN.md) §4.6/§7 and [ARCHITECTURE.md](ARCHITECTURE.md) §8.
> Measured on `chii.c.googlers.com` on 2026-11-13. Raw data: `../tts_bench/results.jsonl`, script `../tts_bench/bench.py`, and the service's own journal (`journalctl --user -u qwen-tts.service`).

---

## 0. Verdict (read this first)

| Question | Answer |
|---|---|
| **Can the current `qwen-tts` service narrate an ebook?** | **No.** It generates speech **~4.5× slower than real time** on this CPU (median RTF 4.46 over 138 production requests; 3.7–9.9 in today's ebook-style test), returns nothing until a whole request is finished (36 s wait for a 9 s sentence, 94 s for a 23 s paragraph), runs one request at a time, and is neither reachable from a phone nor API-compatible with anything a reader app speaks. Continuous listening needs RTF **< 1** with headroom (target ≤ 0.5). |
| **Is it a model problem or a hardware problem?** | Hardware. Qwen3-TTS-1.7B is a 1.7 B-parameter autoregressive model; public reports put it at RTF ≈ 0.35–0.65 on a single modern GPU and > 2.5 on CPUs. On the 12-core Broadwell Xeon (AVX2 only, no AVX-512/VNNI, no GPU) INT8 quantisation is already applied and it is still 4–5× too slow. No amount of client-side cleverness (prefetch, caching, chunking) can fix a producer that is slower than the consumer. |
| **What should MiniBook use instead?** | A **three-rung ladder** (§5): **(0) system-native TTS** on every platform as the always-available default (on Android this slot also hosts MultiTTS / sherpa-onnx neural voices for free); **(1) Microsoft Edge neural voices** as the free high-quality online option; **(2) one generic OpenAI-compatible `/v1/audio/speech` client** for everything else (OpenAI, self-hosted Kokoro-82M, or — if it ever gets a GPU — the user's Qwen box). |
| **Does `qwen-tts` have any role?** | Keep it for what it is used for today: short voice-cloned clips (median request: 25 characters, 3.7 s of audio). For books it becomes viable only behind a GPU *and* an OpenAI-compatible, LAN-bound, streaming-or-sentence-level endpoint (§2.5). MiniBook ships **no Qwen-specific code**. |

## 1. What is on this machine

### 1.1 Hardware

| | |
|---|---|
| CPU | Intel Xeon @ 2.20 GHz, family 6 model 79 (**Broadwell-EP, E5 v4**), 12 cores / 24 threads (KVM guest), AVX2 + FMA, **no AVX-512, no VNNI** |
| RAM | 94 GiB (66 GiB available), 86 GiB swap |
| GPU | none (`nvidia-smi` absent; server reports `device: cpu`) |

### 1.2 `qwen-tts` skill & service (`~/Developer/band/skills/qwen-tts/`)

| Item | Finding (from `scripts/tts_server.py`, `systemctl --user status`, `/health`) |
|---|---|
| Unit | `qwen-tts.service` (systemd **user** unit, enabled, active since 2026-11-09, `Restart=always`) running `uv run tts_server.py` |
| Model | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` (voice-clone "Base" variant), FP32 with per-channel dynamic **INT8** on talker `self_attn` + `mlp.{gate_proj,up_proj}` (99 blocks), `QWEN_TTS_THREADS=12` |
| Memory | 4.9–5.9 GiB resident (cgroup `MemoryCurrent`), **9.9 GiB peak**, ~3 GiB in swap |
| API | `POST /synthesize {text, ref_audio, ref_text?, x_vector_only_mode}` → one complete `audio/wav` body (24 kHz mono PCM16). `GET /health`. **No streaming, no `/v1/audio/speech`, no voice list.** |
| Voice | Voice **cloning only**: every request must name a reference audio (a server-local path, URL or data URI). 3 clone prompts currently cached. |
| Bind | `127.0.0.1:18055` — **not reachable from the LAN / a phone**. |
| Concurrency | A process-wide `_INFER_LOCK` (`threading.Lock`) serialises all inference: second request waits for the first. |
| Length cap | `max_new_tokens=600` at the 12.5 Hz codec ⇒ **hard cap ≈ 48 s of audio per request** (longest observed: 47.92 s). Longer text is silently truncated. |
| Text mangling | `clean_text()` deletes everything inside `()`, `（）`, `[]`, `【】` — fine for chat stage directions, **wrong for books** (drops parentheticals and bracketed text). |
| Client | `tts_client.py` gives up after 150 s (`SYNTHESIZE_HTTP_TIMEOUT_SEC`) — i.e. anything longer than ≈ 33 s of audio at RTF 4.5. |

### 1.3 Hugging Face cache (`~/.cache/huggingface/hub/`)

| Entry | On disk | Status |
|---|---|---|
| `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | 4.3 GB | downloaded — **the running model** |
| `Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice` | 4.3 GB | downloaded, not served (preset-speaker variant; same size ⇒ same speed class) |
| `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | 2.4 GB | downloaded, not served, **not benchmarked** (would require restarting the user's live service with a different model). Estimate, not a measurement: it runs the *same* pipeline — an autoregressive talker emitting 12.5 codec frames per second of audio, the per-frame multi-codebook code predictor, and the FP32 `speech_tokenizer` decoder — and only the talker shrinks (≈ 1.7 B → 0.6 B parameters, ≈ 2.8×); the predictor and decoder cost per frame is unchanged. Scaling the measured median accordingly bounds it at **RTF ≈ 1.6 (best case, talker-dominated) to ≈ 2.5** on this AVX2-only CPU — still above the < 1.0 real-time threshold, with zero headroom for prefetch. |
| `fishaudio/fish-speech-1.5` | **28 KB** | **empty stub** (metadata only — weights were never downloaded) |
| `fishaudio/s2-pro` | **28 KB** | **empty stub** |
| (also present, not TTS) | | `mlx-community/whisper-large-v3-turbo` (ASR, MLX/Apple-silicon format), `google/embeddinggemma-300m` |

So the only locally runnable TTS today is Qwen3-TTS; the Fish Audio entries are placeholders.

## 2. Measurements

Definitions: **RTF** = synthesis wall time ÷ audio duration (lower is better; < 1 = faster than real time). **TTFA** = time from request to first audible sample — for this server it equals the full request latency because nothing is streamed.

### 2.1 Production history (service journal, 2026-11-09 → 11-13, n = 138 requests, INT8, 12 threads)

| Metric | min | median | mean | p90 | max |
|---|---|---|---|---|---|
| RTF | 3.60 | **4.46** | 4.69 | 5.53 | 10.9 |
| Input length (chars) | | 25 | | | 72 |
| Audio duration (s) | | 3.68 | | | 47.92 |
| Latency = TTFA (s) | | **16.5** | | | 187.4 |

Aggregate: 662 s of audio cost 2 987 s of 12-thread CPU time ⇒ RTF 4.51. Average speaking rate ≈ 6.0 chars/s (mostly CJK input).

### 2.2 Ebook-narration test (today, live service, default voice-clone reference)

| Case | Input | Audio | Latency (= TTFA) | RTF | Note |
|---|---|---|---|---|---|
| English sentence | 109 chars | 9.44 s | **36.1 s** | 3.82 | idle host |
| Chinese sentence | 29 chars | **25.12 s** | 94.0 s | 3.74 | expected ≈ 5 s of audio — see §2.3 |
| Chinese paragraph | 134 chars | 23.36 s | **93.7 s** | 4.01 | |
| English paragraph | 411 chars | 26.24 s | **222.1 s** | 8.47 | host under other load (load avg ≈ 17) |
| 2 sentences submitted together — first | 29 chars | 10.00 s | 98.8 s | 9.88 | same text as row 2 |
| 2 sentences submitted together — second | 29 chars | 27.76 s | **261.1 s** | 9.40 (client) / 5.85 (server) | waited 98.8 s behind `_INFER_LOCK`, then 162.3 s of synthesis |

### 2.3 What the numbers mean for a reader

1. **Throughput.** At RTF 4.5 one hour of listening needs 4.5 hours of a fully loaded 12-thread CPU. A 10-hour novel = ~45 CPU-hours. The buffer of a prefetch queue *shrinks* by 3.5 s for every second played; it can never build.
2. **Start-up.** Tap "Read aloud" → 36–94 s of silence before the first sentence (vs. < 1 s for system TTS, ≈ 1 s for Edge).
3. **Seeking.** Every "next sentence", page turn or tap-to-read costs the same 16–90 s again.
4. **Prefetch cannot parallelise.** The lock makes two concurrent requests strictly sequential (row 6: latency = sum of both). Removing the lock would not help: one request already saturates all 12 physical cores.
5. **Contention sensitivity.** RTF doubled (3.8 → 8.5–9.9) when anything else used the host — and this machine is a shared dev box that also serves the chat bots.
6. **Unstable durations.** The *identical* 29-character Chinese sentence produced 25.1 s, 10.0 s and 27.8 s of audio in three runs, where ≈ 5 s is expected at the service's own average rate. Sampling-based autoregressive generation with a cross-lingual clone prompt wanders (long pauses / repeated or invented audio). Unattended narration would need a duration sanity check and re-synthesis — multiplying an already impossible latency.
7. **Protocol gaps** (§1.2): loopback-only, clone-only request shape, no OpenAI-compatible route, 48 s truncation, bracket stripping, 150 s client timeout, WAV-only output (48 kB/s — a 23 s paragraph is 1.1 MB).

**Conclusion: unusable for live Read Aloud, and impractical even as an offline "pre-render the chapter" batch job.**

### 2.4 What would change the verdict

| Change | Expected effect | Enough? |
|---|---|---|
| Run the same model on a GPU (public reports: RTF ≈ 0.35–0.65 on RTX 4090/A100 class; ~97 ms first packet with streaming) | ~10× faster | **Yes**, with §2.5's endpoint changes |
| Switch service to `0.6B-CustomVoice` on this CPU | estimated RTF ≈ 1.6–2.5 (same 12.5 Hz autoregressive loop + unchanged FP32 codec decode; only the talker is ≈ 2.8× smaller — §1.3; unmeasured) | **No** — still slower than real time |
| More threads (12 → 24 SMT) | marginal; history shows 8 → 12 threads did not reach RTF < 3.6 | No |
| Replace the *server model* with **Kokoro-82M** (82 M params, non-autoregressive) on this same Xeon | 20× fewer parameters; desktop-CPU reports are faster than real time | **Likely yes — must be measured** (§7, task V1) |

### 2.5 If the Qwen box is ever made book-capable (not part of MiniBook)

Minimal server-side changes so that MiniBook's generic rung-2 client works unmodified: (a) add `POST /v1/audio/speech {model, input, voice, response_format: "wav"|"mp3"|"pcm", speed}` mapping `voice` → a configured reference clip; (b) bind `0.0.0.0` behind a bearer token; (c) do **not** run `clean_text()` on this route; (d) return `413` instead of truncating when the input would exceed the token cap (the client already sends ≤ 1 sentence, §6.2); (e) optional chunked streaming. These are ~40 lines in `tts_server.py`; they are listed here only so the user knows the app needs nothing Qwen-specific.

## 3. Reference apps — how the user's other products do audio

| App | Relevant convention reused by MiniBook |
|---|---|
| **MiniPod** (`~/Developer/minipod`, `ARCHITECTURE.md` §3.3, §5) | "Assume JS is asleep whenever the screen is off": everything that must survive screen-off (queue advance, sleep timer, checkpoint journal) is **native**; JS only *reconciles*. Android: Media3 `MediaSessionService` (`foregroundServiceType="mediaPlayback"`), `CONTENT_TYPE_SPEECH`, notification/lock-screen/Bluetooth. A `PlayerEngine` interface with a web implementation (`HtmlAudioEngine`) and a native one (`NativeAudioEngine`) handed to the UI by the host entry. All network I/O via a native HTTP plugin (CORS-free), never `CapacitorHttp`. |
| **MiniPod iOS** (`//experimental/users/chii/ios/minipod`) | Hand-rolled Capacitor-8-compatible bridge (`CapacitorBridge.swift`, `capacitor://localhost` `WKURLSchemeHandler` with HTTP-206 Range for local files), the *same* `packages/host-android/www` bundle, `@MainActor` plugin classes with `@unchecked Sendable` boxes at framework boundaries, `AVAudioSession(.playback, mode: .spokenAudio)`, `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter`, native sleep timer + journal, `UIBackgroundModes: audio`, safe-area injected as `--m-safe-*` CSS variables. |
| **Kotori** (`~/Developer/kotori`) | Same monorepo shape (`core` / `ui` / `host-node` / `host-android`), `node:sqlite`, zero-native-addon policy (`onlyBuiltDependencies: []`, `check:native`). |

MiniBook's TTS is therefore designed as a `SpeechPlayer` (the `PlayerEngine` analogue) with a JS-orchestrated web implementation and a native-owned queue on Android/iOS (ARCHITECTURE §8).

## 4. Market survey (2025–2026) for a cross-platform ebook reader

Figures marked † come from vendor pages / community reports found via web search on 2026-11-13 and must be re-verified at implementation time; they are used here for order-of-magnitude decisions only.

### 4.1 Capability matrix

| Option | Cost | Offline | Quality | Time to first audio | Word timing | Background / lock screen | Platforms | Main risk |
|---|---|---|---|---|---|---|---|---|
| **Android `TextToSpeech`** (Google TTS, Samsung, **MultiTTS**, **sherpa-onnx TTS engine**, any installed engine) | free | yes (engine-dependent) | Google: good; MultiTTS/sherpa neural voices: very good, user-chosen | 50–300 ms | `onRangeStart` (API 26+) — Google yes; most third-party engines **no** → sentence-level | yes, inside our Media3 foreground service | Android | Engine quality varies by device; needs `<queries>` for `TTS_SERVICE` on Android 11+; per-utterance text limit (`getMaxSpeechInputLength()`, 4000) |
| **iOS `AVSpeechSynthesizer`** | free | yes | Compact: robotic; Enhanced/Premium (user-downloaded): good. Siri voices are **not** available to apps | < 200 ms | `willSpeakRangeOfSpeechString` | yes if utterances are queued natively under an active `.playback` session (`UIBackgroundModes: audio`); JS must not sit between utterances | iOS | Premium voices need a manual download in iOS Settings; some neural voices report coarse ranges |
| **Web `speechSynthesis`** | free | usually | macOS/Windows: decent; **Edge browser exposes Microsoft "Online (Natural)" voices**; Linux Chrome: poor/none | < 300 ms | `boundary` events for local voices only | tab must stay open; no lock-screen story | PC browsers only (**undefined in Android WebView**; dies in background in iOS `WKWebView`) | Chrome cuts long utterances (~15 s) → must speak sentence by sentence; voice list is async and inconsistent |
| **Microsoft Edge TTS** (Read-Aloud WebSocket, e.g. `edge-tts`) | free | no | **Excellent** (Azure neural: `zh-CN-XiaoxiaoNeural`, `en-US-AvaMultilingualNeural`, 300+ voices, 70+ locales) | ≈ 0.5–1.5 s, streams MP3 | **yes** (`WordBoundary` / `SentenceBoundary` metadata) | yes (we play the returned audio natively) | all (needs a non-browser WebSocket: custom `Origin`/`User-Agent` headers + rotating `Sec-MS-GEC` token cannot be set from WebView/browser JS) | **Unofficial**, no SLA; breaks with HTTP 403 whenever Microsoft rotates the token scheme / client version; possible IP throttling; ToS grey area ⇒ opt-in, never the only path |
| **Kokoro-82M** (Apache-2.0; ONNX via `kokoro-js` WebGPU/WASM, sherpa-onnx, Kokoro-FastAPI server) | free | yes | Very good English; Mandarin via v1.1-zh; ~8 languages total | server CPU/GPU: fast; **phone CPU: reports range from real-time to RTF 2–3†** | server: yes (`captioned_speech`); on-device: no | via engine app or server | Android (inside sherpa-onnx engine app / MultiTTS), PC browser (WebGPU), any server | In-app embedding = 90–330 MB model + runtime + download UI (bloat); mobile speed unproven |
| **Piper / VITS / Matcha** (via sherpa-onnx engine app) | free | yes | Fair (flatter prosody) | fast (RTF ≈ 0.2 on phones†) | no | via engine app | Android | Lower naturalness; still good for E-Ink devices with weak SoCs |
| **Gemini native TTS** (`gemini-2.5-flash-preview-tts` and successors) | ≈ $0.50/M text tokens + $10/M audio tokens† (≈ $0.9 per audio hour†) | no | Excellent, steerable style, 24 languages | 1–several s (preview, not built for sentence-streaming) | no | yes (audio file) | all (HTTPS) | Non-OpenAI wire format (PCM in JSON), preview quotas; cost for whole books |
| **Google Cloud Chirp 3 HD** | $30 / 1 M chars† | no | Excellent | sub-second streaming | no (no SSML marks on Chirp HD) | yes | all | Cost; GCP project + service auth on a phone |
| **OpenAI `gpt-4o-mini-tts` / `tts-1`** | ≈ $0.015/min† / $15 per 1 M chars† | no | Excellent | ≈ 0.5–1 s, streams | no | yes | all | Cost; 2 000-token input cap (fine for sentence chunks) |
| **Fish Audio (S1 / S2) API** | $15 / 1 M UTF-8 bytes† (CJK = 3 bytes/char ⇒ ≈ $45 / 1 M 汉字) | no | Excellent, voice cloning | sub-second | no | yes | all | Cost for CJK; proprietary API (not OpenAI-shaped) |
| **Local/LAN `qwen-tts` (this machine)** | free | LAN | Excellent timbre, clone | **16–260 s** | no | n/a | none today (loopback only) | §2 — RTF 4.5 |
| **Any OpenAI-compatible `/v1/audio/speech` server** (Kokoro-FastAPI, LocalAI, openedai-speech, vLLM-Omni serving Qwen3-TTS on GPU, LiteLLM gateway in front of Gemini/Fish…) | self-hosted: free | LAN | model-dependent | model-dependent | no (standard API) | yes | all | User must run a server |

### 4.2 Cost of listening to one whole book (order of magnitude)

Assumptions: English novel 100 k words ≈ 580 k chars ≈ 11 h; Chinese novel 300 k 汉字 ≈ 17 h.

| Engine | English novel | Chinese novel |
|---|---|---|
| System TTS / Edge TTS / self-hosted Kokoro | $0 | $0 |
| OpenAI `tts-1` ($15/M chars†) | ≈ $9 | ≈ $4.5 |
| OpenAI `gpt-4o-mini-tts` / Gemini Flash TTS (≈ $0.9/h†) | ≈ $10 | ≈ $15 |
| Fish Audio ($15/M bytes†) | ≈ $9 | ≈ $13.5 |
| Chirp 3 HD ($30/M chars†) | ≈ $17 | ≈ $9 |
| `qwen-tts` on this CPU | $0 + **≈ 50 CPU-hours** | $0 + **≈ 75 CPU-hours** |

Paid cloud voices cost roughly the price of the paperback per book. That is acceptable as an *opt-in* for a user who wants it, and wrong as a default.

### 4.3 What comparable readers do

- **Readest** (foliate-js based, cross-platform): system/Web Speech + **Edge TTS** built in, sentence highlighting mapped back to DOM ranges, SSML chunks through an async-iterator engine interface.
- **Legado (阅读)**: Android system TTS + user-defined **HTTP TTS** endpoints (commonly an Edge-TTS relay such as `tts-server-android`). Power users on E-Ink devices install **MultiTTS** as the system engine.
- **Moon+ Reader / Librera**: Android system TTS only; quality is delegated to whichever engine the user installs.
- **KOReader**: no first-party TTS; community plugins call cloud endpoints.

The pattern is consistent: *system TTS as the base, Edge as the free neural upgrade, one generic HTTP hook for everything else* — exactly the ladder below.

## 5. Recommendation — the three-rung ladder

| Rung | Engine | Role | Why |
|---|---|---|---|
| **0 (default, always present)** | **System native TTS** — Android `TextToSpeech`, iOS `AVSpeechSynthesizer`, PC `speechSynthesis` | Zero-setup, offline, free, instant, background-safe, word highlighting where supported. Also the automatic fallback for rungs 1–2. | It is the only option that satisfies P5 ("no configuration before value"). On Android it is also an **extension point**: installing MultiTTS or the sherpa-onnx TTS engine (Kokoro / Piper / Matcha / VITS voices) upgrades MiniBook to offline neural speech with **zero app code**, which is how E-Ink-device users already work. MiniBook enumerates all installed engines (`TextToSpeech.getEngines()`) and their voices. |
| **1 (opt-in switch)** | **Microsoft Edge neural voices** | Best free quality in Chinese/English/Japanese; word-level timing; ~1 s start. | Costs nothing and sounds like a paid service. Because it is unofficial it is off by default, isolated behind one provider class with its protocol constants in one file, and every failure falls back to rung 0 within one sentence. |
| **2 (opt-in, one form: URL · key · voice)** | **OpenAI-compatible `/v1/audio/speech`** | Covers OpenAI, self-hosted **Kokoro-FastAPI** (recommended self-host target for this user's hardware), LocalAI, a GPU-backed Qwen3-TTS, or a LiteLLM gateway in front of Gemini / Fish / Chirp. | One tiny client instead of N vendor SDKs. The user's existing infrastructure plugs in here if/when it is fast enough. |

Explicitly **not** in v1: embedding Kokoro/sherpa-onnx inside the app (model manager + 90–330 MB assets + native libs = bloat, and on Android the system-engine slot already delivers it); a dedicated Gemini/Chirp/Fish provider (reachable through an OpenAI-compatible gateway; a native `GeminiSpeechProvider` is the first candidate if demand appears); `kokoro-js` in the PC browser (PC already has rung 0–2 through the local server).

Per-platform default voice quality without any setup: iOS — Enhanced/Premium voice if installed, else compact; Android — the device's default engine; PC — best local `speechSynthesis` voice for the book language (on Linux, where system voices are poor, the first-run voice sheet suggests enabling Edge voices).

## 6. Architecture consequences (summary — full design in ARCHITECTURE §8)

### 6.1 Two engine families, one player

- **Speak engines** (system TTS): the OS synthesises *and* plays. We feed sentences and receive `start / range / done` callbacks.
- **Synth engines** (Edge, OpenAI-compatible): return audio per sentence; we cache it and play it through the platform audio player.
- A single `SpeechPlayer` consumes an ordered list of **utterances** (one sentence each, with character offsets into the book text) and exposes play/pause/seek-by-sentence/speed/sleep-timer + events. Web implementation is JS-orchestrated; Android and iOS keep the **utterance queue natively** so speech continues with the screen off and the WebView asleep (MiniPod's rule).

### 6.2 Sentence splitting

Deterministic, rule-based, DOM-free splitter in `@minibook/core` (no dependence on `Intl.Segmenter`, whose ICU version differs per platform): block boundaries first, then CJK terminators `。！？…` and Latin `.!?` with closing quotes/brackets attached, abbreviation/decimal/initial guards, hard caps (≤ 200 CJK chars / ≤ 400 Latin chars, split at clause punctuation), and merging of very short fragments. Mixed CJK/English sentences are **not** split by script (modern voices handle embedded English; splitting sounds choppy). Each utterance carries a `lang` for voice selection.

### 6.3 Lookahead prefetch (synth engines)

- Keep **30–120 s** of ready audio ahead of the play head; per-engine `maxConcurrency` (Edge 2, OpenAI-compatible 2 by default, **1** for servers that declare or exhibit single-flight behaviour — e.g. a Qwen-style `_INFER_LOCK`, detected by measuring that two parallel requests take the sum of their times).
- First sentence is fetched alone at top priority (and clause-split if long) to minimise time-to-first-audio.
- Every seek / voice change bumps a generation counter and aborts in-flight requests.
- The player measures each engine's real RTF (EMA of synth time ÷ audio duration). **RTF ≥ 1 ⇒ the UI says so and offers the system voice** — this is precisely the guard that would have caught the Qwen setup automatically.
- Synthesised audio is cached on disk by `hash(engine, voice, text)` (speed is applied at playback, pitch-preserved, so the cache survives speed changes); LRU-capped.

### 6.4 Highlight sync

| Engine | Sentence highlight | Word highlight |
|---|---|---|
| Android system TTS | `onStart(utteranceId)` | `onRangeStart` when the engine reports it |
| iOS system TTS | `didStart` | `willSpeakRangeOfSpeechString` |
| Web `speechSynthesis` | `start` | `boundary` (local voices) |
| Edge | playback start | `WordBoundary` timeline vs. player position |
| OpenAI-compatible | playback start | — |

Highlights are painted without touching the text DOM (CSS Custom Highlight API, overlay-rect fallback), so highlighting can never cause reflow or shift pages. E-Ink mode uses sentence-level solid underline only.

### 6.5 Auto page-turn, sleep timer, background

- **Auto page-turn:** driven by the utterance's character range → page lookup; a sentence that straddles a page break turns at the word that crosses it (or at the proportional time when no word timing exists).
- **Sleep timer:** native on Android/iOS; expiry lets the current sentence finish, then pauses (cleaner than a fade for speech).
- **Background:** Android — Media3 `MediaSessionService` with a custom `Player` that alternates between `TextToSpeech` and ExoPlayer per utterance; iOS — `AVAudioSession(.playback, .spokenAudio)` + `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter`; PC — Media Session API. The native side always holds the *text* of at least the rest of the current chapter and the next one, so if the web layer sleeps or the network drops, speech continues with the system voice.

## 7. Open risks & Stage-2 validation tasks

| ID | Task | Why |
|---|---|---|
| V1 | Benchmark **Kokoro-82M** (Kokoro-FastAPI or `kokoro-onnx`, FP32 and INT8) on this Xeon with `../tts_bench/bench.py` adapted to `/v1/audio/speech`. Accept if RTF ≤ 0.5 at ≤ 12 threads. | Decides whether the user's box can be the rung-2 server on CPU. Not run in Stage 1 (would install new packages/models on the user's machine). |
| V2 | On a real Android phone and an Onyx Boox: measure TTFA and RTF of the sherpa-onnx engine with Kokoro vs. Piper/Matcha voices, and whether `onRangeStart` fires for Google TTS / MultiTTS / sherpa-onnx. | Mobile Kokoro speed reports conflict; determines the voice we recommend in the README for E-Ink devices. |
| V3 | Verify the current Edge Read-Aloud handshake (`Sec-MS-GEC` derivation, version string, required headers) against the latest `edge-tts` release; add a contract test that fails loudly on 403. | The scheme has changed before and will again. |
| V4 | iOS: confirm lock-screen controls + background continuation for an `AVSpeechSynthesizer`-only session on device; if Now-Playing eligibility is flaky, switch the Swift backend to `write(_:toBufferCallback:)` → `AVAudioEngine` (already isolated behind the Swift `SpeechBackend` protocol). | Known area of platform quirks. |
| V5 | Re-check † prices and the existence of an OpenAI-compatible speech route for Gemini before documenting it to users. | Search-derived numbers. |

## 8. Sources

- Local: `~/Developer/band/skills/qwen-tts/{SKILL.md,scripts/tts_server.py,scripts/tts_client.py}`; `journalctl --user -u qwen-tts.service` (138 `TTS synthesis complete` lines); `~/.cache/huggingface/hub`; `~/Developer/minipod/{DESIGN.md,ARCHITECTURE.md}`; `~/Developer/kotori/DESIGN.md`; `//experimental/users/chii/ios/minipod` (`README.md`, `BUILD`, `Sources/Media/MiniPodMediaEngine.swift`, `Sources/Capacitor/*`).
- Web (searched 2026-11-13; summaries, to be re-verified): Qwen3-TTS technical report (arXiv) and qwen.ai / vLLM-Omni docs (97 ms first packet and RTF figures on GPU); `hexgrad/Kokoro-82M`, `onnx-community/Kokoro-82M-v1.1-zh-ONNX`, `kokoro-js`, `k2-fsa/sherpa-onnx` (TTS engine APKs); `rany2/edge-tts` issues on `Sec-MS-GEC` / HTTP 403 and browser header limits; Android `UtteranceProgressListener.onRangeStart` and Media3 `SimpleBasePlayer` docs; Apple `AVSpeechSynthesizer` docs and developer-forum threads on background speech; Chromium bugs on `speechSynthesis` long-utterance cut-off and remote-voice boundary events; Google AI / Google Cloud TTS / OpenAI / Fish Audio pricing pages; Readest, Legado, KOReader, Moon+ Reader documentation.
