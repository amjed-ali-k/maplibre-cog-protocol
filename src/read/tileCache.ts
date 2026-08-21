import type {GeoTIFFImage} from 'geotiff';

/**
 * Opt-in, byte-bounded LRU over *decoded* GeoTIFF source tiles.
 *
 * Why this lives at module scope instead of on the image: `GeoTIFF.getImage()` builds a brand new
 * `GeoTIFFImage` on every call, and `CogReader.getRawTile` calls it once per map tile — so geotiff's
 * own `image.tiles` array (enabled by `cache: true`) starts empty for every single map tile and never
 * hits. Keying by `url|imageIndex` at module scope survives that instance churn and gives one memory
 * budget across every open COG.
 *
 * It matters because overview levels of a COG are rarely aligned with the web mercator grid, so one
 * 256x256 map tile usually straddles several source tiles, and neighbouring map tiles re-decode the
 * same ones. Each decode is a full Blob -> createImageBitmap -> drawImage -> getImageData round trip.
 *
 * Disabled by default: with `enabled: false` nothing is wrapped and behaviour is identical to not
 * having this module at all.
 */

type TileOrStrip = {x: number; y: number; sample: number; data: ArrayBufferLike};

type Entry = {
  promise: Promise<TileOrStrip>;
  bytes: number;
  settled: boolean;
};

export type TileCacheOptions = {
  enabled: boolean;
  maxBytes?: number;
};

export type TileCacheStats = {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
};

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

let enabled = false;
let maxBytes = DEFAULT_MAX_BYTES;
let residentBytes = 0;
let hits = 0;
let misses = 0;

// Map iteration order is insertion order, so re-inserting on read makes this an LRU.
const entries = new Map<string, Entry>();

const installedImages = new WeakSet<GeoTIFFImage>();

const touch = (key: string, entry: Entry): void => {
  entries.delete(key);
  entries.set(key, entry);
};

const drop = (key: string, entry: Entry): void => {
  if (entries.delete(key)) {
    residentBytes -= entry.bytes;
  }
};

/**
 * Evicts least-recently-used *settled* entries until the budget is met. Pending entries hold no
 * bytes yet and are skipped, both because evicting them would free nothing and because they are the
 * ones deduping in-flight decodes. The loop is bounded by the map size, so a single entry larger
 * than the whole budget just evicts itself and leaves the cache empty rather than spinning.
 */
const evict = (): void => {
  if (residentBytes <= maxBytes) {
    return;
  }
  for (const [key, entry] of entries) {
    if (residentBytes <= maxBytes) {
      return;
    }
    if (entry.settled) {
      drop(key, entry);
    }
  }
};

/**
 * Wraps `getTileOrStrip` on a single `GeoTIFFImage` so decoded source tiles are served from the
 * module-scope cache. No-op while the cache is disabled, and idempotent per instance.
 *
 * @param image the image returned by `GeoTIFF.getImage()`
 * @param keyPrefix identifies the image across instances, e.g. `` `${url}|${imageIndex}` ``
 */
export const installTileCache = (image: GeoTIFFImage, keyPrefix: string): void => {
  if (!enabled || installedImages.has(image)) {
    return;
  }
  installedImages.add(image);

  const original = image.getTileOrStrip.bind(image);

  image.getTileOrStrip = (x, y, sample, poolOrDecoder, signal) => {
    // Re-checked per call so that disabling the cache stops serving from it immediately.
    if (!enabled) {
      return original(x, y, sample, poolOrDecoder, signal);
    }

    const key = `${keyPrefix}|${x}/${y}/${sample}`;

    const cached = entries.get(key);
    if (cached !== undefined) {
      hits++;
      touch(key, cached);
      return cached.promise;
    }

    misses++;

    // The promise is cached, not the resolved value: that is what collapses a burst of concurrent
    // readRasters calls covering the same source tile into a single decode.
    const promise = original(x, y, sample, poolOrDecoder, signal);
    const entry: Entry = {promise, bytes: 0, settled: false};
    entries.set(key, entry);

    promise.then(
      (result) => {
        if (entries.get(key) !== entry) {
          return; // evicted or cleared while decoding
        }
        entry.bytes = result?.data?.byteLength ?? 0;
        entry.settled = true;
        residentBytes += entry.bytes;
        evict();
      },
      () => {
        // Drop failures so a later request can retry instead of replaying the rejection forever.
        if (entries.get(key) === entry) {
          drop(key, entry);
        }
      },
    );

    return promise;
  };
};

/**
 * Enables or disables the decoded-tile cache, optionally setting its byte budget.
 *
 * Disabling releases everything the cache is holding.
 *
 * @param options `enabled` toggles the cache; `maxBytes` sets the budget (default 256 MB)
 */
export const configureTileCache = ({enabled: nextEnabled, maxBytes: nextMaxBytes}: TileCacheOptions): void => {
  if (nextMaxBytes !== undefined) {
    if (!Number.isFinite(nextMaxBytes) || nextMaxBytes <= 0) {
      throw new Error(`Invalid maxBytes ${nextMaxBytes} for the tile cache: expected a positive, finite number.`);
    }
    maxBytes = nextMaxBytes;
  }

  enabled = nextEnabled;

  if (enabled) {
    evict();
  } else {
    clearTileCache();
  }
};

/**
 * Drops every cached tile and resets the hit/miss counters.
 */
export const clearTileCache = (): void => {
  entries.clear();
  residentBytes = 0;
  hits = 0;
  misses = 0;
};

/**
 * Current cache occupancy and hit/miss counters, for instrumentation.
 */
export const getTileCacheStats = (): TileCacheStats => ({
  entries: entries.size,
  bytes: residentBytes,
  hits,
  misses,
});
