/**
 * Web-standard Base64 helpers (no `node:buffer` dependency).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return '';
  const chunkSize = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += chunkSize) {
    const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
    let binary = '';
    for (let j = 0; j < slice.byteLength; j++) {
      binary += String.fromCharCode(slice[j]!);
    }
    parts.push(binary);
  }
  return btoa(parts.join(''));
}

export function base64ToBytes(base64: string): Uint8Array {
  if (!base64) return new Uint8Array(0);
  const clean = base64.trim();
  if (!clean) return new Uint8Array(0);
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
