/* ============================================================
   VERIFICACAO DE INTEGRIDADE — Camada 1 (globals check)
   Tela de arranque estilo terminal com logs detalhados.
   ============================================================ */
(function(){
  'use strict';

  var MANIFEST = {
    critical: [
      'map', 'drawnGroup', 'featuresData', 'activeLayerId', 'config',
      'showAppAlert', 'importGeoJSONFeatures', 'refreshFeatList',
      'markProjectDirty', 'genFid', 'baseGeomType', 'getLayerSchema',
      'assignLayerPane', 'layerVisible', 'layerOrder', 'featureCounter',
      'escapeHtml', 'styleLayerDefault', 'pushHistoryAction',
      'onFeatureCreated', 'onFeatureRemoved', 'defaultSymbology',
      'zoomToLayer', 'renderLayersPanel', 'checkAllTopology',
      'ensureLayerPane', 'applyLayerZOrder', 'restyleAllLayers',
      'countLayerFeatures', 'getLayerFeatureEntries',
      'resolveFeatureColor', 'dataGisMarkerIcon',
      'initMap', 'loadSettings', 'saveSettings',
      'initializeWorkspaces', 'workspaces', 'currentWorkspace',
      'persistCurrentWorkspaceState', 'applyWorkspaceState',
      'renderWorkspaceTabs', 'getWorkspaceById', 'getCurrentWorkspace',
      'proceedToMap', 'renderSettingsMenu'
    ],
    module: [
      'Georef', 'AutoGeoref',
      'coordMode', 'updateCoordBar',
      'settings', 'applyTheme', 'DEFAULT_SETTINGS',
      'pbCreateLayerFromFeatureCollection', 'pbLoadMunicipiosData',
      '__runtimeErrors', '__stateConsistencyCheck'
    ],
    cdn: [
      'L', 'proj4'
    ],
    cdnOptional: [
      'html2canvas', 'XLSX', 'shp',
      'jspdf', 'turf'
    ],
    layoutHooks: [
      'isLayoutViewActive', 'renderLayoutTabsInto',
      'handleAddMapClick', 'leaveLayoutView',
      'notifyLayoutsWorkspaceChanged'
    ]
  };

  var GROUP_LABELS = {
    critical:    'NUCLEO',
    module:      'MODULOS',
    cdn:         'CDN EXT.',
    cdnOptional: 'CDN OPC.',
    layoutHooks: 'LAYOUT '
  };

  /* ---------- helpers ---------- */
  function isDefined(name){
    try {
      var check = new Function(
        'try { return typeof ' + name + ' !== "undefined" && ' + name + ' !== null; }' +
        ' catch(e){ return false; }'
      );
      return check();
    } catch(e){ return false; }
  }

  /* ============================================================
     PRE-BOOT GATE — verifica criticos de forma sincrona.
     Se falhar, bloqueia o arranque da app por completo.
     ============================================================ */
  (function preBootGate(){
    var missing = [];
    var names = MANIFEST.critical;
    for(var i = 0; i < names.length; i++){
      if(!isDefined(names[i])) missing.push(names[i]);
    }
    if(missing.length === 0) return;

    document.documentElement.innerHTML =
      '<head><style>' +
        'html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden;}' +
        '*{font-family:"IBM Plex Mono","Cascadia Code","Courier New",monospace;color:#cc0000;}' +
      '</style></head>' +
      '<body>' +
        '<div style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;">' +
          '<div style="font-size:14px;letter-spacing:3px;margin-bottom:30px;color:#cc0000;">[ FALHA DE INTEGRIDADE ]</div>' +
          '<div style="font-size:11px;color:#888;margin-bottom:20px;text-align:center;line-height:1.8;">' +
            'O software nao pode arranque.<br>' +
            'Ficheiro(s) essencial(is) em falta ou corrompido(s).' +
          '</div>' +
          '<div style="border:1px solid #330000;padding:16px 24px;max-width:600px;width:100%;' +
            'background:rgba(255,0,0,.03);border-radius:2px;">' +
            '<div style="font-size:10px;color:#660000;letter-spacing:1px;margin-bottom:10px;">GLOBAL(S) EM FALTA:</div>' +
            '<div style="font-size:11px;color:#cc0000;line-height:1.7;">' +
              missing.map(function(n){ return '&nbsp;&nbsp;' + n; }).join('<br>') +
            '</div>' +
          '</div>' +
          '<div style="font-size:9px;color:#440000;margin-top:30px;text-align:center;">' +
            'Verifique a consola do navegador para mais detalhes.' +
          '</div>' +
        '</div>' +
      '</body>';

    console.error('[PRE-BOOT GATE] Arranque bloqueado — ' + missing.length + ' global(is) critico(s) em falta:');
    missing.forEach(function(n){ console.error('  ✗ ' + n); });

    throw new Error('[PRE-BOOT GATE] Integridade falhou — app bloqueada. Globals em falta: ' + missing.join(', '));
  })();

  function pad(s, len){
    s = String(s);
    while(s.length < len) s += ' ';
    return s;
  }

  /* ---------- DOM ---------- */
  var overlay = document.createElement('div');
  overlay.id = 'integrity-overlay';
  overlay.innerHTML =
    '<div class="ivo-wrap">' +
      '<div class="ivo-header">' +
        '<div class="ivo-h-left"><span class="ivo-logo">◈ Por favor aguarde</span><span class="ivo-ver">verificacao de integridade</span></div>' +
        '<div class="ivo-h-right"><span class="ivo-dot"></span><span class="ivo-status" id="ivo-status">A iniciar...</span></div>' +
      '</div>' +
      '<div class="ivo-body" id="ivo-body"></div>' +
      '<div class="ivo-footer" id="ivo-footer"></div>' +
    '</div>';

  var style = document.createElement('style');
  style.textContent = [
    '#integrity-overlay{',
      'position:fixed;inset:0;z-index:99999;background:#0a0a0a;',
      'display:none;font-family:"IBM Plex Mono","Cascadia Code","Fira Code",monospace;',
      'color:#8f8f8f;overflow:hidden;',
    '}',
    '#integrity-overlay.ivo-visible{display:block;animation:ivoFadeIn .3s ease forwards;}',
    '#integrity-overlay.ivo-hide{animation:ivoFadeOut .4s ease forwards;}',
    '@keyframes ivoFadeIn{from{opacity:0}to{opacity:1}}',
    '@keyframes ivoFadeOut{from{opacity:1}to{opacity:0}}',
    '.ivo-wrap{',
      'display:flex;flex-direction:column;height:100%;padding:20px 28px;',
      'box-sizing:border-box;',
    '}',
    '.ivo-header{',
      'border-bottom:1px solid #1a1a1a;padding-bottom:10px;margin-bottom:14px;',
      'display:flex;align-items:center;justify-content:space-between;',
    '}',
    '.ivo-h-left{display:flex;align-items:baseline;gap:14px;}',
    '.ivo-h-right{display:flex;align-items:center;gap:6px;font-size:11px;color:#555;}',
    '.ivo-dot{width:6px;height:6px;border-radius:50%;background:#4a9eff;display:inline-block;animation:ivoPulse 1.2s ease-in-out infinite;}',
    '@keyframes ivoPulse{0%,100%{opacity:.4}50%{opacity:1}}',
    '.ivo-logo{color:#e0e0e0;font-weight:600;font-size:13px;letter-spacing:1.5px;}',
    '.ivo-ver{color:#555;font-size:10.5px;}',
    '.ivo-body{',
      'flex:1;overflow-y:auto;font-size:12px;line-height:1.7;',
    '}',
    '.ivo-body::-webkit-scrollbar{width:4px;}',
    '.ivo-body::-webkit-scrollbar-track{background:#111;}',
    '.ivo-body::-webkit-scrollbar-thumb{background:#333;border-radius:2px;}',
    '.ivo-footer{',
      'border-top:1px solid #222;padding-top:12px;margin-top:10px;',
      'display:flex;flex-direction:column;align-items:stretch;gap:8px;',
    '}',
    '.ivo-status-text{color:#555;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.ivo-group-label{color:#ccc;font-weight:500;font-size:11px;letter-spacing:1.5px;margin-top:12px;border-bottom:1px solid #181818;padding-bottom:2px;}',
    '.ivo-group-label:first-child{margin-top:0;}',
    '.ivo-line{color:#8f8f8f;padding-left:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '.ivo-line b{font-weight:600;}',
    '.ivo-line .ok{color:#4ecb71;}',
    '.ivo-line .fail{color:#e85d4a;}',
    '.ivo-line .warn{color:#e8a84a;}',
    '.ivo-sep{color:#333;margin:6px 0 2px 16px;font-size:10px;letter-spacing:1px;}',
    '.ivo-summary{',
      'margin-top:16px;padding:12px 18px;border:1px solid #222;border-radius:6px;',
      'font-size:12px;line-height:1.6;',
    '}',
    '.ivo-summary.ivo-ok{border-color:#1a3a2a;background:rgba(45,125,79,.06);} ',
    '.ivo-summary.ivo-fail{border-color:#3a1a1a;background:rgba(181,71,43,.06);} ',
    '.ivo-summary .ivo-st{font-weight:700;}',
    '.ivo-summary .ivo-st.ok{color:#4ecb71;}',
    '.ivo-summary .ivo-st.fail{color:#e85d4a;}',
    '.ivo-loadbar{',
      'display:flex;gap:2px;padding:4px;background:#0f0f0f;',
      'border:1px solid #222;border-radius:3px;box-sizing:border-box;width:100%;min-height:16px;',
    '}',
    '.ivo-sq{flex:1;height:8px;background:#1c1c1c;border-radius:1px;',
      'transition:background .15s ease;}',
    '.ivo-sq.on{background:#2fbf5f;}',
    '.ivo-loadbar.ok .ivo-sq.on{background:#2d7d4f;}',
    '.ivo-loadbar.fail .ivo-sq.on{background:#b5472b;}',
  ].join('');
  document.head.appendChild(style);
  document.body.appendChild(overlay);

  /* ---------- animation ---------- */
  var body = document.getElementById('ivo-body');
  var footer = document.getElementById('ivo-footer');
  var progressFill = null;
  var logLines = [];
  var maxVisibleLines = 50;

  function showOverlay(){
    overlay.style.display = 'block';
    requestAnimationFrame(function(){
      overlay.classList.add('ivo-visible');
    });
  }

  function hideOverlay(){
    overlay.classList.add('ivo-hide');
    setTimeout(function(){ overlay.style.display = 'none'; }, 400);
  }

  function addGroupLabel(label){
    var el = document.createElement('div');
    el.className = 'ivo-group-label';
    el.textContent = '> ' + label;
    body.appendChild(el);
    logLines.push(el);
    trimLines();
    scrollToBottom();
  }

  function addLine(html){
    var el = document.createElement('div');
    el.className = 'ivo-line';
    el.innerHTML = html;
    body.appendChild(el);
    logLines.push(el);
    trimLines();
    scrollToBottom();
  }

  function addSep(text){
    var el = document.createElement('div');
    el.className = 'ivo-sep';
    el.textContent = text;
    body.appendChild(el);
    logLines.push(el);
    trimLines();
    scrollToBottom();
  }

  function addSummary(ok, html){
    var el = document.createElement('div');
    el.className = 'ivo-summary ' + (ok ? 'ivo-ok' : 'ivo-fail');
    el.innerHTML = html;
    body.appendChild(el);
    scrollToBottom();
  }

  function addProgress(){
    var wrap = document.createElement('div');
    wrap.className = 'ivo-loadbar';
    for(var i = 0; i < 64; i++){
      var sq = document.createElement('span');
      sq.className = 'ivo-sq';
      wrap.appendChild(sq);
    }
    footer.appendChild(wrap);
    progressFill = wrap;
  }

  function setProgress(pct, ok, fail){
    if(!progressFill) return;
    var total = progressFill.children.length;
    var lit = Math.round((Math.min(pct, 100) / 100) * total);
    progressFill.classList.remove('ok', 'fail');
    if(ok) progressFill.classList.add('ok');
    if(fail) progressFill.classList.add('fail');
    for(var i = 0; i < total; i++){
      var sq = progressFill.children[i];
      if(i < lit){
        if(!sq.classList.contains('on')) sq.classList.add('on');
      } else {
        if(sq.classList.contains('on')) sq.classList.remove('on');
      }
    }
  }

  function setFooterText(html){
    var textEl = footer.querySelector('.ivo-status-text');
    if(!textEl){
      footer.innerHTML = '';
      textEl = document.createElement('div');
      textEl.className = 'ivo-status-text';
      footer.appendChild(textEl);
      if(footer.querySelector('.ivo-loadbar') === null){
        addProgress();
      }
    }
    textEl.innerHTML = html;
  }

  function trimLines(){
    while(logLines.length > maxVisibleLines){
      var old = logLines.shift();
      if(old.parentNode) old.parentNode.removeChild(old);
    }
  }

  function scrollToBottom(){
    body.scrollTop = body.scrollHeight;
  }

  /* ---------- check ---------- */
  var GROUPS = ['critical', 'module', 'cdn', 'cdnOptional', 'layoutHooks'];
  var FILE_LABEL = 'FICHEIROS';

  function collectLocalScripts(){
    var out = [];
    var scripts = document.getElementsByTagName('script');
    for(var i = 0; i < scripts.length; i++){
      var src = scripts[i].getAttribute('src') || '';
      if(/^(?:\.\/)?js\/.+\.js$/i.test(src)) out.push(src);
    }
    return out;
  }

  function checkFile(src){
    return fetch(src, {method: 'HEAD'}).then(function(r){
      return r.ok;
    }).catch(function(){
      return fetch(src, {method: 'GET'}).then(function(r){
        return r.ok;
      }).catch(function(){ return false; });
    });
  }

  function runCheck(){
    showOverlay();
    addProgress();
    setFooterText('A verificar sistema...');

    var step = 0;
    var totalSteps = GROUPS.length + 1;
    var allMissing = [];
    var criticalMissing = [];
    var cdnMissing = [];
    var missingFiles = [];

    function doGroup(idx){
      if(idx >= GROUPS.length){
        runFileCheck();
        return;
      }
      var key = GROUPS[idx];
      var pct = (idx / totalSteps) * 100;
      setProgress(pct);
      setFooterText('Etapa ' + (idx + 1) + '/' + totalSteps + ' — ' + GROUP_LABELS[key]);
      var statusEl = document.getElementById('ivo-status');
      if(statusEl) statusEl.textContent = GROUP_LABELS[key];

      setTimeout(function(){
        var res = { total: 0, found: 0, missing: [] };
        var names = MANIFEST[key];
        var foundNames = [];
        var missingNames = [];

        for(var i = 0; i < names.length; i++){
          if(isDefined(names[i])){ foundNames.push(names[i]); }
          else { missingNames.push(names[i]); }
        }
        res.total = names.length;
        res.found = foundNames.length;
        res.missing = missingNames;

        allMissing = allMissing.concat(res.missing);
        if(key === 'critical') criticalMissing = res.missing;
        if(key === 'cdn') cdnMissing = res.missing;

        addGroupLabel(GROUP_LABELS[key] + ' (' + res.found + '/' + res.total + ')');

        if(foundNames.length > 0){
          var chunkSize = 8;
          for(var c = 0; c < foundNames.length; c += chunkSize){
            var chunk = foundNames.slice(c, c + chunkSize);
            var items = chunk.map(function(n){ return '<span class="ok">' + n + '</span>'; }).join(', ');
            addLine(items);
          }
        }

        if(missingNames.length > 0){
          addLine('<span class="fail">EM FALTA:</span> ' +
            missingNames.map(function(n){ return '<span class="fail">' + n + '</span>'; }).join(', '));
        }

        if(foundNames.length === 0 && missingNames.length === 0){
          addLine('<span class="warn">nenhum item neste grupo</span>');
        }

        setProgress(((idx + 1) / totalSteps) * 100);
        doGroup(idx + 1);
      }, 180);
    }

    function runFileCheck(){
      var files = collectLocalScripts();
      addGroupLabel(FILE_LABEL + ' (' + files.length + ' declarados)');
      if(files.length === 0){
        addLine('<span class="warn">nenhum ficheiro local declarado</span>');
        finish();
        return;
      }

      setFooterText('A verificar ficheiros...');
      var idx = 0;
      var checked = 0;
      var filesStart = GROUPS.length / totalSteps;
      var filesSpan = 1 / totalSteps;

      function next(){
        if(idx >= files.length){
          finish();
          return;
        }
        var src = files[idx];
        checkFile(src).then(function(ok){
          checked++;
          if(ok){
            addLine('<span class="ok">OK</span> <b>' + src + '</b>');
          } else {
            missingFiles.push(src);
            addLine('<span class="fail">FALHA</span> <b>' + src + '</b> — <span class="fail">em falta ou inacessivel</span>');
          }
          setProgress((filesStart + filesSpan * (checked / files.length)) * 100);
          setFooterText('Etapa ' + (GROUPS.length + idx + 1) + '/' + totalSteps + ' — ' + FILE_LABEL);
          var statusEl = document.getElementById('ivo-status');
          if(statusEl) statusEl.textContent = FILE_LABEL;
          idx++;
          next();
        });
      }
      next();
    }

    function finish(){
      var totalFound = 0;
      var totalAll = 0;
      for(var i = 0; i < GROUPS.length; i++){
        var names = MANIFEST[GROUPS[i]];
        for(var j = 0; j < names.length; j++){
          if(isDefined(names[j])) totalFound++;
          totalAll++;
        }
      }

      var hasFileFail = missingFiles.length > 0;
      addSep('—'.repeat(50));
      setFooterText('Verificacao concluida — ' + totalFound + '/' + totalAll + ' globals, ' +
        (collectLocalScripts().length - missingFiles.length) + '/' + collectLocalScripts().length + ' ficheiros');
      var statusText = 'OK';
      if(criticalMissing.length > 0 || hasFileFail) statusText = 'Erro';
      else if(cdnMissing.length > 0) statusText = 'OK (avisos)';

      var statusEl = document.getElementById('ivo-status');
      if(statusEl) statusEl.textContent = statusText;
      if(criticalMissing.length === 0 && cdnMissing.length === 0 && !hasFileFail){
        setProgress(100, true, false);
        addSummary(true,
          '<span class="ivo-st ok">TUDO OK</span><br>' +
          'Todos os <b>' + totalFound + '</b> globals verificados com sucesso.<br>' +
          'Todos os <b>' + collectLocalScripts().length + '</b> ficheiros locais carregados.<br>' +
          'Nenhum modulo critico ou recurso externo em falta.'
        );
      } else if(criticalMissing.length > 0 || hasFileFail){
        setProgress(100, false, true);
        var failParts = [];
        if(criticalMissing.length > 0){
          failParts.push(criticalMissing.length + ' global(is) critico(s) em falta:<br>' +
            criticalMissing.map(function(n){ return '&nbsp;&nbsp;— ' + n; }).join('<br>'));
        }
        if(hasFileFail){
          failParts.push(missingFiles.length + ' ficheiro(s) local(is) em falta:<br>' +
            missingFiles.map(function(n){ return '&nbsp;&nbsp;— ' + n; }).join('<br>'));
        }
        addSummary(false,
          '<span class="ivo-st fail">ERRO</span><br>' +
          failParts.join('<br><br>') +
          '<br><br>Ficheiro(s) pode(m) ter falhado ao carregar.'
        );
        if(typeof showAppAlert === 'function'){
          showAppAlert(
            'Verificacao de integridade detetou ' +
            (criticalMissing.length + missingFiles.length) +
            ' item(ns) em falta:\n\n' +
            criticalMissing.concat(missingFiles).map(function(n){ return '  - ' + n; }).join('\n'),
            {error: true}
          );
        }
      } else {
        setProgress(100, true, false);
        addSummary(true,
          '<span class="ivo-st ok">OK COM AVISOS</span><br>' +
          'Nucleo intacto. ' + cdnMissing.length + ' recurso(s) externo(s) em falta.'
        );
      }

      window.__integrityResult = { criticalMissing: criticalMissing, cdnMissing: cdnMissing, missingFiles: missingFiles };

      if(criticalMissing.length === 0 && !hasFileFail){
        setTimeout(hideOverlay, 1800);
      }
    }

    doGroup(0);
  }

  /* ---------- kick off ---------- */
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', function(){
      setTimeout(runCheck, 1200);
    });
  } else {
    setTimeout(runCheck, 1200);
  }

})();
