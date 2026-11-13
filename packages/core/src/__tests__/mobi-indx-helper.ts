export function encodeVarIntForwardForTest(val: number): Uint8Array {
  if (val === 0) return Uint8Array.from([0x80]);
  const bytes: number[] = [];
  let v = val;
  while (v > 0) {
    bytes.push(v & 0x7f);
    v = Math.floor(v / 128);
  }
  bytes.reverse();
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! | 0x80;
  return Uint8Array.from(bytes);
}
