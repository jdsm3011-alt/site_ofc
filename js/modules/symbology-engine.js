/* === MÓDULO: SYMBOLOGY ENGINE === */
/* Layer feature queries, classification algorithms (equal interval,
   quantile, Jenks), default styling, feature color resolution,
   restyleLayerId */
/* Origem: 05-app-main.js linhas 4898-5115 */
(function(){

function getLayerFeatureEntries(layerId){
  if(typeof getFeatureIdsForLayer === 'function'){
    const ids = getFeatureIdsForLayer(layerId);
    const out = [];
    ids.forEach(id=>{ const e = featuresData.get(id); if(e) out.push(e); });
    return out;
  }
  const out = [];
  featuresData.forEach(entry=>{ if(entry.layerId === layerId) out.push(entry); });
  return out;
}

function getAttributeRawValues(layerId, attrName){
  return getLayerFeatureEntries(layerId)
    .map(e => e.props ? e.props[attrName] : undefined)
    .filter(v => v !== undefined && v !== null && String(v).trim() !== '');
}

function getUniqueValuesForAttr(layerId, attrName){
  const seen = new Set();
  const out = [];
  getAttributeRawValues(layerId, attrName).forEach(v=>{
    const key = String(v);
    if(!seen.has(key)){ seen.add(key); out.push(key); }
  });
  out.sort((a,b)=> a.localeCompare(b, 'pt', {numeric:true, sensitivity:'base'}));
  return out;
}

function getNumericValuesForAttr(layerId, attrName){
  return getAttributeRawValues(layerId, attrName)
    .map(v=>parseFloat(v))
    .filter(n=>Number.isFinite(n))
    .sort((a,b)=>a-b);
}

function classifyEqualInterval(values, classCount){
  const min = values[0], max = values[values.length-1];
  const breaks = [];
  if(min === max){ breaks.push({min, max}); return breaks; }
  const step = (max - min) / classCount;
  for(let i=0;i<classCount;i++){
    const lo = min + step*i;
    const hi = (i === classCount-1) ? max : min + step*(i+1);
    breaks.push({min: lo, max: hi});
  }
  return breaks;
}

function classifyQuantile(values, classCount){
  const n = values.length;
  const breaks = [];
  for(let i=0;i<classCount;i++){
    const loIdx = Math.floor(i * n / classCount);
    const hiIdx = (i === classCount-1) ? (n-1) : Math.max(loIdx, Math.floor((i+1) * n / classCount) - 1);
    breaks.push({min: values[loIdx], max: values[hiIdx]});
  }
  for(let i=1;i<breaks.length;i++){
    if(breaks[i].min < breaks[i-1].max) breaks[i].min = breaks[i-1].max;
  }
  breaks[breaks.length-1].max = values[n-1];
  return breaks;
}

function classifyJenks(values, classCount){
  const data = values.slice();
  const n = data.length;
  if(n <= classCount){
    return classifyEqualInterval(data, classCount);
  }
  const mat1 = [];
  const mat2 = [];
  for(let i=0;i<=n;i++){
    mat1.push(new Array(classCount+1).fill(0));
    mat2.push(new Array(classCount+1).fill(0));
  }
  for(let i=1;i<=classCount;i++){
    mat1[1][i] = 1;
    mat2[1][i] = 0;
    for(let j=2;j<=n;j++) mat2[j][i] = Infinity;
  }
  let v = 0;
  for(let l=2;l<=n;l++){
    let s1=0, s2=0, w=0;
    for(let m=1;m<=l;m++){
      const i3 = l - m + 1;
      const val = data[i3-1];
      s2 += val*val; s1 += val; w++;
      v = s2 - (s1*s1)/w;
      const i4 = i3 - 1;
      if(i4 !== 0){
        for(let j=2;j<=classCount;j++){
          if(mat2[l][j] >= (v + mat2[i4][j-1])){
            mat1[l][j] = i3;
            mat2[l][j] = v + mat2[i4][j-1];
          }
        }
      }
    }
    mat1[l][1] = 1;
    mat2[l][1] = v;
  }
  let k = n;
  const kclass = new Array(classCount+1);
  kclass[classCount] = data[n-1];
  kclass[0] = data[0];
  let countNum = classCount;
  while(countNum >= 2){
    const id = mat1[k][countNum] - 2;
    kclass[countNum-1] = data[id];
    k = mat1[k][countNum] - 1;
    countNum--;
  }
  const breaks = [];
  for(let i=0;i<classCount;i++){
    breaks.push({min: kclass[i], max: kclass[i+1]});
  }
  return breaks;
}

function computeGraduatedBreaks(layerId, attrName, method, classCount){
  const values = getNumericValuesForAttr(layerId, attrName);
  if(values.length === 0) return [];
  const n = Math.max(1, Math.min(classCount || 5, values.length));
  let ranges;
  if(method === 'quantis') ranges = classifyQuantile(values, n);
  else if(method === 'jenks') ranges = classifyJenks(values, n);
  else ranges = classifyEqualInterval(values, n);
  return ranges.map((r, i)=>({min:r.min, max:r.max, color: paletteColor(i)}));
}

function styleLayerDefault(layer, layerId){
  const schema = layerId != null ? getLayerSchema(layerId) : null;
  const color = (schema && schema.baseColor) || DEFAULT_COLOR;
  const fillOpacity = ((schema && schema.opacity != null) ? schema.opacity : DEFAULT_OPACITY) / 100;
  if(layer.setIcon){
    layer.setIcon(dataGisMarkerIcon(color));
  } else if(layer.setStyle){
    layer.setStyle({color, weight:3, fillColor: color, fillOpacity});
  }
}

function resolveFeatureColor(schema, props){
  const sym = schema.symbology;
  if(sym && sym.mode === 'unicos' && sym.attr){
    const raw = props ? props[sym.attr] : undefined;
    const key = (raw === undefined || raw === null) ? '' : String(raw);
    const match = sym.uniqueValues.find(u=>String(u.value) === key);
    if(match) return match.color;
    return schema.baseColor || DEFAULT_COLOR;
  }
  if(sym && sym.mode === 'graduado' && sym.attr){
    const num = parseFloat(props ? props[sym.attr] : undefined);
    if(Number.isFinite(num)){
      const cls = sym.breaks.find(b=>num >= b.min && num <= b.max)
        || (sym.breaks.length ? sym.breaks[sym.breaks.length-1] : null);
      if(cls) return cls.color;
    }
    return schema.baseColor || DEFAULT_COLOR;
  }
  if(schema.mode === 'atributos' && Array.isArray(schema.attributes)){
    const catAttr = schema.attributes.find(a=>a.type==='categorico' && a.name === schema.colorAttr)
      || schema.attributes.find(a=>a.type==='categorico');
    if(catAttr){
      const val = props ? props[catAttr.name] : undefined;
      const cls = (catAttr.classes || []).find(c=>c.name === val);
      return cls ? cls.color : (schema.baseColor || DEFAULT_COLOR);
    }
  }
  return schema.baseColor || DEFAULT_COLOR;
}

function styleLayerByClass(entry){
  const schema = getLayerSchema(entry.layerId);
  if(!schema) return;
  const hasActiveSymbology = schema.symbology && (schema.symbology.mode === 'unicos' || schema.symbology.mode === 'graduado');
  if(!hasActiveSymbology && schema.mode !== 'atributos'){ styleLayerDefault(entry.layer, entry.layerId); return; }
  const color = resolveFeatureColor(schema, entry.props);
  const fillOpacity = ((schema && schema.opacity != null) ? schema.opacity : DEFAULT_OPACITY) / 100;
  if(entry.layer.setIcon){
    entry.layer.setIcon(dataGisMarkerIcon(color));
  } else if(entry.layer.setStyle){
    entry.layer.setStyle({color, fillColor:color, fillOpacity, weight:3});
  }
}

function restyleLayerId(layerId){
  const schema = getLayerSchema(layerId);
  if(!schema) return;
  getLayerFeatureEntries(layerId).forEach(entry=>{
    const sym = schema.symbology;
    if(sym && (sym.mode === 'unicos' || sym.mode === 'graduado')){
      styleLayerByClass(entry);
    } else if(schema.mode === 'atributos'){
      styleLayerByClass(entry);
    } else {
      styleLayerDefault(entry.layer, layerId);
    }
    if(entry.hasOverlap) applyTopologyVisual(entry);
  });
}

window.getLayerFeatureEntries = getLayerFeatureEntries;
window.getAttributeRawValues = getAttributeRawValues;
window.getUniqueValuesForAttr = getUniqueValuesForAttr;
window.getNumericValuesForAttr = getNumericValuesForAttr;
window.classifyEqualInterval = classifyEqualInterval;
window.classifyQuantile = classifyQuantile;
window.classifyJenks = classifyJenks;
window.computeGraduatedBreaks = computeGraduatedBreaks;
window.styleLayerDefault = styleLayerDefault;
window.resolveFeatureColor = resolveFeatureColor;
window.styleLayerByClass = styleLayerByClass;
window.restyleLayerId = restyleLayerId;

})();
