// shim: ensure `mergeGeometries` export is available regardless of three version
// NOTE: must import via a relative path, NOT the bare 'three/examples/...' specifier —
// vite.config.js aliases that exact specifier to this file, so importing it by name here
// would make this module import itself (an infinite self-reference), leaving BG's exports
// permanently undefined and silently forcing the no-op fallback below.
import * as BG from '../../node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';

// Provide the named export expected by web-ifc-three
export const mergeGeometries =
  BG.mergeGeometries ?? BG.mergeBufferGeometries ?? function (geometries) {
    console.warn('mergeGeometries fallback used — behavior may be incorrect.');
    return geometries && geometries.length ? geometries[0] : null;
  };

// Re-export everything else so other imports still work
export * from '../../node_modules/three/examples/jsm/utils/BufferGeometryUtils.js';
export default BG;