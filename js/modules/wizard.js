(function(){
/* ============================================================
   WIZARD — passo 1
   ============================================================ */
document.querySelectorAll('[data-mode]').forEach(card=>{
  card.addEventListener('click', ()=>{
    document.querySelectorAll('[data-mode]').forEach(c=>c.classList.remove('selected'));
    card.classList.add('selected');
    config.mode = card.dataset.mode;
    validateStep1Continue();
  });
});

document.getElementById('wizard-shape-name').addEventListener('input', ()=>{
  document.getElementById('wizard-shape-name-error').style.display = 'none';
  validateStep1Continue();
});

function validateStep1Continue(){
  const hasName = document.getElementById('wizard-shape-name').value.trim().length > 0;
  document.getElementById('step1-next').disabled = !(hasName && config.mode);
}

document.getElementById('step1-next').addEventListener('click', ()=>{
  const name = document.getElementById('wizard-shape-name').value.trim();
  if(!name){
    document.getElementById('wizard-shape-name-error').style.display = 'block';
    return;
  }
  config.shapeName = name;

  if(config.mode === 'atributos'){
    if(config.attributes.length === 0) addAttributeBlock();
    document.getElementById('step3-total').textContent = '3';
    document.getElementById('step3-num').textContent = '3';
    showStep(2);
  } else {
    document.getElementById('step3-total').textContent = '2';
    document.getElementById('step3-num').textContent = '2';
    showStep(3);
  }
});

function showStep(n){
  document.querySelectorAll('.wizard-step').forEach(s=>{
    s.style.display = (s.dataset.step == n) ? '' : 'none';
  });
}

document.getElementById('open-wizard-btn').addEventListener('click', ()=>{
  toggleCloudMenu();
});

document.getElementById('btn-cloud-settings')?.addEventListener('click', (event)=>{
  event.stopPropagation();
  toggleSettingsMenu(true);
});

// Funções de settings/cloud menu migradas para js/modules/settings.js

// Section migrated to js/modules/projects.js
// PROJETOS LOCAIS: localProjectState, startProjectChoice, projectDirty,
// autoSaveEnabled, renderLocalProjectsList, saveLocalProject, loadLocalProject,
// deleteLocalProject, renameLocalProject, updateProjectStatusUI,
// startAutoSave, stopAutoSave, markProjectDirty, startNewProject, etc.

/* ============================================================
   TOGGLE DAS FERRAMENTAS DE EDIÇÃO (draw / edit layers / drag layers /
   remove layers) — por omissão ficam escondidas; o botão do lápis no
   cabeçalho (antes do "Vetorizar") liga/desliga a sua visibilidade.
   As ferramentas em si (map.pm.addControls / applyGeometryConfig) não
   são alteradas — apenas escondemos/mostramos a toolbar já existente
   via CSS (classe "pm-toolbar-visible" em #map).
   ============================================================ */
(function(){
  const toggleBtn = document.getElementById('btn-toggle-pm-toolbar');
  const mapEl = document.getElementById('map');
  if(!toggleBtn || !mapEl) return;
  toggleBtn.addEventListener('click', ()=>{
    const nowVisible = mapEl.classList.toggle('pm-toolbar-visible');
    toggleBtn.classList.toggle('is-active', nowVisible);
    toggleBtn.setAttribute('aria-pressed', nowVisible ? 'true' : 'false');
  });
})();

document.getElementById('open-feature-wizard-btn').addEventListener('click', ()=>{
  archiveActiveLayerIfNeeded();
  document.getElementById('wizard-overlay').classList.remove('hidden');
  document.getElementById('wizard-shape-name').value = config.shapeName || '';
  document.getElementById('wizard-shape-name-error').style.display = 'none';
  validateStep1Continue();
  showStep(1);
  dismissGearCoachmark();
});

/* Se já existe uma camada configurada e com o wizard concluído, guarda-a na lista
   de camadas antes de começar a configurar uma nova — assim não desaparece do painel. */
function archiveActiveLayerIfNeeded(){
  if(!config.geometryType) return; // ainda não há nenhuma camada configurada, nada a arquivar
  const sanitizedName = (config.shapeName || '').toString().trim();
  if(!sanitizedName){
    showAppAlert('Dá um nome à camada antes de a guardar.');
    return;
  }

  layers.push({
    id: activeLayerId,
    name: sanitizedName,
    geometryType: config.geometryType,
    mode: config.mode,
    attributes: Array.isArray(config.attributes) ? config.attributes.filter(a=>a && a.name && a.name.trim()) : [],
    colorAttr: config.colorAttr,
    baseColor: config.baseColor,
    opacity: config.opacity,
    strokeColor: config.strokeColor,
    strokeWidth: config.strokeWidth,
    pointSize: config.pointSize,
    symbology: cloneSymbology(config.symbology)
  });
  activeLayerId = ++layerCounter;
  layerVisible.set(activeLayerId, true);
  config.shapeName = null;
  config.mode = null;
  config.attributes = [];
  config.geometryType = null;
  config.colorAttr = null;
  config.baseColor = null;
  config.opacity = null;
  config.strokeColor = null;
  config.strokeWidth = null;
  config.pointSize = null;
  config.symbology = defaultSymbology();
  refreshLayerEditability();
}

document.getElementById('wizard-close-btn').addEventListener('click', ()=>{
  document.getElementById('wizard-overlay').classList.add('hidden');
});

/* ============================================================
   ATERRAGEM — "Iniciar projeto" + coach-mark da engrenagem
   ============================================================ */
function proceedToMap(){
  document.getElementById('landing-banner').classList.add('hidden');
  map.flyTo([39.6, -8.0], 7, { duration: 2.2, easeLinearity: 0.25 });
  map.once('moveend', showGearCoachmark);
  // nota: deixámos de mostrar o popup "Área offline encontrada" ao reabrir o projeto;
  // as áreas guardadas continuam acessíveis a partir do botão de área offline no cabeçalho.
}

function showGearCoachmark(){
  positionGearCoachmark();
  document.getElementById('gear-coachmark').classList.remove('hidden');
}

function positionGearCoachmark(){
  const btn = document.getElementById('open-feature-wizard-btn');
  const bubble = document.getElementById('gear-coachmark');
  const btnRect = btn.getBoundingClientRect();
  const bubbleWidth = 220;
  let left = btnRect.right - bubbleWidth + 12; // alinha a ponta da seta com o centro do botão
  left = Math.max(10, Math.min(left, window.innerWidth - bubbleWidth - 10));
  bubble.style.left = left + 'px';
  bubble.style.top = (btnRect.bottom + 10) + 'px';
}

function dismissGearCoachmark(){
  document.getElementById('gear-coachmark').classList.add('hidden');
}

document.getElementById('gear-coachmark-close').addEventListener('click', dismissGearCoachmark);
window.addEventListener('resize', ()=>{
  if(!document.getElementById('gear-coachmark').classList.contains('hidden')){
    positionGearCoachmark();
  }
});

/* ============================================================
   WIZARD — passo 2 (atributos)
   ============================================================ */
const attrsContainer = document.getElementById('attrs-container');

function addAttributeBlock(){
  if(config.attributes.length >= 3) return;
  const idx = config.attributes.length;
  const attr = {name:'', type:'texto', classes:[]};
  config.attributes.push(attr);
  renderAttrs();
}

function renderAttrs(){
  attrsContainer.innerHTML = '';
  config.attributes.forEach((attr, idx)=>{
    const block = document.createElement('div');
    block.className = 'attr-block';
    block.innerHTML = `
      <div class="attr-head">
        <b>Atributo ${idx+1}</b>
        <button class="small-link" data-remove="${idx}" style="color:var(--warn);">Remover ✕</button>
      </div>
      <label style="font-size:11px;font-weight:600;color:var(--stone);">Nome do campo</label>
      <input type="text" data-name="${idx}" placeholder="ex: tipo_uso" value="${attr.name}">
      <label style="font-size:11px;font-weight:600;color:var(--stone);">Tipo</label>
      <select data-type="${idx}">
        <option value="texto" ${attr.type==='texto'?'selected':''}>Texto livre</option>
        <option value="numero" ${attr.type==='numero'?'selected':''}>Numérico</option>
        <option value="categorico" ${attr.type==='categorico'?'selected':''}>Categórico (classes predefinidas)</option>
      </select>
      <div class="classes-wrap" data-classes-wrap="${idx}" style="${attr.type==='categorico'?'':'display:none;'}">
        <label style="font-size:11px;font-weight:600;color:var(--stone);">Classes</label>
        <div data-classes-list="${idx}"></div>
        <button class="small-link" data-add-class="${idx}">+ Adicionar classe</button>
      </div>
    `;
    attrsContainer.appendChild(block);
    renderClasses(idx);
  });

  attrsContainer.querySelectorAll('[data-remove]').forEach(b=>{
    b.addEventListener('click', ()=>{
      config.attributes.splice(+b.dataset.remove,1);
      renderAttrs();
    });
  });
  attrsContainer.querySelectorAll('[data-name]').forEach(inp=>{
    inp.addEventListener('input', ()=>{ config.attributes[+inp.dataset.name].name = inp.value; });
  });
  attrsContainer.querySelectorAll('[data-type]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      const i = +sel.dataset.type;
      config.attributes[i].type = sel.value;
      if(sel.value === 'categorico' && config.attributes[i].classes.length === 0){
        config.attributes[i].classes.push({name:'Classe 1', color: PALETTE[0]});
        config.attributes[i].classes.push({name:'Classe 2', color: PALETTE[1]});
      }
      renderAttrs();
    });
  });
  attrsContainer.querySelectorAll('[data-add-class]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const i = +b.dataset.addClass;
      const n = config.attributes[i].classes.length;
      config.attributes[i].classes.push({name:'Classe '+(n+1), color: PALETTE[n % PALETTE.length]});
      renderClasses(i);
    });
  });

  document.getElementById('add-attr').style.display = config.attributes.length >= 3 ? 'none' : '';
}

function renderClasses(idx){
  const wrap = attrsContainer.querySelector(`[data-classes-list="${idx}"]`);
  if(!wrap) return;
  const attr = config.attributes[idx];
  wrap.innerHTML = '';
  attr.classes.forEach((cls, ci)=>{
    const row = document.createElement('div');
    row.className = 'class-row';
    row.innerHTML = `
      <input type="color" value="${cls.color}" data-cls-color="${idx}:${ci}">
      <input type="text" value="${cls.name}" data-cls-name="${idx}:${ci}" placeholder="Nome da classe">
      <button data-cls-remove="${idx}:${ci}" title="Remover classe">✕</button>
    `;
    wrap.appendChild(row);
  });
  wrap.querySelectorAll('[data-cls-color]').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const [i,ci] = inp.dataset.clsColor.split(':').map(Number);
      config.attributes[i].classes[ci].color = inp.value;
    });
  });
  wrap.querySelectorAll('[data-cls-name]').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const [i,ci] = inp.dataset.clsName.split(':').map(Number);
      config.attributes[i].classes[ci].name = inp.value;
    });
  });
  wrap.querySelectorAll('[data-cls-remove]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const [i,ci] = b.dataset.clsRemove.split(':').map(Number);
      config.attributes[i].classes.splice(ci,1);
      renderClasses(i);
    });
  });
}

document.getElementById('add-attr').addEventListener('click', addAttributeBlock);
document.getElementById('step2-back').addEventListener('click', ()=> showStep(1));
document.getElementById('step2-next').addEventListener('click', ()=>{
  config.attributes = (Array.isArray(config.attributes) ? config.attributes : []).filter(a=>a && typeof a === 'object' && a.name && a.name.toString().trim() !== '');
  showStep(3);
});

/* ============================================================
   WIZARD — passo 3 (geometria)
   ============================================================ */
document.querySelectorAll('[data-geom]').forEach(card=>{
  card.addEventListener('click', ()=>{
    document.querySelectorAll('[data-geom]').forEach(c=>c.classList.remove('selected'));
    card.classList.add('selected');
    const geomValue = card.dataset.geom;
    if(!['Point','LineString','Polygon'].includes(geomValue)){
      showAppAlert('Tipo de geometria inválido.', {error: true});
      return;
    }
    config.geometryType = geomValue;
    document.getElementById('step3-finish').disabled = false;
  });
});
document.getElementById('step3-back').addEventListener('click', ()=>{
  showStep(config.mode === 'atributos' ? 2 : 1);
});
document.getElementById('step3-finish').addEventListener('click', finishWizard);

function finishWizard(){
  const shapeName = (document.getElementById('wizard-shape-name')?.value || '').toString().trim();
  if(!shapeName){
    showAppAlert('Dá um nome à camada antes de concluir.');
    return;
  }
  config.shapeName = shapeName;
  document.getElementById('wizard-overlay').classList.add('hidden');
  setupSummary();
  applyGeometryConfig();
  refreshFeatList();
  refreshLayerEditability();
}

function setupSummary(){
  // o resumo de "tipo de geometria + atributos" da camada ativa deixou de ser
  // mostrado no painel — a lista de camadas já traz essa informação em cada linha.
}

/* Expose functions needed by other modules */
window.archiveActiveLayerIfNeeded = archiveActiveLayerIfNeeded;
window.finishWizard = finishWizard;
window.setupSummary = setupSummary;
window.showStep = showStep;
window.proceedToMap = proceedToMap;
window.dismissGearCoachmark = dismissGearCoachmark;
window.validateStep1Continue = validateStep1Continue;
window.addAttributeBlock = addAttributeBlock;
window.renderAttrs = renderAttrs;
window.renderClasses = renderClasses;
})();
