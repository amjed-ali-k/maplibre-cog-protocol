import {afterEach, expect, test} from 'vitest';

import {clearTileCache, configureTileCache, getTileCacheStats, installTileCache} from '../../src/read/tileCache';

type TileOrStrip = {x: number; y: number; sample: number; data: ArrayBufferLike};

// A stand-in for GeoTIFFImage that only implements what installTileCache wraps, and counts decodes.
const fakeImage = (bytesPerTile = 1024) => {
  const decodes: string[] = [];

  const image = {
    decodes,
    failNext: false,
    getTileOrStrip: (x: number, y: number, sample: number): Promise<TileOrStrip> => {
      decodes.push(`${x}/${y}/${sample}`);
      if (image.failNext) {
        image.failNext = false;
        return Promise.reject(new Error('decode failed'));
      }
      return Promise.resolve({x, y, sample, data: new ArrayBuffer(bytesPerTile)});
    },
  };

  return image;
};

const install = (image: ReturnType<typeof fakeImage>, prefix: string) => {
  // @ts-expect-error partial mock — the fake only implements getTileOrStrip
  installTileCache(image, prefix);
};

afterEach(() => {
  configureTileCache({enabled: false, maxBytes: 256 * 1024 * 1024});
});

describe('tileCache', () => {
  test('is disabled by default, leaving getTileOrStrip untouched', async () => {
    const image = fakeImage();
    const original = image.getTileOrStrip;

    install(image, 'a.tif|0');

    expect(image.getTileOrStrip).toBe(original);

    await image.getTileOrStrip(0, 0, 0);
    await image.getTileOrStrip(0, 0, 0);

    expect(image.decodes).toHaveLength(2);
    expect(getTileCacheStats()).toEqual({entries: 0, bytes: 0, hits: 0, misses: 0});
  });

  test('serves repeated reads of the same source tile from cache', async () => {
    configureTileCache({enabled: true});

    const image = fakeImage();
    install(image, 'a.tif|0');

    await image.getTileOrStrip(3, 4, 0);
    await image.getTileOrStrip(3, 4, 0);
    await image.getTileOrStrip(3, 4, 0);

    expect(image.decodes).toEqual(['3/4/0']);
    expect(getTileCacheStats()).toMatchObject({entries: 1, hits: 2, misses: 1});
  });

  test('survives instance churn: a fresh image with the same key still hits', async () => {
    configureTileCache({enabled: true});

    const first = fakeImage();
    install(first, 'a.tif|0');
    await first.getTileOrStrip(1, 1, 0);

    // What GeoTIFF.getImage() does on every call: hand back a brand new instance.
    const second = fakeImage();
    install(second, 'a.tif|0');
    await second.getTileOrStrip(1, 1, 0);

    expect(first.decodes).toEqual(['1/1/0']);
    expect(second.decodes).toEqual([]);
  });

  test('keys by url and image index', async () => {
    configureTileCache({enabled: true});

    const a = fakeImage();
    const b = fakeImage();
    const c = fakeImage();
    install(a, 'a.tif|0');
    install(b, 'a.tif|1');
    install(c, 'b.tif|0');

    await a.getTileOrStrip(0, 0, 0);
    await b.getTileOrStrip(0, 0, 0);
    await c.getTileOrStrip(0, 0, 0);

    expect(getTileCacheStats()).toMatchObject({entries: 3, hits: 0, misses: 3});
  });

  test('distinguishes samples, for planar-separated images', async () => {
    configureTileCache({enabled: true});

    const image = fakeImage();
    install(image, 'a.tif|0');

    await image.getTileOrStrip(0, 0, 0);
    await image.getTileOrStrip(0, 0, 1);

    expect(image.decodes).toEqual(['0/0/0', '0/0/1']);
  });

  test('two concurrent reads of the same source tile produce one decode', async () => {
    configureTileCache({enabled: true});

    const image = fakeImage();
    install(image, 'a.tif|0');

    const [first, second] = await Promise.all([image.getTileOrStrip(2, 2, 0), image.getTileOrStrip(2, 2, 0)]);

    expect(image.decodes).toEqual(['2/2/0']);
    expect(first.data).toBe(second.data);
  });

  test('evicts least-recently-used entries to stay under maxBytes', async () => {
    configureTileCache({enabled: true, maxBytes: 3 * 1024});

    const image = fakeImage(1024);
    install(image, 'a.tif|0');

    await image.getTileOrStrip(0, 0, 0);
    await image.getTileOrStrip(1, 0, 0);
    await image.getTileOrStrip(2, 0, 0);
    await image.getTileOrStrip(0, 0, 0); // touch the oldest so it is no longer the LRU victim
    await image.getTileOrStrip(3, 0, 0); // pushes over budget, evicts 1/0/0

    expect(getTileCacheStats().bytes).toBeLessThanOrEqual(3 * 1024);
    expect(getTileCacheStats().entries).toBe(3);

    await image.getTileOrStrip(0, 0, 0); // still cached
    expect(image.decodes).toEqual(['0/0/0', '1/0/0', '2/0/0', '3/0/0']);

    await image.getTileOrStrip(1, 0, 0); // was evicted, decodes again
    expect(image.decodes).toEqual(['0/0/0', '1/0/0', '2/0/0', '3/0/0', '1/0/0']);
  });

  test('does not loop forever when one tile exceeds the whole budget', async () => {
    configureTileCache({enabled: true, maxBytes: 512});

    const image = fakeImage(4096);
    install(image, 'a.tif|0');

    const tile = await image.getTileOrStrip(0, 0, 0);

    expect(tile.data.byteLength).toBe(4096);
    expect(getTileCacheStats()).toMatchObject({entries: 0, bytes: 0});
  });

  test('evicts a rejected entry so a later request can retry', async () => {
    configureTileCache({enabled: true});

    const image = fakeImage();
    install(image, 'a.tif|0');

    image.failNext = true;
    await expect(image.getTileOrStrip(0, 0, 0)).rejects.toThrow('decode failed');

    const tile = await image.getTileOrStrip(0, 0, 0);

    expect(tile.data.byteLength).toBe(1024);
    expect(image.decodes).toEqual(['0/0/0', '0/0/0']);
  });

  test('installing twice does not double-wrap', async () => {
    configureTileCache({enabled: true});

    const image = fakeImage();
    install(image, 'a.tif|0');
    const wrapped = image.getTileOrStrip;
    install(image, 'a.tif|0');

    expect(image.getTileOrStrip).toBe(wrapped);

    await image.getTileOrStrip(0, 0, 0);
    expect(getTileCacheStats()).toMatchObject({misses: 1, hits: 0});
  });

  test('an already-wrapped instance stops serving from cache once disabled', async () => {
    configureTileCache({enabled: true});

    const image = fakeImage();
    install(image, 'a.tif|0');
    await image.getTileOrStrip(0, 0, 0);

    configureTileCache({enabled: false});

    await image.getTileOrStrip(0, 0, 0);
    expect(image.decodes).toEqual(['0/0/0', '0/0/0']);
  });

  test('disabling releases everything the cache holds', async () => {
    configureTileCache({enabled: true});

    const image = fakeImage();
    install(image, 'a.tif|0');
    await image.getTileOrStrip(0, 0, 0);

    expect(getTileCacheStats().bytes).toBe(1024);

    configureTileCache({enabled: false});

    expect(getTileCacheStats()).toEqual({entries: 0, bytes: 0, hits: 0, misses: 0});
  });

  test('clearTileCache empties the cache and resets the counters', async () => {
    configureTileCache({enabled: true});

    const image = fakeImage();
    install(image, 'a.tif|0');
    await image.getTileOrStrip(0, 0, 0);
    await image.getTileOrStrip(0, 0, 0);

    clearTileCache();

    expect(getTileCacheStats()).toEqual({entries: 0, bytes: 0, hits: 0, misses: 0});

    await image.getTileOrStrip(0, 0, 0);
    expect(image.decodes).toEqual(['0/0/0', '0/0/0']);
  });

  test('shrinking maxBytes evicts down to the new budget immediately', async () => {
    configureTileCache({enabled: true, maxBytes: 10 * 1024});

    const image = fakeImage(1024);
    install(image, 'a.tif|0');
    for (let x = 0; x < 8; x++) {
      await image.getTileOrStrip(x, 0, 0);
    }
    expect(getTileCacheStats().bytes).toBe(8 * 1024);

    configureTileCache({enabled: true, maxBytes: 3 * 1024});

    expect(getTileCacheStats().bytes).toBeLessThanOrEqual(3 * 1024);
  });

  test('rejects an invalid maxBytes', () => {
    expect(() => configureTileCache({enabled: true, maxBytes: 0})).toThrow(/positive, finite/);
    expect(() => configureTileCache({enabled: true, maxBytes: -1})).toThrow(/positive, finite/);
    expect(() => configureTileCache({enabled: true, maxBytes: Number.NaN})).toThrow(/positive, finite/);
  });
});
