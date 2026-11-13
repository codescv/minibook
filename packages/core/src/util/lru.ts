/**
 * Byte-weighted or entry-weighted LRU cache backed by JS `Map` insertion order.
 */
export class LruCache<K, V> {
  private readonly maxWeight: number;
  private readonly weightOf: (value: V) => number;
  private readonly entries = new Map<K, { value: V; weight: number }>();
  private totalWeight = 0;

  constructor(maxWeight: number, weightOf: (value: V) => number = () => 1) {
    this.maxWeight = Math.max(1, maxWeight);
    this.weightOf = weightOf;
  }

  get size(): number {
    return this.entries.size;
  }

  get weight(): number {
    return this.totalWeight;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: K, value: V): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.totalWeight -= existing.weight;
      this.entries.delete(key);
    }
    const weight = Math.max(1, this.weightOf(value));
    if (weight > this.maxWeight) {
      return;
    }
    this.entries.set(key, { value, weight });
    this.totalWeight += weight;
    while (this.totalWeight > this.maxWeight && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.totalWeight -= oldest.weight;
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }
}
