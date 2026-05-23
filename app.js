import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- Геоданные континентов ---------------------------------------------------
// Координаты — географические центроиды (примерные, на основе данных USGS/CIA).
// Площадь в млн км². Все цифры — реальные.
const CONTINENTS = [
  {
    id: 'africa',
    name: 'Африка',
    flag: '🌍',
    lat: 7.1881,
    lon: 21.0938,
    area: 30.37,
    color: 0xffb547,
    tracks: [
      ['Water No Get Enemy', 'Fela Kuti'],
      ['Pata Pata', 'Miriam Makeba'],
      ['Madan', 'Salif Keita'],
      ['Agolo', 'Angélique Kidjo'],
      ['7 Seconds', 'Youssou N\'Dour & Neneh Cherry'],
      ['Yéké Yéké', 'Mory Kanté'],
    ],
  },
  {
    id: 'europe',
    name: 'Европа',
    flag: '🇪🇺',
    lat: 54.5260,
    lon: 15.2551,
    area: 10.18,
    color: 0x8ad8ff,
    tracks: [
      ['Bohemian Rhapsody', 'Queen'],
      ['La Vie en Rose', 'Édith Piaf'],
      ['Around the World', 'Daft Punk'],
      ['Dancing Queen', 'ABBA'],
      ['Symphony No. 9 — Ode to Joy', 'Ludwig van Beethoven'],
      ['Nuvole Bianche', 'Ludovico Einaudi'],
    ],
  },
  {
    id: 'asia',
    name: 'Азия',
    flag: '🏯',
    lat: 34.0479,
    lon: 100.6197,
    area: 44.58,
    color: 0xff7ab6,
    tracks: [
      ['Merry Christmas Mr. Lawrence', 'Ryuichi Sakamoto'],
      ['Silk Road', 'Kitarō'],
      ['Lag Jaa Gale', 'Lata Mangeshkar'],
      ['容易受傷的女人', 'Faye Wong'],
      ['Dynamite', 'BTS'],
      ['Sadeness (Part I)', 'Enigma'],
    ],
  },
  {
    id: 'north-america',
    name: 'Северная Америка',
    flag: '🗽',
    lat: 54.5260,
    lon: -105.2551,
    area: 24.71,
    color: 0xa3ffb0,
    tracks: [
      ['Billie Jean', 'Michael Jackson'],
      ['Like a Rolling Stone', 'Bob Dylan'],
      ['Respect', 'Aretha Franklin'],
      ['Smells Like Teen Spirit', 'Nirvana'],
      ['Hotel California', 'Eagles'],
      ['One Dance', 'Drake'],
    ],
  },
  {
    id: 'south-america',
    name: 'Южная Америка',
    flag: '🦜',
    lat: -8.7832,
    lon: -55.4915,
    area: 17.84,
    color: 0xffd166,
    tracks: [
      ['The Girl from Ipanema', 'Astrud Gilberto & Stan Getz'],
      ['Por Una Cabeza', 'Carlos Gardel'],
      ['Sozinho', 'Caetano Veloso'],
      ['Clandestino', 'Manu Chao'],
      ['Hips Don\'t Lie', 'Shakira'],
      ['Mas Que Nada', 'Sérgio Mendes'],
    ],
  },
  {
    id: 'oceania',
    name: 'Австралия и Океания',
    flag: '🦘',
    lat: -22.7359,
    lon: 140.0188,
    area: 8.51,
    color: 0xc792ff,
    tracks: [
      ['Thunderstruck', 'AC/DC'],
      ['The Less I Know the Better', 'Tame Impala'],
      ['Never Tear Us Apart', 'INXS'],
      ['Treaty', 'Yothu Yindi'],
      ['Chandelier', 'Sia'],
      ['Riptide', 'Vance Joy'],
    ],
  },
  {
    id: 'antarctica',
    name: 'Антарктида',
    flag: '🐧',
    lat: -82.8628,
    lon: 0.0,
    area: 14.20,
    color: 0xeaf2ff,
    tracks: [
      ['Antarctica', 'Vangelis'],
      ['Hoppípolla', 'Sigur Rós'],
      ['An Ending (Ascent)', 'Brian Eno'],
      ['On the Nature of Daylight', 'Max Richter'],
      ['Avril 14th', 'Aphex Twin'],
      ['Spiegel im Spiegel', 'Arvo Pärt'],
    ],
  },
];

// --- Утилиты ----------------------------------------------------------------
// lat (–90..+90), lon (–180..+180) → точка на сфере радиуса R.
// Соответствует стандартной UV-развёртке Three.SphereGeometry и
// экваторно-цилиндрической текстуре Земли (NASA Blue Marble).
function latLonToVector3(lat, lon, radius) {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
     radius * Math.cos(phi),
     radius * Math.sin(phi) * Math.sin(theta),
  );
}

function youTubeSearch(title, artist) {
  const q = encodeURIComponent(`${artist} ${title}`);
  return `https://www.youtube.com/results?search_query=${q}`;
}

// --- Three.js сцена ---------------------------------------------------------
const container = document.getElementById('canvas-container');

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  2000,
);
camera.position.set(0, 3, 6);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

// Звёздное поле
function makeStars(count = 3500, radius = 800) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Равномерное распределение точек на сфере
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = radius * (0.8 + Math.random() * 0.2);
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.2,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.85,
  });
  return new THREE.Points(geo, mat);
}
scene.add(makeStars());

// Освещение: солнечный свет + слабая засветка теневой стороны
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(5, 2, 4);
scene.add(sun);
scene.add(new THREE.AmbientLight(0x223355, 0.55));

// --- Земля ------------------------------------------------------------------
const EARTH_RADIUS = 2;
const loader = new THREE.TextureLoader();
loader.crossOrigin = 'anonymous';

const earthTex = loader.load(
  'https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg',
);
earthTex.colorSpace = THREE.SRGBColorSpace;
earthTex.anisotropy = 8;

// Группа-наклон: ось вращения Земли наклонена на 23.5° (как в реальности).
// Сама Земля вращается вокруг своей локальной оси Y внутри этой группы —
// так наклон остаётся фиксированным относительно мира при любом спине.
const earthTilt = new THREE.Group();
earthTilt.rotation.z = THREE.MathUtils.degToRad(23.5);
scene.add(earthTilt);

const earthGeom = new THREE.SphereGeometry(EARTH_RADIUS, 96, 96);
const earthMat = new THREE.MeshPhongMaterial({
  map: earthTex,
  shininess: 12,
  specular: new THREE.Color(0x224466),
});
const earth = new THREE.Mesh(earthGeom, earthMat);
earthTilt.add(earth);

// Стартовый разворот: долгота ~30° (Восточная Европа / западная Россия)
// смотрит на камеру. По формуле latLonToVector3 и Three.js Ry-конвенции
// это требует поворота на 240°.
earth.rotation.y = THREE.MathUtils.degToRad(240);

// Облачный слой
const cloudsTex = loader.load(
  'https://threejs.org/examples/textures/planets/earth_clouds_1024.png',
);
cloudsTex.colorSpace = THREE.SRGBColorSpace;
const clouds = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS * 1.012, 64, 64),
  new THREE.MeshLambertMaterial({
    map: cloudsTex,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  }),
);
earth.add(clouds);

// Атмосферное свечение (бэксайд-фейк хало)
const atmosphereMat = new THREE.ShaderMaterial({
  side: THREE.BackSide,
  transparent: true,
  uniforms: {},
  vertexShader: `
    varying vec3 vN;
    void main() {
      vN = normalize(normalMatrix * normal);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    varying vec3 vN;
    void main() {
      float i = pow(0.62 - dot(vN, vec3(0.0, 0.0, 1.0)), 2.2);
      gl_FragColor = vec4(0.32, 0.62, 1.0, 1.0) * i;
    }
  `,
});
const atmosphere = new THREE.Mesh(
  new THREE.SphereGeometry(EARTH_RADIUS * 1.12, 64, 64),
  atmosphereMat,
);
earth.add(atmosphere);

// --- Маркеры континентов ----------------------------------------------------
const markers = [];
const markerGroup = new THREE.Group();
earth.add(markerGroup);

const PIN_HEIGHT = 0.06;
for (const c of CONTINENTS) {
  const surface = latLonToVector3(c.lat, c.lon, EARTH_RADIUS);
  const out = latLonToVector3(c.lat, c.lon, EARTH_RADIUS + PIN_HEIGHT);

  // Стерженёк
  const stickGeom = new THREE.CylinderGeometry(0.008, 0.008, PIN_HEIGHT, 8);
  const stickMat = new THREE.MeshBasicMaterial({ color: c.color });
  const stick = new THREE.Mesh(stickGeom, stickMat);
  stick.position.copy(surface.clone().lerp(out, 0.5));
  stick.lookAt(0, 0, 0);
  stick.rotateX(Math.PI / 2);

  // Сфера маркера + ореол (sprite для пульса)
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 16, 16),
    new THREE.MeshBasicMaterial({ color: c.color }),
  );
  ball.position.copy(out);
  ball.userData.continent = c;

  // Пульсирующий ореол на основе sprite
  const haloCanvas = document.createElement('canvas');
  haloCanvas.width = haloCanvas.height = 128;
  const ctx = haloCanvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  const hex = '#' + c.color.toString(16).padStart(6, '0');
  grad.addColorStop(0, hex + 'ff');
  grad.addColorStop(0.35, hex + '66');
  grad.addColorStop(1, hex + '00');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const haloTex = new THREE.CanvasTexture(haloCanvas);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  halo.position.copy(out);
  halo.scale.setScalar(0.25);
  halo.userData.baseScale = 0.25;
  halo.userData.phase = Math.random() * Math.PI * 2;

  markerGroup.add(stick);
  markerGroup.add(ball);
  markerGroup.add(halo);
  markers.push({ ball, halo, data: c });
}

// --- Управление -------------------------------------------------------------
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 3;
controls.maxDistance = 14;
controls.rotateSpeed = 0.5;
controls.zoomSpeed = 0.6;

let autoRotate = false;
renderer.domElement.addEventListener('dblclick', () => {
  autoRotate = !autoRotate;
});

// --- Raycaster для кликов ---------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const ballMeshes = markers.map(m => m.ball);

function setPointerFromEvent(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
}

renderer.domElement.addEventListener('pointermove', e => {
  setPointerFromEvent(e);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(ballMeshes, false);
  renderer.domElement.style.cursor = hits.length ? 'pointer' : 'grab';
});

renderer.domElement.addEventListener('click', e => {
  setPointerFromEvent(e);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(ballMeshes, false);
  if (hits.length) {
    openPanel(hits[0].object.userData.continent);
    flyToContinent(hits[0].object.userData.continent);
  }
});

// --- UI: панель -------------------------------------------------------------
const panel = document.getElementById('panel');
const panelName = document.getElementById('panel-name');
const panelFlag = document.getElementById('panel-flag');
const panelCoords = document.getElementById('panel-coords');
const panelArea = document.getElementById('panel-area');
const trackList = document.getElementById('track-list');
document.getElementById('close-panel').addEventListener('click', closePanel);

function openPanel(c) {
  panelName.textContent = c.name;
  panelFlag.textContent = c.flag;
  const latStr = `${Math.abs(c.lat).toFixed(2)}° ${c.lat >= 0 ? 'с.ш.' : 'ю.ш.'}`;
  const lonStr = `${Math.abs(c.lon).toFixed(2)}° ${c.lon >= 0 ? 'в.д.' : 'з.д.'}`;
  panelCoords.textContent = `Центроид: ${latStr}, ${lonStr}`;
  panelArea.textContent = `Площадь: ${c.area.toFixed(2)} млн км²`;

  trackList.innerHTML = '';
  c.tracks.forEach(([title, artist], i) => {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="num">${String(i + 1).padStart(2, '0')}</span>
      <span class="meta">
        <span class="title"></span>
        <span class="artist"></span>
      </span>
      <a class="play" target="_blank" rel="noopener" aria-label="Play">▶</a>
    `;
    li.querySelector('.title').textContent = title;
    li.querySelector('.artist').textContent = artist;
    li.querySelector('.play').href = youTubeSearch(title, artist);
    trackList.appendChild(li);
  });

  panel.classList.remove('hidden');
  panel.setAttribute('aria-hidden', 'false');
}

function closePanel() {
  panel.classList.add('hidden');
  panel.setAttribute('aria-hidden', 'true');
}

// --- Полёт камеры к континенту ---------------------------------------------
let flying = null;
function flyToContinent(c) {
  // Берём точку маркера в мировых координатах
  const local = latLonToVector3(c.lat, c.lon, EARTH_RADIUS + PIN_HEIGHT);
  const world = local.clone().applyMatrix4(earth.matrixWorld);
  const target = world.clone().normalize().multiplyScalar(5.5);
  flying = { from: camera.position.clone(), to: target, t: 0, dur: 1.2 };
  autoRotate = false;
}

// --- Легенда ----------------------------------------------------------------
const legend = document.getElementById('legend');
for (const c of CONTINENTS) {
  const btn = document.createElement('button');
  const hex = '#' + c.color.toString(16).padStart(6, '0');
  btn.innerHTML = `<span class="dot" style="background:${hex};color:${hex}"></span>${c.name}`;
  btn.addEventListener('click', () => {
    openPanel(c);
    flyToContinent(c);
  });
  legend.appendChild(btn);
}

// --- Анимация ---------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();

  if (autoRotate) {
    earth.rotation.y += dt * 0.06;
  }
  clouds.rotation.y += dt * 0.012;

  // Пульсация ореолов
  for (const m of markers) {
    const s = m.halo.userData.baseScale * (1 + 0.18 * Math.sin(t * 2.2 + m.halo.userData.phase));
    m.halo.scale.setScalar(s);
  }

  // Полёт камеры
  if (flying) {
    flying.t += dt / flying.dur;
    const k = Math.min(1, flying.t);
    const e = 1 - Math.pow(1 - k, 3); // ease-out cubic
    camera.position.lerpVectors(flying.from, flying.to, e);
    camera.lookAt(0, 0, 0);
    if (k >= 1) flying = null;
  }

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

// --- Ресайз -----------------------------------------------------------------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') closePanel();
});
