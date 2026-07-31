/* === MÓDULO: RASTER & GEOREFERENCIACAO === */
/* Raster import/persistence/export/panel, georef mode entry/exit,
   GCP capture, auto-georef detection, manual georef, RMS/stats,
   tile fetching, mosaic building */
/* Origem: 05-app-main.js linhas 2132-4470 */
(function(){
/* ============================================================
   IMPORTAÇÃO DE RASTER (GEORREFERENCIAÇÃO) — FASE 1
   ------------------------------------------------------------
   Deteta imagens (JPG/PNG/TIFF) entre os ficheiros importados e
   trata-as à parte do fluxo vetorial (GeoJSON/Shapefile) acima.

   Três cenários, conforme o documento de planeamento:
     1) TIFF com tags GeoTIFF          -> já georreferenciado
        (a colocação automática completa no mapa fica para uma
        fase seguinte — aqui só se deteta e regista como tal)
     2) imagem + World File (.pgw/...) -> georreferenciado via
        transformação afim lida do World File, colocado já no
        sítio certo
     3) imagem sem nenhuma das duas    -> "pendente", colocado
        provisoriamente perto de (0,0) até o utilizador passar
        pelo modo de Georreferenciação (fase seguinte)
   ============================================================ */
const rasterLayers = new Map(); // id -> {id, name, url, width, height, georeferenced, pending, gcps, transform, overlay, source}
let rasterOverlayGroup = null;
let rasterCounter = 0;

const RASTER_IMAGE_EXT = /\.(jpe?g|png|tiff?|tif)$/i;
const WORLD_FILE_EXT = /\.(pgw|jgw|tfw|wld)$/i;

function genRasterId(){
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('raster-' + Date.now() + '-' + Math.random().toString(36).slice(2));
}

/* FASE 6: converte o ficheiro original para data URL (base64), para poder
   ser gravado no projeto local (localStorage). Um blob: URL só existe
   enquanto a página não recarrega, por isso não serve para persistência;
   a data URL guarda-se tal como o resto do projeto e funciona diretamente
   como src de <img>/L.imageOverlay depois de reaberta. */
function fileToDataUrl(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.onerror = ()=> reject(new Error('Não foi possível ler o ficheiro para guardar no projeto.'));
    reader.readAsDataURL(file);
  });
}

/* separa a lista de ficheiros escolhidos pelo utilizador em três grupos:
   imagens, world files (ficheiros-irmãos de georreferenciação) e o resto
   (GeoJSON/Shapefile, que segue o caminho já existente) */
function splitImportFileGroups(files){
  const images = [];
  const worldFiles = [];
  const rest = [];
  files.forEach(f=>{
    if(RASTER_IMAGE_EXT.test(f.name)) images.push(f);
    else if(WORLD_FILE_EXT.test(f.name)) worldFiles.push(f);
    else rest.push(f);
  });
  return {images, worldFiles, rest};
}

/* nome do ficheiro sem extensão, para conseguir emparelhar imagem.jpg
   com imagem.jgw mesmo que a extensão original tenha maiúsculas/minúsculas
   diferentes */
function fileBaseName(name){
  return String(name || '').replace(/\.[^.]+$/, '').toLowerCase();
}

/* lê um World File (.pgw/.jgw/.tfw/.wld): são sempre 6 números, um por
   linha, na ordem A, D, B, E, C, F, que mapeiam pixel (x,y) da imagem
   para coordenadas do mapa (X,Y) por:
     X = A*x + B*y + C
     Y = D*x + E*y + F
   (as letras seguem a convenção standard de World Files; note-se que
   D e B são os termos de "shear"/rotação, tipicamente 0 em imagens
   não rodadas) */
async function parseWorldFileText(text){
  try{
    const nums = text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length).map(Number);
    if(nums.length < 6 || nums.some(n=>Number.isNaN(n))) return null;
    const [A, D, B, E, C, F] = nums;
    return {a:A, b:B, c:C, d:D, e:E, f:F};
  }catch(err){
    console.error('[WorldFile] parse error:', err);
    return null;
  }
}

/* verifica se um GeoTIFF já traz georreferenciação embutida, olhando
   diretamente para as tags da spec (sem confiar em getBoundingBox(),
   que pode rebentar se a imagem não tiver mesmo nenhuma geo-info) */
function geotiffHasGeoTags(image){
  const fd = image && image.fileDirectory;
  if(!fd) return false;
  if(typeof fd.hasTag === 'function'){
    return fd.hasTag('ModelTiepoint') || fd.hasTag('ModelPixelScale') || fd.hasTag('ModelTransformation');
  }
  return !!(fd.ModelTiepoint || fd.ModelPixelScale || fd.ModelTransformation);
}

/* coloca (ou atualiza) o overlay de uma entrada de raster no mapa —
   usado tanto para o posicionamento provisório em (0,0) como, mais
   tarde (fase 5), para o posicionamento final depois dos GCPs */
function placeRasterOverlay(entry){
  if(!rasterOverlayGroup) rasterOverlayGroup = L.layerGroup().addTo(map);
  if(entry.overlay){ rasterOverlayGroup.removeLayer(entry.overlay); entry.overlay = null; }

  if(entry.transform){
    const corners = Georef.affineToCorners(entry.transform, entry.width, entry.height);
    entry.overlay = L.imageOverlay.rotated(entry.url, corners.topleft, corners.topright, corners.bottomleft, {
      opacity: 0.9,
      className: 'raster-overlay-image'
    });
  } else {
    // sem transformação ainda: posição provisória perto de (0,0), com uma
    // escala fixa e pequena em graus, só para o utilizador conseguir "ver"
    // que a imagem entrou — não tem qualquer relação com coordenadas reais
    const PLACEHOLDER_SPAN_DEG = 0.02;
    const aspect = entry.height > 0 ? (entry.height / entry.width) : 1;
    const widthDeg = PLACEHOLDER_SPAN_DEG;
    const heightDeg = PLACEHOLDER_SPAN_DEG * aspect;
    const bounds = L.latLngBounds([0, 0], [heightDeg, widthDeg]);
    entry.overlay = L.imageOverlay(entry.url, bounds, {
      opacity: 0.9,
      className: 'raster-overlay-image raster-overlay-pending'
    });
  }
  entry.overlay.addTo(rasterOverlayGroup);
}

function focusRasterLayer(entry){
  if(!entry.overlay) return;
  try{ map.fitBounds(entry.overlay.getBounds(), {maxZoom: 18, padding:[40,40]}); }
  catch(err){ /* bounds ainda não prontos, ignora */ }
}

function removeRasterLayer(id){
  const entry = rasterLayers.get(id);
  if(!entry) return;
  if(entry.overlay && rasterOverlayGroup) rasterOverlayGroup.removeLayer(entry.overlay);
  if(entry.url && entry.url.startsWith('blob:')) URL.revokeObjectURL(entry.url);
  rasterLayers.delete(id);
  renderRasterLayersPanel();
}

/* adiciona uma entrada raster construída fora do fluxo de importação normal
   (ex: camada MDT vinda do portal DataGis). O entry deve já trazer
   url/dataUrl, width/height, transform e georeferenced:true — é colocado
   de imediato no mapa e aparece no painel "Imagens". */
function addRasterEntry(entry){
  if(!entry || !entry.url) return null;
  if(!entry.id) entry.id = genRasterId();
  rasterLayers.set(entry.id, entry);
  placeRasterOverlay(entry);
  renderRasterLayersPanel();
  if(typeof window.markProjectDirty === 'function') window.markProjectDirty();
  return entry.id;
}

/* ============================================================
   FASE 6: PERSISTÊNCIA
   ------------------------------------------------------------
   rasterLayers guarda-se como estrutura paralela dentro do próprio
   projeto local (ao lado de layers/geojson), não dentro do
   buildGeoJSON — uma imagem não é uma geometria e misturá-la no
   FeatureCollection só complicaria a exportação GeoJSON normal.
   A imagem em si é gravada como data URL (ver fileToDataUrl, no
   momento do import), já que um blob: URL não sobrevive a um
   fechar/reabrir da página.
   ============================================================ */
function serializeRasterLayersForProject(){
  return Array.from(rasterLayers.values()).map(entry=> ({
    id: entry.id,
    name: entry.name,
    width: entry.width,
    height: entry.height,
    georeferenced: Boolean(entry.georeferenced),
    pending: Boolean(entry.pending),
    autoGeoTiff: Boolean(entry.autoGeoTiff),
    gcps: Array.isArray(entry.gcps) ? entry.gcps.map(g=>({img:{x:g.img.x, y:g.img.y}, map:{lng:g.map.lng, lat:g.map.lat}})) : [],
    transform: entry.transform ? {...entry.transform} : null,
    rmsError: typeof entry.rmsError === 'number' ? entry.rmsError : null,
    rmsUnit: entry.rmsUnit || null,
    source: entry.source || null,
    dataUrl: entry.dataUrl || null
  }));
}

/* remove todas as camadas raster atuais do mapa/estado — usado antes de
   carregar um projeto diferente, para não deixar imagens "presas" de um
   projeto anterior misturadas com o novo */
function clearRasterLayerState(){
  rasterLayers.forEach(entry=>{
    if(entry.overlay && rasterOverlayGroup) rasterOverlayGroup.removeLayer(entry.overlay);
    if(entry.url && entry.url.startsWith('blob:')) URL.revokeObjectURL(entry.url);
  });
  rasterLayers.clear();
  renderRasterLayersPanel();
}

function restoreRasterLayersFromProject(list){
  clearRasterLayerState();
  if(!Array.isArray(list) || !list.length) return;

  list.forEach(rec=>{
    if(!rec || !rec.dataUrl) return; // sem imagem gravada, não há o que restaurar
    const entry = {
      id: rec.id || genRasterId(),
      name: rec.name || 'Imagem',
      url: rec.dataUrl,
      dataUrl: rec.dataUrl,
      width: rec.width, height: rec.height,
      georeferenced: Boolean(rec.georeferenced),
      pending: Boolean(rec.pending),
      autoGeoTiff: Boolean(rec.autoGeoTiff),
      gcps: Array.isArray(rec.gcps) ? rec.gcps : [],
      transform: rec.transform || null,
      overlay: null,
      source: rec.source || null
    };
    if(typeof rec.rmsError === 'number'){ entry.rmsError = rec.rmsError; entry.rmsUnit = rec.rmsUnit || 'm'; }
    rasterLayers.set(entry.id, entry);
    placeRasterOverlay(entry);
  });

  renderRasterLayersPanel();
}

function worldFileExtensionFor(name){
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  const ext = m ? m[1].toLowerCase() : '';
  if(ext === 'jpg' || ext === 'jpeg') return 'jgw';
  if(ext === 'png') return 'pgw';
  if(ext === 'tif' || ext === 'tiff') return 'tfw';
  return 'wld';
}

/* ordem de um World File: A, D, B, E, C, F — um número por linha
   (mesma convenção lida por parseWorldFileText, na importação) */
function buildWorldFileText(transform){
  const fmt = n => Number(n).toFixed(10);
  return [transform.a, transform.d, transform.b, transform.e, transform.c, transform.f]
    .map(fmt).join('\n') + '\n';
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
}

function exportRasterWorldFile(entry){
  if(!entry || !entry.transform){
    showAppAlert('Esta imagem ainda não tem uma transformação calculada — não há World File para exportar.');
    return;
  }
  const text = buildWorldFileText(entry.transform);
  const baseName = fileBaseName(entry.source || entry.name || 'imagem');
  const ext = worldFileExtensionFor(entry.source || entry.name);
  downloadBlob(new Blob([text], {type:'text/plain'}), `${baseName}.${ext}`);
}

/* carrega entry.dataUrl/url para um <img>, para conseguir desenhar num
   canvas e ler os pixels (necessário tanto para o GeoTIFF como, no
   futuro, para qualquer outro formato rasterizado) */
function loadRasterImageElement(entry){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = ()=> resolve(img);
    img.onerror = ()=> reject(new Error('Não foi possível carregar a imagem original.'));
    img.src = entry.dataUrl || entry.url;
  });
}

async function getRasterPixelData(entry){
  try{
    const img = await loadRasterImageElement(entry);
    const canvas = document.createElement('canvas');
    canvas.width = entry.width;
    canvas.height = entry.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, entry.width, entry.height);
    return ctx.getImageData(0, 0, entry.width, entry.height);
  }catch(err){
    console.error('[Raster] pixel data error:', err);
    throw err;
  }
}

/* converte os 6 parâmetros afins (a,b,c,d,e,f) na matriz 4x4 do
   ModelTransformationTag (34264) do GeoTIFF — ao contrário de
   ModelPixelScale+ModelTiepoint, esta suporta rotação/shear, que é o
   caso geral de uma transformação afim calculada a partir de GCPs.
   Usável com geotiff.js v3.0+ (bug #462 corrigido). */
function affineToModelTransformation(t){
  return [
    t.a, t.b, 0, t.c,
    t.d, t.e, 0, t.f,
    0,   0,   0, 0,
    0,   0,   0, 1
  ];
}

/* deteta se a transformação afim tem rotação/shear real (b ou d
   significativos face à escala a/e) — nesse caso ModelPixelScale+
   ModelTiepoint não a conseguem representar (só suportam eixos
   alinhados N-S/E-W) */
function affineHasRotation(t){
  const scaleRef = Math.max(Math.abs(t.a), Math.abs(t.e)) || 1;
  const REL_TOL = 1e-6;
  return Math.abs(t.b) > scaleRef * REL_TOL || Math.abs(t.d) > scaleRef * REL_TOL;
}

/* converte os 6 parâmetros afins (sem rotação) em ModelPixelScale +
   ModelTiepoint — a combinação de tags GeoTIFF "clássica", sem o bug
   descrito abaixo.
     X(i,j) = TiepointX + i*ScaleX
     Y(i,j) = TiepointY - j*ScaleY
   Com X = a*x + c e Y = e*y + f (b=d=0, sem rotação):
     ScaleX = a,  ScaleY = -e,  TiepointX = c,  TiepointY = f       */
function affineToPixelScaleAndTiepoint(t){
  return {
    ModelPixelScale: [t.a, -t.e, 0],
    ModelTiepoint: [0, 0, 0, t.c, t.f, 0]
  };
}

/* ============================================================
   FASE 7 (extra): EXPORTAÇÃO EM OUTROS FORMATOS
   ------------------------------------------------------------
   Além do World File (metadados só), há mais duas opções:
     - imagem original + World File, num .zip (útil para JPG/PNG que
       o QGIS/ArcGIS reconhecem tal como foram importados);
     - GeoTIFF verdadeiro (.tif), com a georreferenciação embutida no
       próprio ficheiro (ModelTransformationTag + GeographicTypeGeoKey
       4326), usando geotiff.js (já carregado para a leitura, na
       Fase 1). writeArrayBuffer só escreve sem compressão — ficheiros
       maiores, mas evita depender de mais uma biblioteca.
   ============================================================ */
async function exportRasterImageZip(entry){
  if(!entry || !entry.transform){
    showAppAlert('Esta imagem ainda não tem uma transformação calculada — não há World File para exportar.');
    return;
  }
  if(typeof JSZip === 'undefined'){
    showAppAlert('A biblioteca de compressão (JSZip) não está disponível nesta página.');
    return;
  }
  let originalBytes;
  try{
    const resp = await fetch(entry.dataUrl || entry.url);
    originalBytes = await resp.arrayBuffer();
  }catch(err){
    console.error('Erro ao obter os bytes originais da imagem:', err);
    showAppAlert('Não foi possível preparar a imagem original para exportar.', {error: true});
    return;
  }
  const baseName = fileBaseName(entry.source || entry.name || 'imagem');
  const imgExt = ((/\.([a-z0-9]+)$/i.exec(entry.source || entry.name || '')) || [null, 'jpg'])[1].toLowerCase();
  const wldExt = worldFileExtensionFor(entry.source || entry.name);

  const zip = new JSZip();
  zip.file(`${baseName}.${imgExt}`, originalBytes);
  zip.file(`${baseName}.${wldExt}`, buildWorldFileText(entry.transform));
  const blob = await zip.generateAsync({type:'blob'});
  downloadBlob(blob, `${baseName}_georreferenciada.zip`);
}

async function exportRasterGeoTiff(entry){
  if(!entry || !entry.transform){
    showAppAlert('Esta imagem ainda não tem uma transformação calculada — não há GeoTIFF para exportar.');
    return;
  }
  if(typeof GeoTIFF === 'undefined' || typeof GeoTIFF.writeArrayBuffer !== 'function'){
    showAppAlert('Esta versão da biblioteca GeoTIFF (geotiff.js) não suporta exportação. Atualiza o script no engenh.html para uma versão mais recente.');
    return;
  }
  /* geotiff.js v3.0+ (geotiffwriter.js) — corrigido no PR #462 (jan 2026):
     o writer já NÃO injeta ModelPixelScale por omissão quando se passa
     ModelTransformation, pelo que podemos usar ModelTransformation diretamente
     para transformações com rotação/shear, sem conflito de tags.
     Para transformações sem rotação, mantemos ModelPixelScale+ModelTiepoint
     por ser mais amplamente suportado. */

  let imageData;
  try{
    imageData = await getRasterPixelData(entry);
  }catch(err){
    console.error('Erro ao ler os pixels da imagem:', err);
    showAppAlert('Não foi possível ler os pixels da imagem para gerar o GeoTIFF.', {error: true});
    return;
  }

  const {data, width, height} = imageData;
  let hasAlpha = false;
  for(let i = 3; i < data.length; i += 4){ if(data[i] < 255){ hasAlpha = true; break; } }

  let values, samplesPerPixel;
  if(hasAlpha){
    values = new Uint8Array(data.buffer.slice(0));
    samplesPerPixel = 4;
  }else{
    values = new Uint8Array(width * height * 3);
    for(let i = 0, j = 0; i < data.length; i += 4, j += 3){
      values[j] = data[i]; values[j+1] = data[i+1]; values[j+2] = data[i+2];
    }
    samplesPerPixel = 3;
  }

  const hasRotation = affineHasRotation(entry.transform);
  const metadata = {
    width, height,
    GTModelTypeGeoKey: 2,      // geográfico (lat/lng), não projetado
    GTRasterTypeGeoKey: 1,     // PixelIsArea
    GeographicTypeGeoKey: 4326,
    SamplesPerPixel: samplesPerPixel,
    PhotometricInterpretation: 2 // RGB
  };
  if(hasAlpha) metadata.ExtraSamples = [2]; // 2 = alfa não-associado

  if(hasRotation){
    metadata.ModelTransformation = affineToModelTransformation(entry.transform);
  }else{
    const {ModelPixelScale, ModelTiepoint} = affineToPixelScaleAndTiepoint(entry.transform);
    metadata.ModelPixelScale = ModelPixelScale;
    metadata.ModelTiepoint = ModelTiepoint;
  }

  let arrayBuffer;
  try{
    arrayBuffer = await GeoTIFF.writeArrayBuffer(values, metadata);
  }catch(err){
    console.error('Erro ao gerar o GeoTIFF:', err);
    showAppAlert('Não foi possível gerar o GeoTIFF: ' + err.message, {error: true});
    return;
  }

  const baseName = fileBaseName(entry.source || entry.name || 'imagem');
  downloadBlob(new Blob([arrayBuffer], {type:'image/tiff'}), `${baseName}_georreferenciada.tif`);
}

/* menu flutuante com as opções de exportação — mesmo padrão de
   position:fixed calculado a partir do botão, usado no seletor de
   georreferenciação (openGeorefPickerMenu) */
function closeRasterExportMenu(){
  document.getElementById('raster-export-menu')?.classList.add('hidden');
}

function openRasterExportMenu(entry, btn){
  const menu = document.getElementById('raster-export-menu');
  const list = document.getElementById('raster-export-list');
  if(!menu || !list || !btn) return;

  const options = [
    {key:'worldfile', label:'World File', hint: '.' + worldFileExtensionFor(entry.source || entry.name) + ' — só os parâmetros'},
    {key:'zip', label:'Imagem + World File', hint: '.zip — imagem original incluída'},
    {key:'geotiff', label:'GeoTIFF', hint: '.tif — georreferenciação embutida'}
  ];
  list.innerHTML = options.map(opt=>`
    <button type="button" class="raster-export-item" data-raster-export-opt="${opt.key}">
      <span>${opt.label}</span>
      <span class="raster-export-item-hint">${opt.hint}</span>
    </button>`).join('');

  list.querySelectorAll('[data-raster-export-opt]').forEach(item=>{
    item.addEventListener('click', ()=>{
      const opt = item.dataset.rasterExportOpt;
      closeRasterExportMenu();
      if(opt === 'worldfile') exportRasterWorldFile(entry);
      else if(opt === 'zip') exportRasterImageZip(entry);
      else if(opt === 'geotiff') exportRasterGeoTiff(entry);
    });
  });

  const rect = btn.getBoundingClientRect();
  menu.classList.remove('hidden');
  const menuRect = menu.getBoundingClientRect();
  menu.style.top = (rect.bottom + 6) + 'px';
  menu.style.left = Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8)) + 'px';
}

document.addEventListener('click', (e)=>{
  const menu = document.getElementById('raster-export-menu');
  if(!menu || menu.classList.contains('hidden')) return;
  if(!menu.contains(e.target) && !e.target.closest('[data-raster-export]')) closeRasterExportMenu();
});

/* processa um único ficheiro de imagem (já sabemos que é .jpg/.png/.tif),
   detetando o cenário certo e registando a entrada em rasterLayers */
async function importSingleRasterFile(file, worldFilesByBase){
  const isTiff = /\.tiff?$/i.test(file.name);
  const base = fileBaseName(file.name);
  const matchingWorldFile = worldFilesByBase.get(base) || null;

  rasterCounter++;
  const id = genRasterId();
  const label = getImportedLayerName(file.name);

  if(isTiff){
    const buffer = await file.arrayBuffer();
    let tiff, image;
    try{
      tiff = await GeoTIFF.fromArrayBuffer(buffer);
      image = await tiff.getImage();
    }catch(err){
      console.error('Erro ao ler TIFF:', err);
      return {status:'error', name:file.name, message:'Não foi possível ler o ficheiro TIFF (formato/compressão não suportada).'};
    }

    const width = image.getWidth();
    const height = image.getHeight();

    if(geotiffHasGeoTags(image)){
      // já georreferenciado — a colocação automática completa (reprojeção,
      // desenho via georaster) fica reservada para uma fase seguinte; por
      // agora deteta-se e regista-se claramente como tal, sem inventar
      // uma posição errada no mapa
      const blobUrl = URL.createObjectURL(file);
      const dataUrl = await fileToDataUrl(file).catch(err=>{ console.warn('Não foi possível gerar data URL para persistência:', err); return null; });
      rasterLayers.set(id, {
        id, name:label, url:blobUrl, dataUrl, width, height,
        georeferenced:true, pending:false, autoGeoTiff:true,
        gcps:[], transform:null, overlay:null, source:file.name
      });
      return {status:'geotiff-auto', name:file.name};
    }

    // TIFF sem tags geo: segue o mesmo caminho de um PNG/JPG normal
    const blobUrl = URL.createObjectURL(file);
    const dataUrl = await fileToDataUrl(file).catch(err=>{ console.warn('Não foi possível gerar data URL para persistência:', err); return null; });
    const entry = {
      id, name:label, url:blobUrl, dataUrl, width, height,
      georeferenced:false, pending:true, gcps:[], transform:null, overlay:null, source:file.name
    };
    if(matchingWorldFile){
      const transform = await parseWorldFileText(await matchingWorldFile.text());
      if(transform){ entry.transform = transform; entry.georeferenced = true; entry.pending = false; }
    }
    rasterLayers.set(id, entry);
    placeRasterOverlay(entry);
    return {status: entry.pending ? 'pending' : 'worldfile', name:file.name};
  }

  // PNG / JPG
  const blobUrl = URL.createObjectURL(file);
  const dims = await new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = ()=> resolve({width:img.naturalWidth, height:img.naturalHeight});
    img.onerror = ()=> reject(new Error('Imagem inválida ou corrompida.'));
    img.src = blobUrl;
  }).catch(err=>{ console.error(err); return null; });

  if(!dims){
    URL.revokeObjectURL(blobUrl);
    return {status:'error', name:file.name, message:'Não foi possível ler a imagem.'};
  }

  const dataUrl = await fileToDataUrl(file).catch(err=>{ console.warn('Não foi possível gerar data URL para persistência:', err); return null; });
  const entry = {
    id, name:label, url:blobUrl, dataUrl, width:dims.width, height:dims.height,
    georeferenced:false, pending:true, gcps:[], transform:null, overlay:null, source:file.name
  };
  if(matchingWorldFile){
    const transform = await parseWorldFileText(await matchingWorldFile.text());
    if(transform){ entry.transform = transform; entry.georeferenced = true; entry.pending = false; }
  }
  rasterLayers.set(id, entry);
  placeRasterOverlay(entry);
  return {status: entry.pending ? 'pending' : 'worldfile', name:file.name};
}

async function importRasterFiles(imageFiles, worldFiles){
  try{
    const worldFilesByBase = new Map();
    worldFiles.forEach(f=> worldFilesByBase.set(fileBaseName(f.name), f));

    const results = await Promise.all(imageFiles.map(f=> importSingleRasterFile(f, worldFilesByBase)));

    renderRasterLayersPanel();

    const pending = results.filter(r=>r.status==='pending').length;
    const worldfile = results.filter(r=>r.status==='worldfile').length;
    const geotiffAuto = results.filter(r=>r.status==='geotiff-auto').length;
    const errors = results.filter(r=>r.status==='error');

    const parts = [];
    if(worldfile > 0) parts.push(`${worldfile} imagem(ns) georreferenciada(s) automaticamente via World File.`);
    if(geotiffAuto > 0) parts.push(`${geotiffAuto} GeoTIFF já georreferenciado(s) detetado(s) (pré-visualização completa numa fase seguinte).`);
    if(pending > 0) parts.push(`${pending} imagem(ns) por georreferenciar — usa o modo de Georreferenciação para as posicionar.`);
    if(errors.length > 0) parts.push(`${errors.length} ficheiro(s) não puderam ser importados: ${errors.map(e=>e.name).join(', ')}.`);
    if(parts.length) showAppAlert(parts.join('\n'));
  }catch(err){
    console.error('[importRasterFiles]', err);
    showAppAlert('Erro ao importar imagens raster.', {error: true});
  }
}

/* painel lateral "Imagens" — lista separada da lista de camadas vetoriais,
   já que uma imagem não tem geometryType/atributos/simbologia */
function renderRasterLayersPanel(){
  const panel = document.getElementById('raster-panel');
  const list = document.getElementById('raster-layers-list');
  if(!panel || !list) return;

  if(rasterLayers.size === 0){
    panel.classList.add('hidden');
    list.innerHTML = '';
    updateGeorefHeaderButton();
    return;
  }
  panel.classList.remove('hidden');

  list.innerHTML = Array.from(rasterLayers.values()).map(entry=>{
    const rmsLabel = (typeof entry.rmsError === 'number')
      ? ` (RMS ${entry.rmsError.toFixed(entry.rmsUnit === 'm' ? 2 : 6)} ${entry.rmsUnit || ''})`
      : '';
    const statusLabel = entry.pending ? 'Não georreferenciada' : (entry.autoGeoTiff ? 'GeoTIFF georreferenciado' : `Georreferenciada${rmsLabel}`);
    const statusIcon = entry.pending ? '⚠️' : '🌍';
    const exportBtn = entry.transform
      ? `<button type="button" class="raster-focus-btn" data-raster-export title="Exportar (World File / imagem / GeoTIFF)">💾</button>`
      : '';
    return `
      <li class="raster-row ${entry.pending ? 'is-pending' : ''}" data-raster-id="${entry.id}" title="${escapeHtml(entry.name)}">
        <span class="raster-status-icon">${statusIcon}</span>
        <span class="raster-name">${escapeHtml(entry.name)}</span>
        <span class="raster-status-label">${statusLabel}</span>
        <button type="button" class="raster-focus-btn" data-raster-focus title="Centrar no mapa">🎯</button>
        ${exportBtn}
        <button type="button" class="raster-remove-btn" data-raster-remove title="Remover">✕</button>
      </li>`;
  }).join('');

  list.querySelectorAll('.raster-row').forEach(row=>{
    const id = row.dataset.rasterId;
    const entry = rasterLayers.get(id);
    if(!entry) return;
    row.querySelector('[data-raster-focus]')?.addEventListener('click', (e)=>{ e.stopPropagation(); focusRasterLayer(entry); });
    row.querySelector('[data-raster-export]')?.addEventListener('click', (e)=>{ e.stopPropagation(); openRasterExportMenu(entry, e.currentTarget); });
    row.querySelector('[data-raster-remove]')?.addEventListener('click', (e)=>{
      e.stopPropagation();
      if(confirm(`Remover a imagem "${entry.name}"?`)) removeRasterLayer(id);
    });
  });

  updateGeorefHeaderButton();
}

/* ============================================================
   BOTÃO "🎯 GEORREFERENCIAR" NO HEADER — FASE 2
   ------------------------------------------------------------
   Só aparece enquanto existir pelo menos uma imagem pendente
   (entry.pending === true). Com uma pendente, avança logo para
   ela; com várias, mostra um pequeno seletor para o utilizador
   escolher qual quer tratar primeiro.
   ============================================================ */
function pendingRasterEntries(){
  return Array.from(rasterLayers.values()).filter(e => e.pending);
}

function updateGeorefHeaderButton(){
  const btn = document.getElementById('btn-georef-mode');
  const badge = document.getElementById('georef-btn-badge');
  if(!btn) return;
  const pending = pendingRasterEntries();
  const wasHidden = btn.classList.contains('hidden');
  btn.classList.toggle('hidden', pending.length === 0);
  btn.title = pending.length > 1
    ? `Georreferenciar imagem (${pending.length} pendentes)`
    : 'Georreferenciar imagem';

  if(pending.length === 0){
    btn.classList.remove('is-attention', 'is-paused');
    if(badge) badge.classList.add('hidden');
    return;
  }

  // acabou de aparecer (0 → N pendentes): "pop" de entrada + começa a
  // pulsar, para guiar o olhar do utilizador até ao botão
  if(wasHidden){
    btn.classList.remove('is-attention'); // reinicia a animação, se aplicável
    void btn.offsetWidth; // força reflow para o CSS animation reiniciar
    btn.classList.add('is-attention');
    btn.classList.remove('is-paused');
  }

  if(badge){
    if(pending.length > 1){
      badge.textContent = String(pending.length);
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

/* pausa a animação de destaque enquanto o utilizador já está a
   interagir (menu aberto ou dentro do próprio modo de georref.) —
   evita distrair quem já está a tratar do assunto */
function setGeorefButtonAttentionPaused(paused){
  document.getElementById('btn-georef-mode')?.classList.toggle('is-paused', !!paused);
}

function openGeorefPickerMenu(){
  const pending = pendingRasterEntries();
  const menu = document.getElementById('georef-picker-menu');
  const list = document.getElementById('georef-picker-list');
  const btn = document.getElementById('btn-georef-mode');
  if(!menu || !list || !btn) return;

  list.innerHTML = pending.map(entry => `
    <button type="button" class="georef-picker-item" data-georef-pick="${entry.id}">
      <span class="raster-status-icon">⚠️</span>
      <span class="raster-name">${escapeHtml(entry.name)}</span>
    </button>`).join('');

  list.querySelectorAll('[data-georef-pick]').forEach(item=>{
    item.addEventListener('click', ()=>{
      const entry = rasterLayers.get(item.dataset.georefPick);
      closeGeorefPickerMenu();
      if(entry) beginGeoreferencingMode(entry);
    });
  });

  const rect = btn.getBoundingClientRect();
  menu.classList.remove('hidden');
  const menuRect = menu.getBoundingClientRect();
  menu.style.top = (rect.bottom + 6) + 'px';
  menu.style.left = Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8)) + 'px';
  setGeorefButtonAttentionPaused(true);
}
function closeGeorefPickerMenu(){
  document.getElementById('georef-picker-menu')?.classList.add('hidden');
  setGeorefButtonAttentionPaused(false);
}
document.addEventListener('click', (e)=>{
  const menu = document.getElementById('georef-picker-menu');
  const btn = document.getElementById('btn-georef-mode');
  if(!menu || menu.classList.contains('hidden')) return;
  if(!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeGeorefPickerMenu();
});

document.getElementById('btn-georef-mode')?.addEventListener('click', (e)=>{
  e.stopPropagation();
  const pending = pendingRasterEntries();
  if(pending.length === 0) return;
  if(pending.length === 1){ beginGeoreferencingMode(pending[0]); return; }
  const menu = document.getElementById('georef-picker-menu');
  if(menu.classList.contains('hidden')) openGeorefPickerMenu(); else closeGeorefPickerMenu();
});

/* ============================================================
   MODO DE GEORREFERENCIAÇÃO — FASE 3 (esqueleto de UI)
   ------------------------------------------------------------
   Aqui entra-se e sai-se do modo, com a barra superior modal, o
   painel lateral da imagem e a notificação flutuante a aparecerem,
   e as restantes ferramentas bloqueadas. A captura de GCPs em si
   (clicar imagem → clicar mapa) fica para a Fase 4 — por agora
   georefModeState.gcps existe só para essa fase pegar a partir daqui.
   ============================================================ */
const georefModeState = {
  active: false,
  entry: null,
  gcps: [],
  pendingImagePoint: null,
  pendingMapPoint: null,
  /* true assim que se clica em "Autogeoreferenciar" — bloqueia imediatamente a
     lógica manual de adicionar pontos (clique na imagem/mapa) — e permanece
     true depois de a deteção terminar com sucesso, altura em que também
     esconde a UI manual (barra de Pontos/Cancelar/Aplicar) e mostra o botão
     "Aplicar alterações". Só volta a false se a deteção falhar em todas as
     fontes, ou ao entrar/sair do modo de georreferenciação. */
  autoGeorefCompleted: false,
  /* só true depois de a autogeoreferenciação falhar E o utilizador clicar
     em "georeferenciar manualmente?" — até lá a barra de pontos e os cliques
     na imagem/mapa ficam escondidos/bloqueados. */
  manualGeorefUnlocked: false
};
let georefGcpMapGroup = null;
let georefPendingMapMarker = null;
let georefGcpIdCounter = 0;

/* bloqueia as restantes ferramentas: esconde a barra Geoman (mesma
   lógica usada no toggle do lápis, btn-toggle-pm-toolbar), desativa
   quaisquer modos de desenho/edição/remoção do Leaflet-Geoman em
   curso, e marca o body para o CSS inibir cabeçalho + painel de
   camadas (georef.css: body.georef-mode-active) */
function lockToolsForGeoref(){
  document.body.classList.add('georef-mode-active');

  const mapEl = document.getElementById('map');
  mapEl.classList.remove('pm-toolbar-visible');
  const pmToggle = document.getElementById('btn-toggle-pm-toolbar');
  if(pmToggle){ pmToggle.classList.remove('is-active'); pmToggle.setAttribute('aria-pressed', 'false'); }

  if(map.pm.globalDrawModeEnabled()) map.pm.disableDraw();
  if(map.pm.globalEditModeEnabled()) map.pm.disableGlobalEditMode();
  if(map.pm.globalDragModeEnabled()) map.pm.disableGlobalDragMode();
  if(map.pm.globalRemovalModeEnabled()) map.pm.disableGlobalRemovalMode();
}

function unlockToolsForGeoref(){
  document.body.classList.remove('georef-mode-active');
}

/* recalcula a posição dos três elementos flutuantes do modo a partir
   de #map.getBoundingClientRect() — mesma convenção usada no resto da
   app para overlays em position:fixed (ex.: georef-picker-menu) */
function positionGeorefOverlays(){
  const mapRect = document.getElementById('map').getBoundingClientRect();
  const halfWidth = mapRect.width / 2;

  /* topbar recentrada sobre a metade esquerda (a única com o
     basemap visível e clicável — a direita fica coberta pelo
     painel da imagem) */
  const topbar = document.getElementById('georef-mode-topbar');
  if(topbar && !topbar.classList.contains('hidden')){
    topbar.style.left = (mapRect.left + halfWidth / 2) + 'px';
    topbar.style.top = (mapRect.top + 14) + 'px';
  }

  /* painel da imagem: ocupa exatamente a metade direita da área do
     mapa, a toda a altura — a metade esquerda fica livre para o
     basemap normal */
  const panel = document.getElementById('georef-image-panel');
  if(panel && !panel.classList.contains('hidden')){
    panel.style.left = (mapRect.left + halfWidth) + 'px';
    panel.style.top = mapRect.top + 'px';
    panel.style.width = halfWidth + 'px';
    panel.style.height = mapRect.height + 'px';
  }

  const banner = document.getElementById('georef-active-banner');
  if(banner && !banner.classList.contains('hidden')){
    banner.style.left = (mapRect.left + 16) + 'px';
    banner.style.bottom = Math.max(16, (window.innerHeight - mapRect.bottom + 16)) + 'px';
  }
}
window.addEventListener('resize', ()=>{ if(georefModeState.active) positionGeorefOverlays(); });

/* ponto de entrada para o modo de georreferenciação em si */
function beginGeoreferencingMode(entry){
  enterGeorefMode(entry);
}

/* dá zoom a Portugal Continental e mostra um popup de confirmação no mapa
   da esquerda, para orientar o utilizador assim que entra no modo —
   fecha sozinho ao fim de alguns segundos para não atrapalhar a captura
   de pontos de controlo que se segue. Só a metade esquerda do #map fica
   visível/clicável no modo de georreferenciação (a direita fica coberta
   pelo painel da imagem), por isso o enquadramento e o popup têm de ser
   calculados só para essa metade — senão Portugal fica centrado a meio
   do ecrã todo, com a esquerda a mostrar só a ponta do país. */
const GEOREF_PORTUGAL_BOUNDS = L.latLngBounds([36.8, -9.6], [42.3, -6.1]);
let georefReadyPopup = null;
function showGeorefReadyPopup(){
  if(typeof map === 'undefined' || !map) return;
  const mapEl = document.getElementById('map');
  const fullWidth = mapEl ? mapEl.getBoundingClientRect().width : map.getSize().x;
  const halfWidth = fullWidth / 2;

  // reserva a metade direita como "padding" para o fitBounds, para que
  // Portugal fique enquadrado dentro da metade esquerda, não do mapa todo
  map.fitBounds(GEOREF_PORTUGAL_BOUNDS, {
    paddingTopLeft: [24, 24],
    paddingBottomRight: [halfWidth + 24, 24]
  });

  const size = map.getSize();
  const leftCenterPoint = L.point(halfWidth / 2, size.y / 2);
  const popupLatLng = map.containerPointToLatLng(leftCenterPoint);

  if(georefReadyPopup){ map.closePopup(georefReadyPopup); georefReadyPopup = null; }
  georefReadyPopup = L.popup({className:'georef-ready-popup', closeOnClick:false})
    .setLatLng(popupLatLng)
    .setContent('Pronto para georreferenciar')
    .openOn(map);
  clearTimeout(showGeorefReadyPopup._timer);
  showGeorefReadyPopup._timer = setTimeout(()=>{
    if(georefReadyPopup){ map.closePopup(georefReadyPopup); georefReadyPopup = null; }
  }, 4000);
}

/* botão "✕" fixo no canto do painel da imagem, sempre visível — ao
   contrário do [Cancelar] da barra superior modal (georef-topbar-cancel),
   que fica escondido junto com toda a barra depois de uma autogeoreferên-
   ciação bem sucedida (ver enterAutoGeorefCompletedState). Sem isto, uma
   vez concluído o fluxo automático deixava de haver forma de cancelar. */
function ensureGeorefPanelCloseButton(){
  let btn = document.getElementById('georef-panel-close-btn');
  if(btn) return btn;

  const panel = document.getElementById('georef-image-panel');
  if(!panel) return null;

  btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'georef-panel-close-btn';
  btn.className = 'georef-panel-close-btn';
  btn.setAttribute('aria-label', 'Cancelar georreferenciação');
  btn.title = 'Cancelar georreferenciação';
  btn.innerHTML = '&times;';
  btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    cancelGeorefMode();
  });
  panel.appendChild(btn);
  return btn;
}

function enterGeorefMode(entry){
  if(georefModeState.active) return;
  georefModeState.active = true;
  setGeorefButtonAttentionPaused(true);
  georefModeState.entry = entry;
  georefModeState.gcps = [];
  georefModeState.pendingImagePoint = null;
  georefModeState.pendingMapPoint = null;
  georefModeState.autoGeorefCompleted = false;
  georefModeState.manualGeorefUnlocked = false;
  resetGeorefAutoCompletedUI();
  hideGeorefManualFallbackOffer();
  setGeorefManualUIVisible(false);

  lockToolsForGeoref();

  document.getElementById('georef-topbar-name').textContent = entry.name;
  const rmsEl = document.getElementById('georef-topbar-rms');
  rmsEl.textContent = '—';
  rmsEl.className = 'georef-topbar-rms';

  const applyBtn = document.getElementById('georef-topbar-apply');
  applyBtn.disabled = true;
  applyBtn.textContent = 'Aplicar';
  document.getElementById('georef-topbar-cancel').disabled = false;

  const imgEl = document.getElementById('georef-image-el');
  imgEl.src = entry.url;
  imgEl.alt = entry.name;

  setGeorefAutoStatus('Aproxima-te à área de interesse no mapa e clica em Autogeoreferenciar.', false, 'idle');

  document.getElementById('georef-image-panel').classList.remove('hidden');
  document.getElementById('georef-active-banner').classList.remove('hidden');
  ensureGeorefPanelCloseButton();

  renderGeorefGCPMarkers();
  renderGeorefGCPList();
  updateGeorefTopbarState();
  enableGeorefAutoButtonIfZoomReady();

  positionGeorefOverlays();
  // zoom a Portugal + popup de confirmação por último: entry está sempre
  // pendente aqui (posição provisória perto de 0,0), por isso focar nela
  // não ajudaria o utilizador — faz mais sentido partir sempre de Portugal
  showGeorefReadyPopup();

  // Arranca já o carregamento do OpenCV.js em segundo plano (worker), para
  // quando o utilizador clicar "Autogeoreferenciar" — normalmente vários
  // segundos depois, enquanto aproxima o mapa — o OpenCV já estar pronto
  // ou quase pronto. Best-effort: se falhar, o clique no botão tenta o
  // carregamento normal na mesma.
  if(typeof AutoGeoref !== 'undefined' && AutoGeoref.warmUp){
    AutoGeoref.warmUp();
  }
}

/* fecha a UI do modo (barra, painel, notificação, marcadores) e larga
   o estado — usada tanto pelo [Cancelar] como, com sucesso, pelo
   [Aplicar]; nunca mexe em rasterLayers, isso é feito por quem chama */
function closeGeorefModeUI(){
  document.getElementById('georef-mode-topbar')?.classList.add('hidden');
  document.getElementById('georef-image-panel')?.classList.add('hidden');
  document.getElementById('georef-active-banner')?.classList.add('hidden');
  hideGeorefStatsCard();

  if(georefReadyPopup && typeof map !== 'undefined' && map){ map.closePopup(georefReadyPopup); georefReadyPopup = null; }

  forceHideAutoGeorefProgressUI();

  if(georefGcpMapGroup){ georefGcpMapGroup.clearLayers(); }
  georefPendingMapMarker = null;
  document.querySelectorAll('.georef-gcp-image-marker, .georef-gcp-pending-marker').forEach(el=> el.remove());

  const imgEl = document.getElementById('georef-image-el');
  imgEl?.removeAttribute('src');

  unlockToolsForGeoref();
  setGeorefButtonAttentionPaused(false);

  georefModeState.active = false;
  georefModeState.entry = null;
  georefModeState.gcps = [];
  georefModeState.pendingImagePoint = null;
  georefModeState.pendingMapPoint = null;
  georefModeState.autoGeorefCompleted = false;
  georefModeState.manualGeorefUnlocked = false;
  resetGeorefAutoCompletedUI();
  hideGeorefManualFallbackOffer();
}

/* [Cancelar] devolve tudo ao estado anterior — o raster continua
   pendente, nada é alterado em rasterLayers */
function cancelGeorefMode(){
  if(!georefModeState.active) return;
  closeGeorefModeUI();
}

// delegado no document (em vez de addEventListener direto no nó do botão):
// sobrevive a qualquer substituição/recriação do #georef-topbar-cancel mais
// tarde na página, que faria um listener direto perder-se silenciosamente
document.addEventListener('click', (e)=>{
  if(e.target.closest('#georef-topbar-cancel')) cancelGeorefMode();
});
document.getElementById('georef-auto-detect-btn')?.addEventListener('click', (e)=>{ e.stopPropagation(); runAutoGeorefDetection(); });

/* ============================================================
   FASE 5: cálculo + aplicação da transformação
   ------------------------------------------------------------
   O RMS devolvido pelo solver está em graus (unidades de lat/lng),
   pouco intuitivo para avaliar precisão; reprojeta-se os resíduos
   para EPSG:3763 (ETRS89 / PT-TM06, já usado no resto da app — ver
   reprojectCoords) para mostrar o erro em metros. Se a reprojeção
   falhar por algum motivo, cai-se para o valor em graus do solver. */
function computeGeorefRmsMeters(gcps, transform){
  try{
    let sumSq = 0;
    gcps.forEach(gcp=>{
      const predLng = transform.a * gcp.img.x + transform.b * gcp.img.y + transform.c;
      const predLat = transform.d * gcp.img.x + transform.e * gcp.img.y + transform.f;
      const pred = proj4('EPSG:4326', 'EPSG:3763', [predLng, predLat]);
      const real = proj4('EPSG:4326', 'EPSG:3763', [gcp.map.lng, gcp.map.lat]);
      const dx = pred[0] - real[0], dy = pred[1] - real[1];
      sumSq += dx*dx + dy*dy;
    });
    return {value: Math.sqrt(sumSq / gcps.length), unit: 'm'};
  }catch(err){
    console.warn('Não foi possível reprojetar para metros, a mostrar RMS em graus:', err);
    return {value: transform.rms, unit: '°'};
  }
}

function formatGeorefRms(rms){
  return rms.value.toFixed(rms.unit === 'm' ? 2 : 6) + ' ' + rms.unit;
}

/* verde <1m, amarelo 1-5m, vermelho >5m — ajustável */
function georefRmsQualityClass(rms){
  if(rms.unit !== 'm') return '';
  if(rms.value < 1) return 'is-good';
  if(rms.value <= 5) return 'is-warn';
  return 'is-bad';
}

/* ---- Estatísticas de precisão (cartão flutuante) ---- */
function computeGeorefPrecisionStats(gcps, quality){
  if(!gcps || gcps.length < 3) return null;
  let transform;
  try{
    transform = Georef.solveAffineLeastSquares(gcps.map(g=>({img:g.img, map:g.map})));
  }catch(e){ return null; }
  const errors = gcps.map(g=>{
    const predLng = transform.a * g.img.x + transform.b * g.img.y + transform.c;
    const predLat = transform.d * g.img.x + transform.e * g.img.y + transform.f;
    try{
      const pred = proj4('EPSG:4326', 'EPSG:3763', [predLng, predLat]);
      const real = proj4('EPSG:4326', 'EPSG:3763', [g.map.lng, g.map.lat]);
      return Math.sqrt((pred[0]-real[0])**2 + (pred[1]-real[1])**2);
    }catch(e2){
      const dx = (predLng - g.map.lng) * 111320 * Math.cos(g.map.lat * Math.PI / 180);
      const dy = (predLat - g.map.lat) * 111320;
      return Math.sqrt(dx*dx + dy*dy);
    }
  });
  const sorted = [...errors].sort((a,b)=> a - b);
  const rms = Math.sqrt(errors.reduce((s,e)=> s + e*e, 0) / errors.length);
  const avg = errors.reduce((s,e)=> s + e, 0) / errors.length;
  const max = sorted[sorted.length - 1];
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || max;
  const perGcpErrors = gcps.map((g, i)=> ({ id: g.id || (i+1), error: errors[i] }));
  return {
    rms, avg, max, p90,
    pointCount: gcps.length,
    inlierCount: quality?.inlierCount ?? gcps.length,
    totalMatches: quality?.totalMatches ?? gcps.length,
    inlierRatio: quality?.inlierRatio ?? 1,
    perGcpErrors
  };
}

function renderGeorefStatsCard(stats){
  const card = document.getElementById('georef-stats-card');
  const grid = document.getElementById('georef-stats-grid');
  const detail = document.getElementById('georef-stats-detail');
  if(!card || !grid) return;
  if(!stats){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  const fmt = v => v < 0.1 ? '< 0.1' : v < 10 ? v.toFixed(1) : Math.round(v);
  const t = v => v < 1 ? 'good' : v < 5 ? 'warn' : 'bad';
  grid.innerHTML = `
    <div class="georef-stat-card ${t(stats.rms)}"><span class="georef-stat-value">${fmt(stats.rms)}</span><span class="georef-stat-label">RMS (m)</span></div>
    <div class="georef-stat-card ${t(stats.avg)}"><span class="georef-stat-value">${fmt(stats.avg)}</span><span class="georef-stat-label">Médio (m)</span></div>
    <div class="georef-stat-card ${t(stats.max)}"><span class="georef-stat-value">${fmt(stats.max)}</span><span class="georef-stat-label">Máx. (m)</span></div>
    <div class="georef-stat-card ${t(stats.p90)}"><span class="georef-stat-value">${fmt(stats.p90)}</span><span class="georef-stat-label">P90 (m)</span></div>
    <div class="georef-stat-card"><span class="georef-stat-value">${stats.pointCount}</span><span class="georef-stat-label">GCPs</span></div>
    <div class="georef-stat-card"><span class="georef-stat-value">${(stats.inlierRatio*100).toFixed(0)}%</span><span class="georef-stat-label">Sucesso</span></div>`;
  if(!detail) return;
  let html = '';
  if(stats.totalMatches && stats.totalMatches !== stats.pointCount){
    html += `<div class="georef-detail-row"><span class="georef-detail-label">Correspondências</span><span class="georef-detail-value">${stats.inlierCount}/${stats.totalMatches}</span></div>`;
  }
  if(stats.perGcpErrors && stats.perGcpErrors.length){
    const maxErr = Math.max(...stats.perGcpErrors.map(e=> e.error), 0.1);
    const pct = v => Math.min((v / maxErr) * 100, 100);
    const toneHex = v => v < 1 ? '#2f7d4f' : v < 5 ? '#a07018' : '#b5472b';
    html += `<div class="georef-error-bar-wrap">`;
    stats.perGcpErrors.forEach((g, i) => {
      const c = toneHex(g.error);
      html += `<div class="georef-error-bar-label"><span>#${i+1}</span><span style="color:${c};font-weight:600">${fmt(g.error)}m</span></div>`;
      html += `<div class="georef-error-bar"><div class="georef-error-bar-fill" style="width:${pct(g.error)}%;background:${c}"></div></div>`;
    });
    html += `</div>`;
  }
  detail.innerHTML = html;
}

function hideGeorefStatsCard(){
  const card = document.getElementById('georef-stats-card');
  if(card) card.classList.add('hidden');
}

function applyGeorefTransform(){
  if(!georefModeState.active) return;
  const entry = georefModeState.entry;
  const gcps = georefModeState.gcps;
  if(!entry || gcps.length < 4) return;

  let transform;
  try{
    transform = Georef.solveAffineLeastSquares(gcps);
  }catch(err){
    showAppAlert('Não foi possível calcular a transformação: ' + err.message, {error: true});
    return;
  }

  const rms = computeGeorefRmsMeters(gcps, transform);

  // tranca já a captura de pontos (map/imagem verificam este flag), mesmo
  // que a UI só feche 1.1s depois para dar tempo de ver o RMS
  georefModeState.active = false;

  const rmsEl = document.getElementById('georef-topbar-rms');
  rmsEl.textContent = 'RMS: ' + formatGeorefRms(rms);
  rmsEl.className = 'georef-topbar-rms ' + georefRmsQualityClass(rms);

  const applyBtn = document.getElementById('georef-topbar-apply');
  const cancelBtn = document.getElementById('georef-topbar-cancel');
  applyBtn.disabled = true;
  cancelBtn.disabled = true;
  applyBtn.textContent = 'Aplicado ✓';

  entry.gcps = gcps.map(g=> ({img: {x: g.img.x, y: g.img.y}, map: {lng: g.map.lng, lat: g.map.lat}}));
  entry.transform = transform;
  entry.georeferenced = true;
  entry.pending = false;
  entry.rmsError = rms.value;
  entry.rmsUnit = rms.unit;

  placeRasterOverlay(entry);
  renderRasterLayersPanel();

  // dá tempo ao utilizador para ver o RMS na barra antes de fechar o modo
  setTimeout(()=>{
    closeGeorefModeUI();
    focusRasterLayer(entry);
    applyBtn.textContent = 'Aplicar';
    applyBtn.disabled = false;
    cancelBtn.disabled = false;
    showTeamToast(`"${entry.name}" georreferenciada com sucesso (RMS ${formatGeorefRms(rms)}).`);
  }, 1100);
}

document.addEventListener('click', (e)=>{
  if(e.target.closest('#georef-topbar-apply')) applyGeorefTransform();
});

document.addEventListener('keydown', (e)=>{
  if(e.key === 'Escape' && georefModeState.active) cancelGeorefMode();
});

/* ============================================================
   Fluxo automático — separação total do modo manual
   ------------------------------------------------------------
   Depois de a autogeoreferenciação terminar com sucesso, a barra
   superior modal (Pontos X/4, Cancelar, Aplicar) desaparece por
   completo e é substituída, na barra inferior do painel da imagem,
   por um botão "Aplicar alterações" — junto ao "Autogeoreferenciar"
   — que dispara a mesma transformação (applyGeorefTransform).
   ============================================================ */

/* cria (uma única vez, de forma preguiçosa) o botão "Aplicar alterações" e
   agrupa-o na mesma linha do botão "Autogeoreferenciar" já existente na
   barra inferior do painel da imagem — sem exigir alterações ao HTML. */
function ensureGeorefApplyChangesButton(){
  let btn = document.getElementById('georef-apply-changes-btn');
  if(btn) return btn;

  const autoBtn = document.getElementById('georef-auto-detect-btn');
  if(!autoBtn || !autoBtn.parentElement) return null;

  let row = autoBtn.parentElement.classList.contains('georef-auto-footer-row')
    ? autoBtn.parentElement
    : null;
  if(!row){
    row = document.createElement('div');
    row.className = 'georef-auto-footer-row';
    autoBtn.parentElement.insertBefore(row, autoBtn);
    row.appendChild(autoBtn);
  }

  btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'georef-apply-changes-btn';
  btn.className = 'btn georef-apply-changes-btn hidden';
  btn.textContent = 'Aplicar alterações';
  btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    // só existe e só reage enquanto o fluxo automático estiver concluído —
    // nunca é usado pelo fluxo manual
    if(!georefModeState.autoGeorefCompleted || btn.disabled) return;
    btn.disabled = true;
    applyGeorefTransform();
  });
  row.appendChild(btn);
  return btn;
}

/* Esconde por completo a barra superior modal (nome/RMS/Pontos/Cancelar/
   Aplicar) e mostra o botão "Aplicar alterações" — chamada só quando a
   deteção automática termina com sucesso. */
function enterAutoGeorefCompletedState(gcpCount, sourceLabel){
  document.getElementById('georef-mode-topbar')?.classList.add('hidden');
  hideGeorefManualFallbackOffer();

  document.querySelector('.georef-gcp-list-wrap')?.classList.remove('hidden');
  document.querySelector('.georef-image-panel-body')?.classList.remove('georef-manual-active');

  const plural = gcpCount === 1 ? '' : 's';
  setGeorefAutoStatus(
    `✓ Georreferenciação automática concluída. Foram encontrados ${gcpCount} ponto${plural} de controlo. Verifica o posicionamento e clica em "Aplicar alterações".`,
    false,
    'success'
  );

  // a lista de GCPs continua visível, mas sem editar/eliminar (ver
  // renderGeorefGCPList)
  renderGeorefGCPList();

  const applyChangesBtn = ensureGeorefApplyChangesButton();
  if(applyChangesBtn){
    applyChangesBtn.disabled = false;
    applyChangesBtn.classList.remove('hidden');
  }

  positionGeorefOverlays();
}

/* devolve a UI ao estado "por processar" — chamada ao entrar de novo em
   enterGeorefMode e ao fechar o modo, para nunca herdar UI de uma sessão
   automática anterior */
function resetGeorefAutoCompletedUI(){
  const applyChangesBtn = document.getElementById('georef-apply-changes-btn');
  if(applyChangesBtn){
    applyChangesBtn.classList.add('hidden');
    applyChangesBtn.disabled = false;
  }
}

/* Mostra ou esconde a barra superior (Pontos/Cancelar/Aplicar) e a lista
   de GCPs — só visíveis no modo manual (após falha automática) ou, em
   leitura, depois de uma autogeoreferenciação bem sucedida. */
function setGeorefManualUIVisible(visible){
  const topbar = document.getElementById('georef-mode-topbar');
  const gcpWrap = document.querySelector('.georef-gcp-list-wrap');
  const panelBody = document.querySelector('.georef-image-panel-body');
  if(topbar) topbar.classList.toggle('hidden', !visible);
  if(gcpWrap) gcpWrap.classList.toggle('hidden', !visible);
  if(panelBody){
    panelBody.classList.toggle('georef-manual-active', visible && !georefModeState.autoGeorefCompleted);
  }
  if(visible) positionGeorefOverlays();
}

function ensureGeorefManualFallbackButton(){
  let btn = document.getElementById('georef-manual-fallback-btn');
  if(btn) return btn;

  const footer = document.getElementById('georef-image-panel-footer');
  if(!footer) return null;

  btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'georef-manual-fallback-btn';
  btn.className = 'btn georef-manual-fallback-btn hidden';
  btn.textContent = 'Autogeoreferenciação falhou — georeferenciar manualmente?';
  btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    enterManualGeorefMode();
  });
  footer.appendChild(btn);
  return btn;
}

function showGeorefManualFallbackOffer(){
  ensureGeorefManualFallbackButton()?.classList.remove('hidden');
}

function hideGeorefManualFallbackOffer(){
  document.getElementById('georef-manual-fallback-btn')?.classList.add('hidden');
}

function enterManualGeorefMode(){
  if(!georefModeState.active || georefModeState.autoGeorefCompleted) return;
  georefModeState.manualGeorefUnlocked = true;
  hideGeorefManualFallbackOffer();
  setGeorefManualUIVisible(true);
  setGeorefAutoStatus(
    'Marca pares de pontos: clica num sítio na imagem e no mesmo sítio no mapa. São necessários pelo menos 4 pontos.',
    false,
    'idle'
  );
  updateGeorefTopbarState();
  positionGeorefOverlays();
}

function canUseManualGeorefCapture(){
  return georefModeState.manualGeorefUnlocked && !georefModeState.autoGeorefCompleted;
}

/* ============================================================
   FASE 4: captura de GCPs (clicar imagem → clicar mapa, em
   qualquer ordem)
   ------------------------------------------------------------
   Estado de máquina simples: um clique num dos lados sem par em
   espera do outro lado fica "pendente" (marcador tracejado); um
   clique no lado oposto completa o par e entra em gcps[]. Clicar
   de novo no mesmo lado, sem ainda ter completado o par, só
   atualiza a posição pendente (não cria pares acidentalmente).
   ============================================================ */

function updateGeorefTopbarState(){
  const n = georefModeState.gcps.length;
  document.getElementById('georef-topbar-count').textContent =
    n <= 4 ? `Pontos: ${n}/4` : `Pontos: ${n} (mín. 4)`;
  document.getElementById('georef-topbar-apply').disabled = n < 4;
}

/* redesenha do zero os marcadores numerados ①②③ — tanto no mapa
   (Leaflet divIcon) como sobrepostos ao canvas da imagem (badges em
   percentagem, para acompanharem qualquer redimensionamento) */
function renderGeorefGCPMarkers(){
  if(!georefGcpMapGroup) georefGcpMapGroup = L.layerGroup().addTo(map);
  georefGcpMapGroup.clearLayers();
  georefPendingMapMarker = null;

  const wrap = document.getElementById('georef-image-canvas-wrap');
  wrap.querySelectorAll('.georef-gcp-image-marker').forEach(el=> el.remove());

  const entry = georefModeState.entry;
  if(!entry) return;

  georefModeState.gcps.forEach((gcp, i)=>{
    const num = i + 1;

    const icon = L.divIcon({
      className: 'georef-gcp-map-marker',
      html: `<span>${num}</span>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
    L.marker([gcp.map.lat, gcp.map.lng], {icon, interactive:false}).addTo(georefGcpMapGroup);

    const badge = document.createElement('span');
    badge.className = 'georef-gcp-image-marker';
    badge.textContent = num;
    badge.style.left = (gcp.img.x / entry.width * 100) + '%';
    badge.style.top = (gcp.img.y / entry.height * 100) + '%';
    wrap.appendChild(badge);
  });

  renderGeorefPendingMarkers();
}

/* mostra o marcador tracejado do lado que já tem clique, enquanto se
   espera pelo clique do lado oposto para completar o par */
function renderGeorefPendingMarkers(){
  document.querySelectorAll('.georef-gcp-pending-marker').forEach(el=> el.remove());
  if(georefPendingMapMarker && georefGcpMapGroup){
    georefGcpMapGroup.removeLayer(georefPendingMapMarker);
    georefPendingMapMarker = null;
  }

  const entry = georefModeState.entry;
  if(georefModeState.pendingImagePoint && entry){
    const wrap = document.getElementById('georef-image-canvas-wrap');
    const badge = document.createElement('span');
    badge.className = 'georef-gcp-pending-marker';
    badge.style.left = (georefModeState.pendingImagePoint.x / entry.width * 100) + '%';
    badge.style.top = (georefModeState.pendingImagePoint.y / entry.height * 100) + '%';
    wrap.appendChild(badge);
  }

  if(georefModeState.pendingMapPoint && georefGcpMapGroup){
    const icon = L.divIcon({
      className: 'georef-gcp-pending-map-marker',
      html: '',
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
    georefPendingMapMarker = L.marker(
      [georefModeState.pendingMapPoint.lat, georefModeState.pendingMapPoint.lng],
      {icon, interactive:false}
    ).addTo(georefGcpMapGroup);
  }
}

/* painel de GCPs: lista com ✔, coordenadas, erro (vazio até à Fase 5
   calcular a transformação) e botões eliminar/editar */
function renderGeorefGCPList(externalGcps){
  if(Array.isArray(externalGcps)){
    if(!georefModeState.active) return;
    georefModeState.gcps = externalGcps.map(gcp => {
      georefGcpIdCounter++;
      return {
        id: 'gcp-' + georefGcpIdCounter,
        img: { x: gcp.img.x, y: gcp.img.y },
        map: { lng: gcp.map.lng, lat: gcp.map.lat },
        error: null
      };
    });
    georefModeState.pendingImagePoint = null;
    georefModeState.pendingMapPoint = null;
    renderGeorefGCPMarkers();
    updateGeorefTopbarState();
  }

  const list = document.getElementById('georef-gcp-list');
  if(!list) return;

  if(georefModeState.gcps.length === 0){
    list.innerHTML = '<li class="georef-gcp-empty">Ainda sem pontos de controlo.</li>';
    return;
  }

  list.innerHTML = georefModeState.gcps.map((gcp, i)=>{
    const num = i + 1;
    const errorLabel = (gcp.error === null || gcp.error === undefined) ? '—' : gcp.error;
    // modo automático concluído: pontos ficam só de leitura, sem editar/eliminar
    // (ver georefModeState.autoGeorefCompleted / enterAutoGeorefCompletedState)
    const actionsHtml = georefModeState.autoGeorefCompleted ? '' : `
        <button type="button" class="georef-gcp-item-edit" data-gcp-edit="${gcp.id}" title="Voltar a marcar o lado do mapa">✎</button>
        <button type="button" class="georef-gcp-item-remove" data-gcp-remove="${gcp.id}" title="Eliminar este ponto">✕</button>`;
    return `
      <li class="georef-gcp-item" data-gcp-id="${gcp.id}">
        <span class="georef-gcp-item-num">✔ ${num}</span>
        <span class="georef-gcp-item-coords">img (${Math.round(gcp.img.x)}, ${Math.round(gcp.img.y)}) → mapa (${gcp.map.lat.toFixed(5)}, ${gcp.map.lng.toFixed(5)})</span>
        <span class="georef-gcp-item-error">${errorLabel}</span>${actionsHtml}
      </li>`;
  }).join('');

  list.querySelectorAll('[data-gcp-remove]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{ e.stopPropagation(); removeGeorefGCP(btn.dataset.gcpRemove); });
  });
  list.querySelectorAll('[data-gcp-edit]').forEach(btn=>{
    btn.addEventListener('click', (e)=>{ e.stopPropagation(); editGeorefGCP(btn.dataset.gcpEdit); });
  });
}

/* Limpa etiquetas técnicas entre parênteses retos (ex.: "[Satélite]",
   "[timing]") que vêm das mensagens de progresso da deteção, e garante
   maiúscula inicial — o essencial (nºs, tempos, escalas) mantém-se, só o
   "ruído" desaparece. A fonte (DGT/Satélite) passa a aparecer à parte,
   numa legenda própria, em vez de prefixar cada mensagem. */
function formatGeorefStatusMessage(message){
  if(!message) return message;
  const cleaned = message.replace(/\[[^\]]*\]\s*/g, '').trim();
  if(!cleaned) return message;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function setGeorefAutoStatus(message, isError, tone, sourceLabel, skipConsoleMirror){
  const displayMessage = formatGeorefStatusMessage(message);
  const statusEl = document.getElementById('georef-auto-status');
  if(statusEl){
    const textEl = document.getElementById('georef-auto-status-text');
    if(textEl){ textEl.textContent = displayMessage; } else { statusEl.textContent = displayMessage; }
    statusEl.classList.toggle('is-error', !!isError);
    statusEl.dataset.state = tone || (isError ? 'error' : 'neutral');
  }
  if(autoGeorefProgressVisible){
    updateAutoGeorefProgressUI(message, sourceLabel, isError);
    if(!skipConsoleMirror && message){
      appendAutoGeorefConsoleLine('[AutoGeoref] ' + message, isError ? 'error' : 'log');
    }
  }
}

let autoGeorefProgressHideTimer = null;
let autoGeorefProgressVisible = false;
const AUTO_GEOREF_CONSOLE_MAX_LINES = 250;

function clearAutoGeorefConsole(){
  const logEl = document.querySelector('#georef-auto-progress .georef-auto-console-log');
  if(logEl) logEl.innerHTML = '';
}

function appendAutoGeorefConsoleLine(text, level){
  if(!text) return;
  ensureAutoGeorefProgressUI();
  const logEl = document.querySelector('#georef-auto-progress .georef-auto-console-log');
  if(!logEl) return;

  const line = document.createElement('div');
  line.className = 'georef-auto-console-line is-' + (level || 'log');

  const ts = document.createElement('span');
  ts.className = 'georef-auto-console-ts';
  ts.textContent = new Date().toTimeString().slice(0, 8);

  const msg = document.createElement('span');
  msg.className = 'georef-auto-console-msg';
  msg.textContent = text;

  line.appendChild(ts);
  line.appendChild(msg);
  logEl.appendChild(line);

  while(logEl.children.length > AUTO_GEOREF_CONSOLE_MAX_LINES){
    logEl.removeChild(logEl.firstChild);
  }
  logEl.scrollTop = logEl.scrollHeight;
}

/* Espelha na mini consola as mensagens [AutoGeoref] da consola F12 enquanto
   a deteção está activa — evita duplicar linhas que já vêm de setGeorefAutoStatus
   (skipConsoleMirror) mas apanha logs directos (tiles, worker, warm-up, etc.). */
(function setupAutoGeorefConsoleCapture(){
  const CAPTURE_TAGS = ['[AutoGeoref', '[AutoGeoref worker]', '[WORKER]'];
  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  function formatConsoleArgs(args){
    return args.map((a)=>{
      if(a == null) return String(a);
      if(a instanceof Error) return a.stack || a.message;
      if(typeof a === 'object'){
        try{ return JSON.stringify(a); }catch(e){ return String(a); }
      }
      return String(a);
    }).join(' ');
  }

  function shouldCapture(text){
    return CAPTURE_TAGS.some((tag)=> text.indexOf(tag) !== -1);
  }

  function capture(level, args){
    const text = formatConsoleArgs(args);
    if(autoGeorefProgressVisible && shouldCapture(text)){
      appendAutoGeorefConsoleLine(text, level);
    }
    orig[level].apply(console, args);
  }

  console.log = (...args)=> capture('log', args);
  console.warn = (...args)=> capture('warn', args);
  console.error = (...args)=> capture('error', args);
})();

function ensureAutoGeorefProgressUI(){
  if(document.getElementById('georef-auto-progress')) return;

  const root = document.createElement('div');
  root.id = 'georef-auto-progress';
  root.className = 'hidden';
  root.innerHTML = `
    <div class="georef-auto-console-header">
      <div class="georef-auto-console-head">
        <span class="georef-auto-console-title">Autogeorreferência</span>
        <span class="georef-auto-console-pill">A processar</span>
      </div>
      <div class="georef-auto-console-source"></div>
    </div>
    <div class="georef-auto-console-log" role="log" aria-live="polite"></div>
  `;
  document.body.appendChild(root);
}

function setAutoGeorefProgressUI({ active = true, text = 'A preparar…', tone = 'working', pill = 'A processar', sourceLabel = '' } = {}){
  ensureAutoGeorefProgressUI();
  const root = document.getElementById('georef-auto-progress');
  const pillEl = root?.querySelector('.georef-auto-console-pill');
  const sourceEl = root?.querySelector('.georef-auto-console-source');
  if(!root) return;

  if(autoGeorefProgressHideTimer){
    clearTimeout(autoGeorefProgressHideTimer);
    autoGeorefProgressHideTimer = null;
  }

  root.classList.toggle('hidden', !active);
  root.classList.toggle('is-success', tone === 'success');
  root.classList.toggle('is-error', tone === 'error');
  root.classList.toggle('is-working', tone === 'working');

  if(pillEl) pillEl.textContent = pill;
  if(sourceEl) sourceEl.textContent = sourceLabel ? `Fonte: ${sourceLabel}` : '';

  autoGeorefProgressVisible = active;

  if(active && tone !== 'working'){
    autoGeorefProgressHideTimer = setTimeout(()=>{
      root.classList.add('hidden');
      autoGeorefProgressVisible = false;
      autoGeorefProgressHideTimer = null;
    }, 3200);
  }
}

function showAutoGeorefProgressUI({ text = 'A preparar…', pill = 'A processar', tone = 'working', sourceLabel = '' } = {}){
  setAutoGeorefProgressUI({ active: true, text, tone, pill, sourceLabel });
  if(text) appendAutoGeorefConsoleLine('[AutoGeoref] ' + text, 'info');
}

function updateAutoGeorefProgressUI(text, sourceLabel){
  if(!autoGeorefProgressVisible) return;
  const root = document.getElementById('georef-auto-progress');
  const sourceEl = root?.querySelector('.georef-auto-console-source');
  if(sourceEl && sourceLabel) sourceEl.textContent = `Fonte: ${sourceLabel}`;
}

function hideAutoGeorefProgressUI({ text = 'Pronto', tone = 'success', pill = 'Concluído', sourceLabel = '' } = {}){
  if(!autoGeorefProgressVisible) return;
  if(text){
    appendAutoGeorefConsoleLine('[AutoGeoref] ' + text, tone === 'error' ? 'error' : 'log');
  }
  if(tone === 'working'){
    setAutoGeorefProgressUI({ active: false, text, tone, pill, sourceLabel });
  } else {
    setAutoGeorefProgressUI({ active: true, text, tone, pill, sourceLabel });
  }
}

/* esconde imediatamente o popup flutuante "A processar/Concluído/Erro",
   sem a transição normal de 1.6s nem depender do estado (tone) atual —
   usada só ao fechar/cancelar o modo de georreferenciação por completo
   (ver closeGeorefModeUI), para nunca o deixar "órfão" no ecrã. */
function forceHideAutoGeorefProgressUI(){
  if(autoGeorefProgressHideTimer){
    clearTimeout(autoGeorefProgressHideTimer);
    autoGeorefProgressHideTimer = null;
  }
  const root = document.getElementById('georef-auto-progress');
  if(root) root.classList.add('hidden');
  autoGeorefProgressVisible = false;
}

function tileYToLat(y, z){
  const n = Math.pow(2, z);
  const rad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
  return rad * 180 / Math.PI;
}

function tileBoundsLatLng(z, x, y){
  const n = Math.pow(2, z);
  return {
    west: x / n * 360 - 180,
    east: (x + 1) / n * 360 - 180,
    north: tileYToLat(y, z),
    south: tileYToLat(y + 1, z)
  };
}

async function loadImageElementFromBlobUrl(url){
  try{
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Não foi possível carregar a imagem de referência.'));
      img.src = url;
    });
  }catch(err){
    console.error('[Image] load failed:', err);
    throw err;
  }
}

async function proxyFetchResource(originalUrl){
  try{
    if(typeof TEAM_API_BASE === 'undefined' || !TEAM_API_BASE){
      throw new Error('Proxy do worker não está configurado.');
    }
    const proxyUrl = `${TEAM_API_BASE}/api/download?url=${encodeURIComponent(originalUrl)}`;
    const response = await fetch(proxyUrl);
    if(!response.ok){
      throw new Error(`Proxy falhou ao obter o recurso: HTTP ${response.status}`);
    }
    return response;
  }catch(err){
    console.error('[Proxy] fetch failed:', err);
    throw err;
  }
}

/* Proxy dedicado a tiles WMS da DGT (rota /api/dgt-tile no worker de equipa —
   ver worker.js). Ao contrário de proxyFetchResource (que só serve GitHub
   Releases, por segurança), esta rota está preparada especificamente para
   pedidos GetMap ao serviço de ortofotos da DGT, e é o caminho fiável: não
   depende de o servidor da DGT enviar CORS (não envia) nem de proxies
   públicos de terceiros (allorigins.win/corsproxy.io/thingproxy.freeboard.io
   mostraram-se todos indisponíveis na prática — ver histórico da consola). */
async function proxyFetchDgtTile(originalUrl){
  try{
    if(typeof TEAM_API_BASE === 'undefined' || !TEAM_API_BASE){
      throw new Error('Proxy do worker não está configurado.');
    }
    const proxyUrl = `${TEAM_API_BASE}/api/dgt-tile?url=${encodeURIComponent(originalUrl)}`;
    const response = await fetch(proxyUrl);
    if(!response.ok){
      const detail = await response.text().catch(()=> null);
      throw new Error(`Proxy DGT falhou: HTTP ${response.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
    }
    return response;
  }catch(err){
    console.error('[DGT] tile fetch failed:', err);
    throw err;
  }
}

async function fetchDirectResource(url){
  try{
    const response = await fetch(url);
    if(!response.ok){
      throw new Error(`Fetch directo falhou: HTTP ${response.status}`);
    }
    return response;
  }catch(err){
    console.error('[Fetch] direct failed:', err);
    throw err;
  }
}

function parseWmsTileBoundsFromUrl(urlString){
  try{
    const url = new URL(urlString, window.location.origin);
    const params = new URLSearchParams(url.search);
    if(!params.has('bbox')) return null;
    const parts = params.get('bbox').split(',').map(Number);
    if(parts.length !== 4 || parts.some(p => !Number.isFinite(p))) return null;
    return { west: parts[0], south: parts[1], east: parts[2], north: parts[3] };
  }catch(err){
    return null;
  }
}

/* Converte coordenadas EPSG:3857 (Web Mercator metros) em WGS84 (lat/lng graus).
   Usado para transformar o bbox do WMS da DGT (que usa EPSG:3857) em lat/lng
   antes de passar ao worker de autogeoreferenciação. */
const EPSG3857_MAX = 20037508.342789244;
function epsg3857ToLatLng(x, y){
  const lng = (x / EPSG3857_MAX) * 180;
  const latRad = Math.atan(Math.exp((y / EPSG3857_MAX) * Math.PI));
  const lat = (latRad * 180) / Math.PI;
  return [lng, lat];
}

/* Tamanho do mosaico de referência: um único tile 256×256 dava muito poucos
   keypoints FAST/BRIEF em cenas difíceis (fontes/sensores diferentes) — ver
   notas de autogeoref. Em vez disso busca-se uma grelha
   GEOREF_MOSAIC_GRID_TILES × GEOREF_MOSAIC_GRID_TILES de tiles em torno do
   tile central (3×3 → 768×768px), com muito mais contexto/keypoints. */
const GEOREF_MOSAIC_GRID_TILES = 3; // ímpar, para haver um tile central bem definido
const GEOREF_MOSAIC_HALF = Math.floor(GEOREF_MOSAIC_GRID_TILES / 2);
const GEOREF_MOSAIC_PX = GEOREF_MOSAIC_GRID_TILES * 256;

/* bbox (EPSG:3857, metros) da grelha de tiles à volta de (xCenter,yCenter) —
   usado para pedir ao WMS da DGT o mosaico inteiro num único GetMap (o WMS
   aceita bbox/width/height arbitrários, ao contrário do serviço de tiles
   XYZ do Satélite, que só serve um tile 256×256 de cada vez). */
function tileGridBBox3857(z, xCenter, yCenter, half){
  const [minX] = tile3857BBox(z, xCenter - half, yCenter);
  const [, , maxX] = tile3857BBox(z, xCenter + half, yCenter);
  const [, minY] = tile3857BBox(z, xCenter, yCenter + half);
  const [, , , maxY] = tile3857BBox(z, xCenter, yCenter - half);
  return [minX, minY, maxX, maxY];
}

/* bounds em lat/lng da mesma grelha — usado para o mosaico Satélite, feito
   de tiles XYZ individuais "costurados" num canvas. */
function tileGridBoundsLatLng(z, xCenter, yCenter, half){
  const westTile = tileBoundsLatLng(z, xCenter - half, yCenter);
  const eastTile = tileBoundsLatLng(z, xCenter + half, yCenter);
  const northTile = tileBoundsLatLng(z, xCenter, yCenter - half);
  const southTile = tileBoundsLatLng(z, xCenter, yCenter + half);
  return { west: westTile.west, east: eastTile.east, north: northTile.north, south: southTile.south };
}

function buildWmsMosaicUrl(info, z, xCenter, yCenter, half){
  const [minX, minY, maxX, maxY] = tileGridBBox3857(z, xCenter, yCenter, half);
  const px = (half * 2 + 1) * 256;
  const params = new URLSearchParams({
    service: 'WMS', version: '1.3.0', request: 'GetMap',
    layers: info.wmsLayer, styles: '', format: 'image/jpeg', transparent: 'false',
    width: String(px), height: String(px), crs: 'EPSG:3857',
    bbox: `${minX},${minY},${maxX},${maxY}`
  });
  return `${info.base}?${params.toString()}`;
}

function applyAutoGeorefGcps(gcps){
  if(!georefModeState.active || !georefModeState.entry) return;
  georefModeState.gcps = gcps.map(gcp => {
    georefGcpIdCounter++;
    return {
      id: 'gcp-' + georefGcpIdCounter,
      img: { x: gcp.img.x, y: gcp.img.y },
      map: { lng: gcp.map.lng, lat: gcp.map.lat },
      error: null
    };
  });
  georefModeState.pendingImagePoint = null;
  georefModeState.pendingMapPoint = null;
  renderGeorefGCPMarkers();
  renderGeorefGCPList();
  updateGeorefTopbarState();
}

function isGeorefAutoZoomReady(){
  if(typeof map === 'undefined' || !map) return false;
  const zoom = map.getZoom();
  return Number.isFinite(zoom) && zoom >= GEOREF_AUTO_MIN_ZOOM && zoom <= GEOREF_AUTO_MAX_ZOOM;
}

function enableGeorefAutoButtonIfZoomReady(){
  const btn = document.getElementById('georef-auto-detect-btn');
  if(!btn) return;
  const ready = isGeorefAutoZoomReady();
  btn.disabled = !ready;
  btn.setAttribute('aria-disabled', ready ? 'false' : 'true');
  if(ready){
    btn.classList.remove('is-disabled');
    btn.title = 'Clicar para autogeorreferenciar quando o zoom estiver entre 17 e 20.';
  } else {
    btn.classList.add('is-disabled');
    btn.title = 'Aproxima o mapa até ao zoom 17–20 para ativar a autogeorreferenciar.';
  }
}

function setGeorefAutoDetectButtonState(isBusy){
  const btn = document.getElementById('georef-auto-detect-btn');
  if(!btn) return;
  const labelEl = btn.querySelector('.georef-auto-btn-label');
  if(isBusy){
    if(labelEl && !btn.dataset.origText){
      btn.dataset.origText = labelEl.textContent;
      labelEl.textContent = 'A processar…';
    }
    btn.classList.add('is-busy');
    const statusEl = document.getElementById('georef-auto-status');
    if(statusEl && statusEl.dataset.state !== 'error'){ statusEl.dataset.state = 'working'; }
  } else {
    if(labelEl && btn.dataset.origText){
      labelEl.textContent = btn.dataset.origText;
      delete btn.dataset.origText;
    }
    btn.classList.remove('is-busy');
  }
}

function warnIfInvalidAutoGeorefZoom(){
  if(isGeorefAutoZoomReady()) return false;
  const zoom = typeof map !== 'undefined' && map ? map.getZoom() : null;
  if(zoom === null || !Number.isFinite(zoom)){
    setGeorefAutoStatus('Zoom inválido para autogeorreferenciar.', true);
  } else if(zoom < GEOREF_AUTO_MIN_ZOOM){
    setGeorefAutoStatus(`Zoom demasiado reduzido (${zoom}). Aproxima até 17-20 para autogeoreferenciar.`, true);
  } else {
    setGeorefAutoStatus(`Zoom demasiado elevado (${zoom}). Ajusta para entre 17-20 para autogeoreferenciar.`, true);
  }
  return true;
}

/* NOTA (bug corrigido): esta função costumava reaproveitar o <img> do tile DGT
   já visível no mapa quando disponível, como atalho para evitar um pedido de
   rede extra. Só que esse <img> é carregado pelo Leaflet diretamente do
   cartografia.dgterritorio.gov.pt, sem `crossOrigin`, e esse servidor não
   envia cabeçalhos CORS — por isso o pixel content fica "non-origin-clean".
   Um ImageBitmap criado a partir dele até se cria sem erro, mas o browser
   recusa-se a TRANSFERI-LO para o worker ("Failed to execute 'postMessage'
   on 'Worker': Non-origin-clean ImageBitmap cannot be transferred"), o que
   fazia a autogeoreferenciação falhar sempre que havia um tile visível (ou
   seja, quase sempre). A partir de agora usa-se sempre o caminho por fetch +
   blob + URL de objeto abaixo, que é sempre "limpo" independentemente de o
   servidor de origem suportar CORS ou não. */
async function fetchDgtReferenceTile(z, x, y){
  // Pede a grelha inteira (GEOREF_MOSAIC_GRID_TILES × mesmo, ex. 3×3 →
  // 768×768px) num único GetMap, em vez de um tile 256×256 isolado — ver
  // GEOREF_MOSAIC_GRID_TILES acima.
  const url = buildWmsMosaicUrl({ base: 'https://cartografia.dgterritorio.gov.pt/wms/ortos2021', wmsLayer: 'Ortos2021-RGB' }, z, x, y, GEOREF_MOSAIC_HALF);
  let response;

  try{
    response = await proxyFetchDgtTile(url);
  }catch(dgtProxyErr){
    console.warn('Proxy DGT do worker falhou, a tentar fetch directo:', dgtProxyErr);
    try{
      response = await fetchDirectResource(url);
    }catch(directErr){
      // já não se tenta allorigins.win/corsproxy.io/thingproxy.freeboard.io:
      // mostraram-se todos indisponíveis na prática (ver histórico da consola
      // desta app) e só atrasavam a mensagem de erro final sem ajudar.
      throw new Error(
        `Proxy DGT: ${dgtProxyErr.message} | Fetch directo: ${directErr.message}`
      );
    }
  }

  const contentType = response.headers.get('Content-Type') || '';
  if(contentType && !contentType.startsWith('image/')){
    const text = await response.text().catch(()=>null);
    throw new Error(`A resposta não é uma imagem. Content-Type=${contentType} ${text ? `Resposta: ${text.slice(0, 200)}` : ''}`);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try{
    const img = await loadImageElementFromBlobUrl(objectUrl);
    const bounds3857 = parseWmsTileBoundsFromUrl(url);
    let bounds = null;
    if(bounds3857){
      const [wLng, wLat] = epsg3857ToLatLng(bounds3857.west, bounds3857.south);
      const [eLng, eLat] = epsg3857ToLatLng(bounds3857.east, bounds3857.north);
      bounds = { west: wLng, south: wLat, east: eLng, north: eLat };
    }
    return { img, objectUrl, bounds };
  }catch(err){
    URL.revokeObjectURL(objectUrl);
    throw err;
  }
}

async function fetchSatelliteReferenceTile(z, x, y){
  // Ao contrário do WMS da DGT, o serviço de tiles XYZ do Esri só serve um
  // tile 256×256 de cada vez — por isso aqui busca-se a grelha
  // GEOREF_MOSAIC_GRID_TILES × mesmo em paralelo e "cose-se" tudo num único
  // canvas (mesma ideia/tamanho do mosaico DGT, ver GEOREF_MOSAIC_GRID_TILES).
  const half = GEOREF_MOSAIC_HALF;
  const gridTiles = half * 2 + 1;
  const px = gridTiles * 256;

  const cells = [];
  for(let dy = -half; dy <= half; dy++){
    for(let dx = -half; dx <= half; dx++){
      cells.push({ dx, dy, tx: x + dx, ty: y + dy });
    }
  }

  async function fetchSingleSatelliteTile(tx, ty){
    const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${ty}/${tx}`;
    let response;
    try{
      response = await fetchDirectResource(url);
    }catch(directErr){
      response = await proxyFetchResource(url);
    }
    const contentType = response.headers.get('Content-Type') || '';
    if(contentType && !contentType.startsWith('image/')){
      throw new Error(`A resposta não é uma imagem (Content-Type=${contentType}).`);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try{
      const img = await loadImageElementFromBlobUrl(objectUrl);
      return { img, objectUrl };
    }catch(err){
      URL.revokeObjectURL(objectUrl);
      throw err;
    }
  }

  const results = await Promise.allSettled(cells.map(c => fetchSingleSatelliteTile(c.tx, c.ty)));

  // O tile central (dx=0,dy=0) é o único indispensável — é a zona-alvo que
  // se está mesmo a tentar georreferenciar. Os tiles à volta só enriquecem
  // o contexto/keypoints do mosaico: se algum destes falhar, fica em branco
  // em vez de abortar a deteção toda.
  const centerIdx = cells.findIndex(c => c.dx === 0 && c.dy === 0);
  if(results[centerIdx].status === 'rejected'){
    throw results[centerIdx].reason || new Error('Falha ao carregar o tile Satélite central.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext('2d');

  let loadedCount = 0;
  results.forEach((res, i) => {
    if(res.status !== 'fulfilled'){
      console.warn('[AutoGeoref] Mosaico Satélite: tile', cells[i].tx, cells[i].ty, 'falhou, fica em branco:', res.reason);
      return;
    }
    const { dx, dy } = cells[i];
    ctx.drawImage(res.value.img, (dx + half) * 256, (dy + half) * 256, 256, 256);
    URL.revokeObjectURL(res.value.objectUrl);
    loadedCount++;
  });

  console.log(`[AutoGeoref] Mosaico Satélite: ${loadedCount}/${cells.length} tiles carregados (${px}×${px}px).`);

  return { img: canvas, objectUrl: null, bounds: tileGridBoundsLatLng(z, x, y, half) };
}

/* Fontes de referência tentadas por ordem, para runAutoGeorefDetection.
   DGT primeiro (mais preciso quando aplicável — ortofoto oficial PT), com
   fallback automático para Satélite (Esri World Imagery) quando o DGT falha
   a carregar OU quando carrega mas a deteção não produz um resultado
   fiável (ex.: imagem de origem tipo Google Maps/satélite, que combina mal
   com o ortofoto DGT). Os dois casos são tratados da mesma forma. */
const AUTO_GEOREF_SOURCES = [
  { key: 'dgt', label: 'DGT', fetchTile: fetchDgtReferenceTile },
  { key: 'satelite', label: 'Satélite', fetchTile: fetchSatelliteReferenceTile }
];

/* Deslocamentos de zoom tentados para o mosaico de referência, por ordem
   (0 primeiro = zoom atual do mapa, sem alteração de comportamento para o
   caso comum). Cada -2 corresponde a ~4× mais área coberta por pixel — ver
   runAutoGeorefDetection. Motivo: FAST/BRIEF só são estáveis dentro de
   ±30-40% de diferença de escala entre imagem e referência (olham para uma
   vizinhança de pixels de tamanho fixo); se a imagem a georreferenciar
   cobrir uma área bem maior do que o mosaico ao zoom atual (ex.: print tirado
   com o mapa mais afastado), NENHUMA quantidade de features resolve isso —
   é preciso a própria referência ir buscar uma área maior (zoom mais baixo). */
const GEOREF_AUTO_ZOOM_OFFSETS = [0, -2, -4];
const GEOREF_TILE_MIN_Z = 12; // nunca descer abaixo disto — deixa de fazer sentido para uma zona local

async function runAutoGeorefDetection(){
  if(!georefModeState.active || !georefModeState.entry){
    showAppAlert('Ativa o modo de georreferenciação antes de usar a autogeorreferenciar.');
    return;
  }
  if(warnIfInvalidAutoGeorefZoom()){
    return;
  }

  // Entra já em "Modo Automático": bloqueia a lógica manual de adicionar
  // pontos (clique na imagem/mapa) assim que se clica em "Autogeoreferenciar",
  // e não só depois de a deteção terminar — evita pontos manuais a serem
  // criados em paralelo com a deteção. Só volta a false se todas as fontes
  // falharem (ver bloco de falha final desta função).
  georefModeState.autoGeorefCompleted = true;
  georefModeState.manualGeorefUnlocked = false;
  hideGeorefManualFallbackOffer();
  setGeorefManualUIVisible(false);
  georefModeState.gcps = [];
  georefModeState.pendingImagePoint = null;
  georefModeState.pendingMapPoint = null;
  renderGeorefGCPMarkers();
  renderGeorefGCPList();

  const btn = document.getElementById('georef-auto-detect-btn');
  if(btn){
    btn.disabled = true;
    setGeorefAutoDetectButtonState(true);
  }

  const imgEl = document.getElementById('georef-image-el');
  if(!imgEl || !imgEl.naturalWidth){
    setGeorefAutoStatus('A imagem ainda não está pronta para deteção.', true);
    georefModeState.autoGeorefCompleted = false;
    if(btn){
      btn.disabled = false;
      setGeorefAutoDetectButtonState(false);
    }
    return;
  }

  clearAutoGeorefConsole();
  showAutoGeorefProgressUI({ text: 'A iniciar autogeorreferenciação…', pill: 'A processar', tone: 'working' });

  const baseZ = Math.max(17, Math.min(map.getZoom(), 20));
  const center = map.getCenter();
  const refTileSize = { width: GEOREF_MOSAIC_PX, height: GEOREF_MOSAIC_PX }; // ex. 768×768 (3×3 tiles) — ver GEOREF_MOSAIC_GRID_TILES

  let winningResult = null;
  let winningSourceLabel = null;
  let lastFailureMessage = null;
  const triedZ = new Set(); // evita repetir o mesmo z quando o clamp a GEOREF_TILE_MIN_Z já foi atingido por um deslocamento anterior

  zoomLoop:
  for(let zi = 0; zi < GEOREF_AUTO_ZOOM_OFFSETS.length; zi++){
    const zOffset = GEOREF_AUTO_ZOOM_OFFSETS[zi];
    const z = Math.max(GEOREF_TILE_MIN_Z, baseZ + zOffset);
    if(triedZ.has(z)) continue; // já tentado (ex.: baseZ já estava perto do mínimo)
    triedZ.add(z);
    const tile = lonLatToTile(center.lng, center.lat, z);
    const zoomNote = zOffset === 0 ? '' : ` (referência mais afastada — zoom ${z}, ~${Math.round(Math.pow(2, -Math.min(0, zOffset)))}× mais área/pixel)`;

    for(let i = 0; i < AUTO_GEOREF_SOURCES.length; i++){
      const source = AUTO_GEOREF_SOURCES[i];
      const isLastAttempt = (zi === GEOREF_AUTO_ZOOM_OFFSETS.length - 1) && (i === AUTO_GEOREF_SOURCES.length - 1);
      const nextLabel = !isLastAttempt
        ? (i + 1 < AUTO_GEOREF_SOURCES.length ? AUTO_GEOREF_SOURCES[i + 1].label : 'zoom mais afastado')
        : null;
      let tileRef;

      showAutoGeorefProgressUI({ text: `A preparar o tile de referência ${source.label}${zoomNote}…`, pill: 'A processar', tone: 'working', sourceLabel: source.label });
      try{
        tileRef = await source.fetchTile(z, tile.x, tile.y);
      }catch(err){
        console.error(err);
        lastFailureMessage = `Falha ao carregar o tile ${source.label}${zoomNote}: ${err.message}`;
        setGeorefAutoStatus(lastFailureMessage + (nextLabel ? ` — a tentar com ${nextLabel}…` : ''), true);
        continue;
      }

      setGeorefAutoStatus(`A comparar a imagem com o mapa (${source.label}${zoomNote})… isto pode demorar alguns segundos.`, false, 'working', source.label);
      try{
        const result = await AutoGeoref.autoGeoref(imgEl, tileRef.img, tileRef.bounds, refTileSize, {
          detect: { scales: [1, 0.75, 0.5, 1.25] },
          ransac: { iterations: 500, inlierThresholdPx: 8 }
        }, (text)=> setGeorefAutoStatus(text, false, 'working', source.label, true));

        if(result.success && Array.isArray(result.gcps) && result.gcps.length >= 4){
          winningResult = result;
          winningSourceLabel = zOffset === 0 ? source.label : `${source.label}${zoomNote}`;
          break zoomLoop;
        }

        lastFailureMessage = !result.success
          ? `Deteção com ${source.label}${zoomNote} falhou: ${result.reason || 'resultado inválido'}`
          : `Deteção com ${source.label}${zoomNote} produziu menos de 4 pontos de controlo.`;
        setGeorefAutoStatus(lastFailureMessage + (nextLabel ? ` — a tentar com ${nextLabel}…` : ''), true);
      }catch(err){
        console.error(err);
        lastFailureMessage = `Erro durante a deteção com ${source.label}${zoomNote}: ${err.message || err}`;
        setGeorefAutoStatus(lastFailureMessage + (nextLabel ? ` — a tentar com ${nextLabel}…` : ''), true);
      }finally{
        if(tileRef && tileRef.objectUrl) URL.revokeObjectURL(tileRef.objectUrl);
      }
    }
  }

  if(!winningResult){
    // Falha em todas as fontes: nada foi mostrado/escondido ainda (isso só
    // acontece no sucesso), por isso basta devolver o modo à disponibilidade
    // manual normal.
    georefModeState.autoGeorefCompleted = false;
    setGeorefAutoStatus(lastFailureMessage || 'Deteção automática falhou em todas as fontes de referência (DGT e Satélite) e zooms tentados.', true);
    hideAutoGeorefProgressUI({ text: 'Falha na deteção', tone: 'error', pill: 'Erro' });
    showGeorefManualFallbackOffer();
    if(btn){
      btn.disabled = false;
      setGeorefAutoDetectButtonState(false);
    }
    return;
  }

  if(!georefModeState.active){
    // o utilizador cancelou o modo (ou fechou-o de outra forma) enquanto a
    // deteção decorria em segundo plano — não há painel/topbar para mostrar
    // resultados, por isso só se limpa a UI de progresso, sem mexer em mais nada
  forceHideAutoGeorefProgressUI();
  hideGeorefStatsCard();
    return;
  }

  applyAutoGeorefGcps(winningResult.gcps);
  enterAutoGeorefCompletedState(winningResult.gcps.length, winningSourceLabel);
  hideAutoGeorefProgressUI({ text: 'Deteção concluída', tone: 'success', pill: 'Concluído', sourceLabel: winningSourceLabel });
  renderGeorefStatsCard(computeGeorefPrecisionStats(winningResult.gcps, winningResult.quality));
  if(btn){
    btn.disabled = false;
    setGeorefAutoDetectButtonState(false);
  }
}

function addGeorefGCP(imgPt, mapPt){
  if(!canUseManualGeorefCapture()) return;
  georefGcpIdCounter++;
  const id = 'gcp-' + georefGcpIdCounter;
  georefModeState.gcps.push({
    id,
    img: {x: imgPt.x, y: imgPt.y},
    map: {lng: mapPt.lng, lat: mapPt.lat},
    error: null
  });
  renderGeorefGCPMarkers();
  renderGeorefGCPList();
  updateGeorefTopbarState();
  if(georefModeState.gcps.length >= 3) renderGeorefStatsCard(computeGeorefPrecisionStats(georefModeState.gcps));
}

function removeGeorefGCP(id){
  if(!canUseManualGeorefCapture()) return;
  const idx = georefModeState.gcps.findIndex(g=> g.id === id);
  if(idx === -1) return;
  georefModeState.gcps.splice(idx, 1);
  renderGeorefGCPMarkers();
  renderGeorefGCPList();
  updateGeorefTopbarState();
  if(georefModeState.gcps.length >= 3) renderGeorefStatsCard(computeGeorefPrecisionStats(georefModeState.gcps));
  else hideGeorefStatsCard();
}

/* "editar" reabre o ponto para correção: retira-o de gcps, mantém o
   lado da imagem como pendente e deixa o lado do mapa livre para ser
   marcado de novo (se quiser mudar também o lado da imagem, basta
   clicar de novo na imagem antes de clicar no mapa) */
function editGeorefGCP(id){
  if(!canUseManualGeorefCapture()) return;
  const idx = georefModeState.gcps.findIndex(g=> g.id === id);
  if(idx === -1) return;
  const [gcp] = georefModeState.gcps.splice(idx, 1);
  georefModeState.pendingImagePoint = {x: gcp.img.x, y: gcp.img.y};
  georefModeState.pendingMapPoint = null;
  renderGeorefGCPMarkers();
  renderGeorefGCPList();
  updateGeorefTopbarState();
}

function registerGeorefImagePoint(imgPt){
  if(!canUseManualGeorefCapture()) return;
  if(georefModeState.pendingMapPoint){
    const mapPt = georefModeState.pendingMapPoint;
    georefModeState.pendingMapPoint = null;
    addGeorefGCP(imgPt, mapPt);
  } else {
    georefModeState.pendingImagePoint = imgPt;
    renderGeorefPendingMarkers();
  }
}

function registerGeorefMapPoint(mapPt){
  if(!canUseManualGeorefCapture()) return;
  if(georefModeState.pendingImagePoint){
    const imgPt = georefModeState.pendingImagePoint;
    georefModeState.pendingImagePoint = null;
    addGeorefGCP(imgPt, mapPt);
  } else {
    georefModeState.pendingMapPoint = mapPt;
    renderGeorefPendingMarkers();
  }
}

/* clique na imagem: converte a posição do clique em pixels reais da
   imagem original, a partir da fração dentro do elemento renderizado
   (a imagem nunca tem letterboxing, por isso fração de ecrã = fração
   da imagem original) */
document.getElementById('georef-image-canvas-wrap')?.addEventListener('click', (e)=>{
  if(!georefModeState.active || !georefModeState.entry) return;
  if(!canUseManualGeorefCapture()) return;
  const imgEl = document.getElementById('georef-image-el');
  const rect = imgEl.getBoundingClientRect();
  if(rect.width === 0 || rect.height === 0) return;
  const fx = (e.clientX - rect.left) / rect.width;
  const fy = (e.clientY - rect.top) / rect.height;
  if(fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
  const entry = georefModeState.entry;
  registerGeorefImagePoint({x: fx * entry.width, y: fy * entry.height});
});

/* clique no mapa: registado uma única vez, guardado por trás do flag
   georefModeState.active (mesmo padrão usado no desenho offline/régua) */
function setupGeorefMapEvents(){
  map.on('click', (e)=>{
    if(!georefModeState.active) return;
    if(!canUseManualGeorefCapture()) return;
    registerGeorefMapPoint({lng: e.latlng.lng, lat: e.latlng.lat});
  });
}

async function processImportedFiles(files){
  try{
    if(!files.length) return;

    const {images, worldFiles, rest} = splitImportFileGroups(files);

    if(images.length > 0){
      try{
        await importRasterFiles(images, worldFiles);
      }catch(err){
        console.error('Erro ao importar imagem(ns):', err);
        showAppAlert('Não foi possível importar uma ou mais imagens. Verifica se os ficheiros não estão corrompidos.', {error: true});
      }
    }

    // se, além das imagens, também vierem ficheiros vetoriais (GeoJSON/Shapefile)
    // na mesma seleção, estes continuam pelo caminho habitual abaixo
    if(rest.length === 0) return;
    files = rest;

    try{
      const hasLooseShp = files.some(f => /\.shp$/i.test(f.name));

      if(hasLooseShp){
        const collections = await parseLooseShapefileParts(files);
        let totalImported = 0, totalSkipped = 0, totalMismatch = 0;
        for(const gj of collections){
          const res = await importFeaturesInChunks(gj, gj.layerName || 'Camada importada');
          totalImported += res.imported; totalSkipped += res.skipped; totalMismatch += res.typeMismatch;
        }
        const parts = [];
        if(totalImported > 0) parts.push(`Importadas ${totalImported} geometria(s) com sucesso.`);
        if(totalSkipped > 0) parts.push(`${totalSkipped} geometria(s) ignorada(s).`);
        if(totalMismatch > 0) parts.push(`${totalMismatch} geometria(s) não corresponderam à camada de destino.`);
        showAppAlert(parts.length ? parts.join(' ') : 'Nenhuma geometria válida encontrada nos ficheiros .shp selecionados.');
        markProjectDirty();
        return;
      }

      const file = files[0];

      // ficheiros grandes (ex.: .zip de shapefile com dezenas/centenas de MB): o parsing
      // e a construção de milhares de geometrias no browser consomem muita memória, por
      // isso avisa-se e dá-se a opção de cancelar antes de tentar, em vez de deixar o
      // separador simplesmente crashar sem explicação.
      const sizeMB = file.size / (1024*1024);
      if(sizeMB > 80){
        const proceed = confirm(
          `O ficheiro "${file.name}" tem cerca de ${sizeMB.toFixed(0)} MB.\n` +
          `Ficheiros deste tamanho podem demorar bastante e, em computadores com pouca ` +
          `memória, podem fazer o separador do browser crashar.\n\nQueres continuar mesmo assim?`
        );
        if(!proceed) return;
      }

      const geojson = await parseImportedFile(file);
      if(!geojson) return;
      const layerName = geojson.layerName || getImportedLayerName(file.name);
      const res = await importFeaturesInChunks(geojson, layerName);
      const parts = [];
      if(res.imported > 0) parts.push(`Importadas ${res.imported} geometria(s) com sucesso.`);
      if(res.skipped > 0) parts.push(`${res.skipped} geometria(s) inválida(s) ou ilegível(is) foram ignoradas.`);
      if(res.typeMismatch > 0) parts.push(`${res.typeMismatch} geometria(s) foram ignoradas por não corresponderem ao tipo configurado da camada de destino.`);
      showAppAlert(parts.length ? parts.join(' ') : 'Nenhuma geometria válida encontrada no ficheiro.');
      markProjectDirty();
    }catch(err){
      console.error('Erro ao importar ficheiro:', err);
      showAppAlert('Não foi possível importar o ficheiro. Verifica se é um GeoJSON válido, um .zip de Shapefile (.shp + .dbf + .shx, opcionalmente .prj), ou ficheiros .shp/.dbf/.shx soltos.', {error: true});
    }
  }catch(err){
    console.error('[Import] file processing error:', err);
    showAppAlert('Erro ao processar ficheiros: ' + err.message, {error:true});
  }
}

document.getElementById('import-file-input').addEventListener('change', async (e)=>{
  try{
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await processImportedFiles(files);
  }catch(err){
    console.error('[import-file-input]', err);
    showAppAlert('Erro ao importar ficheiros.', {error: true});
  }
});

/* --- Expoe no window para05-app-main.js e outros modulos --- */
window.rasterLayers = rasterLayers;
window.splitImportFileGroups = splitImportFileGroups;
window.fileToDataUrl = fileToDataUrl;
window.importRasterFiles = importRasterFiles;
window.serializeRasterLayersForProject = serializeRasterLayersForProject;
window.clearRasterLayerState = clearRasterLayerState;
window.restoreRasterLayersFromProject = restoreRasterLayersFromProject;
window.renderRasterLayersPanel = renderRasterLayersPanel;
window.placeRasterOverlay = placeRasterOverlay;
window.focusRasterLayer = focusRasterLayer;
window.removeRasterLayer = removeRasterLayer;
window.addRasterEntry = addRasterEntry;
window.worldFileExtensionFor = worldFileExtensionFor;
window.buildWorldFileText = buildWorldFileText;
window.downloadBlob = downloadBlob;
window.exportRasterWorldFile = exportRasterWorldFile;
window.loadRasterImageElement = loadRasterImageElement;
window.getRasterPixelData = getRasterPixelData;
window.geotiffHasGeoTags = geotiffHasGeoTags;
window.fileBaseName = fileBaseName;
window.parseWorldFileText = parseWorldFileText;
window.genRasterId = genRasterId;
window.updateGeorefHeaderButton = updateGeorefHeaderButton;
window.cancelGeorefMode = cancelGeorefMode;
window.beginGeoreferencingMode = beginGeoreferencingMode;
window.pendingRasterEntries = pendingRasterEntries;
window.georefModeState = georefModeState;
window.setupGeorefMapEvents = setupGeorefMapEvents;
window.enableGeorefAutoButtonIfZoomReady = enableGeorefAutoButtonIfZoomReady;

})();
