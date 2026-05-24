export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    aMag += x * x;
    bMag += y * y;
  }
  const denom = Math.sqrt(aMag) * Math.sqrt(bMag);
  if (denom === 0) return 0;
  return dot / denom;
}

export function similarityPercent(cosine: number): number {
  const clamped = Math.max(0, Math.min(1, cosine));
  return Math.round(clamped * 1000) / 10;
}

export function encodeEmbedding(vec: Float32Array): string {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString(
    'base64'
  );
}

export function decodeEmbedding(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(
    copy.buffer,
    copy.byteOffset,
    copy.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}
