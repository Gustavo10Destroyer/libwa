/**
 * A map with a fixed capacity that drops the least-recently-used entry.
 *
 * Entity caches are keyed by whatever the provider mentions — every distinct
 * user, chat, group and id pair seen during the process lifetime. Unbounded
 * they grow for as long as the process runs *and* survive a logout into the
 * next account's session; a bounded LRU keeps identity stable for the entries
 * still in use and lets the rest go.
 */
export class LruMap<V> {
  readonly #maxEntries: number;
  readonly #entries = new Map<string, V>();
  readonly #onEvict: ((key: string, value: V) => void) | undefined;

  constructor(maxEntries: number, onEvict?: (key: string, value: V) => void) {
    this.#maxEntries = Math.max(1, maxEntries);
    this.#onEvict = onEvict;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Value for `key`, marking it as recently used. */
  get(key: string): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  /** Stores `value` as the most recently used entry, evicting past the cap. */
  set(key: string, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    this.#evictOverCapacity();
  }

  delete(key: string): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  #evictOverCapacity(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) return;
      const key = oldest.value;
      const value = this.#entries.get(key);
      this.#entries.delete(key);
      if (value !== undefined) {
        this.#onEvict?.(key, value);
      }
    }
  }
}
