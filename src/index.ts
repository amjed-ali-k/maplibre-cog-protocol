import cogProtocol from './cogProtocol';
import {getCogMetadata, setRequestHeaders} from './read/CogReader';
import locationValues from './read/locationValues';
import {
  clearTileCache,
  configureTileCache,
  getTileCacheStats,
  type TileCacheOptions,
  type TileCacheStats,
} from './read/tileCache';
import {colorScale, colorSchemeNames} from './render/colorScale';
import setColorFunction from './render/custom/setColorFunction';
import {clearMask, setMask} from './render/mask';

export type {TileCacheOptions, TileCacheStats};
export {
  clearMask,
  clearTileCache,
  cogProtocol,
  colorScale,
  colorSchemeNames,
  configureTileCache,
  getCogMetadata,
  getTileCacheStats,
  locationValues,
  setColorFunction,
  setMask,
  setRequestHeaders,
};
