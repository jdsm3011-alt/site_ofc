(function(){
/* ============================================================
   SELECIONAR POR ATRIBUTOS (botão da lupa no cabeçalho)
   Cria uma nova camada só com as geometrias que cumprem uma
   condição simples (campo + operador + valor) sobre uma camada
   já existente. Reutiliza buildGeoJSON()/importGeoJSONFeatures()
   em vez de reinventar a criação de geometrias/camadas.
   ============================================================ */
  const menu = document.getElementById('select-by-attr-menu');
  const btn = document.getElementById('btn-select-by-attr');
  const layerSelect = document.getElementById('select-by-attr-layer');
  const fieldSelect = document.getElementById('select-by-attr-field');
  const opSelect = document.getElementById('select-by-attr-op');
  const valueInput = document.getElementById('select-by-attr-value');
  const hintEl = document.getElementById('select-by-attr-hint');
  const statusEl = document.getElementById('select-by-attr-status');
  const applyBtn = document.getElementById('select-by-attr-apply');
  if(!menu || !btn) return;

  // lista de camadas com pelo menos 1 geometria (a ativa + as arquivadas em "layers")
  function listSelectableLayers(){
    const ids = layers.map(l=>l.id).concat(config.geometryType ? [activeLayerId] : []);
    return ids
      .filter(id => countLayerFeatures(id) > 0)
      .map(id => ({ id, schema: getLayerSchema(id) }))
      .filter(entry => entry.schema);
  }

  function populateLayerSelect(){
    const entries = listSelectableLayers();
    layerSelect.innerHTML = entries.length
      ? entries.map(e => `<option value="${e.id}">${escapeHtml(e.schema.name || 'Shape sem nome')}</option>`).join('')
      : '<option value="">Sem camadas com geometrias</option>';
    populateFieldSelect();
  }

  function currentLayerSchema(){
    const id = Number(layerSelect.value);
    if(!Number.isFinite(id)) return null;
    return getLayerSchema(id);
  }

  function populateFieldSelect(){
    const schema = currentLayerSchema();
    const attrs = (schema && schema.mode === 'atributos' && Array.isArray(schema.attributes)) ? schema.attributes : [];
    if(attrs.length){
      fieldSelect.innerHTML = attrs.map(a => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`).join('');
      fieldSelect.disabled = false;
      opSelect.disabled = false;
      valueInput.disabled = false;
      applyBtn.disabled = false;
      hintEl.textContent = '';
    } else {
      fieldSelect.innerHTML = '<option value="">— sem campos —</option>';
      fieldSelect.disabled = true;
      opSelect.disabled = true;
      valueInput.disabled = true;
      applyBtn.disabled = true;
      hintEl.textContent = 'Esta camada não tem atributos definidos, por isso não é possível filtrar por campo.';
    }
  }

  layerSelect.addEventListener('change', populateFieldSelect);

  function openMenu(){
    populateLayerSelect();
    statusEl.textContent = '';
    menu.classList.remove('hidden');
    const rect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    menu.style.top = (rect.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - 8)) + 'px';
  }
  function closeMenu(){ menu.classList.add('hidden'); }

  btn.addEventListener('click', (e)=>{
    e.stopPropagation();
    if(menu.classList.contains('hidden')) openMenu(); else closeMenu();
  });
  document.addEventListener('click', (e)=>{
    if(!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)){
      closeMenu();
    }
  });

  function evalCondition(rawValue, op, queryValue){
    const textA = String(rawValue ?? '').trim();
    const textQ = queryValue.trim();
    if(op === 'eq') return textA === textQ;
    if(op === 'neq') return textA !== textQ;
    if(op === 'contains') return textA.toLowerCase().includes(textQ.toLowerCase());
    if(op === 'gt' || op === 'lt'){
      const numA = parseFloat(rawValue);
      const numQ = parseFloat(queryValue);
      if(Number.isNaN(numA) || Number.isNaN(numQ)) return false;
      return op === 'gt' ? numA > numQ : numA < numQ;
    }
    return false;
  }

  applyBtn.addEventListener('click', ()=>{
    const layerId = Number(layerSelect.value);
    const fieldName = fieldSelect.value;
    const op = opSelect.value;
    const queryValue = valueInput.value;

    if(!Number.isFinite(layerId)){ statusEl.textContent = 'Escolhe uma camada.'; return; }
    if(!fieldName){ statusEl.textContent = 'Escolhe um campo.'; return; }
    if(queryValue.trim() === ''){ statusEl.textContent = 'Escreve um valor para comparar.'; return; }

    const sourceSchema = getLayerSchema(layerId);
    if(!sourceSchema){ statusEl.textContent = 'Camada inválida.'; return; }

    const collection = buildGeoJSON(false, false, layerId);
    const matched = collection.features.filter(f =>
      evalCondition(f.properties ? f.properties[fieldName] : undefined, op, queryValue)
    );

    if(matched.length === 0){
      statusEl.textContent = 'Nenhuma geometria corresponde a esta condição.';
      return;
    }

    const newLayerId = ++layerCounter;
    const newName = (sourceSchema.name || 'camada') + '_selectBA';
    layers.push({
      id: newLayerId,
      name: newName,
      geometryType: sourceSchema.geometryType,
      mode: sourceSchema.mode || 'atributos',
      attributes: Array.isArray(sourceSchema.attributes) ? sourceSchema.attributes.map(a=>({...a})) : [],
      colorAttr: sourceSchema.colorAttr || null,
      baseColor: sourceSchema.baseColor || null,
      opacity: sourceSchema.opacity,
      strokeColor: sourceSchema.strokeColor || null,
      strokeWidth: sourceSchema.strokeWidth != null ? sourceSchema.strokeWidth : null,
      pointSize: sourceSchema.pointSize != null ? sourceSchema.pointSize : null,
      symbology: defaultSymbology()
    });

    importGeoJSONFeatures({type:'FeatureCollection', features: matched}, ()=>newLayerId, true);
    renderLayersPanel();
    markProjectDirty();

    statusEl.textContent = `✓ Criada a camada "${newName}" com ${matched.length} geometria(s).`;
    valueInput.value = '';
  });
})();
