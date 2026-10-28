/** Position texture is GRID_W x GRID_H RGBA32F, colour texture RGBA8. */
export const GRID_W = 1024;
export const GRID_H = 512;
export const POINT_COUNT = GRID_W * GRID_H; // 2^19 = 524288

/** Side of the square working frame a picture is fitted into. */
export const FRAME = 1024;

/** A salient point of a picture, in frame units: x,y in -1..1, z = near - 0.5. */
export interface Feature {
  x: number;
  y: number;
  z: number;
}

export interface SceneData {
  /**
   * xy = position in the square frame (-1..1, y up), z = near - 0.5
   * (-0.5 far .. 0.5 near), w = mote weight (brightness factor 0..1).
   * Length GRID_W*GRID_H*4.
   */
  pos: Float32Array;
  /** rgba8 colour. Length GRID_W*GRID_H*4. */
  col: Uint8Array;
  /** salient points for the trackers, strongest first */
  feats: Feature[];
  /** a photograph: its colours are shown as they are, even on paper */
  photo: boolean;
}

/** Normalised depth map: values 0 (far) .. 1 (near), row-major. */
export interface DepthMap {
  w: number;
  h: number;
  data: Float32Array;
}
