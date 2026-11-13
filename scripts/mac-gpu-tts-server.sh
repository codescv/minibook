#!/usr/bin/env bash
# MiniBook — one-command LAN GPU TTS server for Apple-Silicon Macs (Metal GPU via MLX).
#
#   scripts/mac-gpu-tts-server.sh [qwen-0.6b|qwen-1.7b|kokoro]      (default: qwen-0.6b)
#
# Serves the OpenAI-compatible `POST /v1/audio/speech` of `mlx-audio` on 0.0.0.0:8000 so that
# MiniBook on this Mac, an iPhone and an Android phone on the same Wi-Fi can use it:
#   Books → Settings → Read Aloud → Local GPU server → preset "Mac · mlx-audio" → paste the URL printed below.
#
# Env: PORT (8000) · HOST (0.0.0.0) · HF_ENDPOINT (auto-set to https://hf-mirror.com when
#      huggingface.co is unreachable) · MLX_AUDIO_VERSION (0.6.5) · PYTHON_VERSION (3.12)
#
# SECURITY: the server has NO authentication. Run it only on a trusted home/office LAN.
set -euo pipefail   # written for macOS /bin/bash 3.2 (no empty-array expansion under -u, no mapfile)

PRESET="${1:-qwen-0.6b}"
PORT="${PORT:-8000}"
HOST="${HOST:-0.0.0.0}"
MLX_AUDIO_VERSION="${MLX_AUDIO_VERSION:-0.6.5}"
PYTHON_VERSION="${PYTHON_VERSION:-3.12}"

die() { echo "error: $*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] \
  || die "this script needs an Apple-Silicon Mac (MLX runs on the Metal GPU)."
command -v uv >/dev/null 2>&1 \
  || die "uv not found. Install it with:  curl -LsSf https://astral.sh/uv/install.sh | sh"
command -v curl >/dev/null 2>&1 || die "curl not found."
# mlx-audio[server] builds the small C extension `webrtcvad` from source on first run.
xcode-select -p >/dev/null 2>&1 \
  || die "Xcode Command Line Tools missing. Install with:  xcode-select --install"

EXTRA_WITH=()
case "$PRESET" in
  qwen-0.6b)
    MODEL="mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16"; VOICE="Vivian"; LANG_CODE="chinese"; SIZE="2.5 GB" ;;
  qwen-1.7b)
    MODEL="mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-bf16"; VOICE="Vivian"; LANG_CODE="chinese"; SIZE="4.5 GB" ;;
  kokoro)
    MODEL="mlx-community/Kokoro-82M-bf16"; VOICE="zf_xiaoxiao"; LANG_CODE="z"; SIZE="0.4 GB"
    # Kokoro needs misaki G2P; misaki's English path downloads a spaCy model through pip at runtime.
    EXTRA_WITH=(--with "misaki[zh,en]" --with pip) ;;
  -h|--help|help)
    sed -n '2,14p' "$0"; exit 0 ;;
  *)
    die "unknown preset '$PRESET' (use qwen-0.6b | qwen-1.7b | kokoro)" ;;
esac

# Mainland-China networks: huggingface_hub honours HF_ENDPOINT.
if [[ -z "${HF_ENDPOINT:-}" ]] && ! curl -fsI -m 6 https://huggingface.co >/dev/null 2>&1; then
  export HF_ENDPOINT="https://hf-mirror.com"
  echo "huggingface.co unreachable → using HF_ENDPOINT=${HF_ENDPOINT}"
fi

LAN_IP=""
for IFACE in en0 en1 en2; do
  LAN_IP="$(ipconfig getifaddr "$IFACE" 2>/dev/null || true)"
  [[ -n "$LAN_IP" ]] && break
done
LAN_IP="${LAN_IP:-127.0.0.1}"

cat <<EOF
────────────────────────────────────────────────────────────────────────
 MiniBook local GPU TTS server  (mlx-audio ${MLX_AUDIO_VERSION}, Metal)
   model    ${MODEL}   (first run downloads ≈ ${SIZE})
   Books → Settings → Read Aloud → Local GPU server
     Preset  Mac · mlx-audio
     URL     http://${LAN_IP}:${PORT}
     Model   ${MODEL}
     Voice   ${VOICE}
 No authentication — trusted LAN only.  Ctrl-C to stop.
────────────────────────────────────────────────────────────────────────
EOF

uv tool run --python "$PYTHON_VERSION" --prerelease=allow \
    --from "mlx-audio[server]==${MLX_AUDIO_VERSION}" ${EXTRA_WITH[@]+"${EXTRA_WITH[@]}"} \
    mlx_audio.server --host "$HOST" --port "$PORT" &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

# Wait for the HTTP server, then warm the model (download + load + first Metal compile).
until curl -fs -m 2 "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; do
  kill -0 "$SERVER_PID" 2>/dev/null || die "mlx_audio.server exited during start-up (see log above)."
  sleep 1
done
echo "server is up — warming ${MODEL} (this is where the first-run download happens)…"
if curl -fsS -m 3600 -o /dev/null -H 'Content-Type: application/json' \
     -d "{\"model\":\"${MODEL}\",\"input\":\"你好，欢迎使用。\",\"voice\":\"${VOICE}\",\"lang_code\":\"${LANG_CODE}\",\"response_format\":\"wav\"}" \
     "http://127.0.0.1:${PORT}/v1/audio/speech"; then
  echo "READY — http://${LAN_IP}:${PORT}"
else
  echo "warm-up request failed; the server keeps running — check the log above." >&2
fi

wait "$SERVER_PID"
