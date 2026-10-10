/* Visualizador de edifícios 2D/3D — MapLibre GL JS (um único motor para os dois modos) */

const CONFIG = {
  // Pasta dos dados relativa a ESTA página: o guimaraes3d.html já está dentro de dados3dguimarep/,
  // por isso os ficheiros (e o manifest.json) estão ao lado dele. Se mover o HTML para a raiz, use 'dados3dguimarep/'.
  pastaDados: './',
  // Ficheiros a carregar, pelo nome (na pasta acima). Se a lista ficar vazia, tenta manifest.json e depois a listagem da pasta.
  ficheiros: ['guima_edific.geojson', 'engenh_osm_estradas_guimaraes.geojson', 'mdt.tif'],
  // Alturas aleatórias (para experiências, quando os dados não têm altura): entre min e max, em metros
  alturasAleatorias: true,
  alturaMin: 6,
  alturaMax: 36,
  // Mapa de fundo (sem chave de API): 'imagery' | 'topo' | 'navegacao' | 'osm' | null (sem fundo)
  basemap: 'imagery',
  // false = edifícios sempre com a altura real/fixa (só a câmara transita); true = os volumes crescem do chão ao mudar para 3D
  animarAltura: false,
  // Linhas (ruas, caminhos, rios...): qualquer LineString/MultiLineString nos GeoJSON, desenhadas sobre o relevo
  linhas: { cor: '#ffd23f', largura: 2.2, contorno: '#1d2a33' },
  // Cor de cada edifício a partir dos pixéis da imagem de satélite (Esri) dentro do contorno
  corPorImagem: true,
  zoomCorMax: 18,    // detalhe máximo das imagens usadas
  maxTilesCor: matchMedia('(pointer: coarse)').matches ? 500 : 1500, // se houver mais tiles, baixa o zoom automaticamente
  // Relevo a partir de um MDT em GeoTIFF na pasta data (.tif/.tiff). exagero: fator vertical; sombreado: sombreamento do terreno
  relevo: { exagero: 1, sombreado: true, assentarEdificios: false },
  // Propriedades onde procurar a altura (em metros), por ordem de prioridade
  camposAltura: ['altura', 'height', 'altura_m', 'alt', 'h', 'building:height', 'cota_topo', 'ALTURA', 'HEIGHT'],
  // Propriedades com número de pisos (convertidos com metrosPorPiso)
  camposPisos: ['pisos', 'n_pisos', 'num_pisos', 'floors', 'levels', 'building:levels', 'nr_pisos', 'PISOS'],
  metrosPorPiso: 3,
  // Sem dados de altura: altura base + variação determinística (±) para dar leitura de volumes
  alturaPadrao: 9,
  variacao: 3,
  // Sistema de coordenadas assumido quando os dados não estão em graus (PT-TM06/ETRS89)
  crsPadrao: 'EPSG:3763',
  camera3D: { pitch: 60, bearing: null, zoom: 16, alvo: [-8.300889, 41.446167] }, // alvo [lon, lat]: para onde voa ao entrar em 3D (41°26'46.2"N 8°18'03.2"W); null = mantém o centro; // zoom: aproxima até este nível ao entrar em 3D (null = não mexe no zoom); // bearing: null = não roda; número = roda para esse rumo ao entrar em 3D
  duracao: 1400
};

proj4.defs('EPSG:3763', '+proj=tmerc +lat_0=39.6682583333333 +lon_0=-8.13310833333333 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');
proj4.defs('EPSG:27493', '+proj=tmerc +lat_0=39.66666666666666 +lon_0=-8.131906111111112 +k=1 +x_0=180.598 +y_0=-86.99 +ellps=intl +towgs84=-223.237,110.193,36.649,0,0,0,0 +units=m +no_defs');

const estado = { modo: '2d', fator: CONFIG.animarAltura ? 0 : 1, animacao: null };
const elStatus = document.getElementById('status');
const botao = document.getElementById('btn3d');

function mostrarEstado(msg, erro = false) {
  elStatus.textContent = msg;
  elStatus.className = erro ? 'erro' : '';
}

/* ---------- Descoberta e leitura dos ficheiros ---------- */

async function descobrirFicheiros() {
  // 0) nomes definidos em CONFIG.ficheiros
  if (CONFIG.ficheiros && CONFIG.ficheiros.length) {
    return CONFIG.ficheiros.map(n => CONFIG.pastaDados + encodeURIComponent(n));
  }
  // 1) dados3dguimarep/manifest.json (lista de nomes), se existir
  try {
    const r = await fetch(CONFIG.pastaDados + 'manifest.json');
    if (r.ok) return (await r.json()).map(n => CONFIG.pastaDados + n);
  } catch (_) { /* segue */ }
  // 2) listagem de diretório (python -m http.server, npx serve, etc.)
  const r = await fetch(CONFIG.pastaDados);
  if (!r.ok) throw new Error('Sem listagem de pasta neste servidor: crie dados3dguimarep/manifest.json com a lista de ficheiros, ex.: ["edificios.geojson", "estradas.geojson", "mdt.tif"].');
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const ficheiros = [...doc.querySelectorAll('a')]
    .map(a => decodeURIComponent(a.getAttribute('href') || '').split('/').pop())
    .filter(n => /\.(geo)?json$|\.tiff?$/i.test(n) && n !== 'manifest.json');
  if (!ficheiros.length) throw new Error('Nenhum ficheiro .geojson/.json/.tif encontrado em dados3dguimarep/. Crie dados3dguimarep/manifest.json com a lista de nomes.');
  return ficheiros.map(n => CONFIG.pastaDados + encodeURIComponent(n));
}

function primeiraCoordenada(g) {
  let c = g.coordinates;
  while (Array.isArray(c[0])) c = c[0];
  return c;
}

function detetarCRS(gj, features) {
  const nome = gj.crs && gj.crs.properties && gj.crs.properties.name;
  const m = nome && nome.match(/EPSG[:：]*(\d+)\s*$/i);
  const g = features.find(f => f.geometry)?.geometry;
  if (!g) return null;
  const [x, y] = primeiraCoordenada(g);
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return null; // já em WGS84
  const codigo = m ? `EPSG:${m[1]}` : CONFIG.crsPadrao;
  if (!proj4.defs(codigo)) throw new Error(`Sistema de coordenadas ${codigo} não definido (adicione-o em script.js).`);
  return codigo;
}

function reprojetar(coords, conv) {
  return typeof coords[0] === 'number' ? conv(coords).slice(0, 2) : coords.map(c => reprojetar(c, conv));
}

function extrairAltura(props, indice) {
  if (CONFIG.alturasAleatorias) {
    // Pseudoaleatório determinístico (mesmas alturas em cada recarga); favorece edifícios baixos
    let x = Math.imul(indice + 1, 2654435761) >>> 0;
    x = Math.imul(x ^ (x >>> 15), 2246822519) >>> 0;
    const r = Math.pow((x ^ (x >>> 13)) % 10000 / 10000, 1.8);
    return { h: CONFIG.alturaMin + r * (CONFIG.alturaMax - CONFIG.alturaMin), real: true };
  }
  for (const k of CONFIG.camposAltura) {
    const v = parseFloat(String(props[k]).replace(',', '.'));
    if (isFinite(v) && v > 0) return { h: v, real: true };
  }
  for (const k of CONFIG.camposPisos) {
    const v = parseFloat(String(props[k]).replace(',', '.'));
    if (isFinite(v) && v > 0) return { h: v * CONFIG.metrosPorPiso, real: true };
  }
  const ruido = ((indice * 2654435761) % 1000) / 1000 - 0.5; // determinístico
  return { h: Math.max(3, CONFIG.alturaPadrao + ruido * 2 * CONFIG.variacao), real: false };
}

async function carregarDados() {
  const todos = await descobrirFicheiros();
  const urls = todos.filter(u => /\.(geo)?json$/i.test(u));
  const tifs = todos.filter(u => /\.tiff?$/i.test(u));
  const todas = [], linhas = [];
  let reais = 0;
  for (const url of urls) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Não foi possível carregar "${decodeURIComponent(url)}" (HTTP ${resp.status}). Confirme que o ficheiro está na mesma pasta do HTML e que o nome está certo.`);
    let gj;
    try { gj = await resp.json(); }
    catch (_) { throw new Error(`"${decodeURIComponent(url)}" não é um GeoJSON válido (o servidor pode ter devolvido uma página em vez do ficheiro: confirme o nome e a pasta).`); }
    const feats = (gj.type === 'FeatureCollection' ? gj.features : [gj]).filter(f => f && f.geometry &&
      /Polygon|LineString/.test(f.geometry.type));
    const crs = detetarCRS(gj, feats);
    const conv = crs ? (p => proj4(crs, 'EPSG:4326', p)) : null;
    for (const f of feats) {
      if (conv) f.geometry.coordinates = reprojetar(f.geometry.coordinates, conv);
      f.properties = f.properties || {};
      if (/LineString/.test(f.geometry.type)) { linhas.push(f); continue; }
      const { h, real } = extrairAltura(f.properties, todas.length);
      f.properties._h = Math.round(h * 10) / 10;
      if (real) reais++;
      todas.push(f);
    }
  }
  if (!todas.length && !linhas.length) throw new Error('Os ficheiros não contêm polígonos nem linhas.');
  return { fc: { type: 'FeatureCollection', features: todas }, ficheiros: urls.length, reais, tifs, linhas };
}

function limites(fc) {
  const b = new maplibregl.LngLatBounds();
  const visitar = c => typeof c[0] === 'number' ? b.extend(c) : c.forEach(visitar);
  fc.features.forEach(f => visitar(f.geometry.coordinates));
  return b;
}

/* ---------- Mapa ---------- */

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const BASEMAPS = {
  imagery:   { url: ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}',    maxzoom: 19, attr: 'Imagem © Esri, Maxar, Earthstar Geographics' },
  topo:      { url: ESRI + 'World_Topo_Map/MapServer/tile/{z}/{y}/{x}',   maxzoom: 19, attr: '© Esri, HERE, Garmin, USGS, OpenStreetMap contributors' },
  navegacao: { url: ESRI + 'World_Street_Map/MapServer/tile/{z}/{y}/{x}', maxzoom: 19, attr: '© Esri, HERE, Garmin, OpenStreetMap contributors' },
  osm:       { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',      maxzoom: 19, attr: '© OpenStreetMap contributors', paint: { 'raster-saturation': -0.5 } }
};
const FUNDO_INICIAL = BASEMAPS[CONFIG.basemap] ? CONFIG.basemap : 'nenhum';

const map = new maplibregl.Map({
  container: 'map',
  pixelRatio: Math.min(window.devicePixelRatio || 1, matchMedia('(pointer: coarse)').matches ? 2 : 3), // poupa bateria e memória em telemóveis
  center: [-8.0, 39.6],
  zoom: 6,
  pitch: 0,
  maxPitch: 0,           // em 2D a inclinação está bloqueada
  dragRotate: false,
  style: {
    version: 8,
    sources: Object.fromEntries(Object.entries(BASEMAPS).map(([k, b]) => ['base-' + k, { type: 'raster', tileSize: 256, maxzoom: b.maxzoom, tiles: [b.url], attribution: b.attr }])),
    layers: [
      { id: 'fundo', type: 'background', paint: { 'background-color': '#e8e6e0' } },
      ...Object.entries(BASEMAPS).map(([k, b]) => ({ id: 'base-' + k, type: 'raster', source: 'base-' + k, paint: b.paint || {}, layout: { visibility: k === FUNDO_INICIAL ? 'visible' : 'none' } }))
    ]
  }
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

const RAMPA = ['interpolate', ['linear'], ['coalesce', ['get', '_h'], 9], 3, '#d9c7a8', 9, '#c9a87e', 20, '#a77f5e', 45, '#7d5f55', 90, '#4d4a5c'];
function corEdificios(modo = CONFIG.corPorImagem ? 'imagem' : 'altura', cor = '#c9a87e') {
  if (modo === 'unica') return cor;
  if (modo === 'imagem') return ['case', ['has', '_cor'], ['to-color', ['get', '_cor']], RAMPA];
  return RAMPA;
}
const larguraLinha = k => ['interpolate', ['exponential', 1.6], ['zoom'], 10, 0.6 * k, 14, 2 * k, 18, 6 * k];

// Cota do terreno por edifício (_z, calculada a partir do MDT), com o mesmo exagero do relevo
const expressaoBase = () => ['*', ['coalesce', ['get', '_z'], 0], CONFIG.relevo.exagero];
function expressaoAltura(f) {
  return ['+', expressaoBase(), ['*', ['coalesce', ['get', '_h'], CONFIG.alturaPadrao], f]];
}

map.on('load', async () => {
  map.setLight({ anchor: 'viewport', position: [1.4, 210, 45], intensity: 0.42, color: '#fff6e8' });
  try {
    const { fc, ficheiros, reais, tifs, linhas } = await carregarDados();
    let aviso = '';
    if (tifs.length) {
      try {
        const assentar = await prepararRelevo(tifs[0]);
        if (CONFIG.relevo.assentarEdificios) await assentar(fc);
        aviso = ' · relevo ativo';
      }
      catch (e) { console.error(e); aviso = ` · relevo não carregado (${e.message})`; }
    }

    // Linhas: ficam por baixo dos edifícios e assentam no relevo
    if (linhas.length) {
      map.addSource('linhas', { type: 'geojson', data: { type: 'FeatureCollection', features: linhas } });
      const traco = { 'line-cap': 'round', 'line-join': 'round' };
      map.addLayer({ id: 'linhas-contorno', type: 'line', source: 'linhas', layout: traco,
        paint: { 'line-color': CONFIG.linhas.contorno, 'line-width': larguraLinha(CONFIG.linhas.largura + 1.8), 'line-opacity': 0.55 } });
      map.addLayer({ id: 'linhas', type: 'line', source: 'linhas', layout: traco,
        paint: { 'line-color': CONFIG.linhas.cor, 'line-width': larguraLinha(CONFIG.linhas.largura) } });
      map.on('click', 'linhas', e => {
        if (map.queryRenderedFeatures(e.point, { layers: ['edificios-3d'] }).length) return; // edifício tem prioridade
        const linhasHtml = Object.entries(e.features[0].properties).slice(0, 14).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
        new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(e.lngLat).setHTML(`<table>${linhasHtml}</table>`).addTo(map);
      });
      map.on('mouseenter', 'linhas', () => map.getCanvas().style.cursor = 'pointer');
      map.on('mouseleave', 'linhas', () => map.getCanvas().style.cursor = '');
    }

    map.addSource('edificios', { type: 'geojson', data: fc, buffer: 32, tolerance: 0.2 });
    map.addLayer({
      id: 'edificios-3d', type: 'fill-extrusion', source: 'edificios',
      paint: {
        'fill-extrusion-height': expressaoAltura(estado.fator),
        'fill-extrusion-base': expressaoBase(),
        'fill-extrusion-vertical-gradient': true,
        'fill-extrusion-opacity': 0.94,
        'fill-extrusion-color': corEdificios()
      }
    });
    // Contorno nítido para legibilidade em 2D (desaparece à medida que sobem os volumes)
    map.addLayer({
      id: 'edificios-linha', type: 'line', source: 'edificios',
      paint: { 'line-color': '#6b4f3a', 'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.3, 19, 1.2], 'line-opacity': 0.7 }
    });

    iniciarPainel({ temLinhas: linhas.length > 0, temRelevo: !!map.getLayer('sombreado') });
    map.fitBounds(limites({ features: [...fc.features, ...linhas] }), { padding: 60, duration: 0 });
    const n = fc.features.length.toLocaleString('pt-PT');
    mostrarEstado(`${n} edifícios` + (linhas.length ? ` · ${linhas.length.toLocaleString('pt-PT')} linhas` : '') + ` de ${ficheiros} ficheiro(s)` + (reais === 0 ? ' · sem alturas nos dados: extrusão estimada' : '') + aviso);
    setTimeout(() => elStatus.classList.add('hide'), 4500);
    if (CONFIG.corPorImagem) colorirPorImagem(fc);

    map.on('click', 'edificios-3d', e => {
      const p = { ...e.features[0].properties };
      const altura = p._h; delete p._h; delete p._z; delete p._cor;
      const linhas = Object.entries(p).slice(0, 14).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
      new maplibregl.Popup({ maxWidth: '320px' }).setLngLat(e.lngLat)
        .setHTML(`<table>${linhas}<tr><td>altura (m)</td><td>${altura}</td></tr></table>`).addTo(map);
    });
    map.on('mouseenter', 'edificios-3d', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'edificios-3d', () => map.getCanvas().style.cursor = '');
  } catch (err) {
    const local = location.protocol === 'file:';
    mostrarEstado(local
      ? 'Abra o site através de um servidor local (ver instruções): o navegador bloqueia a leitura de dados3dguimarep/ em file://.'
      : err.message, true);
  }
});

/* ---------- Relevo: MDT GeoTIFF -> tiles terrarium gerados no navegador ---------- */

proj4.defs('EPSG:25829', '+proj=utm +zone=29 +ellps=GRS80 +units=m +no_defs');
proj4.defs('EPSG:32629', '+proj=utm +zone=29 +datum=WGS84 +units=m +no_defs');

async function prepararRelevo(url) {
  const N = 256;
  const tiff = await GeoTIFF.fromUrl(url);
  const img = await tiff.getImage();
  const chaves = img.getGeoKeys() || {};
  const cod = chaves.ProjectedCSTypeGeoKey || chaves.GeographicTypeGeoKey;
  const crs = (!cod || cod === 32767) ? CONFIG.crsPadrao : (cod === 4258 ? 'EPSG:4326' : `EPSG:${cod}`);
  if (!proj4.defs(crs)) throw new Error(`MDT em ${crs}: falta a definição em script.js`);

  const [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution();
  const W = img.getWidth(), H = img.getHeight();
  const nodata = img.getGDALNoData();
  const fwd = proj4('EPSG:4326', crs).forward;
  const inv = proj4(crs, 'EPSG:4326').forward;

  const cantos = [[ox, oy], [ox + W * rx, oy], [ox + W * rx, oy + H * ry], [ox, oy + H * ry]].map(inv);
  const lons = cantos.map(c => c[0]), lats = cantos.map(c => c[1]);
  const bounds = [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  const resM = crs === 'EPSG:4326' ? Math.abs(rx) * 111320 : Math.abs(rx);
  const lat0 = (bounds[1] + bounds[3]) / 2;
  const maxzoom = Math.max(8, Math.min(17, Math.round(Math.log2(156543.03 * Math.cos(lat0 * Math.PI / 180) / resM))));

  maplibregl.addProtocol('mdt', async params => {
    const [z, x, y] = params.url.replace('mdt://', '').split('/').map(Number);
    const n = 2 ** z, lon0 = x / n * 360 - 180, dlon = 360 / n;
    const lat = k => Math.atan(Math.sinh(Math.PI * (1 - 2 * k / n))) * 180 / Math.PI;
    const A = new Float64Array(N * N), B = new Float64Array(N * N);
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (let j = 0; j < N; j++) {
      const la = lat(y + (j + 0.5) / N);
      for (let i = 0; i < N; i++) {
        const p = fwd([lon0 + (i + 0.5) / N * dlon, la]);
        const a = (p[0] - ox) / rx, b = (p[1] - oy) / ry, k = j * N + i;
        A[k] = a; B[k] = b;
        if (a < minA) minA = a; if (a > maxA) maxA = a;
        if (b < minB) minB = b; if (b > maxB) maxB = b;
      }
    }
    const elev = new Float32Array(N * N); // 0 por defeito (fora do MDT / sem dados)
    if (maxA >= 0 && maxB >= 0 && minA < W && minB < H) {
      const x0 = Math.max(0, Math.floor(minA) - 1), y0 = Math.max(0, Math.floor(minB) - 1);
      const x1 = Math.min(W, Math.ceil(maxA) + 2), y1 = Math.min(H, Math.ceil(maxB) + 2);
      const ww = x1 - x0, wh = y1 - y0, esc = Math.min(1, 512 / Math.max(ww, wh));
      const rw = Math.max(2, Math.round(ww * esc)), rh = Math.max(2, Math.round(wh * esc));
      const d = (await img.readRasters({ window: [x0, y0, x1, y1], width: rw, height: rh, resampleMethod: 'bilinear', samples: [0] }))[0];
      const val = (c, r) => { const v = d[r * rw + c]; return (v === nodata || !(v > -500) || v > 9000) ? 0 : v; };
      for (let k = 0; k < N * N; k++) {
        if (A[k] < 0 || A[k] >= W || B[k] < 0 || B[k] >= H) continue;
        const u = Math.min(rw - 1, Math.max(0, (A[k] - x0) * rw / ww - 0.5));
        const v = Math.min(rh - 1, Math.max(0, (B[k] - y0) * rh / wh - 0.5));
        const c0 = Math.floor(u), r0 = Math.floor(v), c1 = Math.min(rw - 1, c0 + 1), r1 = Math.min(rh - 1, r0 + 1);
        const fu = u - c0, fv = v - r0;
        elev[k] = (val(c0, r0) * (1 - fu) + val(c1, r0) * fu) * (1 - fv) + (val(c0, r1) * (1 - fu) + val(c1, r1) * fu) * fv;
      }
    }
    const rgba = new Uint8ClampedArray(N * N * 4);
    for (let k = 0; k < N * N; k++) { // codificação terrarium
      const e = elev[k] + 32768, f = Math.floor(e);
      rgba[k * 4] = f >> 8; rgba[k * 4 + 1] = f & 255; rgba[k * 4 + 2] = Math.floor((e - f) * 256); rgba[k * 4 + 3] = 255;
    }
    const cv = new OffscreenCanvas(N, N);
    cv.getContext('2d').putImageData(new ImageData(rgba, N, N), 0, 0);
    return { data: await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer() };
  });

  map.addSource('dem', { type: 'raster-dem', tiles: ['mdt://{z}/{x}/{y}'], tileSize: N, encoding: 'terrarium', minzoom: 0, maxzoom, bounds });
  if (CONFIG.relevo.sombreado) {
    map.addLayer({ id: 'sombreado', type: 'hillshade', source: 'dem',
      paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#26303a', 'hillshade-highlight-color': '#ffffff' } });
  }
  map.setTerrain({ source: 'dem', exaggeration: CONFIG.relevo.exagero });

  // Calcula a cota do terreno de cada edifício (mínimo dos vértices do contorno) -> propriedade _z
  return async function assentar(fc) {
    const pts = [];
    let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity;
    for (const f of fc.features) {
      const g = f.geometry, anel = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
      const p = anel.map(c => { const q = fwd(c); return [(q[0] - ox) / rx, (q[1] - oy) / ry]; });
      for (const [a, b] of p) {
        if (a < minA) minA = a; if (a > maxA) maxA = a;
        if (b < minB) minB = b; if (b > maxB) maxB = b;
      }
      pts.push(p);
    }
    if (maxA < 0 || maxB < 0 || minA >= W || minB >= H) return;
    const x0 = Math.max(0, Math.floor(minA) - 1), y0 = Math.max(0, Math.floor(minB) - 1);
    const x1 = Math.min(W, Math.ceil(maxA) + 2), y1 = Math.min(H, Math.ceil(maxB) + 2);
    const ww = x1 - x0, wh = y1 - y0, esc = Math.min(1, 3000 / Math.max(ww, wh));
    const rw = Math.max(2, Math.round(ww * esc)), rh = Math.max(2, Math.round(wh * esc));
    const d = (await img.readRasters({ window: [x0, y0, x1, y1], width: rw, height: rh, resampleMethod: 'bilinear', samples: [0] }))[0];
    const val = (c, r) => { const v = d[r * rw + c]; return (v === nodata || !(v > -500) || v > 9000) ? 0 : v; };
    fc.features.forEach((f, n) => {
      let z = Infinity;
      for (const [a, b] of pts[n]) {
        if (a < 0 || a >= W || b < 0 || b >= H) { z = Math.min(z, 0); continue; }
        const u = Math.min(rw - 1, Math.max(0, (a - x0) * rw / ww - 0.5)), v = Math.min(rh - 1, Math.max(0, (b - y0) * rh / wh - 0.5));
        const c0 = Math.floor(u), r0 = Math.floor(v), c1 = Math.min(rw - 1, c0 + 1), r1 = Math.min(rh - 1, r0 + 1), fu = u - c0, fv = v - r0;
        z = Math.min(z, (val(c0, r0) * (1 - fu) + val(c1, r0) * fu) * (1 - fv) + (val(c0, r1) * (1 - fu) + val(c1, r1) * fu) * fv);
      }
      f.properties._z = Math.round(z * 10) / 10;
    });
  };
}

/* ---------- Cor dos edifícios a partir da imagem de satélite ---------- */

async function colorirPorImagem(fc) {
  try {
    const feats = fc.features;
    const aneis = feats.map(f => f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0]);
    const cent = aneis.map(a => { let x = 0, y = 0; for (const c of a) { x += c[0]; y += c[1]; } return [x / a.length, y / a.length]; });
    const mercX = (lon, z) => (lon + 180) / 360 * 2 ** z * 256;
    const mercY = (lat, z) => { const s = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z * 256; };
    const dentro = (x, y, a) => {
      let r = false;
      for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
        if ((a[i][1] > y) !== (a[j][1] > y) && x < (a[j][0] - a[i][0]) * (y - a[i][1]) / (a[j][1] - a[i][1]) + a[i][0]) r = !r;
      }
      return r;
    };

    // Zoom das imagens: o mais detalhado que não exceda o limite de tiles
    let z = CONFIG.zoomCorMax;
    for (; z > 14; z--) {
      const t = new Set(cent.map(c => Math.floor(mercX(c[0], z) / 256) + '/' + Math.floor(mercY(c[1], z) / 256)));
      if (t.size <= CONFIG.maxTilesCor) break;
    }

    // Pontos de amostragem dentro de cada contorno (grelha 5x5), agrupados por tile
    const porTile = new Map();
    const add = (i, lon, lat) => {
      const X = mercX(lon, z), Y = mercY(lat, z), tx = Math.floor(X / 256), ty = Math.floor(Y / 256), k = tx + '/' + ty;
      if (!porTile.has(k)) porTile.set(k, []);
      porTile.get(k).push(i, Math.floor(X) - tx * 256, Math.floor(Y) - ty * 256);
    };
    aneis.forEach((a, i) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const c of a) { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); }
      let n = 0;
      for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 5; gx++) {
        const lon = x0 + (gx + 0.5) / 5 * (x1 - x0), lat = y0 + (gy + 0.5) / 5 * (y1 - y0);
        if (dentro(lon, lat, a)) { add(i, lon, lat); n++; }
      }
      if (!n) add(i, cent[i][0], cent[i][1]);
    });

    // Descarregar os tiles (em paralelo) e recolher os pixéis amostrados
    const amostras = new Array(feats.length);
    const chaves = [...porTile.keys()];
    let feitos = 0, falhas = 0, prox = 0;
    const proc = async k => {
      const [tx, ty] = k.split('/').map(Number);
      try {
        const r = await fetch(BASEMAPS.imagery.url.replace('{z}', z).replace('{x}', tx).replace('{y}', ty), { mode: 'cors' });
        if (!r.ok) throw new Error(r.status);
        const bmp = await createImageBitmap(await r.blob());
        const cx = new OffscreenCanvas(256, 256).getContext('2d', { willReadFrequently: true });
        cx.drawImage(bmp, 0, 0);
        const d = cx.getImageData(0, 0, 256, 256).data, l = porTile.get(k);
        for (let j = 0; j < l.length; j += 3) {
          const o = (l[j + 2] * 256 + l[j + 1]) * 4;
          (amostras[l[j]] = amostras[l[j]] || []).push(d[o], d[o + 1], d[o + 2]);
        }
      } catch (_) { falhas++; }
      if (++feitos % 15 === 0) { elStatus.classList.remove('hide'); mostrarEstado(`A colorir edifícios pela imagem… ${Math.round(feitos / chaves.length * 100)}%`); }
    };
    await Promise.all(Array.from({ length: 10 }, async () => { while (prox < chaves.length) await proc(chaves[prox++]); }));
    if (falhas === chaves.length) throw new Error('não foi possível ler as imagens de satélite (CORS/rede)');

    // Cor média por edifício, ignorando pixéis de vegetação (copas sobre telhados) quando possível
    const hex = v => Math.round(v).toString(16).padStart(2, '0');
    let n = 0;
    feats.forEach((f, i) => {
      const a = amostras[i];
      if (!a) return;
      let sr = 0, sg = 0, sb = 0, c = 0, ar = 0, ag = 0, ab = 0, ac = 0;
      for (let j = 0; j < a.length; j += 3) {
        ar += a[j]; ag += a[j + 1]; ab += a[j + 2]; ac++;
        if (!(a[j + 1] > a[j] * 1.05 && a[j + 1] > a[j + 2] * 1.05)) { sr += a[j]; sg += a[j + 1]; sb += a[j + 2]; c++; }
      }
      const [r, g, b] = c ? [sr / c, sg / c, sb / c] : [ar / ac, ag / ac, ab / ac];
      f.properties._cor = '#' + hex(r) + hex(g) + hex(b);
      n++;
    });
    map.getSource('edificios').setData(fc);
    mostrarEstado(`${n.toLocaleString('pt-PT')} edifícios coloridos pela imagem (zoom ${z})`);
    setTimeout(() => elStatus.classList.add('hide'), 3500);
  } catch (e) {
    console.error(e);
    mostrarEstado(`Cor por imagem indisponível: ${e.message}`, true);
  }
}

/* ---------- Painel: mapa de fundo, simbologia e mini legenda ---------- */

function iniciarPainel({ temLinhas, temRelevo }) {
  const $ = id => document.getElementById(id);
  const pintar = (id, prop, v) => map.getLayer(id) && map.setPaintProperty(id, prop, v);
  const ver = (ids, on) => ids.forEach(id => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
  const marcar = (grupo, valor) => grupo.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === valor));
  const escolher = (grupo, fn) => grupo.addEventListener('click', e => { const b = e.target.closest('button'); if (b) fn(b.dataset.v); });

  if (matchMedia('(max-width: 640px)').matches) { // em ecrãs pequenos o painel começa recolhido
    $('painel-toggle').setAttribute('aria-expanded', 'false');
    $('painel-corpo').hidden = true;
  }
  $('painel-toggle').addEventListener('click', e => {
    const aberto = e.currentTarget.getAttribute('aria-expanded') === 'true';
    e.currentTarget.setAttribute('aria-expanded', !aberto);
    $('painel-corpo').hidden = aberto;
  });

  // Mapa de fundo (ou superfície com uma só cor)
  const aplicarFundo = id => {
    Object.keys(BASEMAPS).forEach(k => ver(['base-' + k], k === id));
    marcar($('fundos'), id);
    $('linha-superficie').hidden = id !== 'nenhum';
    pintar('sombreado', 'hillshade-exaggeration', id === 'nenhum' ? 0.7 : 0.35);
  };
  escolher($('fundos'), aplicarFundo);
  $('cor-superficie').addEventListener('input', e => pintar('fundo', 'background-color', e.target.value));
  $('linha-sombreado').hidden = !temRelevo;
  $('sombreado').addEventListener('change', e => ver(['sombreado'], e.target.checked));

  // Edifícios
  const E = { modo: CONFIG.corPorImagem ? 'imagem' : 'altura', cor: '#c9a87e' };
  const gradientes = { imagem: 'linear-gradient(90deg,#b86f52,#c9c3b6,#ece8df,#8a9a74)', altura: 'linear-gradient(90deg,#d9c7a8,#a77f5e,#4d4a5c)' };
  const aplicarEdificios = () => {
    pintar('edificios-3d', 'fill-extrusion-color', corEdificios(E.modo, E.cor));
    marcar($('edif-modo'), E.modo);
    $('linha-edif-cor').hidden = E.modo !== 'unica';
    $('amostra-edif').style.background = E.modo === 'unica' ? E.cor : gradientes[E.modo];
  };
  escolher($('edif-modo'), v => { E.modo = v; aplicarEdificios(); });
  $('edif-cor').value = E.cor;
  $('edif-cor').addEventListener('input', e => { E.cor = e.target.value; aplicarEdificios(); });
  $('edif-vis').addEventListener('change', e => ver(['edificios-3d', 'edificios-linha'], e.target.checked));
  $('edif-opac').addEventListener('input', e => pintar('edificios-3d', 'fill-extrusion-opacity', +e.target.value));

  // Linhas
  $('sec-linhas').hidden = !temLinhas;
  const L = { cor: CONFIG.linhas.cor, k: 1 };
  const aplicarLinhas = () => {
    const w = CONFIG.linhas.largura * L.k;
    pintar('linhas', 'line-color', L.cor);
    pintar('linhas', 'line-width', larguraLinha(w));
    pintar('linhas-contorno', 'line-width', larguraLinha(w + 1.8));
    const a = $('amostra-linhas');
    a.style.background = L.cor;
    a.style.height = Math.max(2, Math.round(w * 1.6)) + 'px';
  };
  $('linhas-cor').value = L.cor;
  $('linhas-cor').addEventListener('input', e => { L.cor = e.target.value; aplicarLinhas(); });
  $('linhas-larg').addEventListener('input', e => { L.k = +e.target.value; aplicarLinhas(); });
  $('linhas-vis').addEventListener('change', e => ver(['linhas', 'linhas-contorno'], e.target.checked));
  $('linhas-opac').addEventListener('input', e => { pintar('linhas', 'line-opacity', +e.target.value); pintar('linhas-contorno', 'line-opacity', 0.55 * e.target.value); });

  aplicarFundo(FUNDO_INICIAL); aplicarEdificios(); aplicarLinhas();
  $('painel').hidden = false;
}

/* ---------- Transição 2D <-> 3D ---------- */

function animarFator(destino, duracao) {
  cancelAnimationFrame(estado.animacao);
  const inicio = estado.fator, t0 = performance.now();
  const passo = agora => {
    const t = Math.min(1, (agora - t0) / duracao);
    const e = t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
    estado.fator = inicio + (destino - inicio) * e;
    if (map.getLayer('edificios-3d')) map.setPaintProperty('edificios-3d', 'fill-extrusion-height', expressaoAltura(estado.fator));
    if (map.getLayer('edificios-linha')) map.setPaintProperty('edificios-linha', 'line-opacity', 0.7 * (1 - estado.fator * 0.85));
    if (t < 1) estado.animacao = requestAnimationFrame(passo);
  };
  estado.animacao = requestAnimationFrame(passo);
}

function definirModo(modo) {
  estado.modo = modo;
  const e3d = modo === '3d';
  botao.setAttribute('aria-pressed', e3d);
  const reduzir = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const dur = reduzir ? 0 : CONFIG.duracao;

  if (e3d) {
    map.setMaxPitch(85);
    map.dragRotate.enable();
    map.touchZoomRotate.enableRotation();
    map.touchPitch.enable();
    // Mantém o centro: apenas a inclinação e a rotação mudam
    const alvo = { pitch: CONFIG.camera3D.pitch, center: map.getCenter(), zoom: map.getZoom(), duration: dur, essential: true };
    estado.zoom2d = map.getZoom(); estado.centro2d = map.getCenter();
    if (CONFIG.camera3D.alvo) alvo.center = CONFIG.camera3D.alvo;
    if (CONFIG.camera3D.zoom !== null) alvo.zoom = Math.max(map.getZoom(), CONFIG.camera3D.zoom);
    if (CONFIG.camera3D.bearing !== null) alvo.bearing = CONFIG.camera3D.bearing;
    map.easeTo(alvo); // aproxima (se configurado) e inclina, mantendo o centro
  } else {
    map.dragRotate.disable();
    map.touchPitch.disable();
    map.touchZoomRotate.disableRotation();
    map.easeTo({ pitch: 0, bearing: 0, center: estado.centro2d ?? map.getCenter(), zoom: estado.zoom2d ?? map.getZoom(), duration: dur, essential: true }); // volta à vista de antes do 3D
    map.once('moveend', () => { if (estado.modo === '2d') map.setMaxPitch(0); });
  }
  if (CONFIG.animarAltura) animarFator(e3d ? 1 : 0, dur);
}

botao.addEventListener('click', () => definirModo(estado.modo === '2d' ? '3d' : '2d'));
document.addEventListener('keydown', e => {
  if (e.key.toLowerCase() === 'd' && !e.ctrlKey && !e.metaKey) botao.click();
});
