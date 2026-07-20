/* ============================================================
   IMPORTAÇÃO CAD — DXF/DWG → SIG
   ============================================================
   Módulo autónomo, depende de funções/variáveis já existentes em
   05-app-main.js (layers, layerCounter, activeLayerId, config,
   featuresData, map, drawnGroup, layerVisible, layerOrder,
   getLayerSchema, importGeoJSONFeatures, buildGeoJSON,
   exportShapefileZip, zoomToLayer, renderLayersPanel,
   markProjectDirty, defaultSymbology) e das bibliotecas já
   carregadas globalmente: proj4, turf, shpwrite.

   Âmbito assumido (importante, para não prometer o que não se
   consegue cumprir dentro de uma página web):

   - DXF é suportado de facto (parsing feito no browser com a
     biblioteca "dxf-parser", carregada sob pedido via import()).
   - DWG NÃO é suportado. É um formato binário proprietário da
     Autodesk — não existe forma fiável de o ler dentro de uma
     página web sem uma licença/SDK (Autodesk RealDWG ou ODA).
     Quando o utilizador escolhe um .dwg, a app explica isto e
     sugere converter primeiro para .dxf com uma ferramenta
     gratuita (ODA File Converter, LibreCAD, QCAD, ou "Guardar
     como" no AutoCAD).
   - A "deteção inteligente" é baseada em REGRAS (nome da layer,
     tipo de entidade, geometria fechada/aberta, nome de blocos) —
     não é um modelo de IA treinado, e por isso não se apresenta
     nenhuma percentagem de "precisão estimada" inventada. O que se
     mostra no relatório final são contagens reais.
   - Exportação: GeoJSON e Shapefile reutilizam as funções já
     existentes na app. KML é gerado por um pequeno conversor
     próprio. GeoPackage não está disponível nesta versão (exige
     uma biblioteca SQLite/GDAL que não faz sentido correr no
     browser) — fica assinalado como tal na interface.
   ============================================================ */
(function(){
  var pageEl = document.getElementById('cad-import-page');
  var openBtn = document.getElementById('btn-cad-import');
  var closeBtn = document.getElementById('cad-close-btn');
  var contentEl = document.getElementById('cad-content');
  var navBtns = Array.prototype.slice.call(document.querySelectorAll('#cad-import-page .ss-nav-btn'));
  if(!pageEl || !openBtn) return;

  var LS_PROFILES = 'cadImportProfiles';
  var LS_HISTORY = 'cadImportHistory';
  var STEP_LABELS = ['Ficheiro','Pré-visualização','Regras & coordenadas','Conversão','Relatório','Guardar perfil'];

  var S = {
    section: 'wizard',
    step: 0,
    fileName: null,
    dxf: null,
    entities: [],
    layerTable: [],     // [{name, count, colorHex, checked, geomHint, targetName}]
    fromCRS: 'EPSG:3763',
    customProj4: '',
    bbox: null,          // {minX,minY,maxX,maxY,width,height} — extensão bruta das coordenadas do DXF
    twoPointInput: {p1x:'', p1y:'', p1lat:'', p1lon:'', p2x:'', p2y:'', p2lat:'', p2lon:''},
    twoPoint: null,       // {valid, p1:{x,y}, q1:{x,y}, scale, rotation} — transformação calculada
    result: null,       // {groups:[{targetName, geomType, layerId, imported, errors}], unsupported, elapsedSec}
    profileName: null
  };

  function resetState(){
    S.step = 0; S.fileName = null; S.dxf = null; S.entities = [];
    S.layerTable = []; S.result = null; S.profileName = null;
    S.bbox = null; S.twoPoint = null;
    S.twoPointInput = {p1x:'', p1y:'', p1lat:'', p1lon:'', p2x:'', p2y:'', p2lat:'', p2lon:''};
  }

  /* ============================================================
     ABRIR / FECHAR
     ============================================================ */
  openBtn.addEventListener('click', function(){ pageEl.hidden = false; switchSection('wizard'); });
  closeBtn.addEventListener('click', function(){ pageEl.hidden = true; });
  document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && !pageEl.hidden) pageEl.hidden = true; });
  navBtns.forEach(function(btn){ btn.addEventListener('click', function(){ switchSection(btn.dataset.cadSection); }); });

  function switchSection(name){
    S.section = name;
    navBtns.forEach(function(b){ b.classList.toggle('is-active', b.dataset.cadSection === name); });
    if(name === 'wizard') renderWizard();
    else if(name === 'profiles') renderProfiles();
    else if(name === 'batch') renderBatch();
    else if(name === 'history') renderHistory();
    else if(name === 'help') renderHelp();
  }

  /* ============================================================
     HELPERS
     ============================================================ */
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function normalize(s){
    return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'');
  }
  function loadProfiles(){ try{ return JSON.parse(localStorage.getItem(LS_PROFILES)||'[]'); }catch(e){ return []; } }
  function saveProfiles(list){ try{ localStorage.setItem(LS_PROFILES, JSON.stringify(list)); }catch(e){} }
  function loadHistory(){ try{ return JSON.parse(localStorage.getItem(LS_HISTORY)||'[]'); }catch(e){ return []; } }
  function pushHistory(entry){
    var h = loadHistory(); h.unshift(entry);
    if(h.length > 200) h = h.slice(0,200);
    try{ localStorage.setItem(LS_HISTORY, JSON.stringify(h)); }catch(e){}
  }

  var dxfParserPromise = null;
  function ensureDxfParser(){
    if(window.DxfParser) return Promise.resolve(window.DxfParser);
    if(!dxfParserPromise){
      dxfParserPromise = import('https://cdn.jsdelivr.net/npm/dxf-parser@1.1.2/+esm')
        .then(function(mod){
          window.DxfParser = mod.default || mod.DxfParser;
          return window.DxfParser;
        });
    }
    return dxfParserPromise;
  }

  /* cores AutoCAD Color Index (ACI) mais comuns — suficiente para dar uma
     cor aproximada; 0/256 (byblock/bylayer) ficam sem cor própria */
  var ACI = {1:'#ff0000',2:'#ffff00',3:'#00ff00',4:'#00ffff',5:'#0000ff',6:'#ff00ff',7:'#ffffff',8:'#808080',9:'#c0c0c0'};
  function aciToHex(idx){ return ACI[idx] || null; }

  /* ============================================================
     LEITURA E PARSING DO FICHEIRO
     ============================================================ */
  function handleFile(file){
    var ext = (file.name.split('.').pop()||'').toLowerCase();
    if(ext === 'dwg'){
      renderDwgWarning(file.name);
      return;
    }
    if(ext !== 'dxf'){
      alert('Formato não suportado. Escolha um ficheiro .dxf (ou .dwg, para ver as instruções de conversão).');
      return;
    }
    S.fileName = file.name;
    renderLoading();
    ensureDxfParser().then(function(DxfParser){
      var reader = new FileReader();
      reader.onload = function(e){
        try{
          var parser = new DxfParser();
          var dxf = parser.parseSync ? parser.parseSync(e.target.result) : parser.parse(e.target.result);
          S.dxf = dxf;
          S.entities = (dxf && dxf.entities) || [];
          buildLayerTable();
          S.bbox = computeBBox(S.entities);
          S.step = 1;
          renderWizard();
        } catch(err){
          console.error('Erro ao processar DXF:', err);
          alert('Não foi possível processar este DXF. Ficheiro corrompido ou com entidades muito específicas não suportadas.');
          S.step = 0; renderWizard();
        }
      };
      reader.onerror = function(){ alert('Não foi possível ler o ficheiro.'); };
      reader.readAsText(file);
    }).catch(function(err){
      console.error(err);
      alert('Não foi possível carregar o leitor de DXF (verifica a ligação à internet).');
      S.step = 0; renderWizard();
    });
  }

  function renderLoading(){
    contentEl.innerHTML = '<h2>A processar…</h2><p class="ss-subtitle">A ler o ficheiro DXF e a identificar layers e entidades.</p>';
  }

  function renderDwgWarning(name){
    contentEl.innerHTML =
      '<h2>Ficheiro .dwg detetado</h2>' +
      '<div class="ss-note"><b>O DWG não pode ser lido diretamente numa página web.</b> É um formato binário proprietário da Autodesk — ler um .dwg de forma fiável exige uma licença/SDK (Autodesk RealDWG ou ODA), o que está fora do alcance desta aplicação.<br><br>' +
      'Para importares "' + esc(name) + '", converte primeiro para <b>.dxf</b> com uma destas ferramentas gratuitas e depois volta a esta página:' +
      '<ul style="margin:10px 0 0 18px; padding:0;">' +
        '<li>ODA File Converter (gratuito, oficial)</li>' +
        '<li>LibreCAD ou QCAD (abrir e "Guardar como" .dxf)</li>' +
        '<li>AutoCAD / BricsCAD — "Guardar como" → DXF</li>' +
      '</ul></div>' +
      '<button class="ss-btn" id="cad-dwg-retry">Escolher outro ficheiro</button>';
    document.getElementById('cad-dwg-retry').addEventListener('click', function(){ S.step = 0; renderWizard(); });
  }

  /* ============================================================
     TABELA DE LAYERS (Fase 1/2) + heurísticas de deteção (Fase 6)
     ============================================================ */
  var KEYWORD_RULES = [
    {re:/cota|dim/, target:'Cotas', geom:'LineString', checked:false},
    {re:/texto|text|label|annot|rotul/, target:'Textos', geom:'Point', checked:false},
    {re:/simbolo|symbol/, target:'Símbolos', geom:'Point', checked:false},
    {re:/build|edif/, target:'Edifícios', geom:'Polygon', checked:true},
    {re:/road|estrada|arruamento|^via$/, target:'Estradas', geom:'LineString', checked:true},
    {re:/eixo|axis/, target:'Eixos', geom:'LineString', checked:true},
    {re:/passeio|sidewalk|calcada/, target:'Passeios', geom:'LineString', checked:true},
    {re:/tree|arvore/, target:'Árvores', geom:'Point', checked:true},
    {re:/water|agua|hidr/, target:'Rede Água', geom:'LineString', checked:true},
    {re:/sewer|esgoto|saneamento/, target:'Rede Esgotos', geom:'LineString', checked:true}
  ];
  var BLOCK_TIPO_RULES = [
    {re:/arvore|tree/, tipo:'Árvore'},
    {re:/hidrante|hydrant/, tipo:'Hidrante'},
    {re:/poste|pole|light/, tipo:'Poste'},
    {re:/caixa|manhole|visita/, tipo:'Caixa de Visita'},
    {re:/valvula|valve/, tipo:'Válvula'}
  ];

  function classifyLayerName(name){
    var n = normalize(name);
    for(var i=0;i<KEYWORD_RULES.length;i++){
      if(KEYWORD_RULES[i].re.test(n)) return {targetName: KEYWORD_RULES[i].target, geom: KEYWORD_RULES[i].geom, checked: KEYWORD_RULES[i].checked};
    }
    return null;
  }
  function classifyBlockTipo(blockName){
    var n = normalize(blockName);
    for(var i=0;i<BLOCK_TIPO_RULES.length;i++){
      if(BLOCK_TIPO_RULES[i].re.test(n)) return BLOCK_TIPO_RULES[i].tipo;
    }
    return blockName || 'Bloco';
  }

  function entityIsClosed(e){
    if(e.shape === true || e.closed === true) return true;
    var v = e.vertices;
    if(Array.isArray(v) && v.length > 2){
      var a = v[0], b = v[v.length-1];
      if(a && b && Math.abs(a.x-b.x) < 1e-6 && Math.abs(a.y-b.y) < 1e-6) return true;
    }
    return false;
  }

  function dominantGeomForLayer(entities){
    var counts = {Point:0, LineString:0, Polygon:0};
    entities.forEach(function(e){
      if(e.type === 'INSERT' || e.type === 'CIRCLE' || e.type === 'TEXT' || e.type === 'MTEXT' || e.type === 'POINT') counts.Point++;
      else if((e.type === 'LWPOLYLINE' || e.type === 'POLYLINE') && entityIsClosed(e)) counts.Polygon++;
      else if(e.type === 'LINE' || e.type === 'LWPOLYLINE' || e.type === 'POLYLINE' || e.type === 'ARC') counts.LineString++;
    });
    return Object.keys(counts).sort(function(a,b){ return counts[b]-counts[a]; })[0];
  }

  function buildLayerTable(){
    var byLayer = {};
    S.entities.forEach(function(e){
      var lname = e.layer || '0';
      if(!byLayer[lname]) byLayer[lname] = [];
      byLayer[lname].push(e);
    });
    var dxfLayerColors = {};
    try{
      var tbl = S.dxf.tables && S.dxf.tables.layer && S.dxf.tables.layer.layers;
      if(tbl) Object.keys(tbl).forEach(function(k){ dxfLayerColors[k] = aciToHex(tbl[k].colorIndex || tbl[k].color); });
    }catch(e){}

    S.layerTable = Object.keys(byLayer).map(function(lname){
      var ents = byLayer[lname];
      var guess = classifyLayerName(lname);
      var geom = (guess && guess.geom) || dominantGeomForLayer(ents);
      return {
        name: lname,
        count: ents.length,
        colorHex: dxfLayerColors[lname] || '#3d6b4f',
        checked: guess ? guess.checked : true,
        geomHint: geom,
        targetName: (guess && guess.targetName) || lname
      };
    }).sort(function(a,b){ return b.count - a.count; });
  }

  /* extensão bruta (bounding box) das coordenadas tal como estão no DXF,
     antes de qualquer reprojeção — serve para detetar desenhos "locais"
     (sem coordenadas geográficas reais, ex: modelos exportados de
     Blender/SketchUp à escala do próprio objeto) */
  function computeBBox(entities){
    var minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity, found=false;
    function acc(x,y){
      if(typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return;
      found = true;
      if(x<minX) minX=x; if(x>maxX) maxX=x;
      if(y<minY) minY=y; if(y>maxY) maxY=y;
    }
    entities.forEach(function(e){
      if(Array.isArray(e.vertices)) e.vertices.forEach(function(v){ if(v) acc(v.x, v.y); });
      if(e.center) acc(e.center.x, e.center.y);
      if(e.position) acc(e.position.x, e.position.y);
      if(e.insertionPoint) acc(e.insertionPoint.x, e.insertionPoint.y);
      if(e.startPoint) acc(e.startPoint.x, e.startPoint.y);
    });
    if(!found) return null;
    return {minX:minX, minY:minY, maxX:maxX, maxY:maxY, width: maxX-minX, height: maxY-minY};
  }

  /* ============================================================
     RENDER PRINCIPAL DO WIZARD
     ============================================================ */
  function renderWizard(){
    var stepsHtml = STEP_LABELS.map(function(label,i){
      var cls = i === S.step ? 'is-active' : (i < S.step ? 'is-done' : '');
      return '<div class="ss-step-pill ' + cls + '"><span class="ss-step-num">' + (i+1) + '</span>' + esc(label) + '</div>';
    }).join('');

    contentEl.innerHTML =
      '<h2>Nova importação</h2>' +
      '<p class="ss-subtitle">Converte um desenho CAD (DXF) diretamente para uma ou mais camadas SIG, com limpeza automática de geometria.</p>' +
      '<div class="ss-steps">' + stepsHtml + '</div>' +
      '<div id="cad-step-body"></div>';

    if(S.step === 0) renderStep1();
    else if(S.step === 1) renderStep2Preview();
    else if(S.step === 2) renderStep3Rules();
    else if(S.step === 3) renderStep4Convert();
    else if(S.step === 4) renderStep5Report();
    else if(S.step === 5) renderStep6SaveProfile();
  }

  /* ---------------- FASE 1: ficheiro ---------------- */
  function renderStep1(){
    var body = document.getElementById('cad-step-body');
    body.innerHTML =
      '<div class="ss-card">' +
        '<h3>Ficheiro CAD</h3>' +
        '<div class="ss-dropzone" id="cad-dropzone">' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
          '<b>Clique para escolher um ficheiro .dxf</b>' +
          '<span>.dwg também é aceite — mostra instruções de conversão para .dxf</span>' +
        '</div>' +
        '<input type="file" id="cad-file-input" accept=".dxf,.dwg" style="display:none;">' +
        (S.fileName ? '<div class="ss-file-chip">📄 ' + esc(S.fileName) + '</div>' : '') +
      '</div>';

    var dz = document.getElementById('cad-dropzone');
    var fi = document.getElementById('cad-file-input');
    dz.addEventListener('click', function(){ fi.click(); });
    dz.addEventListener('dragover', function(e){ e.preventDefault(); dz.classList.add('is-drag'); });
    dz.addEventListener('dragleave', function(){ dz.classList.remove('is-drag'); });
    dz.addEventListener('drop', function(e){
      e.preventDefault(); dz.classList.remove('is-drag');
      if(e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
    });
    fi.addEventListener('change', function(){ if(fi.files && fi.files[0]) handleFile(fi.files[0]); });
  }

  /* ---------------- FASE 2: pré-visualização de layers ---------------- */
  function renderStep2Preview(){
    var body = document.getElementById('cad-step-body');
    var totalEntities = S.entities.length;
    var rowsHtml = S.layerTable.map(function(l, i){
      return '<div class="cad-layer-row">' +
        '<input type="checkbox" data-idx="'+i+'" class="cad-layer-check" '+(l.checked?'checked':'')+'>' +
        '<span class="cad-layer-swatch" style="background:'+esc(l.colorHex)+';"></span>' +
        '<span class="cad-layer-name">' + esc(l.name) + '<span class="cad-geom-badge ' + (l.geomHint==='Point'?'pt':l.geomHint==='Polygon'?'pg':'ln') + '">' + esc(l.geomHint) + '</span></span>' +
        '<span class="cad-layer-count">' + l.count + ' entidade(s)</span>' +
      '</div>';
    }).join('');

    var bboxWarnHtml = '';
    if(S.bbox && Math.max(S.bbox.width, S.bbox.height) < 5){
      bboxWarnHtml =
        '<div class="ss-note" style="background:rgba(179,65,60,.07); border-color:rgba(179,65,60,.28);">' +
          '<b>⚠ Este desenho parece não ter coordenadas geográficas reais.</b> ' +
          'As geometrias ocupam apenas ' + S.bbox.width.toFixed(3) + ' × ' + S.bbox.height.toFixed(3) + ' unidades no total ' +
          '(demasiado pequeno para ser um levantamento à escala real). É provável que seja um modelo local ' +
          '(ex: exportado de um programa 3D como Blender/SketchUp), à escala do próprio objeto, sem qualquer ligação ao mundo real.<br><br>' +
          'Se escolheres um sistema de coordenadas geográfico (ETRS89/PT-TM06 ou WGS84) na fase seguinte, o desenho vai aparecer ' +
          'minúsculo e num sítio aleatório do mapa. Usa antes a opção <b>"Desenho local (georreferenciar manualmente por 2 pontos)"</b> na fase seguinte.' +
        '</div>';
    }

    body.innerHTML =
      '<div class="ss-note"><b>' + esc(S.fileName) + '</b> — ' + totalEntities + ' entidade(s) em ' + S.layerTable.length + ' layer(s). Sistema de coordenadas: não indicado no DXF (escolhe-se na fase seguinte).</div>' +
      bboxWarnHtml +
      '<div class="ss-card">' +
        '<h3>Layers encontrados (escolhe quais importar)</h3>' +
        rowsHtml +
      '</div>' +
      '<div class="ss-actions-row">' +
        '<button class="ss-btn ss-btn-secondary" id="cad-step2-back">← Voltar</button>' +
        '<button class="ss-btn" id="cad-step2-next">Seguinte →</button>' +
      '</div>';

    Array.prototype.slice.call(document.querySelectorAll('.cad-layer-check')).forEach(function(cb){
      cb.addEventListener('change', function(){ S.layerTable[Number(cb.dataset.idx)].checked = cb.checked; });
    });
    document.getElementById('cad-step2-back').addEventListener('click', function(){ S.step = 0; renderWizard(); });
    document.getElementById('cad-step2-next').addEventListener('click', function(){
      if(!S.layerTable.some(function(l){ return l.checked; })){ alert('Selecione pelo menos um layer.'); return; }
      S.step = 2; renderWizard();
    });
  }

  /* ---------------- FASE 3 + 7: regras de conversão + CRS ---------------- */
  function renderStep3Rules(){
    var body = document.getElementById('cad-step-body');
    var checkedLayers = S.layerTable.filter(function(l){ return l.checked; });

    var rowsHtml = checkedLayers.map(function(l, i){
      return '<tr>' +
        '<td><b>' + esc(l.name) + '</b><div class="ss-hint">' + l.count + ' entidade(s)</div></td>' +
        '<td><input type="text" data-idx="'+i+'" class="cad-target-name" value="'+esc(l.targetName)+'" style="width:100%; padding:6px 8px; border:1px solid var(--line-strong); border-radius:6px;"></td>' +
        '<td><select data-idx="'+i+'" class="cad-target-geom">' +
          ['Point','LineString','Polygon'].map(function(g){ return '<option value="'+g+'"'+(g===l.geomHint?' selected':'')+'>'+g+'</option>'; }).join('') +
        '</select></td>' +
      '</tr>';
    }).join('');

    body.innerHTML =
      '<div class="ss-note"><b>Fase 3.</b> Define, para cada layer CAD escolhido, o nome da camada SIG de destino (é criada uma camada nova com este nome) e o tipo de geometria. Só precisas de fazer isto uma vez (depois guarda como perfil).</div>' +
      '<div class="ss-card">' +
        '<h3>Correspondência layer CAD → camada SIG</h3>' +
        '<table class="ss-map-table"><thead><tr><th>Layer CAD</th><th>Nome da camada SIG</th><th>Geometria</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>' +
      '</div>' +
      '<div class="ss-card">' +
        '<h3>Fase 7 / Sistema de coordenadas de origem</h3>' +
        '<div class="ss-field">' +
          '<label>O ficheiro está em:</label>' +
          '<select id="cad-crs-select">' +
            '<option value="EPSG:3763"'+(S.fromCRS==='EPSG:3763'?' selected':'')+'>ETRS89 / PT-TM06 (EPSG:3763) / metros, uso comum em Portugal</option>' +
            '<option value="EPSG:4326"'+(S.fromCRS==='EPSG:4326'?' selected':'')+'>WGS84 / graus (EPSG:4326)</option>' +
            '<option value="custom"'+(S.fromCRS==='custom'?' selected':'')+'>Outro (definição proj4 manual)</option>' +
            '<option value="twopoint"'+(S.fromCRS==='twopoint'?' selected':'')+'>Desenho local (sem coordenadas reais, georreferenciar manualmente por 2 pontos)</option>' +
          '</select>' +
        '</div>' +
        '<div class="ss-field" id="cad-crs-custom-wrap" style="'+(S.fromCRS==='custom'?'':'display:none;')+'">' +
          '<label>Definição proj4</label>' +
          '<input type="text" id="cad-crs-custom" placeholder="+proj=... +ellps=... +units=m +no_defs" value="'+esc(S.customProj4)+'">' +
          '<div class="ss-hint">Só para quem já conhece o sistema de coordenadas do desenho. Se não souberes, escolhe uma das opções acima.</div>' +
        '</div>' +
        '<div class="ss-field" id="cad-crs-twopoint-wrap" style="'+(S.fromCRS==='twopoint'?'':'display:none;')+'">' +
          '<div class="ss-hint" style="margin-bottom:10px;">Indica dois pontos do desenho (as coordenadas tal como aparecem no CAD) e onde esses mesmos dois pontos ficam no mundo real (latitude/longitude). A app calcula a escala e a rotação automaticamente a partir destes dois pontos.</div>' +
          '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">' +
            '<div><label>Ponto 1 / X no desenho</label><input type="text" id="cad-tp-p1x" value="'+esc(S.twoPointInput.p1x)+'" placeholder="ex: 0.004042"></div>' +
            '<div><label>Ponto 1 / Y no desenho</label><input type="text" id="cad-tp-p1y" value="'+esc(S.twoPointInput.p1y)+'" placeholder="ex: -0.091303"></div>' +
            '<div><label>Ponto 1 / Latitude real</label><input type="text" id="cad-tp-p1lat" value="'+esc(S.twoPointInput.p1lat)+'" placeholder="ex: 41.15790"></div>' +
            '<div><label>Ponto 1 / Longitude real</label><input type="text" id="cad-tp-p1lon" value="'+esc(S.twoPointInput.p1lon)+'" placeholder="ex: -8.62910"></div>' +
            '<div><label>Ponto 2 / X no desenho</label><input type="text" id="cad-tp-p2x" value="'+esc(S.twoPointInput.p2x)+'" placeholder="ex: 0.019870"></div>' +
            '<div><label>Ponto 2 / Y no desenho</label><input type="text" id="cad-tp-p2y" value="'+esc(S.twoPointInput.p2y)+'" placeholder="ex: -0.050120"></div>' +
            '<div><label>Ponto 2 / Latitude real</label><input type="text" id="cad-tp-p2lat" value="'+esc(S.twoPointInput.p2lat)+'" placeholder="ex: 41.15845"></div>' +
            '<div><label>Ponto 2 / Longitude real</label><input type="text" id="cad-tp-p2lon" value="'+esc(S.twoPointInput.p2lon)+'" placeholder="ex: -8.62822"></div>' +
          '</div>' +
          '<div class="ss-hint" id="cad-tp-status" style="margin-top:8px;"></div>' +
        '</div>' +
      '</div>' +
      '<div class="ss-actions-row">' +
        '<button class="ss-btn ss-btn-secondary" id="cad-step3-back">← Voltar</button>' +
        '<button class="ss-btn" id="cad-step3-next">Converter →</button>' +
      '</div>';

    Array.prototype.slice.call(document.querySelectorAll('.cad-target-name')).forEach(function(inp){
      inp.addEventListener('change', function(){ checkedLayers[Number(inp.dataset.idx)].targetName = inp.value.trim() || checkedLayers[Number(inp.dataset.idx)].name; });
    });
    Array.prototype.slice.call(document.querySelectorAll('.cad-target-geom')).forEach(function(sel){
      sel.addEventListener('change', function(){ checkedLayers[Number(sel.dataset.idx)].geomHint = sel.value; });
    });
    document.getElementById('cad-crs-select').addEventListener('change', function(e){
      S.fromCRS = e.target.value;
      document.getElementById('cad-crs-custom-wrap').style.display = S.fromCRS === 'custom' ? '' : 'none';
      document.getElementById('cad-crs-twopoint-wrap').style.display = S.fromCRS === 'twopoint' ? '' : 'none';
    });
    var customInp = document.getElementById('cad-crs-custom');
    if(customInp) customInp.addEventListener('change', function(){ S.customProj4 = customInp.value.trim(); });

    ['p1x','p1y','p1lat','p1lon','p2x','p2y','p2lat','p2lon'].forEach(function(key){
      var inp = document.getElementById('cad-tp-' + key);
      if(!inp) return;
      inp.addEventListener('change', function(){
        S.twoPointInput[key] = inp.value.trim();
        updateTwoPointTransform();
      });
    });
    updateTwoPointTransform();

    document.getElementById('cad-step3-back').addEventListener('click', function(){ S.step = 1; renderWizard(); });
    document.getElementById('cad-step3-next').addEventListener('click', function(){
      if(S.fromCRS === 'twopoint' && (!S.twoPoint || !S.twoPoint.valid)){
        alert('Preenche os dois pontos de georreferenciação corretamente antes de converter (' + (S.twoPoint && S.twoPoint.error ? S.twoPoint.error : 'campos em falta') + ').');
        return;
      }
      S.step = 3; renderWizard(); runConversion();
    });
  }

  /* ---------------- georreferenciação manual por 2 pontos ---------------- */
  /* Calcula uma transformação de similaridade (translação + escala uniforme +
     rotação) que faz corresponder dois pontos do desenho CAD a duas posições
     reais (lat/lon). Útil para desenhos "locais" sem coordenadas geográficas
     (ex: modelos exportados de Blender/SketchUp, à escala do próprio objeto). */
  function buildTwoPointTransform(){
    var v = S.twoPointInput;
    var p1x = parseFloat(v.p1x), p1y = parseFloat(v.p1y);
    var p2x = parseFloat(v.p2x), p2y = parseFloat(v.p2y);
    var lat1 = parseFloat(v.p1lat), lon1 = parseFloat(v.p1lon);
    var lat2 = parseFloat(v.p2lat), lon2 = parseFloat(v.p2lon);

    var fields = [p1x,p1y,p2x,p2y,lat1,lon1,lat2,lon2];
    if(fields.some(function(n){ return !isFinite(n); })){
      return {valid:false, error:'preenche os 8 campos (2 pontos do desenho + 2 pontos reais)'};
    }
    if(Math.abs(lat1) > 90 || Math.abs(lat2) > 90 || Math.abs(lon1) > 180 || Math.abs(lon2) > 180){
      return {valid:false, error:'latitude/longitude fora do intervalo válido'};
    }

    var dSrc = {x: p2x - p1x, y: p2y - p1y};
    var distSrc = Math.hypot(dSrc.x, dSrc.y);
    if(distSrc < 1e-9){
      return {valid:false, error:'os dois pontos do desenho não podem ser coincidentes'};
    }

    var q1, q2;
    try{
      q1 = proj4('EPSG:4326', 'EPSG:3763', [lon1, lat1]);
      q2 = proj4('EPSG:4326', 'EPSG:3763', [lon2, lat2]);
    }catch(err){
      return {valid:false, error:'não foi possível converter as coordenadas reais indicadas'};
    }
    var dDst = {x: q2[0]-q1[0], y: q2[1]-q1[1]};
    var distDst = Math.hypot(dDst.x, dDst.y);
    if(distDst < 1e-6){
      return {valid:false, error:'os dois pontos reais não podem ser coincidentes'};
    }

    var scale = distDst / distSrc;
    var rotation = Math.atan2(dDst.y, dDst.x) - Math.atan2(dSrc.y, dSrc.x);

    return {
      valid: true,
      p1: {x: p1x, y: p1y},
      q1: {x: q1[0], y: q1[1]},
      scale: scale,
      rotation: rotation
    };
  }

  function updateTwoPointTransform(){
    var statusEl = document.getElementById('cad-tp-status');
    var hasAny = Object.keys(S.twoPointInput).some(function(k){ return S.twoPointInput[k] !== ''; });
    if(!hasAny){
      S.twoPoint = null;
      if(statusEl) statusEl.innerHTML = '';
      return;
    }
    var t = buildTwoPointTransform();
    S.twoPoint = t;
    if(!statusEl) return;
    if(t.valid){
      var scaleTxt = t.scale >= 1 ? (t.scale.toFixed(2) + '×') : ('1 / ' + (1/t.scale).toFixed(2));
      var rotDeg = (t.rotation * 180 / Math.PI).toFixed(1);
      statusEl.innerHTML = '<span style="color:var(--green-deep);">✓ Transformação calculada / escala ' + scaleTxt + ', rotação ' + rotDeg + '°</span>';
    } else {
      statusEl.innerHTML = '<span style="color:#b3413c;">✗ ' + esc(t.error) + '</span>';
    }
  }

  /* ---------------- reprojeção de coordenadas ---------------- */
  function reprojectXY(x, y){
    try{
      if(S.fromCRS === 'EPSG:4326') return [x, y];
      if(S.fromCRS === 'EPSG:3763') return proj4('EPSG:3763', 'EPSG:4326', [x, y]);
      if(S.fromCRS === 'custom' && S.customProj4){
        if(!proj4.defs('CAD_CUSTOM_SRC')) proj4.defs('CAD_CUSTOM_SRC', S.customProj4);
        return proj4('CAD_CUSTOM_SRC', 'EPSG:4326', [x, y]);
      }
      if(S.fromCRS === 'twopoint' && S.twoPoint && S.twoPoint.valid){
        var tp = S.twoPoint;
        var dx = x - tp.p1.x, dy = y - tp.p1.y;
        var cosA = Math.cos(tp.rotation), sinA = Math.sin(tp.rotation);
        var mx = tp.q1.x + tp.scale * (dx*cosA - dy*sinA);
        var my = tp.q1.y + tp.scale * (dx*sinA + dy*cosA);
        return proj4('EPSG:3763', 'EPSG:4326', [mx, my]);
      }
    }catch(e){ /* cai para passthrough abaixo */ }
    return [x, y];
  }

  /* ---------------- construção de arcos ---------------- */
  function arcPoints(center, radius, startDeg, endDeg, segments){
    var start = startDeg, end = endDeg;
    if(end <= start) end += 360;
    var pts = [];
    for(var i=0;i<=segments;i++){
      var ang = (start + (end-start) * (i/segments)) * Math.PI/180;
      pts.push({x: center.x + radius*Math.cos(ang), y: center.y + radius*Math.sin(ang)});
    }
    return pts;
  }

  function dedupeConsecutive(pts){
    var out = [];
    pts.forEach(function(p){
      var last = out[out.length-1];
      if(!last || Math.abs(last.x-p.x) > 1e-9 || Math.abs(last.y-p.y) > 1e-9) out.push(p);
    });
    return out;
  }

  /* ---------------- FASE 4/5/6/8: conversão de uma entidade ---------------- */
  function convertEntity(e, targetGeomType, layerColorHex){
    try{
      if(e.type === 'DIMENSION' || e.type === 'HATCH') return null; // cotas/tramas: não convertidas

      if(e.type === 'CIRCLE' && e.center){
        var c = reprojectXY(e.center.x, e.center.y);
        return {geomType:'Point', coords:c, extra:{Raio: e.radius || null}};
      }
      if(e.type === 'INSERT'){
        var p = e.position || e.insertionPoint;
        if(!p) return null;
        var c2 = reprojectXY(p.x, p.y);
        return {geomType:'Point', coords:c2, extra:{Tipo: classifyBlockTipo(e.name)}};
      }
      if(e.type === 'TEXT' || e.type === 'MTEXT'){
        var sp = e.startPoint || e.position;
        if(!sp) return null;
        var c3 = reprojectXY(sp.x, sp.y);
        return {geomType:'Point', coords:c3, extra:{Label: e.text || ''}};
      }
      if(e.type === 'ARC' && e.center && e.radius != null){
        var raw = arcPoints(e.center, e.radius, e.startAngle||0, e.endAngle||360, 16);
        var clean = dedupeConsecutive(raw);
        if(clean.length < 2) return null;
        return {geomType:'LineString', coords: clean.map(function(pt){ return reprojectXY(pt.x, pt.y); })};
      }
      if(e.type === 'LINE' || e.type === 'LWPOLYLINE' || e.type === 'POLYLINE'){
        var verts = e.vertices;
        if(!Array.isArray(verts) || verts.length < 2) return null;
        var closed = entityIsClosed(e);
        var cleanV = dedupeConsecutive(verts);
        if(targetGeomType === 'Polygon' && closed){
          var ring = cleanV.slice();
          if(ring.length < 3) return null;
          var first = ring[0], last = ring[ring.length-1];
          if(Math.abs(first.x-last.x) > 1e-9 || Math.abs(first.y-last.y) > 1e-9) ring.push(first);
          if(ring.length < 4) return null;
          return {geomType:'Polygon', coords: ring.map(function(pt){ return reprojectXY(pt.x, pt.y); })};
        }
        if(cleanV.length < 2) return null;
        return {geomType:'LineString', coords: cleanV.map(function(pt){ return reprojectXY(pt.x, pt.y); })};
      }
      return null; // SPLINE, 3DFACE, SOLID, ELLIPSE, etc. — não suportado nesta versão
    } catch(err){
      return null;
    }
  }

  /* ---------------- FASE 4-9: núcleo da conversão (sem tocar na UI) ---------------- */
  function performConversion(){
    var t0 = performance.now();
    var checkedLayers = S.layerTable.filter(function(l){ return l.checked; });
    var groups = [];
    var unsupported = 0;
    var today = new Date().toISOString().slice(0,10);

    checkedLayers.forEach(function(l){
      var ents = S.entities.filter(function(e){ return (e.layer||'0') === l.name; });
      var features = [];
      var idCounter = 0;
      ents.forEach(function(e){
        var conv = convertEntity(e, l.geomHint, l.colorHex);
        if(!conv){ unsupported++; return; }
        idCounter++;
        var props = {
          ID: l.targetName + '_' + idCounter,
          Layer: l.name,
          Cor: l.colorHex,
          Tipo: (conv.extra && conv.extra.Tipo) || l.targetName,
          DataImportacao: today
        };
        if(conv.extra && conv.extra.Label !== undefined) props.Label = conv.extra.Label;
        if(conv.extra && conv.extra.Raio !== undefined && conv.extra.Raio !== null) props.Raio = conv.extra.Raio;

        var geometry;
        if(conv.geomType === 'Point') geometry = {type:'Point', coordinates: conv.coords};
        else if(conv.geomType === 'LineString') geometry = {type:'LineString', coordinates: conv.coords};
        else geometry = {type:'Polygon', coordinates: [conv.coords]};

        var feature = {type:'Feature', geometry: geometry, properties: props};

        try{
          if(conv.geomType === 'LineString') props.Comprimento = Math.round(turf.length(feature, {units:'kilometers'}) * 1000);
          if(conv.geomType === 'Polygon') props.Área = Math.round(turf.area(feature));
        }catch(err){ /* geometria inválida para cálculo — mantém sem a métrica */ }

        features.push(feature);
      });

      groups.push({targetName: l.targetName, geomType: l.geomHint, features: features, cadLayer: l.name});
    });

    var createdLayers = [];
    groups.forEach(function(g){
      if(!g.features.length){ createdLayers.push({name:g.targetName, geomType:g.geomType, layerId:null, imported:0}); return; }
      var newLayerId = ++layerCounter;
      layers.push({
        id: newLayerId, name: g.targetName, geometryType: g.geomType, mode: 'atributos',
        attributes: [], colorAttr: null, baseColor: null, opacity: 100, symbology: defaultSymbology()
      });
      var res = importGeoJSONFeatures({type:'FeatureCollection', features: g.features}, function(){ return newLayerId; }, true);
      createdLayers.push({name: g.targetName, geomType: g.geomType, layerId: newLayerId, imported: res.imported, skipped: res.skipped});
    });

    markProjectDirty();

    var elapsedSec = ((performance.now() - t0) / 1000).toFixed(1);
    var result = {groups: createdLayers, unsupported: unsupported, elapsedSec: elapsedSec};

    pushHistory({
      at: Date.now(), fileName: S.fileName,
      groups: createdLayers.map(function(g){ return {name:g.name, imported:g.imported}; }),
      unsupported: unsupported, user: window.currentAdminUser || 'Desconhecido'
    });

    return result;
  }

  /* ---------------- versão interativa: atualiza a UI para o ecrã de relatório ---------------- */
  function runConversion(){
    S.result = performConversion();
    renderLayersPanel();
    S.step = 4;
    renderWizard();
  }

  function renderStep4Convert(){
    var body = document.getElementById('cad-step-body');
    body.innerHTML = '<div class="ss-card"><h3>A converter…</h3><p class="ss-hint">A ler geometrias, limpar e criar camadas. Não feche esta janela.</p></div>';
  }

  /* ---------------- FASE 9/12/13: relatório + exportação + zoom ---------------- */
  function renderStep5Report(){
    var body = document.getElementById('cad-step-body');
    var r = S.result;
    var statsHtml = r.groups.map(function(g){
      return '<div class="ss-stat-box is-create"><b>✓ ' + g.imported + '</b><span>' + esc(g.name) + ' (' + g.geomType + ')</span></div>';
    }).join('');

    var actionsHtml = r.groups.filter(function(g){ return g.layerId; }).map(function(g){
      return '<div class="ss-recipe-card">' +
        '<div><b>' + esc(g.name) + '</b><span>' + g.imported + ' geometria(s)</span></div>' +
        '<div class="ss-recipe-actions">' +
          '<button class="ss-btn ss-btn-secondary" data-zoom="' + g.layerId + '">Zoom</button>' +
          '<button class="ss-btn ss-btn-secondary" data-exp-geojson="' + g.layerId + '">GeoJSON</button>' +
          '<button class="ss-btn ss-btn-secondary" data-exp-shp="' + g.layerId + '">Shapefile</button>' +
          '<button class="ss-btn ss-btn-secondary" data-exp-kml="' + g.layerId + '">KML</button>' +
        '</div>' +
      '</div>';
    }).join('');

    body.innerHTML =
      '<div class="ss-stats-grid">' + statsHtml + '</div>' +
      (r.unsupported ? '<p class="ss-hint">✗ ' + r.unsupported + ' entidade(s) não suportada(s) ou inválida(s) foram ignoradas.</p>' : '<p class="ss-hint">✗ 0 erros.</p>') +
      '<p class="ss-hint">Tempo: ' + r.elapsedSec + 's</p>' +
      '<div class="ss-card"><h3>Camadas criadas (exportar / ver no mapa)</h3>' + (actionsHtml || '<p class="ss-empty">Nenhuma camada criada.</p>') +
      '<div class="ss-hint" style="margin-top:8px;">GeoPackage não está disponível nesta versão.</div></div>' +
      '<div class="ss-actions-row">' +
        '<button class="ss-btn" id="cad-step5-next">Guardar como perfil →</button>' +
        '<button class="ss-btn ss-btn-secondary" id="cad-finish">Concluir</button>' +
      '</div>';

    Array.prototype.slice.call(document.querySelectorAll('[data-zoom]')).forEach(function(btn){
      btn.addEventListener('click', function(){ zoomToLayer(Number(btn.dataset.zoom)); pageEl.hidden = true; });
    });
    Array.prototype.slice.call(document.querySelectorAll('[data-exp-geojson]')).forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = Number(btn.dataset.expGeojson);
        var gj = buildGeoJSON(false, false, id);
        var blob = new Blob([JSON.stringify(gj)], {type:'application/geo+json'});
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = (getLayerSchema(id).name || 'camada') + '.geojson'; a.click();
      });
    });
    Array.prototype.slice.call(document.querySelectorAll('[data-exp-shp]')).forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = Number(btn.dataset.expShp);
        var gj = buildGeoJSON(false, false, id);
        exportShapefileZip(gj, getLayerSchema(id).name || 'camada', btn, null);
      });
    });
    Array.prototype.slice.call(document.querySelectorAll('[data-exp-kml]')).forEach(function(btn){
      btn.addEventListener('click', function(){
        var id = Number(btn.dataset.expKml);
        var gj = buildGeoJSON(false, false, id);
        var kml = geojsonToKML(gj, getLayerSchema(id).name || 'camada');
        var blob = new Blob([kml], {type:'application/vnd.google-earth.kml+xml'});
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = (getLayerSchema(id).name || 'camada') + '.kml'; a.click();
      });
    });

    document.getElementById('cad-step5-next').addEventListener('click', function(){ S.step = 5; renderWizard(); });
    document.getElementById('cad-finish').addEventListener('click', function(){ resetState(); renderWizard(); });
  }

  /* conversor GeoJSON -> KML simples (pontos, linhas e polígonos) */
  function geojsonToKML(gj, name){
    function coordsToKml(coords, isRing){
      return coords.map(function(c){ return c[0] + ',' + c[1] + (c.length>2?','+c[2]:',0'); }).join(' ');
    }
    var placemarks = (gj.features||[]).map(function(f){
      var g = f.geometry; if(!g) return '';
      var geomXml = '';
      if(g.type === 'Point'){
        geomXml = '<Point><coordinates>'+g.coordinates[0]+','+g.coordinates[1]+',0</coordinates></Point>';
      } else if(g.type === 'LineString'){
        geomXml = '<LineString><coordinates>'+coordsToKml(g.coordinates)+'</coordinates></LineString>';
      } else if(g.type === 'Polygon'){
        geomXml = '<Polygon><outerBoundaryIs><LinearRing><coordinates>'+coordsToKml(g.coordinates[0])+'</coordinates></LinearRing></outerBoundaryIs></Polygon>';
      } else return '';
      var props = f.properties || {};
      var pname = props.ID || props.Label || '';
      var desc = Object.keys(props).map(function(k){ return k+': '+props[k]; }).join('&#10;');
      return '<Placemark><name>'+esc(String(pname))+'</name><description>'+esc(desc)+'</description>'+geomXml+'</Placemark>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>'+esc(name)+'</name>'+placemarks+'</Document></kml>';
  }

  /* ---------------- FASE 10: guardar perfil ---------------- */
  function renderStep6SaveProfile(){
    var body = document.getElementById('cad-step-body');
    var checkedLayers = S.layerTable.filter(function(l){ return l.checked; });
    body.innerHTML =
      '<div class="ss-card">' +
        '<h3>Guardar este perfil de importação</h3>' +
        '<div class="ss-field"><label>Nome do perfil</label><input type="text" id="cad-profile-name" placeholder="ex: Topografia Empresa X" value="'+esc(S.profileName||'')+'"></div>' +
        '<button class="ss-btn" id="cad-profile-save">Guardar perfil</button>' +
        '<div class="ss-hint">Guarda a correspondência de layers, geometrias e sistema de coordenadas. Da próxima vez, basta escolher o perfil em "Perfis guardados" e o novo ficheiro DXF.</div>' +
      '</div>' +
      '<div class="ss-actions-row">' +
        '<button class="ss-btn ss-btn-secondary" id="cad-finish2">Concluir sem guardar</button>' +
      '</div>';

    document.getElementById('cad-profile-save').addEventListener('click', function(){
      var name = document.getElementById('cad-profile-name').value.trim();
      if(!name){ alert('Dê um nome ao perfil.'); return; }
      var profiles = loadProfiles();
      var profile = {
        name: name, fromCRS: S.fromCRS, customProj4: S.customProj4,
        layerRules: checkedLayers.map(function(l){ return {name:l.name, targetName:l.targetName, geomHint:l.geomHint, checked:true}; }),
        createdAt: Date.now()
      };
      var idx = profiles.findIndex(function(p){ return p.name === name; });
      if(idx >= 0) profiles[idx] = profile; else profiles.push(profile);
      saveProfiles(profiles);
      resetState();
      switchSection('profiles');
    });
    document.getElementById('cad-finish2').addEventListener('click', function(){ resetState(); renderWizard(); });
  }

  /* ============================================================
     PERFIS GUARDADOS
     ============================================================ */
  function renderProfiles(){
    var profiles = loadProfiles();
    var itemsHtml = profiles.map(function(p, i){
      return '<div class="ss-recipe-card">' +
        '<div><b>' + esc(p.name) + '</b><span>' + p.layerRules.length + ' layer(s) mapeado(s) · CRS: ' + esc(p.fromCRS) + '</span></div>' +
        '<div class="ss-recipe-actions">' +
          '<button class="ss-btn" data-run="'+i+'">Importar com este perfil</button>' +
          '<button class="ss-btn ss-btn-secondary ss-btn-danger" data-del="'+i+'">Eliminar</button>' +
        '</div>' +
      '</div>';
    }).join('');
    contentEl.innerHTML =
      '<h2>Perfis guardados</h2>' +
      '<p class="ss-subtitle">Perfis de conversão (Fase 10). Escolhe um perfil, depois o ficheiro DXF novo (o mapeamento de layers e o sistema de coordenadas já vêm preenchidos).</p>' +
      (itemsHtml || '<p class="ss-empty">Ainda não guardou nenhum perfil.</p>');

    profiles.forEach(function(p,i){
      var runBtn = contentEl.querySelector('[data-run="'+i+'"]');
      var delBtn = contentEl.querySelector('[data-del="'+i+'"]');
      if(runBtn) runBtn.addEventListener('click', function(){ startFromProfile(p); });
      if(delBtn) delBtn.addEventListener('click', function(){
        if(!confirm('Eliminar o perfil "'+p.name+'"?')) return;
        var list = loadProfiles(); list.splice(i,1); saveProfiles(list); renderProfiles();
      });
    });
  }

  function applyProfileToLayerTable(profile){
    S.fromCRS = profile.fromCRS; S.customProj4 = profile.customProj4 || '';
    S.layerTable.forEach(function(l){
      var rule = profile.layerRules.find(function(r){ return r.name === l.name; });
      if(rule){ l.checked = true; l.targetName = rule.targetName; l.geomHint = rule.geomHint; }
      else { l.checked = false; }
    });
  }

  function startFromProfile(profile){
    resetState();
    S.profileName = profile.name;
    S.fromCRS = profile.fromCRS; S.customProj4 = profile.customProj4 || '';
    switchSection('wizard');
    // fica na fase 1 à espera do ficheiro; quando o DXF for lido,
    // o perfil é aplicado automaticamente à tabela de layers (ver handleFile abaixo)
    S._pendingProfile = profile;
  }

  var _origHandleFile = handleFile;
  handleFile = function(file){
    _origHandleFile(file);
    if(S._pendingProfile){
      var profile = S._pendingProfile;
      var elapsed = 0;
      var checkApply = setInterval(function(){
        elapsed += 150;
        if(S.layerTable && S.layerTable.length){
          applyProfileToLayerTable(profile);
          S._pendingProfile = null;
          clearInterval(checkApply);
          renderWizard();
        } else if(elapsed > 10000){
          S._pendingProfile = null;
          clearInterval(checkApply);
        }
      }, 150);
    }
  };

  /* ============================================================
     IMPORTAÇÃO EM LOTE (Fase 11)
     ============================================================ */
  function renderBatch(){
    var profiles = loadProfiles();
    contentEl.innerHTML =
      '<h2>Importação em lote</h2>' +
      '<p class="ss-subtitle">Escolhe vários ficheiros DXF de uma vez e um perfil guardado — a app converte todos, um a um, com as mesmas regras.</p>' +
      (profiles.length ?
        '<div class="ss-card">' +
          '<div class="ss-field"><label>Perfil a aplicar</label><select id="cad-batch-profile">' +
            profiles.map(function(p,i){ return '<option value="'+i+'">'+esc(p.name)+'</option>'; }).join('') +
          '</select></div>' +
          '<div class="ss-dropzone" id="cad-batch-dropzone">' +
            '<b>Clique para escolher vários ficheiros .dxf</b><span>Ou arraste-os para aqui</span>' +
          '</div>' +
          '<input type="file" id="cad-batch-input" accept=".dxf" multiple style="display:none;">' +
          '<div id="cad-batch-status" class="ss-hint" style="margin-top:10px;"></div>' +
        '</div>'
        : '<p class="ss-empty">Precisa de guardar pelo menos um perfil (em "Nova importação" → Fase 10) antes de poder converter em lote.</p>');

    if(!profiles.length) return;
    var dz = document.getElementById('cad-batch-dropzone');
    var input = document.getElementById('cad-batch-input');
    var statusEl = document.getElementById('cad-batch-status');
    dz.addEventListener('click', function(){ input.click(); });
    dz.addEventListener('dragover', function(e){ e.preventDefault(); dz.classList.add('is-drag'); });
    dz.addEventListener('dragleave', function(){ dz.classList.remove('is-drag'); });
    dz.addEventListener('drop', function(e){
      e.preventDefault(); dz.classList.remove('is-drag');
      runBatch(Array.prototype.slice.call(e.dataTransfer.files));
    });
    input.addEventListener('change', function(){ runBatch(Array.prototype.slice.call(input.files)); });

    function runBatch(files){
      var dxfFiles = files.filter(function(f){ return /\.dxf$/i.test(f.name); });
      if(!dxfFiles.length){ statusEl.textContent = 'Nenhum .dxf válido selecionado.'; return; }
      var profile = profiles[Number(document.getElementById('cad-batch-profile').value)];
      statusEl.textContent = '0 / ' + dxfFiles.length + ' processados…';
      var done = 0, totalImported = 0;
      function next(){
        if(done >= dxfFiles.length){
          statusEl.textContent = 'Concluído: ' + done + ' ficheiro(s), ' + totalImported + ' geometria(s) importadas no total.';
          renderLayersPanel();
          return;
        }
        var file = dxfFiles[done];
        ensureDxfParser().then(function(DxfParser){
          var reader = new FileReader();
          reader.onload = function(e){
            try{
              var parser = new DxfParser();
              var dxf = parser.parseSync ? parser.parseSync(e.target.result) : parser.parse(e.target.result);
              resetState();
              S.fileName = file.name; S.dxf = dxf; S.entities = (dxf && dxf.entities) || [];
              buildLayerTable();
              applyProfileToLayerTable(profile);
              runConversionSilent(function(imported){
                totalImported += imported;
                done++;
                statusEl.textContent = done + ' / ' + dxfFiles.length + ' processados…';
                next();
              });
            }catch(err){ done++; next(); }
          };
          reader.readAsText(file);
        });
      }
      next();
    }
  }

  /* versão da conversão usada no lote: igual a runConversion() mas sem
     navegar para o ecrã de relatório — devolve o total importado por callback */
  function runConversionSilent(cb){
    var result = performConversion();
    var total = result.groups.reduce(function(s,g){ return s + (g.imported||0); }, 0);
    cb(total);
  }

  /* ============================================================
     HISTÓRICO
     ============================================================ */
  function renderHistory(){
    var history = loadHistory();
    var itemsHtml = history.map(function(h){
      var date = new Date(h.at).toLocaleString('pt-PT');
      var groupsStr = h.groups.map(function(g){ return g.name + ' (' + g.imported + ')'; }).join(', ');
      return '<div class="ss-history-item">' +
        '<b>' + esc(h.fileName) + '</b>' +
        '<div>' + date + ' · ' + esc(groupsStr) + (h.unsupported ? ' · ✗ ' + h.unsupported + ' não suportadas' : '') + '</div>' +
        '<div>Utilizador: ' + esc(h.user || 'Desconhecido') + '</div>' +
      '</div>';
    }).join('');
    contentEl.innerHTML =
      '<h2>Histórico</h2>' +
      '<p class="ss-subtitle">Cada importação CAD fica registada aqui.</p>' +
      (itemsHtml || '<p class="ss-empty">Ainda não há importações registadas.</p>');
  }

  /* ============================================================
     COMO USAR
     ============================================================ */
  function renderHelp(){
    contentEl.innerHTML =
      '<h2>Como usar a Importação CAD</h2>' +
      '<p class="ss-subtitle">Guia rápido. Cada bloco pode ser aberto/fechado clicando no título.</p>' +

      '<details class="ss-help-item" open>' +
        '<summary>1. O que é isto?</summary>' +
        '<div class="ss-help-body">Converte um desenho CAD (.dxf) em camadas SIG desta app / edifícios, estradas, árvores, redes, etc. (em vez de teres de desenhar tudo à mão por cima do CAD).</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>2. Porque é que o .dwg não funciona diretamente?</summary>' +
        '<div class="ss-help-body">O DWG é um formato binário fechado da Autodesk. Sem uma licença/SDK oficial (RealDWG ou ODA), não há forma fiável de o ler dentro de uma página web. A solução simples: converter para .dxf primeiro, com o ODA File Converter (gratuito), LibreCAD, QCAD, ou "Guardar como" a partir do AutoCAD/BricsCAD.</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>3. Passo a passo</summary>' +
        '<div class="ss-help-body">' +
          '<b>Fase 1.</b> Escolhe o .dxf — a app mostra quantas entidades e layers encontrou.<br><br>' +
          '<b>Fase 2.</b> Confirma quais layers importar (Cotas, Textos e Símbolos ficam desligados por omissão — normalmente não são geometria útil).<br><br>' +
          '<b>Fase 3.</b> Para cada layer, confirma o nome da camada SIG a criar e o tipo de geometria sugerido.<br><br>' +
          '<b>Fase 7 (na mesma página).</b> Indica em que sistema de coordenadas está o desenho — o mais comum em Portugal é ETRS89/PT-TM06. Se o desenho não tiver coordenadas reais (ex: um modelo exportado de um programa 3D, sem ligação ao mundo real — a app avisa disto na Fase 2), usa a opção "Desenho local", indicando 2 pontos do desenho e onde ficam no mundo real.<br><br>' +
          '<b>Fase 4-9.</b> A app converte, limpa a geometria (remove pontos repetidos, fecha polígonos, ignora geometria vazia) e mostra o relatório final.' +
        '</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>4. Como é decidido o tipo de geometria e a camada de destino?</summary>' +
        '<div class="ss-help-body">Por regras simples, não por inteligência artificial: o nome do layer (ex: "Buildings" → Edifícios/Polígono), se a polilinha está fechada (→ provável edifício/polígono) ou aberta (→ linha), e o nome dos blocos inseridos (ex: bloco "Árvore" → ponto do tipo Árvore). São sugestões — podes sempre alterar antes de converter.</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>5. Que atributos ficam criados automaticamente?</summary>' +
        '<div class="ss-help-body">ID, Layer (nome original no CAD), Cor, Tipo, Data de Importação, e ainda Comprimento (linhas) ou Área (polígonos), calculados automaticamente.</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>6. Perfis e lote — para quê?</summary>' +
        '<div class="ss-help-body">Se recebes sempre o mesmo tipo de desenho (ex: topografia de uma empresa), guarda a configuração como perfil. Depois, em "Importação em lote", podes converter dezenas de DXF de uma vez com o mesmo perfil.</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>7. Exportação — o que está disponível?</summary>' +
        '<div class="ss-help-body">Depois de converter, cada camada criada pode ser exportada diretamente para GeoJSON, Shapefile (.zip) ou KML. GeoPackage não está disponível nesta versão.</div>' +
      '</details>' +

      '<details class="ss-help-item">' +
        '<summary>8. Que tipos de entidade CAD são suportados?</summary>' +
        '<div class="ss-help-body">Linhas, polilinhas (abertas → linhas, fechadas → polígonos), círculos e blocos inseridos (→ pontos), arcos (aproximados por segmentos de linha) e texto (→ ponto com etiqueta). Cotas e tramas (hatch) não são convertidas. Splines, faces 3D e outras entidades muito específicas também não são suportadas nesta versão — ficam contabilizadas como "não suportadas" no relatório em vez de causarem erro.</div>' +
      '</details>';
  }

})();
