/* ============================================================
   SINCRONIZAÇÃO INTELIGENTE — Excel/CSV → SIG
   ============================================================
   Módulo autónomo. Depende de variáveis/funções já existentes em
   05-app-main.js (layers, activeLayerId, config, featuresData, map,
   drawnGroup, layerVisible, layerOrder, getLayerSchema, assignLayerPane,
   ensureLayerPane, styleLayerDefault, genFid, markProjectDirty,
   refreshFeatList, applyLayerZOrder, checkAllTopology) e da biblioteca
   SheetJS (window.XLSX) carregada via CDN.

   Âmbito assumido (importante):
   - "Camada SIG" = uma das camadas já existentes nesta aplicação
     (painel de camadas), não um SIG externo.
   - A ATUALIZAÇÃO de atributos funciona para qualquer tipo de geometria.
   - A CRIAÇÃO automática de novas entidades (registos sem correspondência)
     só é feita quando a camada é de PONTOS e o Excel/CSV tem colunas de
     latitude/longitude mapeadas. Para linhas/polígonos não há forma de
     inventar geometria a partir de uma folha de cálculo — esses casos
     ficam assinalados no relatório como "sem geometria" e têm de ser
     desenhados manualmente.
   - A "Fase 8 — Automatização total" (agendamento às 08:00 mesmo com a
     app fechada) não é possível dentro de uma página web: só corre
     código enquanto a aplicação está aberta. O que se disponibiliza é
     uma verificação periódica *enquanto a app está aberta* (via File
     System Access API, suportada no Chromium/Electron). Para um
     agendamento verdadeiramente ao nível do sistema operativo é preciso
     um script externo (ex: Tarefas Agendadas do Windows) — fora do
     alcance de uma página HTML.
   ============================================================ */
(function(){
  var pageEl = document.getElementById('smart-sync-page');
  var openBtn = document.getElementById('btn-smart-sync');
  var closeBtn = document.getElementById('ss-close-btn');
  var contentEl = document.getElementById('ss-content');
  var navBtns = Array.prototype.slice.call(document.querySelectorAll('.ss-nav-btn'));
  if(!pageEl || !openBtn) return;

  var LS_RECIPES = 'smartSyncRecipes';
  var LS_HISTORY = 'smartSyncHistory';
  var LS_HASHES_PREFIX = 'smartSyncHashes:';

  var STEP_LABELS = ['Ficheiro & camada','Correspondência & chave','Pré-visualização','Execução','Relatório','Guardar receita'];

  /* ---------------- estado da sessão da sincronização atual ---------------- */
  var S = {
    section: 'wizard',
    step: 0,
    workbook: null,
    sheetName: null,
    rows: [],            // array de objetos {coluna: valor} da folha escolhida
    headers: [],          // nomes das colunas do Excel/CSV
    layerId: null,
    keyExcelCol: null,
    keySigField: null,
    latCol: null,
    lngCol: null,
    mapping: [],          // [{sigField, excelCol}]
    preview: null,        // resultado calculado da fase 4
    lastResult: null,     // resultado calculado da fase 5/6
    activeRecipeName: null,
    fileName: null
  };

  function resetSyncState(){
    S.step = 0; S.workbook = null; S.sheetName = null; S.rows = []; S.headers = [];
    S.layerId = null; S.keyExcelCol = null; S.keySigField = null; S.latCol = null; S.lngCol = null;
    S.mapping = []; S.preview = null; S.lastResult = null; S.activeRecipeName = null; S.fileName = null;
  }

  /* ============================================================
     ABRIR / FECHAR PÁGINA
     ============================================================ */
  openBtn.addEventListener('click', function(){
    pageEl.hidden = false;
    switchSection('wizard');
  });
  closeBtn.addEventListener('click', function(){
    pageEl.hidden = true;
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && !pageEl.hidden) pageEl.hidden = true;
  });

  navBtns.forEach(function(btn){
    btn.addEventListener('click', function(){ switchSection(btn.dataset.ssSection); });
  });

  function switchSection(name){
    S.section = name;
    navBtns.forEach(function(b){ b.classList.toggle('is-active', b.dataset.ssSection === name); });
    if(name === 'wizard') renderWizard();
    else if(name === 'recipes') renderRecipes();
    else if(name === 'automation') renderAutomation();
    else if(name === 'history') renderHistory();
    else if(name === 'help') renderHelp();
  }

  /* ============================================================
     HELPERS GERAIS
     ============================================================ */
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function loadRecipes(){
    try { return JSON.parse(localStorage.getItem(LS_RECIPES) || '[]'); } catch(e){ return []; }
  }
  function saveRecipes(list){
    try { localStorage.setItem(LS_RECIPES, JSON.stringify(list)); } catch(e){}
  }
  function loadHistory(){
    try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]'); } catch(e){ return []; }
  }
  function pushHistory(entry){
    var h = loadHistory();
    h.unshift(entry);
    if(h.length > 200) h = h.slice(0, 200);
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(h)); } catch(e){}
  }
  function getRowHashes(recipeKey){
    try { return JSON.parse(localStorage.getItem(LS_HASHES_PREFIX + recipeKey) || '{}'); } catch(e){ return {}; }
  }
  function setRowHashes(recipeKey, obj){
    try { localStorage.setItem(LS_HASHES_PREFIX + recipeKey, JSON.stringify(obj)); } catch(e){}
  }
  function simpleHash(str){
    var h = 0;
    for(var i=0;i<str.length;i++){ h = ((h<<5)-h + str.charCodeAt(i))|0; }
    return h.toString(36);
  }

  /* devolve a lista de camadas disponíveis (arquivadas + a ativa), tal
     como o resto da app já faz noutros sítios (painel de camadas, etc.) */
  function getAllLayerIds(){
    var ids = layers.map(function(l){ return l.id; });
    if(config && config.geometryType && ids.indexOf(activeLayerId) === -1) ids.push(activeLayerId);
    return ids;
  }
  function getLayerLabel(id){
    var schema = getLayerSchema(id);
    return schema ? (schema.name || ('Camada ' + id)) : ('Camada ' + id);
  }

  /* ============================================================
     LEITURA DE FICHEIROS (XLSX / XLS / CSV)
     ============================================================ */
  function readFile(file, cb){
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var reader = new FileReader();
    reader.onerror = function(){ cb(new Error('Não foi possível ler o ficheiro.')); };
    if(ext === 'csv'){
      reader.onload = function(e){
        try{
          var wb = XLSX.read(e.target.result, {type:'string'});
          cb(null, wb);
        } catch(err){ cb(err); }
      };
      reader.readAsText(file, 'UTF-8');
    } else {
      reader.onload = function(e){
        try{
          var data = new Uint8Array(e.target.result);
          var wb = XLSX.read(data, {type:'array'});
          cb(null, wb);
        } catch(err){ cb(err); }
      };
      reader.readAsArrayBuffer(file);
    }
  }

  function loadSheet(sheetName){
    S.sheetName = sheetName;
    var ws = S.workbook.Sheets[sheetName];
    var json = XLSX.utils.sheet_to_json(ws, {defval:'', raw:true});
    S.rows = json;
    S.headers = XLSX.utils.sheet_to_json(ws, {header:1})[0] || Object.keys(json[0] || {});
  }

  /* ============================================================
     WIZARD — RENDER PRINCIPAL
     ============================================================ */
  function renderWizard(){
    var stepsHtml = STEP_LABELS.map(function(label, i){
      var cls = i === S.step ? 'is-active' : (i < S.step ? 'is-done' : '');
      return '<div class="ss-step-pill ' + cls + '"><span class="ss-step-num">' + (i+1) + '</span>' + esc(label) + '</div>';
    }).join('');

    contentEl.innerHTML =
      '<h2>Nova sincronização</h2>' +
      '<p class="ss-subtitle">Atualiza uma camada SIG diretamente a partir de um ficheiro Excel ou CSV, sem edição manual.</p>' +
      '<div class="ss-steps">' + stepsHtml + '</div>' +
      '<div id="ss-step-body"></div>';

    if(S.step === 0) renderStep1();
    else if(S.step === 1) renderStep2();
    else if(S.step === 2) renderStep3Preview();
    else if(S.step === 3) renderStep4Execute();
    else if(S.step === 4) renderStep5Report();
    else if(S.step === 5) renderStep6SaveRecipe();
  }

  /* ---------------- FASE 1: ficheiro, folha, camada ---------------- */
  function renderStep1(){
    var body = document.getElementById('ss-step-body');
    var layerOptions = getAllLayerIds().map(function(id){
      return '<option value="' + id + '"' + (S.layerId === id ? ' selected' : '') + '>' + esc(getLayerLabel(id)) + '</option>';
    }).join('');

    body.innerHTML =
      '<div class="ss-card">' +
        '<h3>1 / Ficheiro Excel/CSV</h3>' +
        '<div class="ss-dropzone" id="ss-dropzone">' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
          '<b>Clique para escolher um ficheiro .xlsx ou .csv</b>' +
          '<span>Ou arraste o ficheiro para aqui</span>' +
        '</div>' +
        '<input type="file" id="ss-file-input" accept=".xlsx,.xls,.csv" style="display:none;">' +
        (S.fileName ? '<div class="ss-file-chip">📄 ' + esc(S.fileName) + '</div>' : '') +
        (S.workbook && S.workbook.SheetNames.length > 1 ?
          '<div class="ss-field" style="margin-top:14px;"><label>Folha</label><select id="ss-sheet-select">' +
            S.workbook.SheetNames.map(function(n){ return '<option value="'+esc(n)+'"'+(n===S.sheetName?' selected':'')+'>'+esc(n)+'</option>'; }).join('') +
          '</select></div>' : '') +
      '</div>' +

      '<div class="ss-card">' +
        '<h3>2 / Camada SIG a atualizar</h3>' +
        '<div class="ss-field">' +
          '<label>Camada</label>' +
          '<select id="ss-layer-select"><option value="">— escolher —</option>' + layerOptions + '</select>' +
          '<div class="ss-hint">São as camadas já criadas nesta aplicação (painel de camadas).</div>' +
        '</div>' +
      '</div>' +

      '<div class="ss-actions-row">' +
        '<button class="ss-btn" id="ss-step1-next" ' + (S.rows.length && S.layerId ? '' : 'disabled') + '>Seguinte →</button>' +
      '</div>';

    var dz = document.getElementById('ss-dropzone');
    var fileInput = document.getElementById('ss-file-input');
    dz.addEventListener('click', function(){ fileInput.click(); });
    dz.addEventListener('dragover', function(e){ e.preventDefault(); dz.classList.add('is-drag'); });
    dz.addEventListener('dragleave', function(){ dz.classList.remove('is-drag'); });
    dz.addEventListener('drop', function(e){
      e.preventDefault(); dz.classList.remove('is-drag');
      if(e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', function(){
      if(fileInput.files && fileInput.files[0]) handleFile(fileInput.files[0]);
    });

    var sheetSelect = document.getElementById('ss-sheet-select');
    if(sheetSelect){
      sheetSelect.addEventListener('change', function(){
        loadSheet(sheetSelect.value);
        renderStep1();
      });
    }

    var layerSelect = document.getElementById('ss-layer-select');
    if(layerSelect){
      layerSelect.addEventListener('change', function(){
        S.layerId = layerSelect.value ? Number(layerSelect.value) : null;
        renderStep1();
      });
    }

    var nextBtn = document.getElementById('ss-step1-next');
    if(nextBtn) nextBtn.addEventListener('click', function(){
      buildDefaultMapping();
      S.step = 1;
      renderWizard();
    });

    function handleFile(file){
      S.fileName = file.name;
      readFile(file, function(err, wb){
        if(err){ alert('Erro a ler o ficheiro: ' + err.message); return; }
        S.workbook = wb;
        loadSheet(wb.SheetNames[0]);
        renderStep1();
      });
    }
  }

  /* tenta adivinhar automaticamente as correspondências entre colunas do
     Excel e os campos da camada, por semelhança de nome (fase 2) */
  function buildDefaultMapping(){
    var schema = getLayerSchema(S.layerId);
    var attrs = (schema && schema.attributes) || [];
    S.mapping = attrs.map(function(attr){
      var guess = S.headers.find(function(h){
        return h && attr.name && h.toString().toLowerCase().replace(/[^a-z0-9]/g,'') === attr.name.toLowerCase().replace(/[^a-z0-9]/g,'');
      }) || S.headers.find(function(h){
        return h && attr.name && h.toString().toLowerCase().includes(attr.name.toLowerCase().slice(0,4));
      }) || '';
      return {sigField: attr.name, excelCol: guess};
    });
    if(!S.keySigField && attrs.length){
      // tenta adivinhar qual campo parece ser o identificador
      var idAttr = attrs.find(function(a){ return /id|codigo|código|obra|ref/i.test(a.name); }) || attrs[0];
      S.keySigField = idAttr.name;
      var m = S.mapping.find(function(mm){ return mm.sigField === S.keySigField; });
      S.keyExcelCol = m ? m.excelCol : (S.headers[0] || '');
    }
  }

  /* ---------------- FASE 2/3: correspondência dos campos + chave ---------------- */
  function renderStep2(){
    var body = document.getElementById('ss-step-body');
    var schema = getLayerSchema(S.layerId);
    var attrs = (schema && schema.attributes) || [];
    var geomType = schema && schema.geometryType;

    var rowsHtml = attrs.map(function(attr, i){
      var options = ['<option value="">— não corresponder —</option>'].concat(
        S.headers.map(function(h){
          var m = S.mapping[i];
          return '<option value="'+esc(h)+'"'+(m && m.excelCol===h?' selected':'')+'>'+esc(h)+'</option>';
        })
      ).join('');
      return '<tr>' +
        '<td><b>' + esc(attr.name) + '</b><div class="ss-hint">' + esc(attr.type||'') + '</div></td>' +
        '<td><select data-idx="'+i+'" class="ss-map-select">' + options + '</select></td>' +
        '<td class="ss-map-key-radio"><input type="radio" name="ss-key-field" value="'+esc(attr.name)+'" ' + (S.keySigField===attr.name?'checked':'') + '></td>' +
      '</tr>';
    }).join('');

    var latLngHtml = geomType === 'Point' ?
      '<div class="ss-card">' +
        '<h3>Colunas de coordenadas (opcional, só necessário para criar pontos novos)</h3>' +
        '<div class="ss-field" style="display:flex; gap:12px;">' +
          '<div style="flex:1;"><label>Coluna de Latitude</label><select id="ss-lat-select"><option value="">—</option>' +
            S.headers.map(function(h){ return '<option value="'+esc(h)+'"'+(h===S.latCol?' selected':'')+'>'+esc(h)+'</option>'; }).join('') +
          '</select></div>' +
          '<div style="flex:1;"><label>Coluna de Longitude</label><select id="ss-lng-select"><option value="">—</option>' +
            S.headers.map(function(h){ return '<option value="'+esc(h)+'"'+(h===S.lngCol?' selected':'')+'>'+esc(h)+'</option>'; }).join('') +
          '</select></div>' +
        '</div>' +
        '<div class="ss-hint">Se não indicar latitude/longitude, os registos sem correspondência ficam assinalados no relatório em vez de serem criados automaticamente.</div>' +
      '</div>' : '';

    body.innerHTML =
      '<div class="ss-note"><b>Fase 2 e 3.</b> Faça corresponder cada campo da camada a uma coluna do Excel e assinale, na última coluna, qual é o identificador (a "chave") usado para saber que registo do Excel corresponde a que objeto da camada.</div>' +
      '<div class="ss-card">' +
        '<h3>Correspondência de campos</h3>' +
        '<table class="ss-map-table"><thead><tr><th>Campo SIG</th><th>Coluna do Excel/CSV</th><th>Chave</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
      '</div>' +
      latLngHtml +
      '<div class="ss-actions-row">' +
        '<button class="ss-btn ss-btn-secondary" id="ss-step2-back">← Voltar</button>' +
        '<button class="ss-btn" id="ss-step2-next" ' + (S.keySigField ? '' : 'disabled') + '>Pré-visualizar →</button>' +
      '</div>';

    Array.prototype.slice.call(document.querySelectorAll('.ss-map-select')).forEach(function(sel){
      sel.addEventListener('change', function(){
        var i = Number(sel.dataset.idx);
        S.mapping[i].excelCol = sel.value;
        if(S.mapping[i].sigField === S.keySigField) S.keyExcelCol = sel.value;
      });
    });
    Array.prototype.slice.call(document.querySelectorAll('input[name="ss-key-field"]')).forEach(function(radio){
      radio.addEventListener('change', function(){
        S.keySigField = radio.value;
        var m = S.mapping.find(function(mm){ return mm.sigField === S.keySigField; });
        S.keyExcelCol = m ? m.excelCol : '';
      });
    });
    var latSel = document.getElementById('ss-lat-select');
    var lngSel = document.getElementById('ss-lng-select');
    if(latSel) latSel.addEventListener('change', function(){ S.latCol = latSel.value; });
    if(lngSel) lngSel.addEventListener('change', function(){ S.lngCol = lngSel.value; });

    document.getElementById('ss-step2-back').addEventListener('click', function(){ S.step = 0; renderWizard(); });
    document.getElementById('ss-step2-next').addEventListener('click', function(){
      if(!S.keyExcelCol){ alert('Escolha a coluna do Excel correspondente ao campo-chave.'); return; }
      computePreview();
      S.step = 2;
      renderWizard();
    });
  }

  /* ---------------- validação (fase 10) + deteção de alterações (fase 9) + preview (fase 4) ---------------- */
  function computePreview(){
    var schema = getLayerSchema(S.layerId);
    var attrs = (schema && schema.attributes) || [];
    var mapping = S.mapping.filter(function(m){ return m.excelCol; });
    var recipeKey = 'layer' + S.layerId + ':' + S.keySigField;
    var lastHashes = getRowHashes(recipeKey);

    // índice das entidades existentes desta camada pela chave
    var existingByKey = {};
    featuresData.forEach(function(entry, id){
      if(entry.layerId === S.layerId){
        var val = entry.props ? entry.props[S.keySigField] : undefined;
        if(val !== undefined && val !== null && val !== ''){
          existingByKey[String(val).trim()] = entry;
        }
      }
    });

    var seenKeys = {};
    var results = [];
    var validationErrors = [];

    S.rows.forEach(function(row, rowIdx){
      var keyVal = row[S.keyExcelCol];
      var keyStr = (keyVal === undefined || keyVal === null) ? '' : String(keyVal).trim();
      var rowErrors = [];

      if(!keyStr) rowErrors.push('chave vazia');
      if(keyStr && seenKeys[keyStr]) rowErrors.push('chave duplicada no ficheiro');
      seenKeys[keyStr] = (seenKeys[keyStr] || 0) + 1;

      var newProps = {};
      mapping.forEach(function(m){
        var attr = attrs.find(function(a){ return a.name === m.sigField; });
        var val = row[m.excelCol];
        if(attr && attr.type === 'numero' && val !== '' && val !== undefined && val !== null && isNaN(Number(val))){
          rowErrors.push('valor não-numérico em "' + attr.name + '"');
        }
        newProps[m.sigField] = (val === undefined || val === null) ? '' : val;
      });

      var lat = S.latCol ? Number(row[S.latCol]) : null;
      var lng = S.lngCol ? Number(row[S.lngCol]) : null;
      if(S.latCol && (row[S.latCol] !== '' && row[S.latCol] !== undefined) && (isNaN(lat) || lat < -90 || lat > 90)) rowErrors.push('latitude inválida');
      if(S.lngCol && (row[S.lngCol] !== '' && row[S.lngCol] !== undefined) && (isNaN(lng) || lng < -180 || lng > 180)) rowErrors.push('longitude inválida');

      var hash = simpleHash(JSON.stringify(newProps));
      var unchanged = keyStr && lastHashes[keyStr] === hash;

      var existing = keyStr ? existingByKey[keyStr] : null;
      var action;
      if(rowErrors.length){
        action = 'error';
      } else if(existing){
        action = unchanged ? 'skip' : 'update';
      } else {
        var geomType = schema && schema.geometryType;
        var canCreate = geomType === 'Point' && S.latCol && S.lngCol && lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng);
        action = canCreate ? 'create' : 'error';
        if(!canCreate && !rowErrors.length) rowErrors.push('sem correspondência e sem geometria para criar automaticamente');
      }

      results.push({
        rowIdx: rowIdx, keyStr: keyStr, newProps: newProps, hash: hash,
        existing: existing || null, action: action, errors: rowErrors, lat: lat, lng: lng
      });
      if(rowErrors.length) validationErrors.push({rowIdx: rowIdx, keyStr: keyStr, errors: rowErrors});
    });

    S.preview = {
      results: results,
      recipeKey: recipeKey,
      counts: {
        total: results.length,
        update: results.filter(function(r){ return r.action==='update'; }).length,
        create: results.filter(function(r){ return r.action==='create'; }).length,
        error: results.filter(function(r){ return r.action==='error'; }).length,
        skip: results.filter(function(r){ return r.action==='skip'; }).length
      },
      validationErrors: validationErrors
    };
  }

  /* ---------------- FASE 4: pré-visualização ---------------- */
  function renderStep3Preview(){
    var body = document.getElementById('ss-step-body');
    var c = S.preview.counts;
    var rowsHtml = S.preview.results.slice(0, 300).map(function(r){
      var tag = {update:'upd', create:'new', error:'err', skip:'skip'}[r.action];
      var tagLabel = {update:'Atualizar', create:'Criar', error:'Erro', skip:'Sem alterações'}[r.action];
      return '<tr>' +
        '<td>' + esc(r.keyStr || '(vazio)') + '</td>' +
        '<td><span class="ss-tag ' + tag + '">' + tagLabel + '</span></td>' +
        '<td>' + esc(r.errors.join('; ')) + '</td>' +
      '</tr>';
    }).join('');

    body.innerHTML =
      '<div class="ss-stats-grid">' +
        '<div class="ss-stat-box"><b>' + c.total + '</b><span>registos encontrados</span></div>' +
        '<div class="ss-stat-box is-update"><b>' + c.update + '</b><span>serão atualizados</span></div>' +
        '<div class="ss-stat-box is-create"><b>' + c.create + '</b><span>serão criados</span></div>' +
        '<div class="ss-stat-box is-conflict"><b>' + c.error + '</b><span>apresentam erros/conflitos</span></div>' +
      '</div>' +
      (c.skip ? '<p class="ss-hint">' + c.skip + ' registo(s) sem alterações desde a última sincronização desta receita (serão ignorados (deteção de alterações).</p>' : '') +
      '<div class="ss-card">' +
        '<h3>Detalhe por registo</h3>' +
        '<div class="ss-table-wrap"><table class="ss-table"><thead><tr><th>Chave</th><th>Ação</th><th>Notas</th></tr></thead><tbody>' + (rowsHtml || '<tr><td colspan="3" class="ss-empty">Sem registos.</td></tr>') + '</tbody></table></div>' +
        (S.preview.results.length > 300 ? '<div class="ss-hint">A mostrar os primeiros 300 de ' + S.preview.results.length + ' registos.</div>' : '') +
      '</div>' +
      '<div class="ss-actions-row">' +
        '<button class="ss-btn ss-btn-secondary" id="ss-step3-back">← Voltar</button>' +
        '<button class="ss-btn" id="ss-step3-next" ' + ((c.update + c.create) ? '' : 'disabled') + '>Executar →</button>' +
      '</div>';

    document.getElementById('ss-step3-back').addEventListener('click', function(){ S.step = 1; renderWizard(); });
    document.getElementById('ss-step3-next').addEventListener('click', function(){
      S.step = 3;
      renderWizard();
      runExecution();
    });
  }

  /* ---------------- FASE 5: execução ---------------- */
  function renderStep4Execute(){
    var body = document.getElementById('ss-step-body');
    body.innerHTML = '<div class="ss-card"><h3>A executar…</h3><p class="ss-hint">A atualizar objetos na camada. Não feche esta janela.</p></div>';
  }

  function runExecution(){
    var t0 = performance.now();
    var updated = 0, created = 0, errors = 0;
    var hashesToStore = getRowHashes(S.preview.recipeKey);
    var schema = getLayerSchema(S.layerId);

    S.preview.results.forEach(function(r){
      if(r.action === 'update'){
        Object.keys(r.newProps).forEach(function(field){
          r.existing.props[field] = r.newProps[field];
        });
        r.existing.updatedAt = Date.now();
        updated++;
        hashesToStore[r.keyStr] = r.hash;
      } else if(r.action === 'create'){
        try{
          var marker = L.marker([r.lat, r.lng]);
          if(layerVisible.get(S.layerId) === undefined) layerVisible.set(S.layerId, true);
          if(!layerOrder.includes(S.layerId)) layerOrder.unshift(S.layerId);
          drawnGroup.addLayer(marker);
          assignLayerPane(marker, S.layerId);
          var id = L.Util.stamp(marker);
          var entry = {
            layer: marker, props: {...r.newProps}, id: id, fid: genFid(), updatedAt: Date.now(),
            label: 'Geometria (sync)', geomType: 'Point', layerId: S.layerId,
            hasOverlap:false, overlapsWith:[], showMeasures:false, measureTooltips:[]
          };
          entry.props[S.keySigField] = r.keyStr;
          featuresData.set(id, entry);
          styleLayerDefault(marker, S.layerId);
          created++;
          hashesToStore[r.keyStr] = r.hash;
        } catch(e){
          errors++;
        }
      } else if(r.action === 'error'){
        errors++;
      }
    });

    setRowHashes(S.preview.recipeKey, hashesToStore);
    if(typeof markProjectDirty === 'function') markProjectDirty();
    if(typeof refreshFeatList === 'function') refreshFeatList();
    if(typeof applyLayerZOrder === 'function') applyLayerZOrder();
    if(typeof checkAllTopology === 'function') { try{ checkAllTopology(); } catch(e){} }

    var elapsedSec = ((performance.now() - t0) / 1000).toFixed(1);
    S.lastResult = {
      updated: updated, created: created, errors: errors,
      total: S.preview.counts.total, elapsedSec: elapsedSec, at: Date.now()
    };

    pushHistory({
      at: Date.now(),
      recipeName: S.activeRecipeName || '(sincronização avulsa)',
      layerName: getLayerLabel(S.layerId),
      fileName: S.fileName,
      updated: updated, created: created, errors: errors,
      user: window.currentAdminUser || 'Desconhecido'
    });

    S.step = 4;
    renderWizard();
  }

  /* ---------------- FASE 6: relatório ---------------- */
  function renderStep5Report(){
    var body = document.getElementById('ss-step-body');
    var r = S.lastResult;
    body.innerHTML =
      '<div class="ss-stats-grid">' +
        '<div class="ss-stat-box is-update"><b>✓ ' + r.updated + '</b><span>atualizados</span></div>' +
        '<div class="ss-stat-box is-create"><b>✓ ' + r.created + '</b><span>inseridos</span></div>' +
        '<div class="ss-stat-box is-conflict"><b>✗ ' + r.errors + '</b><span>erros</span></div>' +
        '<div class="ss-stat-box"><b>' + r.elapsedSec + 's</b><span>tempo total</span></div>' +
      '</div>' +
      '<div class="ss-actions-row">' +
        '<button class="ss-btn ss-btn-secondary" id="ss-export-report">Exportar relatório</button>' +
        '<button class="ss-btn" id="ss-step5-next">Guardar como receita →</button>' +
        '<button class="ss-btn ss-btn-secondary" id="ss-finish">Concluir</button>' +
      '</div>';

    document.getElementById('ss-export-report').addEventListener('click', exportReport);
    document.getElementById('ss-step5-next').addEventListener('click', function(){ S.step = 5; renderWizard(); });
    document.getElementById('ss-finish').addEventListener('click', function(){ resetSyncState(); renderWizard(); });
  }

  function exportReport(){
    var lines = ['Sincronização Inteligente / Relatório', new Date().toLocaleString('pt-PT'), ''];
    lines.push('Camada: ' + getLayerLabel(S.layerId));
    lines.push('Ficheiro: ' + (S.fileName || ''));
    lines.push('Atualizados: ' + S.lastResult.updated);
    lines.push('Inseridos: ' + S.lastResult.created);
    lines.push('Erros: ' + S.lastResult.errors);
    lines.push('Tempo: ' + S.lastResult.elapsedSec + 's');
    lines.push('');
    lines.push('Chave;Ação;Notas');
    S.preview.results.forEach(function(r){
      lines.push([r.keyStr, r.action, r.errors.join(' / ')].join(';'));
    });
    var blob = new Blob([lines.join('\n')], {type:'text/plain;charset=utf-8'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'relatorio-sync-' + Date.now() + '.txt';
    a.click();
  }

  /* ---------------- FASE 7: guardar receita ---------------- */
  function renderStep6SaveRecipe(){
    var body = document.getElementById('ss-step-body');
    body.innerHTML =
      '<div class="ss-card">' +
        '<h3>Guardar esta configuração como receita</h3>' +
        '<div class="ss-field"><label>Nome da receita</label><input type="text" id="ss-recipe-name" placeholder="ex: Atualização Obras" value="' + esc(S.activeRecipeName || '') + '"></div>' +
        '<button class="ss-btn" id="ss-recipe-save">Guardar receita</button>' +
      '</div>' +
      '<div class="ss-actions-row">' +
        '<button class="ss-btn ss-btn-secondary" id="ss-finish2">Concluir sem guardar</button>' +
      '</div>';

    document.getElementById('ss-recipe-save').addEventListener('click', function(){
      var name = document.getElementById('ss-recipe-name').value.trim();
      if(!name){ alert('Dê um nome à receita.'); return; }
      var recipes = loadRecipes();
      var recipe = {
        name: name, layerId: S.layerId, keySigField: S.keySigField, keyExcelCol: S.keyExcelCol,
        mapping: S.mapping, latCol: S.latCol, lngCol: S.lngCol, sheetName: S.sheetName,
        createdAt: Date.now()
      };
      var idx = recipes.findIndex(function(r){ return r.name === name; });
      if(idx >= 0) recipes[idx] = recipe; else recipes.push(recipe);
      saveRecipes(recipes);
      resetSyncState();
      switchSection('recipes');
    });
    document.getElementById('ss-finish2').addEventListener('click', function(){ resetSyncState(); renderWizard(); });
  }

  /* ============================================================
     RECEITAS GUARDADAS
     ============================================================ */
  function renderRecipes(){
    var recipes = loadRecipes();
    var itemsHtml = recipes.map(function(r, i){
      return '<div class="ss-recipe-card">' +
        '<div><b>' + esc(r.name) + '</b><span>' + esc(getLayerLabel(r.layerId)) + ' · chave: ' + esc(r.keySigField) + '</span></div>' +
        '<div class="ss-recipe-actions">' +
          '<button class="ss-btn" data-run="' + i + '">Executar receita</button>' +
          '<button class="ss-btn ss-btn-secondary ss-btn-danger" data-del="' + i + '">Eliminar</button>' +
        '</div>' +
      '</div>';
    }).join('');

    contentEl.innerHTML =
      '<h2>Receitas guardadas</h2>' +
      '<p class="ss-subtitle">Configurações de sincronização guardadas (Fase 7). Basta escolher o novo ficheiro e clicar em "Executar receita".</p>' +
      (itemsHtml || '<p class="ss-empty">Ainda não guardou nenhuma receita.</p>');

    recipes.forEach(function(r, i){
      var runBtn = contentEl.querySelector('[data-run="'+i+'"]');
      var delBtn = contentEl.querySelector('[data-del="'+i+'"]');
      if(runBtn) runBtn.addEventListener('click', function(){ startFromRecipe(r); });
      if(delBtn) delBtn.addEventListener('click', function(){
        if(!confirm('Eliminar a receita "' + r.name + '"?')) return;
        var list = loadRecipes(); list.splice(i, 1); saveRecipes(list); renderRecipes();
      });
    });
  }

  function startFromRecipe(recipe){
    resetSyncState();
    S.activeRecipeName = recipe.name;
    S.layerId = recipe.layerId;
    S.keySigField = recipe.keySigField;
    S.keyExcelCol = recipe.keyExcelCol;
    S.mapping = recipe.mapping.slice();
    S.latCol = recipe.latCol;
    S.lngCol = recipe.lngCol;
    switchSection('wizard');
    // fica na fase 1 à espera do novo ficheiro; folha/mapeamento já pré-preenchidos
  }

  /* ============================================================
     AUTOMAÇÃO (Fase 8, versão realista dentro de uma página web)
     ============================================================ */
  var automationTimer = null;
  var watchedDirHandle = null;

  function renderAutomation(){
    var supported = !!window.showDirectoryPicker;
    contentEl.innerHTML =
      '<h2>Automação</h2>' +
      '<div class="ss-note"><b>Importante:</b> uma página web só executa código enquanto está aberta. Não é possível agendar "às 08:00 mesmo com o computador desligado" a partir daqui — isso exige um script fora do browser (ex: Tarefas Agendadas do Windows a abrir a app e a receita). O que se disponibiliza abaixo é uma verificação automática ' +
        '<b>enquanto a aplicação estiver aberta</b>: escolhe uma pasta, e a app procura periodicamente por ficheiros novos para aplicar uma receita.</div>' +
      (!supported ? '<p class="ss-empty">O navegador/versão atual não suporta acesso a pastas (File System Access API). Esta funcionalidade fica indisponível aqui.</p>' :
        '<div class="ss-card">' +
          '<h3>Verificação periódica</h3>' +
          '<div class="ss-field"><label>Receita a aplicar</label><select id="ss-auto-recipe"><option value="">— escolher —</option>' +
            loadRecipes().map(function(r,i){ return '<option value="'+i+'">'+esc(r.name)+'</option>'; }).join('') +
          '</select></div>' +
          '<div class="ss-field"><label>Intervalo de verificação (minutos)</label><input type="number" id="ss-auto-interval" value="15" min="1"></div>' +
          '<button class="ss-btn" id="ss-auto-pick-folder">Escolher pasta a vigiar</button>' +
          '<div id="ss-auto-folder-status" class="ss-hint" style="margin-top:8px;"></div>' +
          '<div class="ss-actions-row">' +
            '<button class="ss-btn" id="ss-auto-start" disabled>Iniciar verificação automática</button>' +
            '<button class="ss-btn ss-btn-secondary" id="ss-auto-stop" disabled>Parar</button>' +
          '</div>' +
          '<div class="ss-hint">A pasta escolhida só fica ativa enquanto esta aba estiver aberta (não persiste depois de fechar/recarregar a página).</div>' +
        '</div>');

    if(!supported) return;

    var pickBtn = document.getElementById('ss-auto-pick-folder');
    var startBtn = document.getElementById('ss-auto-start');
    var stopBtn = document.getElementById('ss-auto-stop');
    var statusEl = document.getElementById('ss-auto-folder-status');

    pickBtn.addEventListener('click', function(){
      window.showDirectoryPicker().then(function(handle){
        watchedDirHandle = handle;
        statusEl.textContent = 'Pasta selecionada: ' + handle.name;
        startBtn.disabled = false;
      }).catch(function(){ /* utilizador cancelou */ });
    });

    startBtn.addEventListener('click', function(){
      var recipeIdx = document.getElementById('ss-auto-recipe').value;
      var minutes = Number(document.getElementById('ss-auto-interval').value) || 15;
      if(recipeIdx === '' || !watchedDirHandle){ alert('Escolha uma receita e uma pasta.'); return; }
      var recipe = loadRecipes()[Number(recipeIdx)];
      if(automationTimer) clearInterval(automationTimer);
      checkFolderForNewFiles(watchedDirHandle, recipe); // primeira verificação imediata
      automationTimer = setInterval(function(){ checkFolderForNewFiles(watchedDirHandle, recipe); }, minutes * 60000);
      startBtn.disabled = true; stopBtn.disabled = false;
      statusEl.textContent = 'A vigiar "' + watchedDirHandle.name + '" a cada ' + minutes + ' min (enquanto a app estiver aberta).';
    });

    stopBtn.addEventListener('click', function(){
      if(automationTimer) clearInterval(automationTimer);
      automationTimer = null;
      startBtn.disabled = false; stopBtn.disabled = true;
      statusEl.textContent = 'Verificação automática parada.';
    });
  }

  /* procura o ficheiro .xlsx/.csv mais recente na pasta vigiada e, se for
     novo desde a última verificação, aplica a receita automaticamente */
  var lastSeenFile = null;
  function checkFolderForNewFiles(dirHandle, recipe){
    (async function(){
      var newest = null;
      for await (var entry of dirHandle.values()){
        if(entry.kind === 'file' && /\.(xlsx|xls|csv)$/i.test(entry.name)){
          var file = await entry.getFile();
          if(!newest || file.lastModified > newest.file.lastModified) newest = {entry: entry, file: file};
        }
      }
      if(!newest) return;
      var signature = newest.file.name + ':' + newest.file.lastModified;
      if(signature === lastSeenFile) return; // já processado
      lastSeenFile = signature;

      resetSyncState();
      S.activeRecipeName = recipe.name;
      S.layerId = recipe.layerId; S.keySigField = recipe.keySigField; S.keyExcelCol = recipe.keyExcelCol;
      S.mapping = recipe.mapping.slice(); S.latCol = recipe.latCol; S.lngCol = recipe.lngCol;
      S.fileName = newest.file.name;
      readFile(newest.file, function(err, wb){
        if(err) return;
        S.workbook = wb;
        loadSheet(recipe.sheetName && wb.SheetNames.indexOf(recipe.sheetName) !== -1 ? recipe.sheetName : wb.SheetNames[0]);
        computePreview();
        runExecution();
      });
    })();
  }

  /* ============================================================
     HISTÓRICO (Fase 11)
     ============================================================ */
  function renderHistory(){
    var history = loadHistory();
    var itemsHtml = history.map(function(h){
      var date = new Date(h.at).toLocaleString('pt-PT');
      return '<div class="ss-history-item">' +
        '<b>' + esc(h.recipeName) + '</b> / ' + esc(h.layerName || '') +
        '<div>' + date + ' · ✓ ' + h.updated + ' atualizados · ✓ ' + h.created + ' inseridos' + (h.errors ? ' · ✗ ' + h.errors + ' erros' : '') + '</div>' +
        '<div>Utilizador: ' + esc(h.user || 'Desconhecido') + (h.fileName ? ' · Ficheiro: ' + esc(h.fileName) : '') + '</div>' +
      '</div>';
    }).join('');

    contentEl.innerHTML =
      '<h2>Histórico</h2>' +
      '<p class="ss-subtitle">Cada execução de sincronização fica registada aqui (quando e por quem os dados foram atualizados).</p>' +
      (itemsHtml || '<p class="ss-empty">Ainda não há sincronizações registadas.</p>');
  }

  /* ============================================================
     COMO USAR (menu de ajuda)
     ============================================================ */
  function renderHelp(){
    contentEl.innerHTML =
      '<h2>Como usar a Sincronização Inteligente</h2>' +
      '<p class="ss-subtitle">Guia rápido, passo a passo. Cada bloco pode ser aberto/fechado clicando no título.</p>' +

      '<details class="ss-help-item" open>' +
        '<summary>1. O que é isto?</summary>' +
        '<div class="ss-help-body">' +
          'Serve para atualizar uma camada SIG já existente na app diretamente a partir de um ficheiro Excel (.xlsx) ou CSV (sem teres de abrir cada objeto e editar os campos à mão). ' +
          'A app compara o ficheiro com o que já está na camada e diz-te o que muda, antes de mudar seja o que for.' +
        '</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>2. Passo a passo (Nova sincronização)</summary>' +
        '<div class="ss-help-body">' +
          '<b>Fase 1 / Ficheiro e camada.</b> Escolhe o Excel/CSV (arrasta para a caixa ou clica nela). Se o ficheiro tiver várias folhas, escolhe a folha certa. Depois escolhe a camada da tua app que queres atualizar.<br><br>' +
          '<b>Fase 2 / Correspondência.</b> Para cada campo da camada (ex: ESTADO, TECNICO, DATA), escolhe a coluna do Excel que lhe corresponde. A app tenta adivinhar por ti, mas confirma sempre.<br><br>' +
          '<b>Fase 3 / Chave.</b> Na mesma tabela, marca com o botão de opção qual é o campo que serve de identificador único (ex: ID_OBRA). É assim que a app sabe que a linha "ID 1587" do Excel corresponde ao objeto "ID_OBRA 1587" da camada.<br><br>' +
          '<b>Fase 4 / Pré-visualização.</b> A app mostra quantos registos vai atualizar, criar ou que têm erros. Nada é alterado ainda.<br><br>' +
          '<b>Fase 5/6 / Executar e relatório.</b> Clica em "Executar" e no fim vês o resumo (atualizados / inseridos / erros / tempo). Podes exportar o relatório em .txt.' +
        '</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>3. Quando é que cria objetos novos em vez de só atualizar?</summary>' +
        '<div class="ss-help-body">' +
          'Só quando a camada é de <b>pontos</b> e mapeaste colunas de latitude e longitude no Excel. Sem essas duas colunas, ou se a camada for de linhas/polígonos, os registos sem correspondência ficam marcados como "sem geometria" — tens de os desenhar manualmente, porque não há como inventar uma linha ou polígono a partir de uma folha de cálculo.' +
        '</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>4. Receitas guardadas — para quê?</summary>' +
        '<div class="ss-help-body">' +
          'Se atualizas sempre a mesma camada a partir do mesmo tipo de ficheiro (ex: "Excel Obras.xlsx" → camada "Obras Municipais"), guarda a configuração como receita na Fase 7. Da próxima vez não precisas de repetir a correspondência de campos — vais a "Receitas guardadas", clicas em "Executar receita" e só escolhes o ficheiro novo.' +
        '</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>5. Automação — o que é possível e o que não é</summary>' +
        '<div class="ss-help-body">' +
          'Podes escolher uma pasta e um intervalo (ex: a cada 15 min); enquanto a app estiver aberta, ela verifica a pasta e aplica a receita escolhida a ficheiros novos automaticamente.<br><br>' +
          '<b>O que isto NÃO faz:</b> não corre com a app fechada nem com o computador desligado. Um verdadeiro agendamento "todos os dias às 08:00 sem ninguém tocar em nada" tem de ser feito fora da página web (ex: Tarefas Agendadas do Windows a abrir a app).' +
        '</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>6. Como sei o que mudou entre sincronizações?</summary>' +
        '<div class="ss-help-body">' +
          'A app guarda uma "assinatura" dos valores de cada registo depois de cada sincronização com a mesma receita. Da vez seguinte, se um registo não mudou nada desde a última vez, aparece como "sem alterações" na pré-visualização e não é tocado — só se atualiza o que realmente mudou.' +
        '</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>7. Erros e conflitos mais comuns</summary>' +
        '<div class="ss-help-body">' +
          '• <b>Chave vazia</b> — a linha do Excel não tem valor na coluna escolhida como identificador.<br>' +
          '• <b>Chave duplicada no ficheiro</b> — dois registos do Excel com o mesmo ID.<br>' +
          '• <b>Valor não-numérico</b> — um campo definido como número na camada recebeu texto.<br>' +
          '• <b>Latitude/longitude inválida</b> — fora do intervalo -90/90 ou -180/180.<br>' +
          'Nenhum destes registos é alterado; ficam listados no relatório para corrigires no Excel e voltares a tentar.' +
        '</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>8. Onde fica o histórico?</summary>' +
        '<div class="ss-help-body">' +
          'Em "Histórico", no menu à esquerda — mostra data/hora, receita usada, quantos registos foram atualizados/inseridos e quem fez a sincronização.' +
        '</div>' +
      '</details>';
  }

})();
