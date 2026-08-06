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

/* ---- Notificação unificada ---- */
/* Types: 'info' | 'success' | 'error'
   Todas as notificações surgem no canto superior esquerdo do mapa,
   com a mesma estética, animações e comportamento. */
let _notifId = 0;
window.showNotification = function(msg, opts){
  opts = opts || {};
  const container = document.getElementById('notif-container');
  if(!container) return;
  const type = opts.error ? 'error' : (opts.type || 'info');
  const timeout = opts.timeout != null ? opts.timeout : 4000;
  const id = ++_notifId;

  const el = document.createElement('div');
  el.className = 'notif-item notif-' + type;
  el.dataset.notifId = id;

  const iconMap = {info: 'i', success: '✓', error: '!'};
  el.innerHTML =
    '<span class="notif-icon">' + (iconMap[type] || 'i') + '</span>' +
    '<span class="notif-text">' + msg + '</span>' +
    '<button class="notif-close" aria-label="Fechar" type="button">✕</button>';

  container.appendChild(el);
  void el.offsetWidth;
  el.classList.add('is-visible');

  const dismiss = ()=>{
    if(!el.parentNode) return;
    el.classList.remove('is-visible');
    el.classList.add('is-leaving');
    setTimeout(()=>{ if(el.parentNode) el.remove(); }, 300);
  };

  el.querySelector('.notif-close').onclick = dismiss;
  if(timeout > 0){
    el._hideTimer = setTimeout(dismiss, timeout);
  }
  el.onmouseenter = ()=>{ clearTimeout(el._hideTimer); };
  el.onmouseleave = ()=>{
    if(timeout > 0) el._hideTimer = setTimeout(dismiss, 1200);
  };

  return {dismiss, el};
};

/* backward compat: showAppAlert agora usa showNotification */
window.showAppAlert = function(msg, opts){
  showNotification(msg, opts);
};

window.paletteColor = function(i){ return SYMBOLOGY_PALETTE[i % SYMBOLOGY_PALETTE.length]; };

window.defaultSymbology = function(){
  return {
    mode: 'simples',
    attr: null,
    method: 'iguais',   // 'manual' | 'quantis' | 'iguais' | 'jenks'
    classCount: 5,
    breaks: [],          // [{min, max, color, strokeWidth}] (modo graduado)
    uniqueValues: []      // [{value, color, strokeWidth}] (modo valores únicos)
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
    breaks: Array.isArray(sym.breaks) ? sym.breaks.map(b=>({min:b.min, max:b.max, color:b.color, strokeWidth: b.strokeWidth != null ? b.strokeWidth : 3})) : [],
    uniqueValues: Array.isArray(sym.uniqueValues) ? sym.uniqueValues.map(u=>({value:u.value, color:u.color, strokeWidth: u.strokeWidth != null ? u.strokeWidth : 3})) : []
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
