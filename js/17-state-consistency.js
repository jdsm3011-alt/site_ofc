/* ============================================================
   CAMADA 3 — State Consistency Check
   Verifica que featuresData, drawnGroup, layers, layerOrder,
   layerVisible, layerPanes e activeLayerId estao sincronizados.
   ============================================================ */
(function(){
  'use strict';

  /* ---------- access globals safely ---------- */
  function g(name){
    try {
      var fn = new Function('try { return ' + name + '; } catch(e){ return undefined; }');
      return fn();
    } catch(e){ return undefined; }
  }

  function isObj(o){ return o !== null && typeof o === 'object'; }
  function isFn(o){ return typeof o === 'function'; }
  function isNum(o){ return typeof o === 'number' && isFinite(o); }

  /* ---------- checks ---------- */
  function runChecks(){
    var issues = [];
    var featuresData = g('featuresData');
    var drawnGroup   = g('drawnGroup');
    var layers       = g('layers');
    var layerOrder   = g('layerOrder');
    var layerVisible = g('layerVisible');
    var layerPanes   = g('layerPanes');
    var activeLayerId= g('activeLayerId');
    var layerCounter = g('layerCounter');
    var getLayerSchema = g('getLayerSchema');
    var countLayerFeatures = g('countLayerFeatures');

    /* ---- 1: activeLayerId valido ---- */
    if(isNum(activeLayerId)){
      if(activeLayerId !== 0){
        var schema = isFn(getLayerSchema) ? getLayerSchema(activeLayerId) : null;
        if(!schema){
          issues.push({check:'activeLayerId', severity:'error',
            msg:'activeLayerId (' + activeLayerId + ') nao corresponde a nenhuma camada ativa ou arquivada.'});
        }
      }
    } else if(activeLayerId !== undefined){
      issues.push({check:'activeLayerId', severity:'error',
        msg:'activeLayerId e invalido: ' + JSON.stringify(activeLayerId)});
    }

    /* ---- 2: layerOrder vs layers ---- */
    if(Array.isArray(layerOrder) && Array.isArray(layers)){
      var allKnownIds = layers.map(function(l){ return l.id; });
      if(isNum(activeLayerId) && activeLayerId !== 0) allKnownIds.push(activeLayerId);

      var extraInOrder = layerOrder.filter(function(id){ return allKnownIds.indexOf(id) === -1; });
      if(extraInOrder.length){
        issues.push({check:'layerOrder', severity:'error',
          msg:'layerOrder contem IDs desconhecidos: [' + extraInOrder.join(', ') + ']'});
      }
    }

    /* ---- 3: layerVisible vs layers ---- */
    if(isObj(layerVisible) && Array.isArray(layers)){
      var visKeys = isFn(layerVisible.entries)
        ? Array.from(layerVisible.entries()).map(function(e){ return e[0]; })
        : Object.keys(layerVisible);
      var allKnownIds2 = layers.map(function(l){ return l.id; });
      if(isNum(activeLayerId) && activeLayerId !== 0) allKnownIds2.push(activeLayerId);

      var extraVis = visKeys.filter(function(k){ return allKnownIds2.indexOf(Number(k)) === -1 && allKnownIds2.indexOf(k) === -1; });
      if(extraVis.length){
        issues.push({check:'layerVisible', severity:'warn',
          msg:'layerVisible contem keys de camadas inexistentes: [' + extraVis.join(', ') + ']'});
      }
    }

    /* ---- 4: layerPanes vs layerOrder ---- */
    if(isObj(layerPanes) && Array.isArray(layerOrder)){
      var paneKeys = isFn(layerPanes.keys) ? Array.from(layerPanes.keys()) : Object.keys(layerPanes).map(Number);
      var orphanPanes = paneKeys.filter(function(k){ return layerOrder.indexOf(k) === -1; });
      if(orphanPanes.length){
        issues.push({check:'layerPanes', severity:'warn',
          msg:'layerPanes contem panes sem entrada em layerOrder: [' + orphanPanes.join(', ') + ']'});
      }
    }

    /* ---- 5: featuresData vs drawnGroup ---- */
    if(isObj(featuresData) && isObj(drawnGroup) && isFn(drawnGroup.hasLayer)){
      var orphanFeatures = [];
      var ghostLayers = [];

      /* features em featuresData que nao estao no drawnGroup */
      if(isFn(featuresData.forEach)){
        featuresData.forEach(function(entry, id){
          if(!entry || !entry.layer) return;
          if(!drawnGroup.hasLayer(entry.layer)){
            orphanFeatures.push({id: id, label: entry.label || '?', layerId: entry.layerId});
          }
        });
      }
      if(orphanFeatures.length){
        issues.push({check:'featuresData↔drawnGroup', severity:'error',
          msg: orphanFeatures.length + ' feature(s) em featuresData mas ausente(s) do drawnGroup: ' +
            orphanFeatures.slice(0, 5).map(function(f){ return f.label + ' (id:' + f.id + ')'; }).join(', ') +
            (orphanFeatures.length > 5 ? ' ... +' + (orphanFeatures.length - 5) : '')});
      }

      /* layers no drawnGroup que nao tem entry em featuresData */
      if(isFn(drawnGroup.getLayers)){
        var mapLayers = drawnGroup.getLayers();
        for(var i = 0; i < mapLayers.length; i++){
          var ml = mapLayers[i];
          var stamp = isFn(g('L') && g('L').Util && g('L').Util.stamp) ? g('L').Util.stamp(ml) : null;
          if(stamp !== null && !featuresData.has(stamp)){
            ghostLayers.push({stamp: stamp});
          }
        }
        if(ghostLayers.length){
          issues.push({check:'drawnGroup↔featuresData', severity:'error',
            msg: ghostLayers.length + ' layer(es) no drawnGroup sem entry em featuresData (orfas).'});
        }
      }
    }

    /* ---- 6: feature count por layer ---- */
    if(isObj(featuresData) && isFn(countLayerFeatures) && Array.isArray(layers)){
      var countMap = {};
      if(isFn(featuresData.forEach)){
        featuresData.forEach(function(entry){
          if(!entry) return;
          var lid = entry.layerId;
          countMap[lid] = (countMap[lid] || 0) + 1;
        });
      }
      var mismatches = [];
      layers.forEach(function(l){
        var reported = countLayerFeatures(l.id);
        var actual = countMap[l.id] || 0;
        if(reported !== actual){
          mismatches.push(l.name + ': countLayerFeatures=' + reported + ' vs forEach=' + actual);
        }
      });
      if(mismatches.length){
        issues.push({check:'featureCount', severity:'warn',
          msg:'Inconsistencia no count de features:\n  ' + mismatches.join('\n  ')});
      }
    }

    /* ---- 7: featuresData orphan entries (layerId nao existe) ---- */
    if(isObj(featuresData) && Array.isArray(layers)){
      var knownIds = layers.map(function(l){ return l.id; });
      if(isNum(activeLayerId) && activeLayerId !== 0) knownIds.push(activeLayerId);
      var orphanEntries = [];
      if(isFn(featuresData.forEach)){
        featuresData.forEach(function(entry, id){
          if(!entry) return;
          if(knownIds.indexOf(entry.layerId) === -1){
            orphanEntries.push({id: id, label: entry.label || '?', layerId: entry.layerId});
          }
        });
      }
      if(orphanEntries.length){
        issues.push({check:'featuresData↔layers', severity:'error',
          msg: orphanEntries.length + ' feature(s) com layerId desconhecido: ' +
            orphanEntries.slice(0, 5).map(function(f){ return f.label + ' (layerId:' + f.layerId + ')'; }).join(', ')});
      }
    }

    return issues;
  }

  /* ---------- badge + panel ---------- */
  var btnEl = null;
  var panelEl = null;
  var panelOpen = false;
  var lastIssues = [];

  function ensureBtn(){
    if(btnEl) return;
    btnEl = document.createElement('div');
    btnEl.id = 'sc-badge';
    btnEl.title = 'Verificar consistencia do estado (clique)';
    btnEl.innerHTML =
      '<span id="sc-count">0</span>' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
      '</svg>';
    btnEl.onclick = function(){
      lastIssues = runChecks();
      updateBtn();
      ensurePanel();
      renderPanel();
      panelOpen = true;
      panelEl.classList.add('open');
    };
    document.body.appendChild(btnEl);
  }

  function updateBtn(){
    ensureBtn();
    var n = lastIssues.length;
    var countEl = btnEl.querySelector('#sc-count');
    if(countEl) countEl.textContent = n;
    btnEl.title = n > 0
      ? n + ' inconsistencia(s) detetada(s) — clique para ver detalhes'
      : 'Verificar consistencia do estado (clique)';
    if(n > 0){
      btnEl.style.borderColor = 'rgba(232,168,74,.5)';
      btnEl.style.color = '#e8a84a';
    } else {
      btnEl.style.borderColor = 'rgba(45,125,79,.4)';
      btnEl.style.color = '#4ecb71';
    }
  }

  function ensurePanel(){
    if(panelEl) return;
    panelEl = document.createElement('div');
    panelEl.id = 'sc-panel';
    panelEl.innerHTML =
      '<div class="sc-ph">' +
        '<span class="sc-pt">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' +
          '</svg> State Consistency' +
        '</span>' +
        '<button class="sc-pcl" id="sc-run-btn">Reverificar</button>' +
        '<button class="sc-pcx" id="sc-close-btn">&times;</button>' +
      '</div>' +
      '<div class="sc-progress" id="sc-progress"><div class="sc-progress-fill" id="sc-progress-fill"></div></div>' +
      '<div class="sc-pb" id="sc-pb">' +
        '<div class="sc-empty">Clique "Reverificar" para executar os checks.</div>' +
      '</div>';
    document.body.appendChild(panelEl);
    document.getElementById('sc-close-btn').onclick = function(){ panelOpen = false; panelEl.classList.remove('open'); };
    document.getElementById('sc-run-btn').onclick = function(){
      var bar = document.getElementById('sc-progress-fill');
      var body = panelEl.querySelector('#sc-pb');
      bar.style.width = '0%';
      bar.classList.remove('done','fail');
      body.innerHTML = '<div class="sc-empty">A verificar...</div>';
      requestAnimationFrame(function(){
        bar.classList.add('sc-animate');
        bar.style.width = '100%';
      });
      setTimeout(function(){
        bar.classList.remove('sc-animate');
        lastIssues = runChecks();
        bar.classList.add(lastIssues.length === 0 ? 'done' : 'fail');
        updateBtn();
        renderPanel();
      }, 350);
    };
  }

  function togglePanel(){
    ensurePanel();
    panelOpen = !panelOpen;
    if(panelOpen){ renderPanel(); panelEl.classList.add('open'); }
    else { panelEl.classList.remove('open'); }
  }

  function renderPanel(){
    var body = panelEl.querySelector('#sc-pb');
    if(!body) return;
    if(lastIssues.length === 0){
      body.innerHTML = '<div class="sc-ok">' +
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#4ecb71" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>' +
        '</svg>' +
        '<div>Tudo consistente. Nenhuma anomalia detetada.</div></div>';
      return;
    }

    var errors = lastIssues.filter(function(i){ return i.severity === 'error'; });
    var warns  = lastIssues.filter(function(i){ return i.severity === 'warn'; });

    var html = '';
    if(errors.length){
      html += '<div class="sc-section-title sc-err-title">' + errors.length + ' ERRO(S)</div>';
      errors.forEach(function(i){
        html += '<div class="sc-item sc-err">' +
          '<div class="sc-ich"><span class="sc-icheck">' + esc(i.check) + '</span></div>' +
          '<div class="sc-imsg">' + esc(i.msg) + '</div></div>';
      });
    }
    if(warns.length){
      html += '<div class="sc-section-title sc-warn-title">' + warns.length + ' AVISO(S)</div>';
      warns.forEach(function(i){
        html += '<div class="sc-item sc-warn">' +
          '<div class="sc-ich"><span class="sc-icheck">' + esc(i.check) + '</span></div>' +
          '<div class="sc-imsg">' + esc(i.msg) + '</div></div>';
      });
    }
    body.innerHTML = html;
  }

  function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  /* ---------- debounce ---------- */
  var debounceTimer = null;
  function scheduleCheck(){
    if(debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function(){
      lastIssues = runChecks();
      updateBtn();
      if(panelOpen) renderPanel();
    }, 2000);
  }

  /* ---------- init ---------- */
  var hookedDrawnGroup = null;

  function rehookEvents(){
    var dg = g('drawnGroup');
    if(dg && isFn(dg.on) && dg !== hookedDrawnGroup){
      if(hookedDrawnGroup && isFn(hookedDrawnGroup.off)){
        hookedDrawnGroup.off('layeradd', scheduleCheck);
        hookedDrawnGroup.off('layerremove', scheduleCheck);
      }
      dg.on('layeradd', scheduleCheck);
      dg.on('layerremove', scheduleCheck);
      hookedDrawnGroup = dg;
    }
  }

  function hookEvents(){
    rehookEvents();

    document.addEventListener('keydown', function(e){
      if((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'i'){
        e.preventDefault();
        lastIssues = runChecks();
        updateBtn();
        togglePanel();
      }
    });
  }

  /* ---------- CSS ---------- */
  var css =
    '#sc-badge{' +
      'position:fixed;bottom:54px;left:0;z-index:99997;' +
      'display:flex;align-items:center;gap:5px;' +
      'background:#1a1a1a;border:1px solid rgba(45,125,79,.4);border-radius:0 6px 6px 0;border-left:none;' +
      'padding:6px 10px 6px 14px;cursor:pointer;color:#4ecb71;' +
      'font-family:"IBM Plex Mono",monospace;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.35);' +
      'transform:translateX(calc(-100% + 30px));' +
      'transition:transform .25s ease,border-color .3s,color .3s;' +
    '}' +
    '#sc-badge:hover{transform:translateX(0);}' +
    '#sc-badge svg{flex-shrink:0;}' +
    '#sc-badge #sc-count{' +
      'font-size:11px;font-weight:700;' +
      'background:rgba(45,125,79,.15);padding:1px 6px;border-radius:8px;' +
      'min-width:18px;text-align:center;' +
    '}' +
    '#sc-panel{' +
      'position:fixed;bottom:92px;left:0;z-index:99998;' +
      'width:460px;max-width:calc(100vw - 24px);max-height:calc(100vh - 72px);' +
      'background:#1a1a1a;border:1px solid #333;border-radius:8px;' +
      'box-shadow:0 8px 32px rgba(0,0,0,.5);' +
      'display:flex;flex-direction:column;overflow:hidden;' +
      'opacity:0;visibility:hidden;transform:translateY(8px);' +
      'transition:opacity .2s,transform .2s,visibility 0s linear .2s;' +
    '}' +
    '#sc-panel.open{' +
      'opacity:1;visibility:visible;transform:translateY(0);' +
      'transition:opacity .2s,transform .2s,visibility 0s linear 0s;' +
    '}' +
    '.sc-ph{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #333;background:rgba(0,0,0,.2);flex-shrink:0;}' +
    '.sc-pt{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#ddd;flex:1;}' +
    '.sc-pt svg{color:#4ecb71;flex-shrink:0;}' +
    '.sc-pcl{font-size:11px;color:#888;background:none;border:1px solid #444;border-radius:4px;padding:3px 10px;cursor:pointer;}' +
    '.sc-pcl:hover{color:#4ecb71;border-color:#4ecb71;}' +
    '.sc-pcx{font-size:18px;color:#888;background:none;border:none;cursor:pointer;padding:0 2px;}' +
    '.sc-pcx:hover{color:#ddd;}' +
    '.sc-pb{flex:1;overflow-y:auto;padding:8px 0;max-height:60vh;}' +
    '.sc-pb::-webkit-scrollbar{width:4px;}' +
    '.sc-pb::-webkit-scrollbar-thumb{background:#444;border-radius:2px;}' +
    '.sc-empty{padding:24px;text-align:center;color:#888;font-size:12px;font-style:italic;}' +
    '.sc-ok{padding:28px 20px;text-align:center;color:#4ecb71;font-size:12px;display:flex;flex-direction:column;align-items:center;gap:10px;}' +
    '.sc-section-title{font-size:11px;font-weight:700;letter-spacing:1px;padding:6px 14px;}' +
    '.sc-err-title{color:#e85d4a;background:rgba(232,93,74,.06);}' +
    '.sc-warn-title{color:#e8a84a;background:rgba(232,168,74,.06);margin-top:4px;}' +
    '.sc-item{padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.03);}' +
    '.sc-item:hover{background:rgba(255,255,255,.02);}' +
    '.sc-ich{margin-bottom:3px;}' +
    '.sc-icheck{font-family:monospace;font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;}' +
    '.sc-err .sc-icheck{color:#e85d4a;background:rgba(232,93,74,.12);}' +
    '.sc-warn .sc-icheck{color:#e8a84a;background:rgba(232,168,74,.12);}' +
    '.sc-imsg{font-size:12px;color:#bbb;line-height:1.4;word-break:break-word;}' +
    '.sc-progress{height:2px;background:#222;flex-shrink:0;}' +
    '.sc-progress-fill{height:100%;width:0%;background:#4a9eff;transition:width .3s ease;}' +
    '.sc-progress-fill.sc-animate{transition:width .3s ease;}' +
    '.sc-progress-fill.done{background:#4ecb71;width:100% !important;}' +
    '.sc-progress-fill.fail{background:#e8a84a;width:100% !important;}';

  var s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);

  /* ---------- init ---------- */
  function init(){
    ensureBtn();
    updateBtn();
    hookEvents();
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){ setTimeout(init, 300); });
  } else {
    setTimeout(init, 300);
  }

  window.__stateConsistencyCheck = runChecks;
  window.__rehookStateConsistency = rehookEvents;

})();
