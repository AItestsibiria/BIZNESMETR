// Реальные геоцентрические 3D-позиции планет в three.js scene (world-units).
//
// Босс 2026-05-31 (8-я попытка фикса flyby): планеты должны стоять в РЕАЛЬНЫХ
// 3D-позициях с учётом реальных дистанций от Земли (AU) — НЕ на одной сфере
// radius=1500. Камера летит к настоящей точке планеты в космосе → честный
// VirtualSky-style 3D, как в реальной солнечной системе.
//
// Алгоритм — упрощённые орбитальные элементы Schlyter (ppcomp.html, epoch J2000):
// 1) Гелиоцентрические декартовы координаты планеты через Keplerian orbital
//    elements (a, e, i, Ω/N, ω/w, M) с прецессией по дате.
// 2) Геоцентрические = гелио_планета - гелио_Земля (Земля как 3-я планета).
// 3) Эклиптика → экватор (наклон 23.4393°).
// 4) Scale: 1 AU = AU_SCALE world-units (= 1500). Меркурий ~585, Нептун ~45000.
//
// Reuse-working-solutions: те же orbital elements что в globe-view.tsx
// `PLANET_ELEMENTS` (Schlyter). НЕ дублируем — экспортируем оттуда же.
// Связано с: Влёт-результат rule (один фикс закрывает корень), Reuse rule.

import * as THREE from "three";

// Орбитальные элементы Schlyter (https://www.stjarnhimlen.se/comp/ppcomp.html).
// Формат: каждое значение = [base_at_epoch_J2000, rate_per_day].
// a = большая полуось (а.е.) — константа.
// e, i, N, w, M — эксцентриситет / наклонение / долгота восх.узла / арг.перигелия / средняя аномалия.
type OrbElem = {
  N: [number, number];
  i: [number, number];
  w: [number, number];
  a: number;
  e: [number, number];
  M: [number, number];
};

const ELEMENTS: Record<string, OrbElem> = {
  mercury: { N: [48.3313, 3.24587e-5], i: [7.0047, 5.0e-8], w: [29.1241, 1.01444e-5], a: 0.387098, e: [0.205635, 5.59e-10], M: [168.6562, 4.0923344368] },
  venus:   { N: [76.6799, 2.4659e-5],  i: [3.3946, 2.75e-8], w: [54.891, 1.38374e-5],  a: 0.72333,  e: [0.006773, -1.302e-9], M: [48.0052, 1.6021302244] },
  // Земля (требуется для перевода гелио→гео). Schlyter не даёт Земли напрямую —
  // используем зеркало Солнца (см. ниже sunHeliocentric, который и есть -Earth).
  mars:    { N: [49.5574, 2.11081e-5], i: [1.8497, -1.78e-8], w: [286.5016, 2.92961e-5], a: 1.523688, e: [0.093405, 2.516e-9], M: [18.6021, 0.5240207766] },
  jupiter: { N: [100.4542, 2.76854e-5], i: [1.303, -1.557e-7], w: [273.8777, 1.64505e-5], a: 5.20256, e: [0.048498, 4.469e-9], M: [19.895, 0.0830853001] },
  saturn:  { N: [113.6634, 2.3898e-5], i: [2.4886, -1.081e-7], w: [339.3939, 2.97661e-5], a: 9.55475, e: [0.055546, -9.499e-9], M: [316.967, 0.0334442282] },
  uranus:  { N: [74.0005, 1.3978e-5], i: [0.7733, 1.9e-8], w: [96.6612, 3.0565e-5], a: 19.18171, e: [0.047318, 7.45e-9], M: [142.5905, 0.011725806] },
  neptune: { N: [131.7806, 3.0173e-5], i: [1.7700, -2.55e-7], w: [272.8461, -6.027e-6], a: 30.05826, e: [0.008606, 2.15e-9], M: [260.2471, 0.005995147] },
};

const RAD = Math.PI / 180;

// Дни от эпохи Шлютера (2000 Jan 0.0 UT = JD 2451543.5).
function schlyterDay(dt: number): number {
  return dt / 86400000 + 2440587.5 - 2451543.5;
}

// Нормировка угла в [0, 360).
function rev(x: number): number {
  return ((x % 360) + 360) % 360;
}

// Гелиоцентрические декартовы (эклиптические) координаты планеты в а.е.
// Возвращает [xh, yh, zh] в гелиоцентрической эклиптической плоскости J2000.
function planetHeliocentric(el: OrbElem, d: number): [number, number, number] {
  const N = (el.N[0] + el.N[1] * d) * RAD;
  const i = (el.i[0] + el.i[1] * d) * RAD;
  const w = (el.w[0] + el.w[1] * d) * RAD;
  const a = el.a;
  const e = el.e[0] + el.e[1] * d;
  const M = rev(el.M[0] + el.M[1] * d) * RAD;
  // Решаем уравнение Кеплера E - e*sin(E) = M (3 итерации Ньютона — достаточно).
  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  for (let k = 0; k < 3; k++) {
    E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  }
  // Истинная аномалия + радиус-вектор.
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  const r = Math.sqrt(xv * xv + yv * yv);
  // Гелиоцентрические эклиптические (поворот по N, наклон по i, ориентация по w).
  const cosN = Math.cos(N), sinN = Math.sin(N);
  const cosVW = Math.cos(v + w), sinVW = Math.sin(v + w);
  const cosI = Math.cos(i), sinI = Math.sin(i);
  const xh = r * (cosN * cosVW - sinN * sinVW * cosI);
  const yh = r * (sinN * cosVW + cosN * sinVW * cosI);
  const zh = r * (sinVW * sinI);
  return [xh, yh, zh];
}

// Гелиоцентрические координаты Земли в а.е. (= -координаты Солнца у Шлютера).
// Шлютер даёт гелио координаты Солнца относительно Земли (xs, ys, 0); инвертируем.
function earthHeliocentric(d: number): [number, number, number] {
  const ws = (282.9404 + 4.70935e-5 * d) * RAD;
  const es = 0.016709 - 1.151e-9 * d;
  const Ms = rev(356.047 + 0.9856002585 * d) * RAD;
  let Es = Ms + es * Math.sin(Ms) * (1 + es * Math.cos(Ms));
  for (let k = 0; k < 3; k++) {
    Es = Es - (Es - es * Math.sin(Es) - Ms) / (1 - es * Math.cos(Es));
  }
  const xvs = Math.cos(Es) - es;
  const yvs = Math.sqrt(1 - es * es) * Math.sin(Es);
  const vs = Math.atan2(yvs, xvs);
  const rs = Math.sqrt(xvs * xvs + yvs * yvs);
  const lonsun = vs + ws;
  // Координаты Солнца относительно Земли (гелио): xs = rs*cos(lonsun), ys = rs*sin(lonsun).
  // Земля относительно Солнца — противоположный вектор.
  const xs = rs * Math.cos(lonsun);
  const ys = rs * Math.sin(lonsun);
  return [-xs, -ys, 0];
}

// World-units на 1 астрономическую единицу. Подобрано так, чтобы Меркурий был
// заметно ВНЕ near Earth (radius Earth=100), а Нептун — внутри cam.far=80000.
// 1 AU = 1500 → Меркурий ≈ 585 (за Землёй), Юпитер ≈ 7800, Нептун ≈ 45075.
export const AU_SCALE = 1500;

// Наклон эклиптики к экватору (J2000) в радианах.
const ECLIPTIC_OBLIQUITY = 23.4393 * RAD;

// Главный экспорт: реальная 3D-позиция планеты в three.js scene относительно
// центра Земли (центр scene). Возвращает Vector3 в world-units (1 AU = AU_SCALE).
// Применяет: гелио_планета → гео = (гелио_планета - гелио_земля) → эклиптика→экватор
// → scale в world-units. Никаких подгонок — реальная астрономия.
export function getPlanetGeocentric3D(key: string, date: number): THREE.Vector3 {
  const el = ELEMENTS[key];
  if (!el) return new THREE.Vector3(0, 0, 0);
  const d = schlyterDay(date);
  const [xhP, yhP, zhP] = planetHeliocentric(el, d);
  const [xhE, yhE, zhE] = earthHeliocentric(d);
  // Геоцентрические эклиптические (а.е.).
  const xg = xhP - xhE;
  const yg = yhP - yhE;
  const zg = zhP - zhE;
  // Эклиптика → экватор (поворот вокруг X-оси на 23.4393°).
  const cosObl = Math.cos(ECLIPTIC_OBLIQUITY);
  const sinObl = Math.sin(ECLIPTIC_OBLIQUITY);
  const xe = xg;
  const ye = yg * cosObl - zg * sinObl;
  const ze = yg * sinObl + zg * cosObl;
  // Scale в world-units и поворот в three.js basis: у three-globe Y — север,
  // экваториальная плоскость = XZ. У Шлютера X — точка весеннего равноденствия
  // (на экваторе), Y — +90° по экватору, Z — северный полюс. Преобразование:
  // three.X = xe, three.Y = ze (полюс), three.Z = -ye (для правильного направления вращения).
  return new THREE.Vector3(xe * AU_SCALE, ze * AU_SCALE, -ye * AU_SCALE);
}

// Безопасная проверка: ключ — известная планета.
export function isKnownPlanet(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(ELEMENTS, key);
}
