/* === MÓDULO: UTILS === */
/* Funções utilitárias gerais: showAppAlert, escapeHtml, paletteColor,
   defaultSymbology, cloneSymbology, formatDistance, requestConfirmation */
/* Origem: 05-app-main.js — ver remoções correspondentes */
(function(){

/* ============================================================
   SIMBOLOGIA — modelo de dados
   mode: 'simples'  -> cor única (usa config.baseColor, como sempre foi)
         'unicos'   -> uma cor por cada valor distinto de um atributo (texto/categórico/número)
         'graduado' -> classes numéricas sobre um atributo numérico, com 4 métodos de
                       cálculo dos intervalos: manual, quantis, intervalos iguais, natural breaks (Jenks)
   ============================================================ */
window.SYMBOLOGY_PALETTE = [
  '#F5821F', '#2E7D32', '#1565C0', '#C62828', '#6A1B9A',
  '#00838F', '#F9A825', '#4E342E', '#AD1457', '#33691E',
  '#EF6C00', '#283593', '#00695C', '#D84315', '#5D4037'
];

/* ---- App Alert: popup centralizado no topo (substitui alert() nativo) ---- */
let _appAlertTimer = null;
window.showAppAlert = function(msg, opts){
  const overlay = document.getElementById('app-alert-overlay');
  const icon = document.getElementById('app-alert-icon');
  const text = document.getElementById('app-alert-text');
  const closeBtn = document.getElementById('app-alert-close');
  if(!overlay || !icon || !text || !closeBtn) return;
  clearTimeout(_appAlertTimer);
  const isError = opts && opts.error;
  const card = overlay.querySelector('.app-alert-card');
  card.classList.toggle('is-error', !!isError);
  icon.textContent = isError ? '!' : 'i';
  text.textContent = msg;
  overlay.classList.remove('hidden');
  card.classList.remove('is-leaving');
  void card.offsetWidth;
  const dismiss = ()=>{
    card.classList.add('is-leaving');
    setTimeout(()=> overlay.classList.add('hidden'), 220);
    clearTimeout(_appAlertTimer);
  };
  closeBtn.onclick = dismiss;
  overlay.onclick = e=>{ if(e.target === overlay) dismiss(); };
  _appAlertTimer = setTimeout(dismiss, opts && opts.timeout ? opts.timeout : 5000);
};

window.paletteColor = function(i){ return SYMBOLOGY_PALETTE[i % SYMBOLOGY_PALETTE.length]; };

window.defaultSymbology = function(){
  return {
    mode: 'simples',
    attr: null,
    method: 'iguais',   // 'manual' | 'quantis' | 'iguais' | 'jenks'
    classCount: 5,
    breaks: [],          // [{min, max, color}] (modo graduado)
    uniqueValues: []      // [{value, color}] (modo valores únicos)
  };
};

window.cloneSymbology = function(sym){
  const base = defaultSymbology();
  if(!sym || typeof sym !== 'object') return base;
  return {
    mode: (sym.mode === 'unicos' || sym.mode === 'graduado') ? sym.mode : 'simples',
    attr: sym.attr || null,
    method: ['manual','quantis','iguais','jenks'].includes(sym.method) ? sym.method : 'iguais',
    classCount: Number.isFinite(sym.classCount) ? sym.classCount : 5,
    breaks: Array.isArray(sym.breaks) ? sym.breaks.map(b=>({min:b.min, max:b.max, color:b.color})) : [],
    uniqueValues: Array.isArray(sym.uniqueValues) ? sym.uniqueValues.map(u=>({value:u.value, color:u.color})) : []
  };
};

window.requestConfirmation = function(message){
  if(!settings.confirmDeletes) return true;
  return confirm(message);
};

window.formatDistance = function(distance){
  if(settings.distanceUnits === 'imperial'){
    const feet = distance * 3.28084;
    return feet >= 5280 ? `${(feet / 5280).toFixed(2)} mi` : `${Math.round(feet)} ft`;
  }
  return distance >= 1000 ? `${(distance / 1000).toFixed(2)} km` : `${Math.round(distance)} m`;
};

window.escapeHtml = function(str){
  return String(str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
};

})();
