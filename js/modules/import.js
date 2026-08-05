/* === MÓDULO: IMPORTAÇÃO === */
/* File parsing (parseImportedFile, parseLooseShapefileParts),
   importGeoJSONFeatures, importFeaturesInChunks, finalizeChunkedImport,
   processImportedFiles, drag-and-drop IIFE, select by attributes IIFE */
/* Origem: 05-app-main.js linhas 1903-2131, 4386-4596 */
(function(){
/* ============================================================
   IMPORTAR GEOJSON / SHAPEFILE
   ============================================================ */
function baseGeomType(t){
  if(t === 'MultiPoint') return 'Point';
  if(t === 'MultiLineString') return 'LineString';
  if(t === 'MultiPolygon') return 'Polygon';
  return t;
}

function getImportedLayerName(fileName){
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  const clean = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean || 'Camada importada';
}

function ensureImportedLayerSchema(layerName, geometryType){
  if(!geometryType) return;
  if(!config.geometryType){
    config.shapeName = layerName || 'Camada importada';
    config.mode = 'atributos';
    config.geometryType = geometryType;
    config.attributes = [];
    config.colorAttr = null;
    config.baseColor = null;
    config.opacity = null;
    config.symbology = defaultSymbology();
    if(!layerVisible.has(activeLayerId)) layerVisible.set(activeLayerId, true);
    if(!layerOrder.includes(activeLayerId)) layerOrder.unshift(activeLayerId);
    ensureLayerPane(activeLayerId);
  } else if(!config.shapeName && layerName){
    config.shapeName = layerName;
  }
}

async function parseImportedFile(file){
  try{
    const name = file.name.toLowerCase();
    const layerName = getImportedLayerName(file.name);
    if(name.endsWith('.zip')){
      const buffer = await file.arrayBuffer();
      const result = await shp(buffer);
      if(Array.isArray(result)){
        return {type:'FeatureCollection', features: result.flatMap(fc => fc.features || []), layerName};
      }
      return {...result, layerName};
    }
    const text = await file.text();
    const parsed = JSON.parse(text);
    if(parsed.type === 'FeatureCollection') return {...parsed, layerName};
    if(parsed.type === 'Feature') return {type:'FeatureCollection', features:[parsed], layerName};
    if(parsed.type){ return {type:'FeatureCollection', features:[{type:'Feature', properties:{}, geometry:parsed}], layerName}; }
    throw new Error('Formato GeoJSON não reconhecido.');
  }catch(err){
    console.error('[parseImportedFile]', err);
    showAppAlert('Erro ao importar ficheiro: ' + file.name, {error: true});
    return null;
  }
}

/* ---------- .shp/.dbf/.shx/.prj soltos (sem .zip) ----------
   Agrupa os ficheiros selecionados pelo nome base (ex.: "estradas.shp"
   + "estradas.dbf" + "estradas.prj" -> grupo "estradas") e usa as
   funções de baixo nível da shpjs (já carregada para o .zip) para
   construir o GeoJSON, uma "camada" por grupo/.shp encontrado. */
function groupLooseShapefileParts(files){
  const groups = new Map();
  files.forEach(f=>{
    const m = f.name.match(/^(.*)\.(shp|dbf|shx|prj|cpg)$/i);
    if(!m) return;
    const base = m[1].toLowerCase();
    const ext = m[2].toLowerCase();
    if(!groups.has(base)) groups.set(base, {});
    groups.get(base)[ext] = f;
  });
  return groups;
}

async function parseLooseShapefileParts(files){
  const groups = groupLooseShapefileParts(files);
  const collections = [];
  for(const parts of groups.values()){
    if(!parts.shp) continue; // sem .shp não há geometria para este grupo
    const layerName = getImportedLayerName(parts.shp.name);
    const shpBuffer = await parts.shp.arrayBuffer();
    let prjText;
    if(parts.prj){ try{ prjText = await parts.prj.text(); }catch(e){ prjText = undefined; } }
    const geometries = shp.parseShp(shpBuffer, prjText);

    let properties = geometries.map(()=>({}));
    if(parts.dbf){
      const dbfBuffer = await parts.dbf.arrayBuffer();
      let cpgText;
      if(parts.cpg){ try{ cpgText = (await parts.cpg.text()).trim(); }catch(e){ cpgText = undefined; } }
      try{ properties = shp.parseDbf(dbfBuffer, cpgText); }catch(e){ /* .dbf ilegível: segue só com geometria */ }
    }

    const gj = shp.combine([geometries, properties]);
    collections.push({...gj, layerName});
  }
  if(!collections.length){
    throw new Error('Não foi encontrado nenhum ficheiro .shp válido na seleção.');
  }
  return collections;
}

function importGeoJSONFeatures(geojson, layerIdResolver, silent, options = {}){
  if(!geojson || typeof geojson !== 'object' || !Array.isArray(geojson.features)){
    showAppAlert('O conteúdo importado não tem o formato esperado de GeoJSON.', {error: true});
    return {imported:0, skipped:0};
  }

  const features = geojson.features.filter(f => f && f.geometry);
  let imported = 0, skipped = 0;

  const firstGeometryType = features.length ? baseGeomType(features.find(f => f.geometry && f.geometry.type)?.geometry?.type) : null;
  if(!layerIdResolver && firstGeometryType){
    ensureImportedLayerSchema(options.layerName || geojson.layerName || null, firstGeometryType);
  }

  let typeMismatch = 0;

  features.forEach(f=>{
    let layer;
    try{ layer = L.geoJSON(f).getLayers()[0]; }
    catch(err){ skipped++; return; }
    if(!layer){ skipped++; return; }

    const rawProps = f.properties && typeof f.properties === 'object' ? {...f.properties} : {};
    const layerId = layerIdResolver ? layerIdResolver(rawProps) : activeLayerId;

    // valida a geometria importada contra o tipo configurado da camada de destino
    // (impede geometrias mistas numa camada, o que deixava o estado da app inconsistente)
    const targetSchema = getLayerSchema(layerId);
    const targetGeomType = targetSchema ? targetSchema.geometryType : config.geometryType;
    const importedGeomType = baseGeomType(f.geometry.type);
    if(targetGeomType && importedGeomType && targetGeomType !== importedGeomType){
      typeMismatch++;
      return;
    }

    drawnGroup.addLayer(layer);
    featureCounter++;
    const id = L.Util.stamp(layer);
    const fid = rawProps.__fid || genFid();
    const updatedAt = rawProps.__updatedAt || Date.now();
    assignLayerPane(layer, layerId);
    delete rawProps.__fid;
    delete rawProps.__updatedAt;
    delete rawProps.__layerId;
    const props = rawProps;
    inferLayerAttributesFromProps(layerId, props);
    const label = props.name || props.label || 'Geometria '+featureCounter;
    const geomType = baseGeomType(f.geometry.type);
    const entry = {layer, props, id, fid, updatedAt, label, geomType, layerId, hasOverlap:false, overlapsWith:[], showMeasures:false, measureTooltips:[]};
    featuresData.set(id, entry);
    if(typeof addToLayerIndex === 'function') addToLayerIndex(entry);
    if(typeof invalidateAnalysisCache === 'function') invalidateAnalysisCache();

    styleLayerByClass(entry);
    if(!getLayerSchema(layerId) || getLayerSchema(layerId).mode !== 'atributos'){ styleLayerDefault(layer, layerId); }
    bindFeatureContextMenu(entry);
    bindFeatureEditTracking(entry);

    imported++;
  });

  if(!options.deferPostProcess){
    refreshFeatList();
    checkAllTopology();

    if(imported > 0){
      try{ map.fitBounds(drawnGroup.getBounds(), {padding:[40,40], maxZoom:18}); }catch(err){ /* bounds inválidos, ignora */ }
    }
  }

  const parts = [];
  if(imported > 0) parts.push(`Importadas ${imported} geometria(s) com sucesso.`);
  if(skipped > 0) parts.push(`${skipped} geometria(s) inválida(s) ou ilegível(is) foram ignoradas.`);
  if(typeMismatch > 0) parts.push(`${typeMismatch} geometria(s) foram ignoradas por não corresponderem ao tipo configurado da camada de destino.`);
  const msg = parts.length ? parts.join(' ') : 'Nenhuma geometria válida encontrada no ficheiro.';
  if(!silent) showAppAlert(msg);
  return {imported, skipped, typeMismatch};
}

/* Conclui o pós-processamento pesado que o import em lotes (importFeaturesInChunks)
   propositadamente adia até ao fim, para não repetir checkAllTopology()/fitBounds()
   uma vez por lote (isso, sim, travava/crashava com ficheiros grandes). */
function finalizeChunkedImport(){
  refreshFeatList();
  checkAllTopology();
  if(featuresData.size > 0){
    try{ map.fitBounds(drawnGroup.getBounds(), {padding:[40,40], maxZoom:18}); }catch(err){ /* bounds inválidos, ignora */ }
  }
}

/* Importa um FeatureCollection potencialmente enorme em lotes, cedendo o
   thread principal (via requestAnimationFrame) entre cada lote. Isto não
   reduz o pico de memória do GeoJSON já parseado, mas evita o bloqueio
   síncrono prolongado que levava o separador a ficar "sem resposta" e,
   em ficheiros muito grandes, a ser morto pelo browser. */
async function importFeaturesInChunks(geojson, layerName, chunkSize = 400){
  try{
    const allFeatures = Array.isArray(geojson.features) ? geojson.features : [];
    const total = allFeatures.length;
    if(total <= chunkSize){
      const res = importGeoJSONFeatures({...geojson, layerName}, null, true, { layerName });
      finalizeChunkedImport();
      return res;
    }

    let imported = 0, skipped = 0, typeMismatch = 0;
    for(let i = 0; i < total; i += chunkSize){
      const chunk = { type:'FeatureCollection', features: allFeatures.slice(i, i + chunkSize), layerName };
      const res = importGeoJSONFeatures(chunk, null, true, { layerName, deferPostProcess:true });
      imported += res.imported; skipped += res.skipped; typeMismatch += res.typeMismatch;
      // dá uma oportunidade ao browser de pintar/libertar memória entre lotes
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    finalizeChunkedImport();
    return {imported, skipped, typeMismatch};
  }catch(err){
    console.error('[Import] chunk error:', err);
    showAppAlert('Erro na importação: ' + err.message, {error:true});
  }
}

document.getElementById('btn-import-geom').addEventListener('click', ()=>{
  document.getElementById('import-file-input').click();
});

/* ============================================================
   Processamento de ficheiros importados (orchestra vetorial + raster)
   ============================================================ */
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

/* ============================================================
   ARRASTAR-E-LARGAR — o browser nunca deixa um <input type="file">
   ver os "irmãos" de um ficheiro (.dbf/.shx/.prj do mesmo .shp) só
   por segurança/sandboxing; não há forma de contornar isso com um
   clique simples. Mas ao ARRASTAR uma PASTA inteira para cima do
   mapa, a API de arrastar do browser (webkitGetAsEntry) dá acesso
   ao conteúdo dessa pasta — por isso esta é a forma real de "só
   apontar para o sítio e ele vai buscar o resto": arrasta a pasta
   onde estão o .shp/.dbf/.shx/.prj (ou o .zip, ou um .geojson) e
   este código lê tudo lá dentro sozinho.
   ============================================================ */
async function readAllDirEntries(reader){
  try{
    let all = [];
    let batch;
    do{
      batch = await new Promise((resolve, reject)=> reader.readEntries(resolve, reject));
      all = all.concat(batch);
    } while(batch.length > 0);
    return all;
  }catch(err){
    console.error('[readAllDirEntries]', err);
    return [];
  }
}

async function collectFilesFromEntry(entry, out){
  try{
    if(!entry) return;
    if(entry.isFile){
      const file = await new Promise((resolve, reject)=> entry.file(resolve, reject));
      out.push(file);
    } else if(entry.isDirectory){
      const entries = await readAllDirEntries(entry.createReader());
      for(const child of entries){ await collectFilesFromEntry(child, out); }
    }
  }catch(err){
    console.error('[collectFilesFromEntry]', err);
  }
}

async function collectFilesFromDataTransfer(dataTransfer){
  try{
    const items = dataTransfer && dataTransfer.items ? Array.from(dataTransfer.items) : [];
    const out = [];
    if(items.length && items[0].webkitGetAsEntry){
      for(const item of items){
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if(entry) await collectFilesFromEntry(entry, out);
        else if(item.getAsFile){ const f = item.getAsFile(); if(f) out.push(f); }
      }
    } else if(dataTransfer && dataTransfer.files){
      out.push(...Array.from(dataTransfer.files));
    }
    return out;
  }catch(err){
    console.error('[collectFilesFromDataTransfer]', err);
    return [];
  }
}

(function wireImportDragAndDrop(){
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    body.is-file-drag-over::after{
      content:"Larga aqui para importar (.shp/.dbf/.shx/.prj, .zip ou .geojson)";
      position:fixed; inset:0; z-index:2147482000;
      display:flex; align-items:center; justify-content:center;
      background:rgba(23,49,36,.55); color:#fff;
      font-family:'IBM Plex Sans', sans-serif; font-size:18px; font-weight:700;
      text-align:center; padding:40px; pointer-events:none;
      border:4px dashed rgba(255,255,255,.7); box-sizing:border-box;
    }
  `;
  document.head.appendChild(styleEl);

  const isFileDrag = (ev)=> ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');

  // Nota: NÃO se usa um contador de dragenter/dragleave (fica facilmente
  // dessincronizado — ex. se o arrasto sair da janela do browser sem
  // largar em lado nenhum, o "dragleave" final às vezes não chega a
  // disparar, e o overlay fica preso a tapar o ecrã inteiro). Em vez
  // disso: o "dragover" dispara continuamente enquanto se arrasta por
  // cima da página, por isso basta reiniciar um temporizador a cada
  // "dragover" — se ele parar de disparar (arrasto saiu ou foi cancelado),
  // o overlay esconde-se sozinho pouco depois, sem poder ficar preso.
  let hideTimer = null;
  function showDragOverlay(){
    document.body.classList.add('is-file-drag-over');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hideDragOverlay, 150);
  }
  function hideDragOverlay(){
    clearTimeout(hideTimer);
    hideTimer = null;
    document.body.classList.remove('is-file-drag-over');
  }

  document.addEventListener('dragenter', (ev)=>{
    if(!isFileDrag(ev)) return;
    ev.preventDefault();
    showDragOverlay();
  });
  document.addEventListener('dragover', (ev)=>{
    if(!isFileDrag(ev)) return;
    ev.preventDefault();
    showDragOverlay();
  });
  document.addEventListener('drop', async (ev)=>{
    if(!isFileDrag(ev)) return;
    ev.preventDefault();
    hideDragOverlay();
    try{
      const files = await collectFilesFromDataTransfer(ev.dataTransfer);
      if(files.length) await processImportedFiles(files);
    }catch(err){
      console.error('[drop-handler]', err);
      showAppAlert('Erro ao processar ficheiros arrastados.', {error: true});
    }
  });
  // salvaguardas extra: se o utilizador sair da janela a meio do arrasto
  // (troca de app, alt-tab) sem largar nem voltar, o overlay não fica preso.
  window.addEventListener('blur', hideDragOverlay);
  document.addEventListener('mouseleave', hideDragOverlay);
})();

/* --- Expõe no window para raster.js e outros módulos --- */
window.baseGeomType = baseGeomType;
window.getImportedLayerName = getImportedLayerName;
window.ensureImportedLayerSchema = ensureImportedLayerSchema;
window.parseImportedFile = parseImportedFile;
window.groupLooseShapefileParts = groupLooseShapefileParts;
window.parseLooseShapefileParts = parseLooseShapefileParts;
window.importGeoJSONFeatures = importGeoJSONFeatures;
window.finalizeChunkedImport = finalizeChunkedImport;
window.importFeaturesInChunks = importFeaturesInChunks;
window.processImportedFiles = processImportedFiles;

})();
