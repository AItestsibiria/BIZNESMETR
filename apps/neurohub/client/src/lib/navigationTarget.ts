// Босс 2026-05-31: строгие типы целей навигации в 3D-globe.
//
// Жёсткое разделение planet vs star — НЕЛЬЗЯ переиспользовать selectedTarget
// без type, НЕЛЬЗЯ Earth как fallback для star flight, НЕЛЬЗЯ shared state
// где star может перезаписать selectedPlanet или наоборот.
//
// Planet (включая Sun/Moon) — реальный 3D Object в world coordinates →
// flight по `worldPosition` через camera.lerpVectors.
//
// Star (из VirtualSky / skyCatalog BRIGHT_STARS) — НЕ scene body. Это
// направление на небесной сфере (RA/Dec). Flight = камера летит ПО
// направлению на дальнюю virtualPoint (например на радиусе 20000 в
// сторону RA/Dec). Земля как fallback НЕ используется.

import type * as THREE from "three";

export type TargetType = "planet" | "star" | "none";

export interface PlanetTarget {
  type: "planet";
  /** Уникальный ключ — moon | sun | mercury | venus | mars | jupiter | saturn | uranus | neptune. */
  id: string;
  /** Three.js mesh/group — позиция читается через getWorldPosition (динамически). */
  object3D: THREE.Object3D;
  /** Snapshot world-position на момент создания target'а (для start позиции lerp). */
  worldPosition: THREE.Vector3;
}

export interface StarTarget {
  type: "star";
  /** ID из BRIGHT_STARS каталога (Sirius / Vega / etc). */
  id: string;
  /** Русское имя для UI. */
  name?: string;
  /** Right Ascension в часах [0, 24). */
  ra: number;
  /** Declination в градусах [-90, 90]. */
  dec: number;
  /** Нормализованный 3D-вектор направления (RA/Dec → unit vector). */
  direction: THREE.Vector3;
  /** Точка на дальней небесной сфере куда летит камера (direction × R_sky). */
  virtualPoint: THREE.Vector3;
}

export interface NoneTarget {
  type: "none";
}

export type NavigationTarget = PlanetTarget | StarTarget | NoneTarget;

/**
 * Конвертация RA (часы) + Dec (градусы) в 3D unit vector (Earth-relative).
 * RA → азимут (×15° для часов), Dec → высота. Y-up Three.js конвенция.
 */
export function raDecToDirection(ra: number, dec: number, ThreeNS: typeof import("three")): THREE.Vector3 {
  const lon = ra * 15 * (Math.PI / 180); // RA hours → radians
  const lat = dec * (Math.PI / 180);
  const x = Math.cos(lat) * Math.cos(lon);
  const z = Math.cos(lat) * Math.sin(lon);
  const y = Math.sin(lat);
  return new ThreeNS.Vector3(x, y, z).normalize();
}

/** Радиус дальней небесной сферы для star flight target (за всеми planet meshes). */
export const STAR_SKY_RADIUS = 50000;

/** Создать StarTarget из RA/Dec. */
export function createStarTarget(
  id: string,
  ra: number,
  dec: number,
  name: string | undefined,
  ThreeNS: typeof import("three"),
): StarTarget {
  const direction = raDecToDirection(ra, dec, ThreeNS);
  const virtualPoint = direction.clone().multiplyScalar(STAR_SKY_RADIUS);
  return { type: "star", id, name, ra, dec, direction, virtualPoint };
}

/** Создать PlanetTarget из existing mesh. */
export function createPlanetTarget(
  id: string,
  object3D: THREE.Object3D,
  ThreeNS: typeof import("three"),
): PlanetTarget {
  const worldPosition = new ThreeNS.Vector3();
  try { object3D.getWorldPosition(worldPosition); } catch { /* no-op */ }
  return { type: "planet", id, object3D, worldPosition };
}
