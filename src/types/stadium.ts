import type { Vec3 } from './game';

export interface StadiumColors {
  grassLight: number;
  grassDark: number;
  redTeam: number;
  blueTeam: number;
  refKit: number;
  nightSkyTop: number;
  nightSkyHorizon: number;
}

/**
 * Spatial coordinate contract for the stylized 3D night stadium.
 *
 * Pitch Orientation & Goal Directions:
 * - X axis runs across the width of the pitch: [-halfWidth, +halfWidth] = [-22, +22].
 * - Z axis runs along the length of the pitch: [-halfLength, +halfLength] = [-34, +34].
 * - Y axis is vertical (pitch surface at Y = 0).
 * - RED team defends the goal at Z = -34 (facing +Z) and attacks toward Z = +34.
 *   -> Ball entering Z > +34 inside goal bounds scores for RED (`goalScored = 'red'`).
 * - BLUE team defends the goal at Z = +34 (facing -Z) and attacks toward Z = -34.
 *   -> Ball entering Z < -34 inside goal bounds scores for BLUE (`goalScored = 'blue'`).
 * - Technical area (coaches & benches) sits on the +X touchline (`X ≈ 24.5..25.5`).
 * - VAR review booth sits on the -X touchline (`X = -25.5, Z = 0`).
 */
export interface StadiumConfig {
  pitchWidth: number;
  halfWidth: number;
  pitchLength: number;
  halfLength: number;
  goalWidth: number;
  goalHeight: number;
  goalDepth: number;
  penaltyBoxWidth: number;
  penaltyBoxDepth: number;
  penaltySpotZ: number;
  centerCircleRadius: number;
  benchPositions: {
    red: Vec3[];
    blue: Vec3[];
  };
  coachZones: {
    red: Vec3;
    blue: Vec3;
  };
  varBoothPos: Vec3;
  floodlightTowers: Vec3[];
  standsCameraPos: Vec3;
  colors: StadiumColors;
}

export const DEFAULT_STADIUM_CONFIG: StadiumConfig = {
  pitchWidth: 44,
  halfWidth: 22,
  pitchLength: 68,
  halfLength: 34,
  goalWidth: 9.2,
  goalHeight: 3.6,
  goalDepth: 2.6,
  penaltyBoxWidth: 24,
  penaltyBoxDepth: 12,
  penaltySpotZ: 23,
  centerCircleRadius: 6.5,
  benchPositions: {
    red: [
      { x: 25.5, y: 0, z: -9 },
      { x: 25.5, y: 0, z: -6 },
      { x: 25.5, y: 0, z: -3 },
    ],
    blue: [
      { x: 25.5, y: 0, z: 3 },
      { x: 25.5, y: 0, z: 6 },
      { x: 25.5, y: 0, z: 9 },
    ],
  },
  coachZones: {
    red: { x: 24.5, y: 0, z: -13 },
    blue: { x: 24.5, y: 0, z: 13 },
  },
  varBoothPos: { x: -25.5, y: 0, z: 0 },
  floodlightTowers: [
    { x: -30, y: 0, z: -42 },
    { x: 30, y: 0, z: -42 },
    { x: -30, y: 0, z: 42 },
    { x: 30, y: 0, z: 42 },
  ],
  standsCameraPos: { x: -34, y: 15, z: -14 },
  colors: {
    grassLight: 0x22a855,
    grassDark: 0x198943,
    redTeam: 0xe62e3d,
    blueTeam: 0x2277ff,
    refKit: 0xffd426,
    nightSkyTop: 0x050918,
    nightSkyHorizon: 0x14224a,
  },
};
