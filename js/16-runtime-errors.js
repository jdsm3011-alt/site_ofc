/* ============================================================
   CAMADA 2 — Runtime Error Trapping
   Captura erros JS + promises rejeitadas.
   Badge flutuante + painel de detalhes. Zero dependencia do DOM.
   ============================================================ */
(function(){
  'use strict';

  var errors = [];
  window.__runtimeErrors = errors;
  var MAX_ERRORS = 200;
  var badgeEl = null;
  var panelEl = null;
  var panelOpen = false;

  /* ---------- helpers ---------- */
  function fmtTime(d){
    return String(d.getHours()).padStart(2,'0') + ':' +
           String(d.getMinutes()).padStart(2,'0') + ':' +
           String(d.getSeconds()).padStart(2,'0') + '.' +
           String(d.getMilliseconds()).padStart(3,'0');
  }

  function escHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function basename(path){
    return String(path).split('/').pop().split('\\').pop();
  }

  function truncStack(stack, maxLines){
    var lines = String(stack).split('\n');
    return lines.length > maxLines
      ? lines.slice(0, maxLines).join('\n') + '\n  ... +' + (lines.length - maxLines) + ' linhas'
      : stack;
  }

  /* ---------- badge ---------- */
  function ensureBadge(){
    if(badgeEl) return;
    badgeEl = document.createElement('div');
    badgeEl.id = 're-badge';
    badgeEl.title = 'Erros detetados (0)';
    badgeEl.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
        '<line x1="12" y1="9" x2="12" y2="13"/>' +
        '<line x1="12" y1="17" x2="12.01" y2="17"/>' +
      '</svg>' +
      '<span id="re-count">0</span>';
    badgeEl.onclick = togglePanel;
    document.body.appendChild(badgeEl);
  }

  function updateBadge(){
    ensureBadge();
    var n = errors.length;
    badgeEl.querySelector('#re-count').textContent = n;
    badgeEl.title = 'Erros detetados (' + n + ')';
    badgeEl.style.display = n > 0 ? 'flex' : 'none';
  }

  /* ---------- panel ---------- */
  function ensurePanel(){
    if(panelEl) return;
    panelEl = document.createElement('div');
    panelEl.id = 're-panel';
    panelEl.innerHTML =
      '<div class="re-ph">' +
        '<span class="re-pt">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
            '<line x1="12" y1="9" x2="12" y2="13"/>' +
            '<line x1="12" y1="17" x2="12.01" y2="17"/>' +
          '</svg> Runtime Errors' +
        '</span>' +
        '<button class="re-pcl" id="re-clear-btn">Limpar</button>' +
        '<button class="re-pcx" id="re-close-btn">&times;</button>' +
      '</div>' +
      '<div class="re-pb" id="re-pb">' +
        '<div class="re-empty">Nenhum erro detetado.</div>' +
      '</div>';
    document.body.appendChild(panelEl);
    document.getElementById('re-close-btn').onclick = closePanel;
    document.getElementById('re-clear-btn').onclick = clearErrors;
  }

  function renderPanel(){
    var body = panelEl.querySelector('#re-pb');
    if(!body) return;
    if(errors.length === 0){
      body.innerHTML = '<div class="re-empty">Nenhum erro detetado.</div>';
      return;
    }
    var html = '';
    for(var i = errors.length - 1; i >= 0; i--){
      var e = errors[i];
      var src = e.source ? basename(e.source) : '(inline)';
      var loc = e.source ? src + ':' + (e.line||'?') + (e.col ? ':'+e.col : '') : '';
      html +=
        '<div class="re-item">' +
          '<div class="re-ih">' +
            '<span class="re-ii">#'+(i+1)+'</span>' +
            '<span class="re-it">'+escHtml(e.time)+'</span>' +
            '<span class="re-il">'+escHtml(loc)+'</span>' +
          '</div>' +
          '<div class="re-im">'+escHtml(e.message)+'</div>' +
          (e.stack ? '<pre class="re-is">'+escHtml(truncStack(e.stack,4))+'</pre>' : '') +
        '</div>';
    }
    body.innerHTML = html;
  }

  function togglePanel(){
    ensurePanel();
    panelOpen = !panelOpen;
    if(panelOpen){ renderPanel(); panelEl.classList.add('open'); }
    else { panelEl.classList.remove('open'); }
  }

  function closePanel(){
    panelOpen = false;
    if(panelEl) panelEl.classList.remove('open');
  }

  function clearErrors(){
    errors.length = 0;
    updateBadge();
    if(panelOpen) renderPanel();
  }

  /* ---------- capture ---------- */
  function push(type, msg, source, line, col, stack, raw){
    if(errors.length >= MAX_ERRORS) return;
    errors.push({
      type:type, message:msg||'(sem mensagem)',
      source:source||'', line:line||0, col:col||0,
      time:fmtTime(new Date()), stack:stack||'', raw:raw||null
    });
    updateBadge();
    if(panelOpen) renderPanel();
  }

  /* ---------- hooks ---------- */
  window.addEventListener('error', function(e){
    push('error', e.message, e.filename, e.lineno, e.colno, e.error && e.error.stack, e.error);
  });

  window.addEventListener('unhandledrejection', function(e){
    var r = e.reason;
    if(r instanceof Error){ push('rejection', r.message, '', 0, 0, r.stack, r); }
    else { push('rejection', String(r)); }
  });

  /* ---------- smoke test: verifica funcoes criticas no arranque ---------- */
  var CRITICAL_FUNCS = [
    'showAppAlert', 'importGeoJSONFeatures', 'refreshFeatList',
    'markProjectDirty', 'genFid', 'baseGeomType', 'getLayerSchema',
    'assignLayerPane', 'styleLayerDefault', 'pushHistoryAction',
    'onFeatureCreated', 'onFeatureRemoved', 'defaultSymbology',
    'zoomToLayer', 'renderLayersPanel', 'checkAllTopology',
    'ensureLayerPane', 'applyLayerZOrder', 'restyleAllLayers',
    'countLayerFeatures', 'getLayerFeatureEntries',
    'resolveFeatureColor', 'dataGisMarkerIcon',
    'initMap', 'loadSettings', 'saveSettings',
    'initializeWorkspaces', 'proceedToMap', 'renderSettingsMenu',
    'enableGeorefAutoButtonIfZoomReady', 'setupGeorefMapEvents',
    'importRasterFiles', 'clearRasterLayerState',
    'serializeRasterLayersForProject', 'restoreRasterLayersFromProject',
    'renderRasterLayersPanel', 'setupOfflineMapEvents',
    'setupRulerMapEvents', 'renderOfflineAreasMenu',
    'updateConnectivityUI', 'applySettingsToEditing',
    'updateCoordBar', 'updateMapGridVisibility',
    'renderLayersPanel', 'renderSymbologyPanel'
  ];

  function runSmokeTest(){
    var missing = [];
    var failed  = [];
    for(var i = 0; i < CRITICAL_FUNCS.length; i++){
      var name = CRITICAL_FUNCS[i];
      try {
        var fn = new Function('return typeof window["' + name + '"] === "function"');
        if(!fn()) missing.push(name);
      } catch(e){
        missing.push(name);
      }
    }
    if(missing.length > 0){
      push('smoke-test',
        'Funcoes criticas em falta (' + missing.length + '): ' + missing.join(', '),
        '16-runtime-errors.js', 0, 0, '', null
      );
    }
    if(failed.length > 0){
      push('smoke-test',
        'Funcoes criticas que falharam ao invocar (' + failed.length + '): ' + failed.join(', '),
        '16-runtime-errors.js', 0, 0, '', null
      );
    }
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){
      setTimeout(runSmokeTest, 500);
    });
  } else {
    setTimeout(runSmokeTest, 500);
  }

  /* ---------- CSS (inline, zero specificity fights) ---------- */
  var css =
    '#re-badge{' +
      'position:fixed;bottom:16px;left:16px;z-index:99997;' +
      'display:none;align-items:center;gap:5px;' +
      'background:#1a1a1a;border:1px solid rgba(181,71,43,.4);border-radius:6px;' +
      'padding:6px 10px;cursor:pointer;color:#e85d4a;' +
      'font-family:"IBM Plex Mono",monospace;' +
      'box-shadow:0 2px 12px rgba(0,0,0,.35);' +
      'transition:transform .15s ease;' +
    '}' +
    '#re-badge:hover{transform:scale(1.05);}' +
    '#re-badge svg{flex-shrink:0;}' +
    '#re-badge #re-count{' +
      'font-size:11px;font-weight:700;' +
      'background:rgba(181,71,43,.15);padding:1px 6px;border-radius:8px;' +
      'min-width:18px;text-align:center;' +
    '}' +
    '#re-panel{' +
      'position:fixed;bottom:56px;left:16px;z-index:99999;' +
      'width:420px;max-width:calc(100vw - 24px);max-height:calc(100vh - 72px);' +
      'background:#1a1a1a;border:1px solid #333;border-radius:8px;' +
      'box-shadow:0 8px 32px rgba(0,0,0,.5);' +
      'display:flex;flex-direction:column;overflow:hidden;' +
      'opacity:0;visibility:hidden;transform:translateY(8px);' +
      'transition:opacity .2s,transform .2s,visibility 0s linear .2s;' +
    '}' +
    '#re-panel.open{' +
      'opacity:1;visibility:visible;transform:translateY(0);' +
      'transition:opacity .2s,transform .2s,visibility 0s linear 0s;' +
    '}' +
    '.re-ph{' +
      'display:flex;align-items:center;gap:8px;padding:10px 14px;' +
      'border-bottom:1px solid #333;background:rgba(0,0,0,.2);flex-shrink:0;' +
    '}' +
    '.re-pt{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:700;color:#ddd;flex:1;}' +
    '.re-pt svg{color:#e85d4a;flex-shrink:0;}' +
    '.re-pcl{' +
      'font-size:11px;color:#888;background:none;border:1px solid #444;' +
      'border-radius:4px;padding:3px 10px;cursor:pointer;' +
    '}' +
    '.re-pcl:hover{color:#e85d4a;border-color:#e85d4a;}' +
    '.re-pcx{' +
      'font-size:18px;color:#888;background:none;border:none;cursor:pointer;padding:0 2px;' +
    '}' +
    '.re-pcx:hover{color:#ddd;}' +
    '.re-pb{flex:1;overflow-y:auto;padding:8px 0;max-height:60vh;}' +
    '.re-pb::-webkit-scrollbar{width:4px;}' +
    '.re-pb::-webkit-scrollbar-thumb{background:#444;border-radius:2px;}' +
    '.re-empty{padding:24px;text-align:center;color:#888;font-size:12px;font-style:italic;}' +
    '.re-item{padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.04);}' +
    '.re-item:hover{background:rgba(255,255,255,.02);}' +
    '.re-item:last-child{border-bottom:none;}' +
    '.re-ih{display:flex;align-items:center;gap:8px;margin-bottom:4px;}' +
    '.re-ii{font-family:monospace;font-size:10px;font-weight:700;color:#e85d4a;min-width:22px;}' +
    '.re-it{font-family:monospace;font-size:10px;color:#666;}' +
    '.re-il{font-family:monospace;font-size:10px;color:#888;margin-left:auto;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px;}' +
    '.re-im{font-size:12px;color:#ddd;line-height:1.4;word-break:break-word;}' +
    '.re-is{font-family:monospace;font-size:10px;color:#666;margin:6px 0 0;padding:6px 8px;background:rgba(0,0,0,.2);border-radius:4px;white-space:pre-wrap;word-break:break-all;max-height:80px;border:1px solid rgba(255,255,255,.04);}';

  var s = document.createElement('style');
  s.textContent = css;
  document.head.appendChild(s);

  /* ---------- expose ---------- */
  window.__runtimeErrorsClear = clearErrors;
  window.__runtimeErrorsExport = function(){ return JSON.parse(JSON.stringify(errors)); };

})();
