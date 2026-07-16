/* ============================================================
   13-GEOREF-UI.JS — liga a UI (Fases 1-4 do georef.css/engenh.html)
   à lógica já validada em 11-georef.js (Georef.*) e 12-autogeoref.js
   (AutoGeoref.*).
   ------------------------------------------------------------
   PRESSUPOSTOS (por não ter acesso a 05-app-main.js):
     - `map` é a instância Leaflet global, tal como 11-georef.js
       já assume (`Georef.spikeTest` usa-a diretamente).
     - `.hidden{ display:none }` já existe como utilitário global
       (é usada em dezenas de elementos no engenh.html).
     - `#import-file-input` é o único <input type="file"> de
       importação; este módulo ACRESCENTA um listener 'change'
       próprio (filtra só imagens) — não interfere com o listener
       que já trata GeoJSON/Shapefile/CAD.
     - html2canvas (carregado para os Layouts) está disponível
       globalmente para capturar o viewport do mapa como imagem
       de referência para a Fase "Autogeoreferenciar".

   O QUE ESTE FICHEIRO NÃO FAZ (propositadamente, fica para depois):
     - persistência do raster (autosave/projeto) — as imagens só
       vivem em memória (dataURL) enquanto a página está aberta;
     - Fase 7 (menu de exportação de raster, #raster-export-menu);
     - reprojeção para EPSG:3763 (o RMS mostrado é uma conversão
       aproximada graus→metros, só para dar intuição de qualidade).
   ============================================================ */

(function(){

  /* ------------------------------------------------------------
     ESTADO
     ------------------------------------------------------------ */
  const rasters = [];              // { id, name, url, imgWidth, imgHeight, status:'pending'|'done', layer }
  let activeId = null;             // id do raster atualmente em modo de georreferenciação
  let gcps = [];                   // { id, num, img:{x,y}, map:{lat,lng}, source, mapMarker, imgMarkerEl }
  let transform = null;            // último resultado de Georef.solveAffineLeastSquares
  let captureStage = 'image';      // 'image' (à espera de clique na imagem) | 'map' (à espera de clique no mapa)
  let pendingImgPoint = null;      // ponto de imagem já marcado, à espera do clique correspondente no mapa
  let pendingImgMarkerEl = null;
  let editingGcpId = null;         // != null enquanto se reclica o mapa para corrigir um ponto existente
  let gcpSeq = 1;
  let rasterSeq = 1;

  const PENDING_PIXEL_SCALE = 0.00005; // graus/pixel só para a pré-visualização provisória em (0,0)
  const MIN_GCPS = 3;

  /* ------------------------------------------------------------
     REFERÊNCIAS DOM (o HTML/CSS já existem — ver engenh.html)
     ------------------------------------------------------------ */
  const el = {};
  function grab(){
    el.importInput      = document.getElementById('import-file-input');
    el.georefBtn         = document.getElementById('btn-georef-mode');
    el.georefBtnBadge    = document.getElementById('georef-btn-badge');
    el.rasterPanel        = document.getElementById('raster-panel');
    el.rasterList         = document.getElementById('raster-layers-list');
    el.pickerMenu         = document.getElementById('georef-picker-menu');
    el.pickerList          = document.getElementById('georef-picker-list');
    el.banner              = document.getElementById('georef-active-banner');
    el.topbar               = document.getElementById('georef-mode-topbar');
    el.topbarName           = document.getElementById('georef-topbar-name');
    el.topbarCount          = document.getElementById('georef-topbar-count');
    el.topbarRms            = document.getElementById('georef-topbar-rms');
    el.topbarCancel         = document.getElementById('georef-topbar-cancel');
    el.topbarApply          = document.getElementById('georef-topbar-apply');
    el.imagePanel            = document.getElementById('georef-image-panel');
    el.imagePanelBody        = document.getElementById('georef-image-panel-body');
    el.imageWrap              = document.getElementById('georef-image-canvas-wrap');
    el.imageEl                = document.getElementById('georef-image-el');
    el.autoDetectBtn          = document.getElementById('georef-auto-detect-btn');
    el.autoStatus             = document.getElementById('georef-auto-status');
    el.gcpList                = document.getElementById('georef-gcp-list');

    if(!document.getElementById('georef-auto-progress')){
      const progressRoot = document.createElement('div');
      progressRoot.id = 'georef-auto-progress';
      progressRoot.className = 'hidden';
      progressRoot.innerHTML = `
        <div class="georef-auto-progress-icon">🪄</div>
        <div class="georef-auto-progress-content">
          <div class="georef-auto-progress-head">
            <span class="georef-auto-progress-title">Autogeorreferenciação</span>
            <span class="georef-auto-progress-pill">A processar</span>
          </div>
          <div class="georef-auto-progress-bar">
            <span class="georef-auto-progress-bar-fill"></span>
          </div>
          <div class="georef-auto-progress-text">A preparar…</div>
        </div>
      `;
      document.body.appendChild(progressRoot);
    }

    el.autoProgressRoot = document.getElementById('georef-auto-progress');
    el.autoProgressTitle = el.autoProgressRoot?.querySelector('.georef-auto-progress-title');
    el.autoProgressPill = el.autoProgressRoot?.querySelector('.georef-auto-progress-pill');
    el.autoProgressText = el.autoProgressRoot?.querySelector('.georef-auto-progress-text');
  }

  let autoProgressHideTimer = null;

  function setAutoDetectProgressUI({ active = true, text = 'A preparar…', tone = 'working', pill = 'A processar' } = {}){
    if(!el.autoProgressRoot) return;
    if(autoProgressHideTimer){ clearTimeout(autoProgressHideTimer); autoProgressHideTimer = null; }

    el.autoProgressRoot.classList.toggle('hidden', !active);
    el.autoProgressRoot.classList.toggle('is-success', tone === 'success');
    el.autoProgressRoot.classList.toggle('is-error', tone === 'error');
    el.autoProgressRoot.classList.toggle('is-working', tone === 'working');

    if(el.autoProgressPill){ el.autoProgressPill.textContent = pill; }
    if(el.autoProgressText){ el.autoProgressText.textContent = text; }

    if(active && tone !== 'working'){
      autoProgressHideTimer = setTimeout(()=>{
        el.autoProgressRoot.classList.add('hidden');
      }, 1600);
    }

    if(el.autoStatus){
      el.autoStatus.textContent = text;
    }
  }

  function updateAutoDetectProgressUI(text){
    if(!text) return;
    if(el.autoProgressText){ el.autoProgressText.textContent = text; }
    if(el.autoStatus){ el.autoStatus.textContent = text; }
  }

  function clearAutoDetectProgressUI(){
    if(autoProgressHideTimer){ clearTimeout(autoProgressHideTimer); autoProgressHideTimer = null; }
    if(el.autoProgressRoot){ el.autoProgressRoot.classList.add('hidden'); }
  }

  function resetAutoProgressTone(){
    if(!el.autoProgressRoot) return;
    el.autoProgressRoot.classList.remove('is-success','is-error','is-working');
  }
  }

  const genRasterId = ()=> 'raster-' + (rasterSeq++);
  const genGcpId    = ()=> 'gcp-' + (gcpSeq++);

  /* ============================================================
     FASE 1 — import de imagens → painel "Imagens" (pendentes)
     ============================================================ */

  const IMAGE_EXT_RE = /\.(jpe?g|png|tiff?)$/i;

  function initImportHook(){
    if(!el.importInput) return;
    el.importInput.addEventListener('change', (evt)=>{
      const files = Array.from(evt.target.files || []).filter(f => IMAGE_EXT_RE.test(f.name));
      files.forEach(addPendingRaster);
      // não fazemos preventDefault/stopPropagation — o handler de
      // GeoJSON/Shapefile/CAD trata os restantes ficheiros do mesmo evento
    });
  }

  function addPendingRaster(file){
    const reader = new FileReader();
    reader.onload = ()=>{
      const url = reader.result;
      const img = new Image();
      img.onload = ()=>{
        const raster = {
          id: genRasterId(),
          name: file.name,
          url,
          imgWidth: img.naturalWidth,
          imgHeight: img.naturalHeight,
          status: 'pending',
          layer: L.imageOverlay(url, pendingBoundsFor(img.naturalWidth, img.naturalHeight), {
            opacity: 0.9,
            className: 'raster-overlay-pending',
            interactive: false
          }).addTo(map)
        };
        rasters.push(raster);
        renderRasterPanel();
        updateGeorefButtonVisibility({ justAdded: true });
      };
      img.onerror = ()=>{
        console.warn('[georef-ui] não foi possível ler as dimensões da imagem:', file.name);
      };
      img.src = url;
    };
    reader.onerror = ()=> console.warn('[georef-ui] falha a ler o ficheiro:', file.name);
    reader.readAsDataURL(file);
  }

  function pendingBoundsFor(imgWidth, imgHeight){
    const south = -imgHeight * PENDING_PIXEL_SCALE;
    const east  =  imgWidth  * PENDING_PIXEL_SCALE;
    return [[south, 0], [0, east]]; // [[south,west],[north,east]]
  }

  function renderRasterPanel(){
    if(!el.rasterList) return;
    el.rasterList.innerHTML = '';
    rasters.forEach(r=>{
      const li = document.createElement('li');
      li.className = 'raster-row' + (r.status === 'pending' ? ' is-pending' : '');
      li.innerHTML = `
        <span class="raster-status-icon">${r.status === 'pending' ? '⚠️' : '🗺️'}</span>
        <span class="raster-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
        <span class="raster-status-label">${r.status === 'pending' ? 'por georreferenciar' : 'georreferenciada'}</span>
        <button type="button" class="raster-focus-btn" title="Focar no mapa" data-id="${r.id}">🔍</button>
        <button type="button" class="raster-remove-btn" title="Remover" data-id="${r.id}">🗑</button>
      `;
      el.rasterList.appendChild(li);
    });
    el.rasterPanel && el.rasterPanel.classList.toggle('hidden', rasters.length === 0);
  }

  function focusRaster(id){
    const r = rasters.find(x=>x.id===id);
    if(!r || !r.layer) return;
    try{ map.fitBounds(r.layer.getBounds()); }catch(e){}
  }

  function removeRaster(id){
    const idx = rasters.findIndex(x=>x.id===id);
    if(idx === -1) return;
    const r = rasters[idx];
    if(activeId === r.id) exitGeorefMode({ apply:false });
    try{ map.removeLayer(r.layer); }catch(e){}
    rasters.splice(idx, 1);
    renderRasterPanel();
    updateGeorefButtonVisibility({});
  }

  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  /* ============================================================
     FASE 2 — botão "🎯 Georreferenciar" no header + seletor
     ============================================================ */

  function pendingRasters(){ return rasters.filter(r => r.status === 'pending'); }

  function updateGeorefButtonVisibility({justAdded} = {}){
    const pending = pendingRasters();
    if(!el.georefBtn) return;
    el.georefBtn.classList.toggle('hidden', pending.length === 0);
    if(el.georefBtnBadge){
      if(pending.length > 1){
        el.georefBtnBadge.textContent = String(pending.length);
        el.georefBtnBadge.classList.remove('hidden');
      } else {
        el.georefBtnBadge.classList.add('hidden');
      }
    }
    if(justAdded && pending.length > 0 && activeId === null){
      el.georefBtn.classList.remove('is-attention');
      // reforça o "pop" mesmo que já estivesse visível de antes
      void el.georefBtn.offsetWidth;
      el.georefBtn.classList.add('is-attention');
    }
  }

  function onGeorefBtnClick(){
    const pending = pendingRasters();
    if(pending.length === 0) return;
    if(pending.length === 1){
      enterGeorefMode(pending[0].id);
      return;
    }
    openGeorefPicker(pending);
  }

  function openGeorefPicker(pending){
    if(!el.pickerMenu || !el.pickerList || !el.georefBtn) return;
    el.pickerList.innerHTML = '';
    pending.forEach(r=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'georef-picker-item';
      btn.textContent = '🖼️ ' + r.name;
      btn.addEventListener('click', ()=>{
        closeGeorefPicker();
        enterGeorefMode(r.id);
      });
      el.pickerList.appendChild(btn);
    });
    const rect = el.georefBtn.getBoundingClientRect();
    el.pickerMenu.style.top = (rect.bottom + 6) + 'px';
    el.pickerMenu.style.left = rect.left + 'px';
    el.pickerMenu.classList.remove('hidden');
    el.georefBtn.classList.add('is-paused');
    document.addEventListener('mousedown', onDocClickClosePicker, true);
  }

  function closeGeorefPicker(){
    el.pickerMenu && el.pickerMenu.classList.add('hidden');
    el.georefBtn && el.georefBtn.classList.remove('is-paused');
    document.removeEventListener('mousedown', onDocClickClosePicker, true);
  }

  function onDocClickClosePicker(evt){
    if(el.pickerMenu && !el.pickerMenu.contains(evt.target) && evt.target !== el.georefBtn){
      closeGeorefPicker();
    }
  }

  /* ============================================================
     FASE 3 — entrar/sair do modo de georreferenciação
     ============================================================ */

  function positionGeorefOverlays(){
    const mapEl = document.getElementById('map');
    if(!mapEl) return;
    const rect = mapEl.getBoundingClientRect();

    if(el.topbar){
      el.topbar.style.top = (rect.top + 14) + 'px';
      el.topbar.style.left = (rect.left + rect.width / 2) + 'px';
    }
    if(el.imagePanel){
      el.imagePanel.style.top = rect.top + 'px';
      el.imagePanel.style.left = (rect.left + rect.width / 2) + 'px';
      el.imagePanel.style.width = (rect.width / 2) + 'px';
      el.imagePanel.style.height = rect.height + 'px';
    }
    if(el.banner){
      el.banner.style.top = (rect.top + 14) + 'px';
      el.banner.style.left = (rect.left + 14) + 'px';
    }
  }

  function enterGeorefMode(rasterId){
    const raster = rasters.find(r => r.id === rasterId);
    if(!raster) return;

    activeId = rasterId;
    gcps = [];
    transform = null;
    captureStage = 'image';
    pendingImgPoint = null;
    editingGcpId = null;

    document.body.classList.add('georef-mode-active');
    el.banner && el.banner.classList.remove('hidden');
    el.topbar && el.topbar.classList.remove('hidden');
    el.imagePanel && el.imagePanel.classList.remove('hidden');
    el.georefBtn && el.georefBtn.classList.remove('is-attention');

    if(el.topbarName) el.topbarName.textContent = raster.name;
    if(el.imageEl) el.imageEl.src = raster.url;
    if(el.autoStatus) el.autoStatus.textContent = 'Usa um tile DGT do mapa como referência.';

    renderGcpList();
    positionGeorefOverlays();

    window.addEventListener('resize', positionGeorefOverlays);
    map.on('move zoom', positionGeorefOverlays);
    el.imageWrap && el.imageWrap.addEventListener('click', onImageClick);
    map.on('click', onMapClick);
  }

  function exitGeorefMode({apply}){
    if(activeId === null) return;

    document.body.classList.remove('georef-mode-active');
    el.banner && el.banner.classList.add('hidden');
    el.topbar && el.topbar.classList.add('hidden');
    el.imagePanel && el.imagePanel.classList.add('hidden');

    window.removeEventListener('resize', positionGeorefOverlays);
    map.off('move zoom', positionGeorefOverlays);
    el.imageWrap && el.imageWrap.removeEventListener('click', onImageClick);
    map.off('click', onMapClick);

    clearGcpMarkers();
    gcps = [];
    transform = null;
    activeId = null;
    editingGcpId = null;

    if(!apply) updateGeorefButtonVisibility({});
  }

  /* ============================================================
     FASE 4 — captura de GCPs (clicar imagem → clicar mapa)
     ============================================================ */

  function onImageClick(evt){
    if(captureStage !== 'image' || !el.imageEl) return;
    const pt = imgClientToPixel(evt, el.imageEl);
    if(pt.x < 0 || pt.y < 0 || pt.x > el.imageEl.naturalWidth || pt.y > el.imageEl.naturalHeight) return;

    pendingImgPoint = pt;
    pendingImgMarkerEl = document.createElement('span');
    pendingImgMarkerEl.className = 'georef-gcp-pending-marker';
    positionMarkerOnImage(pendingImgMarkerEl, pt);
    el.imageWrap.appendChild(pendingImgMarkerEl);

    captureStage = 'map';
    if(el.autoStatus) el.autoStatus.textContent = editingGcpId
      ? 'Clica no mapa no novo local correto para este ponto.'
      : 'Agora clica no mapa, no local correspondente.';
  }

  function onMapClick(evt){
    if(captureStage !== 'map' || !pendingImgPoint) return;

    if(editingGcpId){
      const g = gcps.find(x => x.id === editingGcpId);
      if(g){
        g.img = pendingImgPoint;
        g.map = { lat: evt.latlng.lat, lng: evt.latlng.lng };
      }
      editingGcpId = null;
    } else {
      gcps.push({
        id: genGcpId(),
        num: gcps.length + 1,
        img: pendingImgPoint,
        map: { lat: evt.latlng.lat, lng: evt.latlng.lng },
        source: 'manual'
      });
    }

    pendingImgPoint = null;
    if(pendingImgMarkerEl){ pendingImgMarkerEl.remove(); pendingImgMarkerEl = null; }
    captureStage = 'image';
    if(el.autoStatus) el.autoStatus.textContent = 'Clica na imagem para marcar o próximo ponto.';

    renumerar();
    renderGcpList();
  }

  function renumerar(){ gcps.forEach((g,i)=> g.num = i+1); }

  function imgClientToPixel(evt, imgEl){
    const rect = imgEl.getBoundingClientRect();
    const scaleX = imgEl.naturalWidth / rect.width;
    const scaleY = imgEl.naturalHeight / rect.height;
    return {
      x: (evt.clientX - rect.left) * scaleX,
      y: (evt.clientY - rect.top) * scaleY
    };
  }

  function positionMarkerOnImage(markerEl, pt){
    if(!el.imageEl || !el.imageEl.naturalWidth) return;
    markerEl.style.left = (pt.x / el.imageEl.naturalWidth * 100) + '%';
    markerEl.style.top  = (pt.y / el.imageEl.naturalHeight * 100) + '%';
  }

  function clearGcpMarkers(){
    gcps.forEach(g=>{
      if(g.mapMarker){ try{ map.removeLayer(g.mapMarker); }catch(e){} }
      if(g.imgMarkerEl){ g.imgMarkerEl.remove(); }
    });
    if(el.imageWrap){
      el.imageWrap.querySelectorAll('.georef-gcp-image-marker, .georef-gcp-pending-marker').forEach(n=>n.remove());
    }
    if(pendingImgMarkerEl){ pendingImgMarkerEl.remove(); pendingImgMarkerEl = null; }
  }

  function renderGcpList(){
    clearGcpMarkers();

    gcps.forEach(g=>{
      // marcador sobre a imagem
      const imgMarker = document.createElement('span');
      imgMarker.className = 'georef-gcp-image-marker';
      imgMarker.textContent = g.num;
      positionMarkerOnImage(imgMarker, g.img);
      el.imageWrap && el.imageWrap.appendChild(imgMarker);
      g.imgMarkerEl = imgMarker;

      // marcador correspondente no mapa
      const icon = L.divIcon({
        className: 'georef-gcp-map-marker',
        html: `<span>${g.num}</span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      g.mapMarker = L.marker([g.map.lat, g.map.lng], { icon, interactive: false }).addTo(map);
    });

    if(el.gcpList){
      if(gcps.length === 0){
        el.gcpList.innerHTML = '<li class="georef-gcp-empty">Ainda não marcaste nenhum ponto de controlo.</li>';
      } else {
        el.gcpList.innerHTML = gcps.map(g => `
          <li class="georef-gcp-item" data-id="${g.id}">
            <span class="georef-gcp-item-num">${g.num}${g.source === 'auto' ? ' 🪄' : ''}</span>
            <span class="georef-gcp-item-coords">${g.map.lat.toFixed(5)}, ${g.map.lng.toFixed(5)}</span>
            <button type="button" class="georef-gcp-item-edit" data-id="${g.id}" title="Corrigir ponto no mapa">✏️</button>
            <button type="button" class="georef-gcp-item-remove" data-id="${g.id}" title="Remover ponto">✕</button>
          </li>
        `).join('');
      }
    }

    if(el.topbarCount) el.topbarCount.textContent = `Pontos: ${gcps.length} (mín. ${MIN_GCPS})`;
    updateTransformAndRms();
  }

  function updateTransformAndRms(){
    if(gcps.length < MIN_GCPS){
      transform = null;
      setRms(null, `mínimo de ${MIN_GCPS} pontos`);
      el.topbarApply && (el.topbarApply.disabled = true);
      return;
    }
    try{
      const gcpsForSolver = gcps.map(g => ({ img: g.img, map: { lng: g.map.lng, lat: g.map.lat } }));
      transform = Georef.solveAffineLeastSquares(gcpsForSolver);
      const metros = transform.rms * 111320; // aproximação grosseira graus→metros, só para intuição
      setRms(metros);
      el.topbarApply && (el.topbarApply.disabled = false);
    }catch(err){
      transform = null;
      setRms(null, 'pontos colineares/repetidos');
      el.topbarApply && (el.topbarApply.disabled = true);
    }
  }

  function setRms(metros, note){
    if(!el.topbarRms) return;
    el.topbarRms.classList.remove('is-good','is-warn','is-bad');
    if(metros === null){
      el.topbarRms.textContent = note ? `RMS: — (${note})` : 'RMS: —';
      return;
    }
    el.topbarRms.textContent = `RMS: ≈${metros.toFixed(1)} m`;
    el.topbarRms.classList.add(metros < 1 ? 'is-good' : metros < 5 ? 'is-warn' : 'is-bad');
  }

  function editGcp(id){
    editingGcpId = id;
    captureStage = 'image';
    if(el.autoStatus) el.autoStatus.textContent = 'Clica na imagem no ponto correto (ou volta a clicar no mesmo sítio).';
  }

  function removeGcp(id){
    const idx = gcps.findIndex(g => g.id === id);
    if(idx === -1) return;
    const [g] = gcps.splice(idx, 1);
    if(g.mapMarker){ try{ map.removeLayer(g.mapMarker); }catch(e){} }
    renumerar();
    renderGcpList();
  }

  /* chamada quando os GCPs (manuais ou automáticos) mudam de fonte —
     hoje é usada diretamente pelo fluxo do Web Worker (onAutoDetectClick),
     mas fica exposta em window para continuar a poder ser chamada à mão
     na consola, tal como o resto do módulo. */
  window.renderGeorefGCPList = function(autoGcps, info){
    if(!activeId) return;
    clearGcpMarkers();
    gcps = autoGcps.map((g, i) => ({
      id: genGcpId(),
      num: i + 1,
      img: g.img,
      map: g.map,
      source: 'auto'
    }));
    renderGcpList();
    if(el.autoStatus && info){
      el.autoStatus.textContent = `🪄 ${info.inlierCount}/${info.totalMatches} correspondências (${(info.inlierRatio*100).toFixed(0)}%), RMS ${info.rmsPx.toFixed(1)}px na imagem de referência.`;
    }
  };

  /* ============================================================
     "Autogeoreferenciar" — usa o viewport atual do mapa como
     referência. A deteção ORB + RANSAC corre num Web Worker
     dedicado (ver js/12b-autogeoref-worker.js) porque o OpenCV.js
     compila o WASM de forma síncrona: correr isto na main thread
     deixava a página sem resposta (nem a consola abria) durante
     a compilação + deteção.
     ============================================================ */

  const AUTOGEOREF_WORKER_URL = 'js/12b-autogeoref-worker.js';
  let autoGeorefWorker = null;
  let autoGeorefReqSeq = 1;

  const AUTOGEOREF_REQUEST_TIMEOUT_MS = 90000; // rede lenta + 60s de margem do próprio worker para o OpenCV

  function getAutoGeorefWorker(){
    if(!autoGeorefWorker){
      try{
        autoGeorefWorker = new Worker(AUTOGEOREF_WORKER_URL);
      }catch(err){
        // new Worker() pode lançar de forma síncrona (URL inválido, bloqueio de
        // CSP/mixed-content) — sem isto, essa exceção nunca chegava ao .catch()
        // de onAutoDetectClick porque acontecia fora de qualquer Promise.
        throw new Error('Não foi possível iniciar o worker de autogeoreferenciação (' + AUTOGEOREF_WORKER_URL + '): ' + err.message);
      }
      // se o próprio ficheiro do worker não existir (404) ou tiver um erro de
      // sintaxe, o browser dispara 'error' no objeto Worker — sem um listener
      // aqui, isso ficava completamente silencioso e QUALQUER pedido pendente
      // ficava preso para sempre (era isto que estava a "crashar" o autodetect).
      autoGeorefWorker.addEventListener('error', (evt)=>{
        console.error('[georef-ui] erro no worker de autogeoreferenciação:', evt.message || evt);
        rejectAllPending(new Error(
          'O worker de autogeoreferenciação falhou a carregar (' + AUTOGEOREF_WORKER_URL + '). ' +
          'Confirma que o ficheiro está publicado nesse caminho e que não há bloqueio de CSP. Detalhe: ' +
          (evt.message || 'erro desconhecido')
        ));
        // descarta o worker partido — a próxima tentativa cria um novo
        try{ autoGeorefWorker.terminate(); }catch(e){}
        autoGeorefWorker = null;
      });
    }
    return autoGeorefWorker;
  }

  // pedidos à espera de resposta, para podermos rejeitá-los todos de uma vez
  // se o worker morrer a meio (evento 'error' acima)
  const pendingAutoGeorefRequests = new Map(); // id -> {resolve, reject, onMessage}
  function rejectAllPending(err){
    pendingAutoGeorefRequests.forEach(({reject, onMessage})=>{
      if(autoGeorefWorker) autoGeorefWorker.removeEventListener('message', onMessage);
      reject(err);
    });
    pendingAutoGeorefRequests.clear();
  }

  /* envia um pedido de deteção ao worker e devolve uma Promise;
     onStatus é chamado a cada atualização de progresso (opcional).
     Nunca fica pendente para sempre: rejeita ao fim de
     AUTOGEOREF_REQUEST_TIMEOUT_MS mesmo que o worker nunca responda. */
  function requestAutoGeoref({imgBitmap, refBitmap, refTileBounds, refTileSize, opts}, onStatus){
    const worker = getAutoGeorefWorker();
    const id = autoGeorefReqSeq++;

    return new Promise((resolve, reject)=>{
      const timeoutTimer = setTimeout(()=>{
        pendingAutoGeorefRequests.delete(id);
        worker.removeEventListener('message', onMessage);
        reject(new Error(`Sem resposta do worker em ${AUTOGEOREF_REQUEST_TIMEOUT_MS/1000}s — provavelmente o OpenCV.js não carregou. Confirma a rede/consola.`));
      }, AUTOGEOREF_REQUEST_TIMEOUT_MS);

      function settle(fn, arg){
        clearTimeout(timeoutTimer);
        pendingAutoGeorefRequests.delete(id);
        worker.removeEventListener('message', onMessage);
        fn(arg);
      }

      function onMessage(evt){
        const msg = evt.data;
        if(!msg || msg.id !== id) return;
        if(msg.type === 'status'){
          onStatus && onStatus(msg.text);
        } else if(msg.type === 'done'){
          settle(resolve, msg);
        } else if(msg.type === 'error'){
          settle(reject, new Error(msg.message));
        }
      }

      pendingAutoGeorefRequests.set(id, {resolve: (v)=>settle(resolve, v), reject: (e)=>settle(reject, e), onMessage});
      worker.addEventListener('message', onMessage);

      try{
        worker.postMessage(
          {type:'detect', id, imgBitmap, refBitmap, refTileBounds, refTileSize, opts},
          [imgBitmap, refBitmap] // transferable — evita copiar os pixels
        );
      }catch(err){
        settle(reject, new Error('Falha ao enviar as imagens para o worker: ' + err.message));
      }
    });
  }

  function onAutoDetectClick(){
    const raster = rasters.find(r => r.id === activeId);
    if(!raster || !el.imageEl){
      if(el.autoStatus) el.autoStatus.textContent = 'Sem imagem ativa.';
      return;
    }
    if(typeof html2canvas !== 'function'){
      if(el.autoStatus) el.autoStatus.textContent = 'html2canvas não está disponível — não é possível capturar o mapa.';
      return;
    }

    el.autoDetectBtn && (el.autoDetectBtn.disabled = true);
    resetAutoProgressTone();
    setAutoDetectProgressUI({ active: true, text: '🪄 a capturar o mapa…', pill: 'A processar' });

    const bounds = map.getBounds();
    const refTileBounds = {
      west: bounds.getWest(), east: bounds.getEast(),
      north: bounds.getNorth(), south: bounds.getSouth()
    };

    // scale:1 — evita que o devicePixelRatio (2x/3x em ecrãs HiDPI) infle
    // desnecessariamente o canvas capturado.
    const CAPTURE_TIMEOUT_MS = 20000;
    const captureWithTimeout = Promise.race([
      html2canvas(document.getElementById('map'), { useCORS: true, logging: false, scale: 1 }),
      new Promise((_, reject)=> setTimeout(()=> reject(new Error(
        `Captura do mapa não terminou em ${CAPTURE_TIMEOUT_MS/1000}s.`
      )), CAPTURE_TIMEOUT_MS))
    ]);

    let refCanvas;
    captureWithTimeout
      .then(canvas=>{
        refCanvas = canvas;
        return Promise.all([
          createImageBitmap(el.imageEl),
          createImageBitmap(canvas)
        ]);
      })
      .then(([imgBitmap, refBitmap])=>{
        return requestAutoGeoref({
          imgBitmap, refBitmap,
          refTileBounds,
          refTileSize: { width: refCanvas.width, height: refCanvas.height }
        }, (text)=>{
          updateAutoDetectProgressUI('🪄 ' + text);
          if(text && /OpenCV|correspond|RANSAC|carregar/i.test(text)){
            setAutoDetectProgressUI({ active: true, text: '🪄 ' + text, pill: 'A processar' });
          }
        });
      })
      .then(result=>{
        el.autoDetectBtn && (el.autoDetectBtn.disabled = false);
        if(!result.success){
          const failText = '🪄 ' + result.reason + ' Podes continuar a marcar pontos manualmente.';
          setAutoDetectProgressUI({ active: true, text: failText, tone: 'error', pill: 'Falhou' });
          if(el.autoStatus) el.autoStatus.textContent = failText;
          return;
        }
        setAutoDetectProgressUI({ active: true, text: '🪄 georreferenciação concluída.', tone: 'success', pill: 'Concluído' });
        window.renderGeorefGCPList(result.gcps, result.quality);
      })
      .catch(err=>{
        el.autoDetectBtn && (el.autoDetectBtn.disabled = false);
        const errorText = '🪄 erro: ' + err.message;
        setAutoDetectProgressUI({ active: true, text: errorText, tone: 'error', pill: 'Erro' });
        if(el.autoStatus) el.autoStatus.textContent = errorText;
        console.error('[georef-ui] autogeoref falhou:', err);
      });
  }

  /* ============================================================
     "Aplicar" — usa a transformação afim calculada para colocar
     a imagem definitivamente no mapa via ImageOverlay.Rotated.
     ============================================================ */

  function onApplyClick(){
    const raster = rasters.find(r => r.id === activeId);
    if(!raster || !transform) return;

    const corners = Georef.affineToCorners(transform, raster.imgWidth, raster.imgHeight);
    try{ map.removeLayer(raster.layer); }catch(e){}

    raster.layer = L.imageOverlay.rotated(raster.url, corners.topleft, corners.topright, corners.bottomleft, {
      opacity: 0.9
    }).addTo(map);
    raster.status = 'done';

    try{ map.fitBounds(raster.layer.getBounds()); }catch(e){}

    exitGeorefMode({ apply: true });
    renderRasterPanel();
    updateGeorefButtonVisibility({});
  }

  function onCancelClick(){
    exitGeorefMode({ apply: false });
  }

  /* ============================================================
     LIGAÇÃO DOS EVENTOS ESTÁTICOS
     ============================================================ */

  function bindStaticEvents(){
    el.georefBtn && el.georefBtn.addEventListener('click', onGeorefBtnClick);
    el.topbarCancel && el.topbarCancel.addEventListener('click', onCancelClick);
    el.topbarApply && el.topbarApply.addEventListener('click', onApplyClick);
    el.autoDetectBtn && el.autoDetectBtn.addEventListener('click', onAutoDetectClick);

    el.rasterList && el.rasterList.addEventListener('click', (evt)=>{
      const focusBtn = evt.target.closest('.raster-focus-btn');
      const removeBtn = evt.target.closest('.raster-remove-btn');
      if(focusBtn) focusRaster(focusBtn.dataset.id);
      if(removeBtn) removeRaster(removeBtn.dataset.id);
    });

    el.gcpList && el.gcpList.addEventListener('click', (evt)=>{
      const editBtn = evt.target.closest('.georef-gcp-item-edit');
      const removeBtn = evt.target.closest('.georef-gcp-item-remove');
      if(editBtn) editGcp(editBtn.dataset.id);
      if(removeBtn) removeGcp(removeBtn.dataset.id);
    });
  }

  /* ============================================================
     ARRANQUE
     ============================================================ */

  function boot(){
    if(typeof L === 'undefined' || typeof map === 'undefined'){
      console.warn('[georef-ui] Leaflet/`map` ainda não estão prontos — módulo não iniciado.');
      return;
    }
    grab();
    initImportHook();
    bindStaticEvents();
    updateGeorefButtonVisibility({});
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // exposto para depuração manual na consola
  window.GeorefUI = { rasters, get gcps(){ return gcps; }, enterGeorefMode, exitGeorefMode };

})();
