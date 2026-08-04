/* ============================================================
   LAYOUTS — várias mini-mapas (workspaces) lado a lado, em frames
   arrastáveis/redimensionáveis, dentro de uma página cheia.

   Módulo autónomo, tal como 06-smart-sync.js / 07-cad-import.js.
   Depende de globais já expostos por 05-app-main.js (mesmo scope,
   scripts clássicos): workspaces, getWorkspaceById, currentWorkspace,
   persistCurrentWorkspaceState, applyWorkspaceState, renderWorkspaceTabs,
   defaultSymbology, resolveFeatureColor, dataGisMarkerIcon, escapeHtml,
   DEFAULT_OPACITY, DEFAULT_COLOR.

   Ganchos que este ficheiro expõe em "window" e que 05-app-main.js chama
   (de forma segura, só se existirem):
     - window.isLayoutViewActive()          -> bool
     - window.renderLayoutTabsInto(container) -> insere os separadores de Layout
     - window.handleAddMapClick()           -> abre o modal "Workspace / Layout"
     - window.leaveLayoutView()             -> fecha a página de Layout aberta (se alguma)
     - window.notifyLayoutsWorkspaceChanged(workspace) -> resincroniza frames desse workspace
   ============================================================ */
(function(){

  const MAX_FRAMES_PER_LAYOUT = 3;
  const MIN_FRAME_W = 220;
  const MIN_FRAME_H = 160;
  const MIN_ELEMENT_W = 90;
  const MIN_ELEMENT_H = 60;

  let layouts = [];
  let currentLayoutId = null;
  let activeTabKind = 'workspace'; // 'workspace' | 'layout'
  let layoutCounter = 0;
  let elementCounter = 0;

  /* ============================================================
     DEFINIÇÕES DOS ELEMENTOS CARTOGRÁFICOS (North Arrow, Legenda,
     Escala, Texto, Formas) — ver secção "ELEMENTOS DO LAYOUT" mais
     abaixo para a lógica de criação/render/interação de cada um.
     ============================================================ */
  const ELEMENT_DEFS = {
    'north-arrow': { label:'Seta Norte',      w:70,  h:90,  minW:36, minH:46, lockAspect:true  },
    'legend':      { label:'Legenda',         w:200, h:160, minW:120,minH:80  },
    'scale-bar':   { label:'Escala Gráfica',  w:190, h:46,  minW:110,minH:36  },
    'text':        { label:'Texto',           w:220, h:64,  minW:80, minH:34  },
    'shape-rect':    { label:'Retângulo', w:160, h:100, minW:24, minH:24 },
    'shape-circle':  { label:'Círculo',   w:120, h:120, minW:24, minH:24 },
    'shape-line':    { label:'Linha',     w:180, h:40,  minW:30, minH:16 },
    'shape-arrow':   { label:'Seta',      w:180, h:40,  minW:30, minH:16 },
    'shape-polygon': { label:'Polígono',  w:150, h:130, minW:30, minH:30 }
  };
  const SHAPE_TYPES = ['shape-rect','shape-circle','shape-line','shape-arrow','shape-polygon'];

  /* ---------- utilidades ---------- */
  function safeEscape(str){
    return (typeof escapeHtml === 'function') ? escapeHtml(str) : String(str == null ? '' : str);
  }
  function getWorkspaceByIdSafe(id){
    if(typeof getWorkspaceById === 'function') return getWorkspaceById(id);
    if(typeof workspaces !== 'undefined') return workspaces.find(w=>w.id===id) || null;
    return null;
  }
  function getWorkspacesListSafe(){
    return (typeof workspaces !== 'undefined' && Array.isArray(workspaces)) ? workspaces : [];
  }

  /* ---------- estado ---------- */
  function createLayoutState(id, name){
    return { id, name, frames: [], elements: [] };
  }
  function createFrameState(id, workspaceId, x, y){
    return { id, workspaceId, x: x||40, y: y||40, w: 420, h: 320, map: null, group: null, active: false };
  }
  function createElementState(type, x, y){
    const def = ELEMENT_DEFS[type] || { w:160, h:100 };
    elementCounter += 1;
    const id = 'el-' + Date.now() + '-' + elementCounter;
    const isShape = SHAPE_TYPES.indexOf(type) !== -1;
    return {
      id, type,
      x: x||40, y: y||40, w: def.w, h: def.h,
      refFrameId: null, // usado por 'legend' e 'scale-bar' para saber a que mapa se referem
      data: {
        html: type === 'text' ? 'Texto' : undefined,
        fill: isShape ? (type==='shape-line' || type==='shape-arrow' ? 'none' : 'rgba(31,92,107,.18)') : undefined,
        stroke: isShape ? '#1F5C6B' : undefined,
        strokeWidth: isShape ? 2 : undefined
      }
    };
  }

  /* ============================================================
     MAPAS BASE PARA OS FRAMES — constantes simples de URL de tiles,
     sem tocar na classe OfflineTileLayer/OfflineWMSTileLayer principal.
     ============================================================ */
  function tileLayerForKey(key){
    switch(key){
      case 'claro':
        return L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
          maxZoom:24, maxNativeZoom:19, attribution:''
        });
      case 'osm':
        return L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom:24, maxNativeZoom:19, attribution:''
        });
      case 'dgt':
        return L.tileLayer.wms('https://cartografia.dgterritorio.gov.pt/wms/ortos2021', {
          layers:'Ortos2021-RGB', format:'image/jpeg', transparent:false, version:'1.3.0',
          maxZoom:24, maxNativeZoom:20, minZoom:6, attribution:''
        });
      case 'sentinel':
        return L.tileLayer.wms('https://tiles.maps.eox.at/wms', {
          layers:(typeof window.__sentinelLayerName !== 'undefined' ? window.__sentinelLayerName : 's2cloudless-2025_3857'),
          format:'image/jpeg', transparent:false, version:'1.1.1',
          maxZoom:16, attribution:''
        });
      case 'satelite':
      default:
        return L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          maxZoom:24, maxNativeZoom:19, attribution:''
        });
    }
  }

  /* ============================================================
     CLONE DE GEOMETRIA + SIMBOLOGIA DE UM WORKSPACE (sem depender
     dos globais "activeLayerId/layers/config" — versão isolada).
     ============================================================ */
  function getLayerSchemaForWorkspace(workspace, layerId){
    if(!workspace) return null;
    if(layerId === workspace.activeLayerId && workspace.config){
      const cfg = workspace.config;
      if(!cfg.symbology && typeof defaultSymbology === 'function') cfg.symbology = defaultSymbology();
      return {
        name: cfg.shapeName, geometryType: cfg.geometryType, mode: cfg.mode,
        attributes: cfg.attributes, colorAttr: cfg.colorAttr, baseColor: cfg.baseColor,
        opacity: cfg.opacity, symbology: cfg.symbology
      };
    }
    const rec = Array.isArray(workspace.layers) ? workspace.layers.find(l=>l.id===layerId) : null;
    if(rec && !rec.symbology && typeof defaultSymbology === 'function') rec.symbology = defaultSymbology();
    return rec || null;
  }

  function buildFrameLayerGroup(workspace){
    const group = L.layerGroup();
    if(!workspace || !(workspace.featuresData instanceof Map)) return group;

    const order = Array.isArray(workspace.layerOrder) ? workspace.layerOrder.slice() : [];
    const seen = new Set(order);
    workspace.featuresData.forEach(entry=>{ if(!seen.has(entry.layerId)){ seen.add(entry.layerId); order.push(entry.layerId); } });
    // layerOrder[0] = topo do empilhamento -> desenhar por último (renderiza-se por cima)
    const renderOrder = order.slice().reverse();

    renderOrder.forEach(layerId=>{
      const visible = (workspace.layerVisible instanceof Map) ? workspace.layerVisible.get(layerId) !== false : true;
      if(!visible) return;
      const schema = getLayerSchemaForWorkspace(workspace, layerId);
      if(!schema) return;
      const opacityBase = (typeof DEFAULT_OPACITY !== 'undefined') ? DEFAULT_OPACITY : 35;
      const fillOpacity = ((schema.opacity != null) ? schema.opacity : opacityBase) / 100;

      workspace.featuresData.forEach(entry=>{
        if(entry.layerId !== layerId) return;
        let gj;
        try{ gj = entry.layer.toGeoJSON(); }catch(err){ return; }
        const color = (typeof resolveFeatureColor === 'function')
          ? resolveFeatureColor(schema, entry.props)
          : (schema.baseColor || (typeof DEFAULT_COLOR !== 'undefined' ? DEFAULT_COLOR : '#F5821F'));
        try{
          const geomLayer = L.geoJSON(gj, {
            interactive:false,
            pointToLayer:(feature, latlng)=>{
              const icon = (typeof dataGisMarkerIcon === 'function') ? dataGisMarkerIcon(color) : undefined;
              return icon ? L.marker(latlng, {icon, interactive:false}) : L.circleMarker(latlng, {radius:6, color, fillColor:color, fillOpacity:1, interactive:false});
            },
            style:()=>({ color, fillColor:color, fillOpacity, weight:2, interactive:false })
          });
          group.addLayer(geomLayer);
        }catch(err){ /* geometria inválida — ignora silenciosamente */ }
      });
    });

    return group;
  }

  /* ============================================================
     PÁGINA DE LAYOUT (overlay cheio) — criada dinamicamente
     ============================================================ */
  function ensureLayoutsRoot(){
    return document.getElementById('layouts-root');
  }

  function buildLayoutPageDom(layout){
    const page = document.createElement('div');
    page.className = 'layout-page hidden';
    page.id = 'layout-page-' + layout.id;
    page.innerHTML = `
      <div class="layout-page-topbar">
        <span class="layout-page-topbar-title">${safeEscape(layout.name || 'Layout')}</span>
        <div class="layout-page-toolbar">
          <button type="button" class="layout-add-content-btn layout-page-add-content-btn" id="layout-page-add-content-${layout.id}">
            <span class="layout-add-content-btn-label">+ Adicionar Conteúdo</span>
          </button>
          <button type="button" class="layout-tool-btn layout-page-add-element-btn" id="layout-page-add-element-${layout.id}" title="Adicionar elemento cartográfico">
            <span class="layout-tool-btn-icon">◈</span>
            <span>+ Elemento</span>
          </button>
          <button type="button" class="layout-tool-btn layout-page-export-btn" id="layout-page-export-${layout.id}" title="Exportar composição">
            <span class="layout-tool-btn-icon">⭳</span>
            <span>Exportar</span>
          </button>
          <button type="button" class="layout-page-close" id="layout-page-close-${layout.id}">Voltar ao mapa</button>
        </div>
      </div>
      <div class="layout-canvas">
        <div class="layout-empty-hint" id="layout-empty-hint-${layout.id}">
          <b>Layout vazio</b>
          <span>Usa "Adicionar Conteúdo" no topo para escolher um mapa a mostrar aqui.</span>
        </div>
      </div>
    `;
    const addBtn = page.querySelector('.layout-page-add-content-btn');
    if(addBtn){
      addBtn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        const menu = getAddContentMenuEl();
        if(menu && !menu.classList.contains('hidden')) closeAddContentMenu(); else openAddContentMenu();
      });
    }
    const addElBtn = page.querySelector('.layout-page-add-element-btn');
    if(addElBtn){
      addElBtn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        const menu = getAddElementMenuEl();
        if(menu && !menu.classList.contains('hidden')) closeAddElementMenu(); else openAddElementMenu(addElBtn);
      });
    }
    const exportBtn = page.querySelector('.layout-page-export-btn');
    if(exportBtn){
      exportBtn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        const menu = getExportMenuEl();
        if(menu && !menu.classList.contains('hidden')) closeExportMenu(); else openExportMenu(exportBtn, layout);
      });
    }
    const closeBtn = page.querySelector('.layout-page-close');
    if(closeBtn){
      closeBtn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        if(typeof window.leaveLayoutView === 'function') window.leaveLayoutView();
      });
    }
    return page;
  }

  function updateEmptyHint(layout){
    const hint = document.getElementById('layout-empty-hint-' + layout.id);
    if(hint) hint.classList.toggle('hidden', (layout.frames.length + layout.elements.length) > 0);
  }

  function hideAllLayoutPages(){
    document.querySelectorAll('.layout-page').forEach(p=>p.classList.add('hidden'));
  }

  function showLayoutPage(layout){
    hideAllLayoutPages();
    let page = document.getElementById('layout-page-' + layout.id);
    const root = ensureLayoutsRoot();
    if(!page && root){
      page = buildLayoutPageDom(layout);
      root.appendChild(page);
      layout.frames.forEach(frame=> appendFrameDom(page, layout, frame));
      layout.elements.forEach(element=> appendElementDom(page, layout, element));
    }
    if(page){
      page.classList.remove('hidden');
      updateEmptyHint(layout);
      layout.frames.forEach(frame=> ensureFrameInitialized(layout, frame));
      layout.elements.forEach(element=> refreshElementContent(layout, element));
    }
  }

  /* ============================================================
     FRAMES — criação, drag, resize, ativar/desativar, remover
     ============================================================ */
  function ensureFrameInitialized(layout, frame){
    if(frame.map){
      setTimeout(()=>{ try{ frame.map.invalidateSize(); }catch(e){} }, 0);
      return;
    }
    const container = document.getElementById('layout-frame-map-' + frame.id);
    if(!container) return;
    const ws = getWorkspaceByIdSafe(frame.workspaceId);
    const view = (ws && ws.mapView && ws.mapView.center) ? ws.mapView : {center:[20,0], zoom:2};

    let fmap;
    try{
      fmap = L.map(container, {
        zoomControl:false, attributionControl:false,
        dragging:false, scrollWheelZoom:false, doubleClickZoom:false,
        boxZoom:false, keyboard:false, touchZoom:false, tap:false,
        maxZoom:24
      }).setView(view.center, view.zoom || 2);
    }catch(err){ return; }

    tileLayerForKey(ws ? ws.activeBaseLayerKey : 'satelite').addTo(fmap);
    frame.map = fmap;
    frame.group = buildFrameLayerGroup(ws);
    frame.group.addTo(fmap);
    fmap.on('moveend zoomend', ()=> refreshScaleBarsForFrame(layout, frame));
    setTimeout(()=>{ try{ fmap.invalidateSize(); }catch(e){} refreshScaleBarsForFrame(layout, frame); }, 30);
  }

  function refreshFrameContent(layout, frame){
    if(!frame.map) return;
    const ws = getWorkspaceByIdSafe(frame.workspaceId);
    if(frame.group){ try{ frame.map.removeLayer(frame.group); }catch(e){} }
    frame.group = buildFrameLayerGroup(ws);
    frame.group.addTo(frame.map);
    refreshLegendsForFrame(layout, frame);
  }

  function appendFrameDom(page, layout, frame){
    const canvas = page.querySelector('.layout-canvas');
    if(!canvas) return;
    const ws = getWorkspaceByIdSafe(frame.workspaceId);
    const el = document.createElement('div');
    el.className = 'layout-frame';
    el.id = 'layout-frame-' + frame.id;
    el.style.left = frame.x + 'px';
    el.style.top = frame.y + 'px';
    el.style.width = frame.w + 'px';
    el.style.height = frame.h + 'px';
    el.innerHTML = `
      <div class="layout-frame-map" id="layout-frame-map-${frame.id}"></div>
      <div class="layout-frame-hover-bar" data-role="drag-handle" title="Arrastar para posicionar">
        <span class="layout-frame-hover-title">${safeEscape(ws ? ws.name : 'Mapa')}</span>
        <button type="button" class="layout-frame-hover-btn" data-action="toggle-active" title="Ativar navegação (duplo-clique também funciona)">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>
        </button>
        <button type="button" class="layout-frame-hover-btn danger" data-action="close" title="Remover deste layout">×</button>
      </div>
      ${['nw','n','ne','e','se','s','sw','w'].map(dir=>`<div class="layout-resize-handle rh-${dir}" data-dir="${dir}"></div>`).join('')}
    `;
    canvas.appendChild(el);
    wireFrameInteractions(layout, frame, el);
  }

  function wireFrameInteractions(layout, frame, el){
    const hoverBar = el.querySelector('.layout-frame-hover-bar');
    const mapBox = el.querySelector('.layout-frame-map');
    const closeBtn = el.querySelector('[data-action="close"]');
    const toggleBtn = el.querySelector('[data-action="toggle-active"]');

    closeBtn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      removeFrame(layout, frame, el);
    });
    toggleBtn.addEventListener('click', (ev)=>{
      ev.stopPropagation();
      toggleFrameActive(layout, frame, el);
    });

    /* -------- arrastar: pela barra flutuante (só visível em hover) ou
       diretamente pela caixa do mapa, sempre que o frame não está ativo -------- */
    function startDrag(ev){
      if(frame.active) return;
      ev.preventDefault();
      const startX = ev.clientX, startY = ev.clientY;
      const originX = frame.x, originY = frame.y;
      let moved = false;
      function onMove(mv){
        if(!moved && (Math.abs(mv.clientX-startX) > 2 || Math.abs(mv.clientY-startY) > 2)) moved = true;
        frame.x = originX + (mv.clientX - startX);
        frame.y = originY + (mv.clientY - startY);
        el.style.left = frame.x + 'px';
        el.style.top = frame.y + 'px';
      }
      function onUp(){
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    hoverBar.addEventListener('mousedown', (ev)=>{
      if(ev.target === closeBtn || ev.target === toggleBtn || closeBtn.contains(ev.target) || toggleBtn.contains(ev.target)) return;
      startDrag(ev);
    });
    mapBox.addEventListener('mousedown', (ev)=>{ startDrag(ev); });
    mapBox.addEventListener('dblclick', (ev)=>{
      ev.preventDefault();
      toggleFrameActive(layout, frame, el);
    });

    /* -------- redimensionar (pegas nas 8 direções) -------- */
    el.querySelectorAll('.layout-resize-handle').forEach(handle=>{
      handle.addEventListener('mousedown', (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        const dir = handle.dataset.dir;
        const startX = ev.clientX, startY = ev.clientY;
        const origin = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
        function onMove(mv){
          const dx = mv.clientX - startX, dy = mv.clientY - startY;
          let { x, y, w, h } = origin;
          if(dir.includes('e')) w = Math.max(MIN_FRAME_W, origin.w + dx);
          if(dir.includes('s')) h = Math.max(MIN_FRAME_H, origin.h + dy);
          if(dir.includes('w')){
            w = Math.max(MIN_FRAME_W, origin.w - dx);
            x = origin.x + (origin.w - w);
          }
          if(dir.includes('n')){
            h = Math.max(MIN_FRAME_H, origin.h - dy);
            y = origin.y + (origin.h - h);
          }
          frame.x = x; frame.y = y; frame.w = w; frame.h = h;
          el.style.left = x + 'px'; el.style.top = y + 'px';
          el.style.width = w + 'px'; el.style.height = h + 'px';
          if(frame.map){ try{ frame.map.invalidateSize(); }catch(e){} }
        }
        function onUp(){
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if(frame.map){ try{ frame.map.invalidateSize(); }catch(e){} }
          refreshScaleBarsForFrame(layout, frame);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });

    /* -------- botão direito: menu de contexto (Ativar/Remover) -------- */
    el.addEventListener('contextmenu', (ev)=>{
      ev.preventDefault();
      ev.stopPropagation();
      openFrameContextMenu(ev, layout, frame, el);
    });
  }

  function setFrameInteractive(frame, el, enabled){
    if(!frame.map) return;
    const m = frame.map;
    ['dragging','scrollWheelZoom','doubleClickZoom','boxZoom','touchZoom'].forEach(k=>{
      if(m[k]){ enabled ? m[k].enable() : m[k].disable(); }
    });
    if(m.tap) enabled ? (m.tap.enable && m.tap.enable()) : (m.tap.disable && m.tap.disable());
    el.classList.toggle('is-active-frame', enabled);
  }

  function toggleFrameActive(layout, frame, el){
    if(frame.active){
      frame.active = false;
      setFrameInteractive(frame, el, false);
      syncFrameToggleBtn(el, frame);
      return;
    }
    // desativa qualquer outro frame ativo (só um de cada vez, no layout inteiro)
    layouts.forEach(l=>{
      l.frames.forEach(f=>{
        if(f !== frame && f.active){
          f.active = false;
          const fe = document.getElementById('layout-frame-' + f.id);
          if(fe){ setFrameInteractive(f, fe, false); syncFrameToggleBtn(fe, f); }
        }
      });
    });
    frame.active = true;
    setFrameInteractive(frame, el, true);
    syncFrameToggleBtn(el, frame);
    if(frame.map) setTimeout(()=>{ try{ frame.map.invalidateSize(); }catch(e){} }, 0);
  }
  function syncFrameToggleBtn(el, frame){
    const btn = el.querySelector('[data-action="toggle-active"]');
    if(btn) btn.title = frame.active ? 'Desativar (voltar a arrastar)' : 'Ativar navegação (duplo-clique também funciona)';
  }

  function removeFrame(layout, frame, el){
    layout.frames = layout.frames.filter(f=>f!==frame);
    if(frame.map){ try{ frame.map.remove(); }catch(e){} frame.map = null; }
    if(el && el.parentNode) el.parentNode.removeChild(el);
    updateEmptyHint(layout);
    layout.elements.forEach(element=>{
      if((element.type === 'legend' || element.type === 'scale-bar') && element.refFrameId === frame.id){
        element.refFrameId = pickDefaultRefFrame(layout);
        refreshElementContent(layout, element);
      }
    });
  }

  /* ---------- menu de contexto do frame ---------- */
  function getFrameContextMenuEl(){ return document.getElementById('layout-frame-context-menu'); }

  function openFrameContextMenu(ev, layout, frame, el){
    const menu = getFrameContextMenuEl();
    if(!menu) return;
    menu.innerHTML = '';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.textContent = frame.active ? 'Desativar (voltar a arrastar)' : 'Ativar (navegar neste mapa)';
    toggleBtn.addEventListener('click', ()=>{ closeFrameContextMenu(); toggleFrameActive(layout, frame, el); });
    menu.appendChild(toggleBtn);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.textContent = 'Remover deste layout';
    removeBtn.addEventListener('click', ()=>{ closeFrameContextMenu(); removeFrame(layout, frame, el); });
    menu.appendChild(removeBtn);

    menu.classList.remove('hidden');
    const menuRect = menu.getBoundingClientRect();
    menu.style.top = Math.min(ev.clientY, window.innerHeight - menuRect.height - 8) + 'px';
    menu.style.left = Math.min(ev.clientX, window.innerWidth - menuRect.width - 8) + 'px';
  }
  function closeFrameContextMenu(){
    const menu = getFrameContextMenuEl();
    if(menu) menu.classList.add('hidden');
  }
  document.addEventListener('click', (ev)=>{
    const menu = getFrameContextMenuEl();
    if(menu && !menu.classList.contains('hidden') && !menu.contains(ev.target)) closeFrameContextMenu();
  });
  document.addEventListener('keydown', (ev)=>{
    if(ev.key === 'Escape') closeFrameContextMenu();
  });

  /* ============================================================
     ELEMENTOS DO LAYOUT — North Arrow, Legenda, Escala Gráfica,
     Texto e Formas geométricas. Comportam-se como objetos
     independentes (arrastar/redimensionar/remover), tal como os
     frames de mapa, mas mais leves: barra de arrasto sempre visível
     em vez de sobreposta ao mapa.
     ============================================================ */

  function appendElementDom(page, layout, element){
    const canvas = page.querySelector('.layout-canvas');
    if(!canvas) return;
    const def = ELEMENT_DEFS[element.type] || {};
    const el = document.createElement('div');
    el.className = 'layout-element layout-element-' + element.type;
    el.id = 'layout-element-' + element.id;
    el.style.left = element.x + 'px';
    el.style.top = element.y + 'px';
    el.style.width = element.w + 'px';
    el.style.height = element.h + 'px';

    const isText = element.type === 'text';
    const isBindable = element.type === 'legend' || element.type === 'scale-bar';
    const isShape = SHAPE_TYPES.indexOf(element.type) !== -1;

    el.innerHTML = `
      <div class="layout-element-bar" data-role="drag-handle" title="Arrastar para posicionar">
        <span class="layout-element-grip" aria-hidden="true">⠿</span>
        <span class="layout-element-label">${safeEscape(def.label || 'Elemento')}</span>
        <span class="layout-element-bar-tools">
          ${isText ? textToolbarButtonsHtml() : ''}
          ${isShape ? '<button type="button" class="layout-element-tool-btn" data-action="shape-props" title="Cor / contorno"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg></button>' : ''}
          ${isBindable ? '<button type="button" class="layout-element-tool-btn" data-action="bind-frame" title="Escolher mapa de referência"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg></button>' : ''}
          <button type="button" class="layout-element-tool-btn danger" data-action="close" title="Remover">×</button>
        </span>
      </div>
      <div class="layout-element-body">${elementBodyHtml(element)}</div>
      ${['nw','n','ne','e','se','s','sw','w'].map(dir=>`<div class="layout-resize-handle rh-${dir}" data-dir="${dir}"></div>`).join('')}
    `;
    canvas.appendChild(el);
    wireElementInteractions(layout, element, el);
    if(isText) wireTextElement(layout, element, el);
  }

  function elementBodyHtml(element){
    switch(element.type){
      case 'north-arrow': return northArrowSvg();
      case 'legend': return `<div class="layout-el-legend-body" id="layout-el-legend-${element.id}"><div class="layout-el-legend-empty">Sem mapa associado</div></div>`;
      case 'scale-bar': return `<div class="layout-el-scale-body" id="layout-el-scale-${element.id}"><div class="layout-el-scale-empty">—</div></div>`;
      case 'text': return `<div class="layout-el-text-body" id="layout-el-text-${element.id}" contenteditable="true" spellcheck="false">${element.data.html || 'Texto'}</div>`;
      case 'shape-rect': return `<div class="layout-el-shape layout-el-shape-rect" style="${shapeFillStyle(element)}"></div>`;
      case 'shape-circle': return `<div class="layout-el-shape layout-el-shape-circle" style="${shapeFillStyle(element)}"></div>`;
      case 'shape-line': return shapeSvg(element, 'line');
      case 'shape-arrow': return shapeSvg(element, 'arrow');
      case 'shape-polygon': return shapeSvg(element, 'polygon');
      default: return '';
    }
  }

  function shapeFillStyle(element){
    const d = element.data || {};
    return `background:${d.fill||'rgba(31,92,107,.18)'}; border:${d.strokeWidth||2}px solid ${d.stroke||'#1F5C6B'};`;
  }

  function shapeSvg(element, kind){
    const d = element.data || {};
    const stroke = d.stroke || '#1F5C6B';
    const sw = d.strokeWidth || 2;
    const fill = d.fill || 'none';
    if(kind === 'line'){
      return `<svg class="layout-el-shape-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <line x1="4" y1="50" x2="96" y2="50" stroke="${stroke}" stroke-width="${sw}" vector-effect="non-scaling-stroke" />
      </svg>`;
    }
    if(kind === 'arrow'){
      const markerId = 'arrowhead-' + element.id;
      return `<svg class="layout-el-shape-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs><marker id="${markerId}" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="${stroke}"/></marker></defs>
        <line x1="4" y1="50" x2="90" y2="50" stroke="${stroke}" stroke-width="${sw}" vector-effect="non-scaling-stroke" marker-end="url(#${markerId})" />
      </svg>`;
    }
    // polygon — forma pentagonal por omissão
    return `<svg class="layout-el-shape-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
      <polygon points="50,4 96,38 78,96 22,96 4,38" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" vector-effect="non-scaling-stroke" />
    </svg>`;
  }

  function northArrowSvg(){
    return `<svg class="layout-el-northarrow-svg" viewBox="0 0 60 80" xmlns="http://www.w3.org/2000/svg">
      <polygon points="30,2 44,54 30,42" fill="currentColor"/>
      <polygon points="30,2 16,54 30,42" fill="none" stroke="currentColor" stroke-width="2"/>
      <text x="30" y="72" text-anchor="middle" font-family="'IBM Plex Sans', sans-serif" font-size="16" font-weight="700" fill="currentColor">N</text>
    </svg>`;
  }

  function textToolbarButtonsHtml(){
    return `
      <button type="button" class="layout-element-tool-btn" data-cmd="bold" title="Negrito"><b>B</b></button>
      <button type="button" class="layout-element-tool-btn" data-cmd="italic" title="Itálico"><i>I</i></button>
      <button type="button" class="layout-element-tool-btn" data-cmd="underline" title="Sublinhado"><u>S</u></button>
      <button type="button" class="layout-element-tool-btn" data-cmd="font-dec" title="Diminuir texto">A-</button>
      <button type="button" class="layout-element-tool-btn" data-cmd="font-inc" title="Aumentar texto">A+</button>
      <input type="color" class="layout-element-color-input" data-cmd="color" value="#14181A" title="Cor do texto" />
    `;
  }

  /* -------- interações genéricas: arrastar / redimensionar / remover -------- */
  function wireElementInteractions(layout, element, el){
    const bar = el.querySelector('.layout-element-bar');
    const closeBtn = el.querySelector('[data-action="close"]');
    const bindBtn = el.querySelector('[data-action="bind-frame"]');
    const propsBtn = el.querySelector('[data-action="shape-props"]');

    if(closeBtn) closeBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); removeElement(layout, element, el); });
    if(bindBtn) bindBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); openBindFrameMenu(bindBtn, layout, element); });
    if(propsBtn) propsBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); openShapePropsPopover(propsBtn, layout, element, el); });

    bar.addEventListener('mousedown', (ev)=>{
      if(ev.target.closest('.layout-element-tool-btn') || ev.target.closest('.layout-element-color-input')) return;
      ev.preventDefault();
      const startX = ev.clientX, startY = ev.clientY;
      const originX = element.x, originY = element.y;
      function onMove(mv){
        element.x = originX + (mv.clientX - startX);
        element.y = originY + (mv.clientY - startY);
        el.style.left = element.x + 'px';
        el.style.top = element.y + 'px';
      }
      function onUp(){
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    const def = ELEMENT_DEFS[element.type] || {};
    const minW = def.minW || MIN_ELEMENT_W, minH = def.minH || MIN_ELEMENT_H;
    el.querySelectorAll('.layout-resize-handle').forEach(handle=>{
      handle.addEventListener('mousedown', (ev)=>{
        ev.preventDefault();
        ev.stopPropagation();
        const dir = handle.dataset.dir;
        const origin = { x: element.x, y: element.y, w: element.w, h: element.h };
        const aspect = origin.w / origin.h;
        const startX = ev.clientX, startY = ev.clientY;
        function onMove(mv){
          const dx = mv.clientX - startX, dy = mv.clientY - startY;
          let { x, y, w, h } = origin;
          if(dir.includes('e')) w = Math.max(minW, origin.w + dx);
          if(dir.includes('s')) h = Math.max(minH, origin.h + dy);
          if(dir.includes('w')){ w = Math.max(minW, origin.w - dx); x = origin.x + (origin.w - w); }
          if(dir.includes('n')){ h = Math.max(minH, origin.h - dy); y = origin.y + (origin.h - h); }
          if(def.lockAspect){ h = Math.max(minH, Math.round(w / aspect)); }
          element.x = x; element.y = y; element.w = w; element.h = h;
          el.style.left = x + 'px'; el.style.top = y + 'px';
          el.style.width = w + 'px'; el.style.height = h + 'px';
        }
        function onUp(){
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if(element.type === 'legend' || element.type === 'scale-bar') refreshElementContent(layout, element);
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  function removeElement(layout, element, el){
    layout.elements = layout.elements.filter(e=>e!==element);
    if(el && el.parentNode) el.parentNode.removeChild(el);
    updateEmptyHint(layout);
  }

  /* -------- texto: formatação básica via execCommand -------- */
  function wireTextElement(layout, element, el){
    const body = el.querySelector('.layout-el-text-body');
    if(!body) return;
    body.addEventListener('mousedown', ev=> ev.stopPropagation());
    body.addEventListener('blur', ()=>{ element.data.html = body.innerHTML; });

    el.querySelectorAll('[data-cmd]').forEach(ctrl=>{
      const cmd = ctrl.dataset.cmd;
      if(ctrl.tagName === 'INPUT'){
        ctrl.addEventListener('mousedown', ev=> ev.stopPropagation());
        ctrl.addEventListener('input', ()=>{
          body.focus();
          document.execCommand('foreColor', false, ctrl.value);
          element.data.html = body.innerHTML;
        });
        return;
      }
      ctrl.addEventListener('mousedown', ev=>{ ev.preventDefault(); ev.stopPropagation(); });
      ctrl.addEventListener('click', ()=>{
        body.focus();
        if(cmd === 'bold' || cmd === 'italic' || cmd === 'underline'){
          document.execCommand(cmd, false, null);
        } else if(cmd === 'font-inc' || cmd === 'font-dec'){
          const current = parseInt(window.getComputedStyle(body).fontSize, 10) || 14;
          body.style.fontSize = Math.max(9, current + (cmd === 'font-inc' ? 2 : -2)) + 'px';
        }
        element.data.html = body.innerHTML;
      });
    });
  }

  /* -------- formas: popover simples de cor/contorno -------- */
  function getShapePropsPopoverEl(){ return document.getElementById('layout-shape-props-popover'); }
  function closeShapePropsPopover(){
    const pop = getShapePropsPopoverEl();
    if(pop) pop.classList.add('hidden');
  }
  function openShapePropsPopover(anchorBtn, layout, element, el){
    let pop = getShapePropsPopoverEl();
    if(!pop){
      pop = document.createElement('div');
      pop.id = 'layout-shape-props-popover';
      pop.className = 'layout-shape-props-popover hidden';
      document.body.appendChild(pop);
    }
    const d = element.data || {};
    const isLinear = element.type === 'shape-line' || element.type === 'shape-arrow';
    pop.innerHTML = `
      ${!isLinear ? `<label>Preenchimento <input type="color" data-prop="fill" value="${toHexColor(d.fill) || '#1F5C6B'}"></label>` : ''}
      <label>Contorno <input type="color" data-prop="stroke" value="${toHexColor(d.stroke) || '#1F5C6B'}"></label>
      <label>Espessura <input type="range" min="1" max="10" data-prop="strokeWidth" value="${d.strokeWidth||2}"></label>
    `;
    pop.querySelectorAll('[data-prop]').forEach(inp=>{
      inp.addEventListener('input', ()=>{
        const prop = inp.dataset.prop;
        if(prop === 'fill') element.data.fill = inp.value;
        else if(prop === 'stroke') element.data.stroke = inp.value;
        else if(prop === 'strokeWidth') element.data.strokeWidth = Number(inp.value);
        refreshElementContent(layout, element);
      });
    });
    pop.classList.remove('hidden');
    const rect = anchorBtn.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    pop.style.top = (rect.bottom + 6) + 'px';
    pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - popRect.width - 8)) + 'px';
  }
  function toHexColor(v){
    if(!v || v === 'none' || v.indexOf('rgba') === 0) return null;
    return v;
  }
  document.addEventListener('click', (ev)=>{
    const pop = getShapePropsPopoverEl();
    if(pop && !pop.classList.contains('hidden') && !pop.contains(ev.target) && !ev.target.closest('[data-action="shape-props"]')) closeShapePropsPopover();
  });

  /* -------- legenda / escala: escolher o frame (mapa) de referência -------- */
  function getBindFrameMenuEl(){ return document.getElementById('layout-bind-frame-menu'); }
  function closeBindFrameMenu(){
    const menu = getBindFrameMenuEl();
    if(menu) menu.classList.add('hidden');
  }
  function openBindFrameMenu(anchorBtn, layout, element){
    let menu = getBindFrameMenuEl();
    if(!menu){
      menu = document.createElement('div');
      menu.id = 'layout-bind-frame-menu';
      menu.className = 'layout-content-menu hidden';
      document.body.appendChild(menu);
    }
    menu.innerHTML = '';
    if(!layout.frames.length){
      menu.innerHTML = '<div class="layout-content-menu-empty">Adiciona primeiro um mapa ao layout.</div>';
    } else {
      layout.frames.forEach(frame=>{
        const ws = getWorkspaceByIdSafe(frame.workspaceId);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'layout-content-menu-item';
        item.textContent = (ws ? ws.name : 'Mapa') + (element.refFrameId === frame.id ? ' ✓' : '');
        item.addEventListener('click', ()=>{
          element.refFrameId = frame.id;
          closeBindFrameMenu();
          refreshElementContent(layout, element);
        });
        menu.appendChild(item);
      });
    }
    menu.classList.remove('hidden');
    const rect = anchorBtn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8)) + 'px';
  }
  document.addEventListener('click', (ev)=>{
    const menu = getBindFrameMenuEl();
    if(menu && !menu.classList.contains('hidden') && !menu.contains(ev.target) && !ev.target.closest('[data-action="bind-frame"]')) closeBindFrameMenu();
  });

  function pickDefaultRefFrame(layout){
    const active = layout.frames.find(f=>f.active);
    return active ? active.id : (layout.frames[0] ? layout.frames[0].id : null);
  }

  /* -------- conteúdo dinâmico: legenda + escala gráfica -------- */
  function refreshElementContent(layout, element){
    const el = document.getElementById('layout-element-' + element.id);
    if(el){
      const body = el.querySelector('.layout-element-body');
      if(body && (element.type.indexOf('shape-') === 0)){
        body.innerHTML = elementBodyHtml(element);
      }
    }
    if(element.type === 'legend') renderLegendElement(layout, element);
    if(element.type === 'scale-bar') updateScaleBarElement(layout, element);
  }

  function buildLegendItems(ws){
    if(!ws) return [];
    const order = Array.isArray(ws.layerOrder) ? ws.layerOrder.slice() : [];
    const seen = new Set(order);
    if(ws.featuresData instanceof Map){
      ws.featuresData.forEach(entry=>{ if(!seen.has(entry.layerId)){ seen.add(entry.layerId); order.push(entry.layerId); } });
    }
    const items = [];
    order.forEach(layerId=>{
      const visible = (ws.layerVisible instanceof Map) ? ws.layerVisible.get(layerId) !== false : true;
      if(!visible) return;
      const schema = getLayerSchemaForWorkspace(ws, layerId);
      if(!schema) return;
      const swatches = (typeof layerSwatchColors === 'function')
        ? layerSwatchColors(schema)
        : [{ color: schema.baseColor || (typeof DEFAULT_COLOR !== 'undefined' ? DEFAULT_COLOR : '#F5821F'), label: null }];
      items.push({ layerName: schema.name || 'Camada', geometryType: schema.geometryType, swatches });
    });
    return items;
  }

  function swatchShapeClass(geometryType){
    if(geometryType === 'point' || geometryType === 'ponto') return 'is-point';
    if(geometryType === 'line' || geometryType === 'linha') return 'is-line';
    return 'is-polygon';
  }

  function renderLegendElement(layout, element){
    const body = document.getElementById('layout-el-legend-' + element.id);
    if(!body) return;
    if(!element.refFrameId) element.refFrameId = pickDefaultRefFrame(layout);
    const frame = layout.frames.find(f=>f.id===element.refFrameId);
    if(!frame){ body.innerHTML = '<div class="layout-el-legend-empty">Sem mapa associado — usa o ícone de vínculo.</div>'; return; }
    const ws = getWorkspaceByIdSafe(frame.workspaceId);
    const items = buildLegendItems(ws);
    if(!items.length){ body.innerHTML = '<div class="layout-el-legend-empty">Sem camadas visíveis neste mapa.</div>'; return; }
    body.innerHTML = items.map(it=>`
      <div class="layout-el-legend-group">
        <div class="layout-el-legend-layer-name">${safeEscape(it.layerName)}</div>
        ${it.swatches.map(sw=>`
          <div class="layout-el-legend-row">
            <span class="layout-el-legend-swatch ${swatchShapeClass(it.geometryType)}" style="background:${sw.color||'#999'}"></span>
            <span class="layout-el-legend-label">${safeEscape(sw.label != null ? String(sw.label) : it.layerName)}</span>
          </div>`).join('')}
      </div>`).join('');
  }

  function refreshLegendsForFrame(layout, frame){
    layout.elements.forEach(element=>{
      if(element.type === 'legend' && element.refFrameId === frame.id) renderLegendElement(layout, element);
    });
  }

  /* algoritmo do Leaflet (L.Control.Scale) para arredondar a distância a um
     valor "bonito" — reproduzido aqui porque os frames não usam o controlo
     nativo (zoomControl/attribution desligados e o Leaflet não expõe a
     função isoladamente). */
  function niceRoundNumber(num){
    const pow10 = Math.pow(10, (Math.floor(num) + '').length - 1);
    let d = num / pow10;
    d = d >= 10 ? 10 : d >= 5 ? 5 : d >= 3 ? 3 : d >= 2 ? 2 : 1;
    return pow10 * d;
  }

  function updateScaleBarElement(layout, element){
    const body = document.getElementById('layout-el-scale-' + element.id);
    if(!body) return;
    if(!element.refFrameId) element.refFrameId = pickDefaultRefFrame(layout);
    const frame = layout.frames.find(f=>f.id===element.refFrameId);
    if(!frame || !frame.map){ body.innerHTML = '<div class="layout-el-scale-empty">Sem mapa associado — usa o ícone de vínculo.</div>'; return; }
    const map = frame.map;
    const maxWidthPx = Math.max(50, element.w - 24);
    let maxMeters;
    try{
      const y = map.getSize().y / 2;
      maxMeters = map.distance(map.containerPointToLatLng([0, y]), map.containerPointToLatLng([maxWidthPx, y]));
    }catch(err){ maxMeters = 0; }
    if(!maxMeters){ body.innerHTML = '<div class="layout-el-scale-empty">—</div>'; return; }
    const meters = niceRoundNumber(maxMeters);
    const barWidthPx = Math.round(maxWidthPx * (meters / maxMeters));
    const label = meters >= 1000 ? (Math.round((meters/1000) * 100) / 100) + ' km' : Math.round(meters) + ' m';
    body.innerHTML = `
      <div class="layout-scale-bar-visual" style="width:${barWidthPx}px"></div>
      <div class="layout-scale-bar-label">${label}</div>
    `;
  }

  function refreshScaleBarsForFrame(layout, frame){
    layout.elements.forEach(element=>{
      if(element.type === 'scale-bar' && element.refFrameId === frame.id) updateScaleBarElement(layout, element);
    });
  }

  /* -------- adicionar elemento ao layout atual -------- */
  function addElementToCurrentLayout(type){
    const layout = layouts.find(l=>l.id===currentLayoutId);
    if(!layout) return;
    const offset = layout.elements.length * 22;
    const element = createElementState(type, 60 + offset, 60 + offset);
    if(element.type === 'legend' || element.type === 'scale-bar') element.refFrameId = pickDefaultRefFrame(layout);
    layout.elements.push(element);
    const page = document.getElementById('layout-page-' + layout.id);
    if(page){
      appendElementDom(page, layout, element);
      updateEmptyHint(layout);
      refreshElementContent(layout, element);
    }
  }

  /* ============================================================
     MENU "+ ELEMENTO"
     ============================================================ */
  function getAddElementMenuEl(){ return document.getElementById('layout-add-element-menu'); }
  function closeAddElementMenu(){
    const menu = getAddElementMenuEl();
    if(menu) menu.classList.add('hidden');
  }
  function openAddElementMenu(anchorBtn){
    let menu = getAddElementMenuEl();
    if(!menu){
      menu = document.createElement('div');
      menu.id = 'layout-add-element-menu';
      menu.className = 'layout-content-menu layout-add-element-menu hidden';
      document.body.appendChild(menu);
    }
    const items = [
      { type:'north-arrow', label:'Seta Norte' },
      { type:'legend', label:'Legenda' },
      { type:'scale-bar', label:'Escala Gráfica' },
      { type:'text', label:'Texto' }
    ];
    menu.innerHTML = '';
    items.forEach(it=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'layout-content-menu-item';
      btn.textContent = it.label;
      btn.addEventListener('click', ()=>{ closeAddElementMenu(); addElementToCurrentLayout(it.type); });
      menu.appendChild(btn);
    });
    const shapesHeader = document.createElement('div');
    shapesHeader.className = 'layout-content-menu-section';
    shapesHeader.textContent = 'Formas';
    menu.appendChild(shapesHeader);
    [
      { type:'shape-rect', label:'Retângulo' },
      { type:'shape-circle', label:'Círculo' },
      { type:'shape-line', label:'Linha' },
      { type:'shape-arrow', label:'Seta' },
      { type:'shape-polygon', label:'Polígono' }
    ].forEach(it=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'layout-content-menu-item';
      btn.textContent = it.label;
      btn.addEventListener('click', ()=>{ closeAddElementMenu(); addElementToCurrentLayout(it.type); });
      menu.appendChild(btn);
    });
    menu.classList.remove('hidden');
    const rect = anchorBtn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8)) + 'px';
  }
  document.addEventListener('click', (ev)=>{
    const menu = getAddElementMenuEl();
    if(menu && !menu.classList.contains('hidden') && !menu.contains(ev.target) && !ev.target.closest('.layout-page-add-element-btn')) closeAddElementMenu();
  });

  /* ============================================================
     EXPORTAÇÃO — PDF / JPG / PNG (via html2canvas + jsPDF, carregados
     por CDN em engenh.html). A exportação captura apenas a folha de
     composição (.layout-canvas), escondendo pegas/barras de arrasto.
     ============================================================ */
  function getExportMenuEl(){ return document.getElementById('layout-export-menu'); }
  function closeExportMenu(){
    const menu = getExportMenuEl();
    if(menu) menu.classList.add('hidden');
  }
  function openExportMenu(anchorBtn, layout){
    let menu = getExportMenuEl();
    if(!menu){
      menu = document.createElement('div');
      menu.id = 'layout-export-menu';
      menu.className = 'layout-content-menu layout-export-menu hidden';
      document.body.appendChild(menu);
    }
    menu.innerHTML = '';
    [
      { fmt:'pdf', label:'Exportar para PDF' },
      { fmt:'png', label:'Exportar para PNG' },
      { fmt:'jpg', label:'Exportar para JPG' }
    ].forEach(it=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'layout-content-menu-item';
      btn.textContent = it.label;
      btn.addEventListener('click', ()=>{ closeExportMenu(); runLayoutExport(layout, it.fmt); });
      menu.appendChild(btn);
    });
    menu.classList.remove('hidden');
    const rect = anchorBtn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8)) + 'px';
  }
  document.addEventListener('click', (ev)=>{
    const menu = getExportMenuEl();
    if(menu && !menu.classList.contains('hidden') && !menu.contains(ev.target) && !ev.target.closest('.layout-page-export-btn')) closeExportMenu();
  });

  function runLayoutExport(layout, fmt){
    const page = document.getElementById('layout-page-' + layout.id);
    const canvasEl = page ? page.querySelector('.layout-canvas') : null;
    if(!canvasEl) return;
    if(typeof html2canvas !== 'function'){
      alert('Biblioteca de exportação (html2canvas) não está disponível.');
      return;
    }
    canvasEl.classList.add('layout-exporting');
    const restore = ()=> canvasEl.classList.remove('layout-exporting');
    const bg = (document.body.classList.contains('theme-dark') || document.documentElement.classList.contains('theme-dark')) ? '#14181A' : '#ffffff';
    html2canvas(canvasEl, { backgroundColor: bg, useCORS: true, scale: 2 }).then(canvas=>{
      restore();
      const safeName = (layout.name || 'layout').replace(/[^a-z0-9\-_]+/gi, '_');
      if(fmt === 'pdf'){
        if(!(window.jspdf && window.jspdf.jsPDF)){
          alert('Biblioteca de exportação (jsPDF) não está disponível.');
          return;
        }
        const { jsPDF } = window.jspdf;
        const orientation = canvas.width >= canvas.height ? 'landscape' : 'portrait';
        const pdf = new jsPDF({ orientation, unit:'pt', format:[canvas.width, canvas.height] });
        pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, canvas.width, canvas.height);
        pdf.save(safeName + '.pdf');
        return;
      }
      const mime = fmt === 'jpg' ? 'image/jpeg' : 'image/png';
      const link = document.createElement('a');
      link.download = safeName + '.' + fmt;
      link.href = canvas.toDataURL(mime, 0.92);
      link.click();
    }).catch(err=>{
      restore();
      console.error('Falha ao exportar layout:', err);
      alert('Não foi possível exportar o layout.');
    });
  }

  /* ============================================================
     MENU "ADICIONAR CONTEÚDO" — escolher workspace a inserir
     ============================================================ */
  function getAddContentMenuEl(){ return document.getElementById('layout-content-menu'); }

  function getAddContentBtnEl(){
    const visiblePage = document.querySelector('.layout-page:not(.hidden)');
    const pageBtn = visiblePage ? visiblePage.querySelector('.layout-page-add-content-btn') : null;
    return pageBtn || document.getElementById('layout-add-content-btn');
  }

  function openAddContentMenu(){
    const layout = layouts.find(l=>l.id===currentLayoutId);
    if(!layout) return;
    if(layout.frames.length >= MAX_FRAMES_PER_LAYOUT){
      alert('Este layout já tem o máximo de ' + MAX_FRAMES_PER_LAYOUT + ' mapas.');
      return;
    }
    const menu = getAddContentMenuEl();
    const btn = getAddContentBtnEl();
    if(!menu || !btn) return;
    menu.innerHTML = '';

    const list = getWorkspacesListSafe();
    if(!list.length){
      menu.innerHTML = '<div class="layout-content-menu-empty">Sem mapas disponíveis.</div>';
    } else {
      list.forEach(ws=>{
        const already = layout.frames.some(f=>f.workspaceId===ws.id);
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'layout-content-menu-item';
        item.textContent = (ws.name || 'Mapa') + (already ? ' (já adicionado)' : '');
        item.addEventListener('click', ()=>{
          closeAddContentMenu();
          addFrameToCurrentLayout(ws.id);
        });
        menu.appendChild(item);
      });
    }

    menu.classList.remove('hidden');
    const rect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8)) + 'px';
  }
  function closeAddContentMenu(){
    const menu = getAddContentMenuEl();
    if(menu) menu.classList.add('hidden');
  }
  document.addEventListener('click', (ev)=>{
    const menu = getAddContentMenuEl();
    const btn = getAddContentBtnEl();
    if(menu && !menu.classList.contains('hidden') && !menu.contains(ev.target) && ev.target !== btn && !(btn && btn.contains(ev.target))){
      closeAddContentMenu();
    }
  });

  function addFrameToCurrentLayout(workspaceId){
    const layout = layouts.find(l=>l.id===currentLayoutId);
    if(!layout) return;
    if(layout.frames.length >= MAX_FRAMES_PER_LAYOUT){
      alert('Este layout já tem o máximo de ' + MAX_FRAMES_PER_LAYOUT + ' mapas.');
      return;
    }
    const offset = layout.frames.length * 28;
    const frame = createFrameState('frame-' + Date.now() + '-' + Math.floor(Math.random()*1000), workspaceId, 40 + offset, 40 + offset);
    layout.frames.push(frame);
    const page = document.getElementById('layout-page-' + layout.id);
    if(page){
      appendFrameDom(page, layout, frame);
      updateEmptyHint(layout);
      ensureFrameInitialized(layout, frame);
    }
  }

  /* ============================================================
     CRIAR / ATIVAR LAYOUTS
     ============================================================ */
  function createAndActivateNewLayout(){
    layoutCounter += 1;
    const layout = createLayoutState('layout-' + Date.now() + '-' + layoutCounter, 'Layout ' + layoutCounter);
    layouts.push(layout);
    activateLayout(layout.id);
  }

  function activateLayout(id){
    const layout = layouts.find(l=>l.id===id);
    if(!layout) return;
    if(typeof persistCurrentWorkspaceState === 'function') persistCurrentWorkspaceState();
    currentLayoutId = id;
    activeTabKind = 'layout';
    showLayoutPage(layout);
    updateAddContentBtnVisibility();
    if(typeof renderWorkspaceTabs === 'function') renderWorkspaceTabs();
  }

  function closeLayout(id){
    const layout = layouts.find(l=>l.id===id);
    if(!layout) return;
    layout.frames.forEach(f=>{ if(f.map){ try{ f.map.remove(); }catch(e){} } });
    const page = document.getElementById('layout-page-' + id);
    if(page && page.parentNode) page.parentNode.removeChild(page);
    layouts = layouts.filter(l=>l.id!==id);
    if(currentLayoutId === id){
      currentLayoutId = null;
      activeTabKind = 'workspace';
      updateAddContentBtnVisibility();
    }
    if(typeof renderWorkspaceTabs === 'function') renderWorkspaceTabs();
  }

  function updateAddContentBtnVisibility(){
    const wrap = document.getElementById('layout-add-content-wrap');
    if(wrap) wrap.classList.toggle('hidden', activeTabKind !== 'layout');
  }

  /* ============================================================
     MODAL "Novo Workspace" / "Novo Layout"
     ============================================================ */
  function openAddMapChoice(){
    const overlay = document.getElementById('add-map-choice-overlay');
    if(overlay) overlay.classList.remove('hidden');
  }
  function closeAddMapChoice(){
    const overlay = document.getElementById('add-map-choice-overlay');
    if(overlay) overlay.classList.add('hidden');
  }

  function wireAddMapChoiceModal(){
    const overlay = document.getElementById('add-map-choice-overlay');
    if(!overlay) return;
    overlay.querySelectorAll('[data-add-map-choice]').forEach(card=>{
      card.addEventListener('click', ()=>{
        const choice = card.dataset.addMapChoice;
        closeAddMapChoice();
        if(choice === 'layout'){
          createAndActivateNewLayout();
        } else if(typeof createAndActivateNewWorkspace === 'function'){
          createAndActivateNewWorkspace();
        }
      });
    });
    const cancelBtn = document.getElementById('add-map-choice-cancel');
    if(cancelBtn) cancelBtn.addEventListener('click', closeAddMapChoice);
    overlay.addEventListener('click', (ev)=>{ if(ev.target === overlay) closeAddMapChoice(); });
  }

  /* ============================================================
     SEPARADORES DE LAYOUT NA BARRA DE TABS
     ============================================================ */
  function renderLayoutTabsInto(container){
    if(!container) return;
    layouts.forEach(layout=>{
      const tab = document.createElement('div');
      tab.className = 'layout-tab' + (activeTabKind==='layout' && layout.id===currentLayoutId ? ' is-active' : '');
      tab.setAttribute('role', 'button');
      tab.tabIndex = 0;
      tab.title = 'Layout: ' + (layout.name || '');

      const icon = document.createElement('span');
      icon.className = 'layout-tab-icon';
      icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
      tab.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'layout-tab-label';
      label.textContent = layout.name || 'Layout';
      tab.appendChild(label);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'layout-tab-close';
      closeBtn.title = 'Fechar layout';
      closeBtn.setAttribute('aria-label', 'Fechar layout');
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (ev)=>{ ev.stopPropagation(); closeLayout(layout.id); });
      tab.appendChild(closeBtn);

      const activate = ()=> activateLayout(layout.id);
      tab.addEventListener('click', activate);
      tab.addEventListener('keydown', (ev)=>{
        if(ev.key==='Enter' || ev.key===' '){ ev.preventDefault(); activate(); }
      });

      container.appendChild(tab);
    });
  }

  /* ============================================================
     GANCHOS PÚBLICOS (chamados a partir de 05-app-main.js)
     ============================================================ */
  window.isLayoutViewActive = function(){ return activeTabKind === 'layout'; };

  window.renderLayoutTabsInto = renderLayoutTabsInto;

  window.handleAddMapClick = function(){ openAddMapChoice(); };

  window.leaveLayoutView = function(){
    if(activeTabKind !== 'layout') return;
    activeTabKind = 'workspace';
    currentLayoutId = null;
    hideAllLayoutPages();
    updateAddContentBtnVisibility();
  };

  window.notifyLayoutsWorkspaceChanged = function(workspace){
    if(!workspace || !layouts.length) return;
    layouts.forEach(layout=>{
      layout.frames.forEach(frame=>{
        if(frame.workspaceId === workspace.id) refreshFrameContent(layout, frame);
      });
    });
  };

  /* ============================================================
     ARRANQUE — este script carrega no fim do <body> (depois de
     05-app-main.js), tal como 08-tools-menu.js, por isso o DOM já
     está disponível e não é preciso esperar por DOMContentLoaded.
     ============================================================ */
  function init(){
    wireAddMapChoiceModal();
    const addContentBtn = document.getElementById('layout-add-content-btn');
    if(addContentBtn){
      addContentBtn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        const menu = getAddContentMenuEl();
        if(menu && !menu.classList.contains('hidden')) closeAddContentMenu(); else openAddContentMenu();
      });
    }
    window.addEventListener('resize', ()=>{
      if(activeTabKind !== 'layout') return;
      const layout = layouts.find(l=>l.id===currentLayoutId);
      if(!layout) return;
      layout.frames.forEach(f=>{ if(f.map){ try{ f.map.invalidateSize(); }catch(e){} } });
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
