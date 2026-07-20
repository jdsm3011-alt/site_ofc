# AUDITORIA TÉCNICA COMPLETA — Engenh / StrongGIS / DataGis

**Data:** 20 Julho 2026  
**Versão do software:** 1.4 (experimental)  
**Objetivo:** Documentação técnica exaustiva para programador que irá trabalhar no projeto.

---

## ÍNDICE

1. [Visão Geral da Arquitetura](#1-visão-geral-da-arquitetura)
2. [Inventário de Ficheiros](#2-inventário-de-ficheiros)
3. [Bibliotecas Externas](#3-bibliotecas-externas)
4. [Ciclo de Funcionamento da Aplicação](#4-ciclo-de-funcionamento-da-aplicação)
5. [Organização por Módulos](#5-organização-por-módulos)
6. [Lista Completa de Funcionalidades](#6-lista-completa-de-funcionalidades)
7. [Mapeamento da Interface](#7-mapeamento-da-interface)
8. [Operações GIS](#8-operações-gis)
9. [Gestão de Estado](#9-gestão-de-estado)
10. [Dependências entre Componentes](#10-dependências-entre-componentes)
11. [Funcionalidades Inacabadas ou Experimentais](#11-funcionalidades-inacabadas-ou-experimentais)
12. [Código Morto e Problemas Conhecidos](#12-código-morte-e-problemas-conhecidos)
13. [Resumo Final](#13-resumo-final)

---

## 1. VISÃO GERAL DA ARQUITETURA

### Tipo de Aplicação
Aplicação Web GIS desktop-style, construída com **HTML puro + JavaScript vanilla + CSS** — sem bundler, sem framework, sem npm. Servida localmente ou via dev server.

### Stack Tecnológica
- **Frontend:** HTML5, CSS3, JavaScript ES6+ (sem transpilação)
- **Mapa:** Leaflet 1.9.4 + Leaflet Geoman 2.18.3
- **Análise Espacial:** Turf.js 6.x
- **Sistema de Coordenadas:** Proj4js 2.9.0 (EPSG:4326 ↔ EPSG:3763)
- **Import/Export:** shpjs, shp-write, JSZip, SheetJS, geotiff.js, dxf-parser
- **Layout/Export PDF:** html2canvas + jsPDF
- **ML/AI:** Random Forest puro em Web Worker (assisted vectorization)
- **Georreferenciamento:** ORB + AKAZE + RANSAC puro em Web Worker
- **Temas:** Claro/Escuro via CSS custom properties + `data-theme`
- **Plataforma:** Funciona em browser desktop; bloqueado em mobile

### Arquitetura de Módulos
```
index.html (landing page)
    └── engenh.html (app principal)
         ├── 01-admin-gate.js      (autenticação)
         ├── 02-settings-theme.js  (tema + settings globais)
         ├── 03-coords.js          (barra de coordenadas)
         ├── 04-feedback-toast.js  (feedback)
         ├── 05-app-main.js        (NUCLEO — ~9150 linhas)
         ├── 06-smart-sync.js      (Excel/CSV → GIS)
         ├── 07-cad-import.js      (DXF/DWG → GIS)
         ├── 08-tools-menu.js      (menu de ferramentas)
         ├── 09-layouts.js         (composição multi-mapa)
         ├── 10-portal-bridge.js   (ponte DataGis Portal)
         ├── 11-georef.js          (georreferenciamento manual)
         ├── 12-autogeoref.js      (georreferenciamento automático)
         ├── 12b-autogeoref-worker.js (worker ORB/RANSAC)
         ├── 14-assisted-vect.js   (vetorização assistida UI)
         ├── 14b-assisted-vect-worker.js (worker Random Forest)
         ├── 15-integrity-check.js (verificação de integridade)
         ├── 16-runtime-errors.js  (erros em runtime)
         └── 17-state-consistency.js (consistência de estado)
```

### Padrões de Código
- **IIFEs** para módulos encapsulados (01, 04, 06, 15, 16, 17)
- **Globais no `window`** para módulos que comunicam entre si (02, 03, 05)
- **Web Workers** para computação pesada (auto-georef, assisted-vect)
- **Event delegation** para menus e listas dinâmicas
- **`let`/`const`** em escopo de módulo (não em `window`)
- **CSS custom properties** para design tokens e temas

---

## 2. INVENTÁRIO DE FICHEIROS

### HTML
| Ficheiro | Linhas | Função |
|----------|--------|--------|
| `index.html` | 752 | Landing page — escolher Portal ou StrongGIS |
| `engenh.html` | **1542** | App principal — mapa + todas as funcionalidades — logo FeatherGIS, sidebar-dev-badge, portal-bridge header simplificado |

### CSS (13 ficheiros)
| Ficheiro | Linhas | Função |
|----------|--------|--------|
| `css/base.css` | **1747** | Design tokens, layout, header, sidebar, mapa, overlays, modais, toolbar PM, alertas — header-logo-title adicionado; settings-header/settings-body/settings-footer substituem cloud-menu-header/body; basemap-menu mantido |
| `css/cad-import.css` | 49 | Importação CAD (DXF/DWG) |
| `css/feedback.css` | 196 | Toast de feedback |
| `css/georef.css` | 952 | Georreferenciamento (painel, picker, topbar, GCPs, auto-georef, stats) |
| `css/layouts.css` | 370 | Layout multi-mapa (frames, elementos, drag/resize, export) |
| `css/misc.css` | 61 | Admin gate (login retro) |
| `css/mobile.css` | 19 | Bloqueio mobile |
| `css/pm-toolbar.css` | 22 | Toolbar Geoman (show/hide) |
| `css/portal-bridge.css` | **226** | Painel DataGis Portal — simplificado: cores, bordas, tipografia e hover consistentes com os restantes menus (basemap-menu, settings) |
| `css/select-by-attr.css` | 36 | Seleção por atributo |
| `css/smart-sync.css` | 266 | Smart Sync (Excel/CSV) |
| `css/tools-menu.css` | 129 | Menu de ferramentas |
| `css/vetassist.css` | 245 | Vetorização assistida (AI) |

### JavaScript (18 ficheiros)
| Ficheiro | Linhas | Função |
|----------|--------|--------|
| `js/01-admin-gate.js` | 64 | Autenticação admin (IIFE, terminal animation) |
| `js/02-settings-theme.js` | 43 | Toggle tema + objeto `settings` global |
| `js/03-coords.js` | 23 | Barra de coordenadas (WGS84 ↔ PT-TM06) |
| `js/04-feedback-toast.js` | 75 | Toast de feedback (Formspree) |
| `js/05-app-main.js` | ~9154 | **NUCLEO** — mapa, camadas, basemaps, import/export, offline, análise espacial, gestão de projeto |
| `js/06-smart-sync.js` | ~800 | Sincronização Excel/CSV → camada GIS |
| `js/07-cad-import.js` | ~1100 | Importação DXF/DWG → camada GIS |
| `js/08-tools-menu.js` | ~40 | Orquestração do menu de ferramentas |
| `js/09-layouts.js` | ~1300 | Layout multi-mapa + export PDF/PNG |
| `js/10-portal-bridge.js` | ~400 | Ponte DataGis Portal (dados municipais) |
| `js/11-georef.js` | ~200 | Georreferenciamento manual (GCPs) |
| `js/12-autogeoref.js` | ~700 | Georreferenciamento automático (ORB/AKAZE + RANSAC) |
| `js/12b-autogeoref-worker.js` | ~500 | Worker: ORB + RANSAC puro em JS |
| `js/14-assisted-vect.js` | **1346** | Vetorização assistida — flood fill reescrito com edge-stopping (Sobel gradient), adaptive reference, close+open morphology; pós-processamento com DP 4px, removeCollinear, weldNear + orthogonalize |
| `js/14b-assisted-vect-worker.js` | ~700 | Worker: Random Forest + SLIC + processamento |
| `js/15-integrity-check.js` | **417** | Pré-boot gate + verificação de 64 globals — overlay redesenhado (header limpo com dot pulsante) |
| `js/16-runtime-errors.js` | **221** | Badge de erros runtime + painel |
| `js/17-state-consistency.js` | **392** | Badge de consistência + 7 checks — badge reposicionado à esquerda, shield/count invertidos |
| `js/modules/offline.js` | **142** | Handler de clique do ruler adicionado (#btn-ruler, #ruler-cancel) |
| `js/modules/settings.js` | **698** | Módulo de definições — botão "Guardar" simplificado, hint removido |
| `js/modules/analysis.js` | **718** | Guarda opcional (`?.`) em btn-open-analysis (evita crash se elemento faltar) |

### Workers
| Worker | Ficheiro | Algoritmos |
|--------|----------|------------|
| Auto-Georef | `12b-autogeoref-worker.js` | ORB (feature detection), AKAZE, RANSAC (homography), pure JS |
| Assisted Vectorization | `14b-assisted-vect-worker.js` | SLIC superpixels, Random Forest, morfologia (open/close), Douglas-Peucker, orthogonalização, raster→vector |

---

## 3. BIBLIOTECAS EXTERNAS

### Carregadas via CDN (13)
| Biblioteca | Versão | Uso |
|-----------|--------|-----|
| **Leaflet** | 1.9.4 | Mapa interativo |
| **Leaflet Geoman Free** | 2.18.3 | Ferramentas de desenho/edição |
| **Leaflet.ImageOverlay.Rotated** | 0.2.1 | Overlays de imagem rotacionada (georef) |
| **Turf.js** | 6.x | Análise espacial (buffer, intersect, union, clip, área, comprimento) |
| **Proj4js** | 2.9.0 | Transformação de sistemas de coordenadas |
| **shpjs** | 4.0.4 | Leitura de Shapefiles |
| **shp-write** | 0.4.3 | Escrita de Shapefiles |
| **JSZip** | 3.10.1 | Compressão ZIP |
| **SheetJS (xlsx)** | 0.18.5 | Parsing Excel/CSV |
| **geotiff.js** | 3.0.5 | Leitura/escrita GeoTIFF |
| **html2canvas** | 1.4.1 | HTML → canvas (export layout) |
| **jsPDF** | 2.5.1 | Geração de PDF |
| **dxf-parser** | 1.1.2 | Parsing DXF (dynamic import ESM) |

### Fontes (Google Fonts)
| Fonte | Pesos | Uso |
|-------|-------|-----|
| IBM Plex Sans | 400-700 | UI principal |
| IBM Plex Mono | 400-600 | Código, badges, labels |
| Spectral | 400-600 | Títulos (apenas index.html) |

### APIs/Serviços Externos
| Serviço | URL | Uso |
|---------|-----|-----|
| DataGis Portal | `datagispt.gispt.workers.dev` | Portal geográfico principal |
| Team API | `datagis-equipa.gispt.workers.dev` | Sync equipa, proxy DGT tiles |
| Municípios GeoJSON | `raw.githubusercontent.com/jdsm3011-alt/site_ofc/main/` | Limites municipais |
| Formspree | `formspree.io/f/xvzjojbj` | Submissão de feedback |
| ArcGIS Online | `server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/` | Basemap satélite |
| DGT Ortofotografia | `cartografia.dgterritorio.gov.pt/wms/ortos2021` | Basemap HD Portugal |
| CartoDB | `{s}.basemaps.cartocdn.com/light_all/` | Basemap claro |
| OpenStreetMap | `{s}.tile.openstreetmap.org/` | Basemap OSM |

---

## 4. CICLO DE FUNCIONAMENTO DA APLICAÇÃO

### Fase 1: Carregamento (index.html)
1. Landing page carrega com animações CSS (contornos topográficos, radar)
2. 5 scripts inline executam: loading overlay, close button, fullscreen, theme, continue session
3. Utilizador clica em "StrongGIS" → animação de loading com progress bar
4. Verificação `navigator.onLine` → se offline, aviso
5. Redirecionamento para `engenh.html`

### Fase 2: Autenticação (engenh.html)
1. `01-admin-gate.js` executa (IIFE) → mostra terminal de login
2. Se autenticado → `#admin-gate` esconde, app arranca
3. Se não → acesso negado

### Fase 3: Inicialização da App
1. **CDN scripts carregam** (Leaflet, Geoman, Turf, proj4, etc.)
2. **Módulos locais carregam** em ordem:
   - `02-settings-theme.js` → tema + `settings` global
   - `03-coords.js` → barra de coordenadas
   - `04-feedback-toast.js` → toast de feedback
   - `05-app-main.js` → **inicialização principal**:
     - `loadSettings()` → lê de localStorage
     - `initializeWorkspaces()` → gestão de workspaces
     - `initMap()` → cria mapa Leaflet, basemap, drawnGroup
     - `setupSaveButtonHold()` → auto-save
     - `setupExportMenu()` → exportação
     - `setupAnalysisPanel()` → análise espacial
     - Regista 150+ event listeners
   - Módulos 06-14 → cada um adiciona funcionalidade
   - `15-integrity-check.js` → **pre-boot gate** (verifica 24 globals críticos)
   - `16-runtime-errors.js` → badge de erros
   - `17-state-consistency.js` → badge de consistência

### Fase 4: Utilização Normal
1. Utilizador abre wizard de vetorização (`open-feature-wizard-btn`)
2. Define nome, modo (simples/atributos), geometria
3. Desenha no mapa com ferramentas Geoman
4. Cada feature criada → `onFeatureCreated()`:
   - Adiciona ao `drawnGroup`
   - Cria entry em `featuresData` Map
   - Mostra popup de stats
   - Bind context menu
   - Push para histórico de undo
5. Guarda projeto → `saveCurrentProject()` → localStorage
6. Auto-save a cada 20s (se ativo)

### Fase 5: Integridade Contínua
1. `15-integrity-check.js` → verifica globals a cada 1.2s
2. `16-runtime-errors.js` → captura erros JS e rejeições
3. `17-state-consistency.js` → verifica 7 checks de estado a cada 2s

---

## 5. ORGANIZAÇÃO POR MÓDULOS

### Módulo: Autenticação (`01-admin-gate.js`)
- **Tipo:** IIFE
- **Exporta:** Nada (auto-executa)
- **Depende de:** Nada
- **Funcionalidade:** Terminal de login retro, auto-grant se credenciais corretas
- **Estado:** Funcional

### Módulo: Settings/Tema (`02-settings-theme.js`)
- **Tipo:** Globals no window
- **Exporta:** `settings`, `applyTheme()`, `DEFAULT_SETTINGS`
- **Depende de:** Nada
- **Funcionalidade:** Toggle claro/escuro, persistência em localStorage
- **Estado:** Funcional

### Módulo: Coordenadas (`03-coords.js`)
- **Tipo:** Global
- **Exporta:** `updateCoordBar()`
- **Depende de:** `proj4`, `map`
- **Funcionalidade:** Mostra coordenadas do cursor em WGS84 ou PT-TM06
- **Estado:** Funcional

### Módulo: Feedback (`04-feedback-toast.js`)
- **Tipo:** IIFE
- **Exporta:** Nada
- **Depende de:** Formspree API
- **Funcionalidade:** Toast com formulário de feedback
- **Estado:** Funcional

### Módulo: Núcleo (`05-app-main.js`) — 9154 linhas
- **Tipo:** Globals massivos
- **Exporta:** ~50+ funções, ~30+ variáveis globais
- **Depende de:** Leaflet, Geoman, Turf, proj4, shpjs, shp-write, JSZip, geotiff.js, ImageOverlay.Rotated
- **Sub-funcionalidades:**
  - Gestão de mapa (init, basemaps, zoom, pan)
  - Gestão de camadas (criar, remover, reordenar, visibilidade, z-order)
  - Gestão de features (criar, remover, editar, undo/redo)
  - Simbologia (cores por classe, por atributo, manual)
  - Importação (GeoJSON, Shapefile, GeoTIFF, DXF/DWG, imagem)
  - Exportação (GeoJSON, Shapefile, GeoTIFF, PDF/PNG via layout)
  - Offline (download de tiles, travailho offline)
  - Análise espacial (buffer, intersect, union, difference/clip)
  - Seleção por atributo
  - Medição (ruler, medidas de polígono)
  - Project management (guardar, carregar, workspaces, auto-save)
  - Team sync (Cloudflare Workers API)
  - Municípios (limites administrativos)
  - Topologia (detecção de sobreposições)
  - Undo/Redo (histórico de ações)
  - App Alert (substitui alert() nativo)
- **Estado:** Funcional (módulo principal, muito extenso)

### Módulo: Smart Sync (`06-smart-sync.js`)
- **Tipo:** IIFE + globals
- **Exporta:** `SmartSync`
- **Depende de:** SheetJS (XLSX), Leaflet (markers), 05-app-main
- **Funcionalidade:** Sincronização Excel/CSV → camada GIS com matching de atributos
- **Estado:** Funcional

### Módulo: CAD Import (`07-cad-import.js`)
- **Tipo:** IIFE + globals
- **Exporta:** `CadImport`
- **Depende de:** dxf-parser (dynamic import), proj4, 05-app-main
- **Funcionalidade:** Importação DXF/DWG → camada GIS com perfis guardados e importação em lote
- **Estado:** Funcional

### Módulo: Tools Menu (`08-tools-menu.js`)
- **Tipo:** IIFE
- **Exporta:** Nada
- **Depende de:** Nada
- **Funcionalidade:** Orquestração do dropdown de ferramentas (CAD + Smart Sync)
- **Estado:** Funcional

### Módulo: Layouts (`09-layouts.js`)
- **Tipo:** Globals + IIFE
- **Exporta:** `isLayoutViewActive`, `renderLayoutTabsInto`, `handleAddMapClick`, `leaveLayoutView`, `notifyLayoutsWorkspaceChanged`
- **Depende de:** html2canvas, jsPDF, Leaflet (mini-maps)
- **Funcionalidade:** Composição multi-mapa com frames, elementos (legenda, seta norte, escala, texto, formas), drag/resize, export PDF/PNG/JPG
- **Estado:** Funcional

### Módulo: Portal Bridge (`10-portal-bridge.js`)
- **Tipo:** IIFE + globals
- **Exporta:** `pbCreateLayerFromFeatureCollection`, `pbLoadMunicipiosData`
- **Depende de:** shpjs, 05-app-main
- **Funcionalidade:** Ponte para DataGis Portal — pesquisa por município, download de dados (GeoJSON, Shapefile)
- **Estado:** Funcional

### Módulo: Georef Manual (`11-georef.js`)
- **Tipo:** Objeto global `Georef`
- **Exporta:** `Georef`
- **Depende de:** Leaflet.ImageOverlay.Rotated
- **Funcionalidade:** Georreferenciamento manual com GCPs (Ground Control Points)
- **Estado:** Funcional

### Módulo: Auto-Georef (`12-autogeoref.js` + `12b-autogeoref-worker.js`)
- **Tipo:** Objeto global `AutoGeoref` + Web Worker
- **Exporta:** `AutoGeoref`
- **Depende de:** Web Worker, OpenCV.js (referenciado mas não usado no worker final)
- **Funcionalidade:** Georreferenciamento automático usando ORB + AKAZE + RANSAC em pure JS
- **Algoritmos no Worker:**
  - ORB feature detection
  - AKAZE feature matching
  - RANSAC homography estimation
  - Warp transform
- **Estado:** Funcional (worker reescrito em pure JS, OpenCV.js removido do pipeline)

### Módulo: Vetorização Assistida (`14-assisted-vect.js` + `14b-assisted-vect-worker.js`)
- **Tipo:** IIFE + Web Worker
- **Exporta:** Funções internas
- **Depende de:** Web Worker, Leaflet (L.geoJSON), 05-app-main
- **Funcionalidade:** Detecção automática de edifícios a partir de imagens de satélite
- **Pipeline no Worker:**
  1. Captura tiles do basemap ativo (via `captureBasemapPixels` — usa `getActiveTileInfo()` para obter URL do tile atual, incluindo WMS DGT com EPSG:3857 bbox)
  2. Extrai features espectrais (NDVI, brilho, contraste)
  3. SLIC superpixels (clustering)
  4. Random Forest (treino com samples do utilizador)
  5. Classificação pixel-a-pixel
  6. Morfologia (close → open)
  7. Raster → Vector (contour tracing com `regionToRing`)
  8. Filtro de área mínima
  9. Douglas-Peucker simplification
  10. Orthogonalização de ângulos
- **Globals expostas em 05-app-main.js:** `window.__activeBaseLayerKey`, `window.__basemapLayers`
- **Estado:** Funcional

### Módulo: Pre-Boot Gate (`15-integrity-check.js`)
- **Tipo:** IIFE com pre-boot gate síncrono
- **Exporta:** `window.__integrityResult`
- **Depende de:** Nada
- **Funcionalidade:**
  1. **Pre-boot gate (síncrono):** Verifica 24 globals críticos. Se faltar algum → ecrã preto com erro old-school + throw
  2. **Overlay detalhado (1.2s delay):** Verifica 5 grupos (64 globals no total), mostra log terminal com animação
- **Estado:** Funcional

### Módulo: Runtime Errors (`16-runtime-errors.js`)
- **Tipo:** IIFE
- **Exporta:** `window.__runtimeErrors`
- **Depende de:** Nada
- **Funcionalidade:** Captura erros JS e rejeições, mostra badge vermelho + painel detalhado
- **Estado:** Funcional

### Módulo: State Consistency (`17-state-consistency.js`)
- **Tipo:** IIFE
- **Exporta:** `window.__stateConsistencyCheck`
- **Depende de:** 05-app-main (globais)
- **Funcionalidade:** 7 checks de estado (layers, workspaces, undo, etc.), mostra badge verde + painel
- **Estado:** Funcional

---

## 6. LISTA COMPLETA DE FUNCIONALIDADES

### A. Gestão de Mapa
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Mapa interativo | Base Leaflet com zoom/pan | `05-app-main.js` | Funcional |
| Basemap satélite | ArcGIS World Imagery | `05-app-main.js` | Funcional |
| Basemap HD Portugal | DGT Ortofotografia WMS | `05-app-main.js` | Funcional |
| Basemap claro | CartoDB Light | `05-app-main.js` | Funcional |
| Basemap OSM | OpenStreetMap | `05-app-main.js` | Funcional |
| Troca automática de basemap | Alterna consoante zoom/localização | `05-app-main.js` | Funcional |
| Coordenadas do cursor | Barra inferior com CRS | `03-coords.js`, `05-app-main.js` | Funcional |
| Switch CRS | WGS84 ↔ PT-TM06 | `03-coords.js` | Funcional |

### B. Gestão de Camadas
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Criar camada | Via wizard 3-passos | `05-app-main.js`, `engenh.html` | Funcional |
| Remover camada | Context menu | `05-app-main.js` | Funcional |
| Reordenar camadas | Drag-and-drop na sidebar | `05-app-main.js` | Funcional |
| Toggle visibilidade | Botão "olho" | `05-app-main.js` | Funcional |
| Zoom para camada | Context menu | `05-app-main.js` | Funcional |
| Tabela de atributos | Overlay com tabela completa | `05-app-main.js` | Funcional |
| Simbologia | Cores por classe/atributo | `05-app-main.js` | Funcional |
| Exportar camada | GeoJSON/Shapefile | `05-app-main.js` | Funcional |
| Camadas raster | Suporte a GeoTIFF overlays | `05-app-main.js` | Funcional |
| Workspaces | Múltiplos workspaces com tabs | `05-app-main.js` | Funcional |

### C. Desenho e Edição
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Desenhar pontos | Ferramenta marker | Geoman + `05-app-main.js` | Funcional |
| Desenhar linhas | Ferramenta polyline | Geoman + `05-app-main.js` | Funcional |
| Desenhar polígonos | Ferramenta polygon | Geoman + `05-app-main.js` | Funcional |
| Editar geometrias | Ferramenta edit | Geoman + `05-app-main.js` | Funcional |
| Arrastar geometrias | Ferramenta drag | Geoman + `05-app-main.js` | Funcional |
| Eliminar geometrias | Ferramenta remove | Geoman + `05-app-main.js` | Funcional |
| Undo/Redo | Histórico de ações | `05-app-main.js` | Funcional |
| Atributos por feature | Form modal por feature | `05-app-main.js` | Funcional |
| Medir distância | Ruler tool | `05-app-main.js` | Funcional |
| Medidas de polígono | Área/perímetro/arestas | `05-app-main.js` | Funcional |

### D. Importação
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| GeoJSON | Import .geojson/.json | `05-app-main.js` | Funcional |
| Shapefile | Import .zip/.shp via shpjs | `05-app-main.js` | Funcional |
| GeoTIFF | Import raster via geotiff.js | `05-app-main.js` | Funcional |
| Imagem georreferenciada | .jpg/.png com world file | `05-app-main.js` | Funcional |
| DXF/DWG | CAD via dxf-parser | `07-cad-import.js` | Funcional |
| Perfis de importação | Guardar/reutilizar configs | `07-cad-import.js` | Funcional |
| Importação em lote | Múltiplos DXF de uma vez | `07-cad-import.js` | Funcional |
| Arrastar ficheiros | Drag-and-drop na janela | `05-app-main.js` | Funcional |

### E. Exportação
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| GeoJSON | Export feature collection | `05-app-main.js` | Funcional |
| Shapefile | Export via shp-write | `05-app-main.js` | Funcional |
| GeoTIFF | Export raster via geotiff.js | `05-app-main.js` | Funcional |
| PDF/PNG/JPG do layout | Via html2canvas + jsPDF | `09-layouts.js` | Funcional |
| CRS na exportação | EPSG:3763 ou EPSG:4326 | `05-app-main.js` | Funcional |

### F. Análise Espacial
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Buffer | Zona tampon a distância | `05-app-main.js` (turf.buffer) | Funcional |
| Intersect | Interseção de geometrias | `05-app-main.js` (turf.intersect) | Funcional |
| Union | União de geometrias | `05-app-main.js` (turf.union) | Funcional |
| Difference/Clip | Subtração/recorte | `05-app-main.js` (turf.difference) | Funcional |
| Exportar resultado | GeoJSON/Shapefile do resultado | `05-app-main.js` | Funcional |
| Mapa de preview | Mini-mapa dedicado para análise | `05-app-main.js`, `engenh.html` | Funcional |

### G. Seleção
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Seleção por atributo | Query builder (eq, neq, contains, gt, lt) | `05-app-main.js` | Funcional |
| Highlight de features | Flash visual ao selecionar | `05-app-main.js` | Funcional |

### H. Georreferenciamento
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Georef manual | GCPs manuais + transformação | `11-georef.js`, `05-app-main.js` | Funcional |
| Georef automático | ORB/AKAZE + RANSAC | `12-autogeoref.js`, `12b-autogeoref-worker.js` | Funcional |
| Painel de imagem | Preview da imagem original | `11-georef.js` | Funcional |
| Lista de GCPs | Gestão de pontos de controlo | `11-georef.js` | Funcional |
| Stats de precisão | RMS error, card de estatísticas | `11-georef.js` | Funcional |

### I. Vetorização Assistida (AI)
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Wizard 7 passos | Interface guiada | `14-assisted-vect.js`, `engenh.html` | Funcional |
| Seleção de classe | Building (ativo), road/water/vegetation (desativado) | `14-assisted-vect.js` | Parcial |
| Definição de área | Desenhar retângulo no mapa | `14-assisted-vect.js` | Funcional |
| Samples de treino | Positivos/negativos | `14-assisted-vect.js` | Funcional |
| Processamento | Pipeline completo no worker | `14b-assisted-vect-worker.js` | Funcional |
| Review | Eliminar/aceitar resultados | `14-assisted-vect.js` | Funcional |
| Criação de camada | Resultado → nova camada GIS | `14-assisted-vect.js`, `05-app-main.js` | Funcional |

### J. Offline
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Definir área offline | Desenhar retângulo | `05-app-main.js` | Funcional |
| Download de tiles | Baixar tiles para IDB | `05-app-main.js` | Funcional |
| Modo offline | Trabalhar sem internet | `05-app-main.js` | Funcional |
| Prompt ao reabrir | Detetar área guardada | `05-app-main.js` | Funcional |

### K. Smart Sync (Excel/CSV)
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Wizard completo | 5 secções (wizard, receitas, automação, histórico, ajuda) | `06-smart-sync.js` | Funcional |
| Matching de colunas | Mapear Excel → atributos GIS | `06-smart-sync.js` | Funcional |
| Preview no mapa | Markers de coordenadas | `06-smart-sync.js` | Funcional |
| Receitas guardadas | Reutilizar configurações | `06-smart-sync.js` | Funcional |

### L. CAD Import (DXF/DWG)
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Wizard completo | 5 secções (wizard, perfis, lote, histórico, ajuda) | `07-cad-import.js` | Funcional |
| Conversão CRS | EPSG:4326 ↔ EPSG:3763 | `07-cad-import.js` | Funcional |
| Georreferenciamento CAD | 2-ponto para escala/rotação | `07-cad-import.js` | Funcional |
| Perfis guardados | Reutilizar configs | `07-cad-import.js` | Funcional |
| Importação em lote | Múltiplos DXF | `07-cad-import.js` | Funcional |

### M. Layout Multi-Mapa
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Criar layout | Nova composição | `09-layouts.js` | Funcional |
| Adicionar frames | Mapas independentes | `09-layouts.js` | Funcional |
| Elementos | Legenda, seta norte, escala, texto, formas | `09-layouts.js` | Funcional |
| Drag/Resize | Mover/redimensionar frames e elementos | `09-layouts.js` | Funcional |
| Export PDF | Via html2canvas + jsPDF | `09-layouts.js` | Funcional |
| Export PNG/JPG | Via html2canvas | `09-layouts.js` | Funcional |

### N. Portal Bridge
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Pesquisa por município | CAOP search | `10-portal-bridge.js` | Funcional |
| Download dados | GeoJSON/Shapefile do portal | `10-portal-bridge.js` | Funcional |
| Dados OSM | Download de dados OpenStreetMap | `10-portal-bridge.js` | Funcional |

### O. Municípios
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Pesquisar município | Por nome | `05-app-main.js` | Funcional |
| Carregar limites | GeoJSON do GitHub | `05-app-main.js` | Funcional |
| Gerir carregados | Lista de limites ativos | `05-app-main.js` | Funcional |

### P. Project Management
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Guardar projeto | localStorage | `05-app-main.js` | Funcional |
| Carregar projeto | Lista de guardados | `05-app-main.js` | Funcional |
| Auto-save | A cada 20s (configurável) | `05-app-main.js` | Funcional |
| Workspaces | Múltiplos workspaces | `05-app-main.js` | Funcional |
| Sair com confirmação | Aviso de alterações por guardar | `05-app-main.js` | Funcional |

### Q. Team Sync
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Sync online | Cloudflare Workers API | `05-app-main.js` | Parcial (hidden) |
| Partilha de projeto | Upload/download | `05-app-main.js` | Parcial (hidden) |

### R. Integridade e Monitorização
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Pre-boot gate | Bloqueia app se globals em falta | `15-integrity-check.js` | Funcional |
| Verificação detalhada | Log terminal com 64 globals | `15-integrity-check.js` | Funcional |
| Runtime errors | Badge + painel de erros | `16-runtime-errors.js` | Funcional |
| State consistency | Badge + painel de 7 checks | `17-state-consistency.js` | Funcional |

### S. Feedback
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Formulário de feedback | POST para Formspree | `04-feedback-toast.js` | Funcional |

### T. Topologia
| Funcionalidade | Objetivo | Ficheiros | Estado |
|---------------|----------|-----------|--------|
| Detecção de sobreposições | Verifica sobreposição entre features | `05-app-main.js` | Funcional |
| Warnings visuais | Toggle de avisos | `05-app-main.js` | Funcional |

---

## 7. MAPEAMENTO DA INTERFACE

### Header (barra superior)
| Botão | ID | Função | Atalho |
|-------|-----|--------|--------|
| Guardar | `btn-save-project` | Guardar projeto | — |
| Projetos guardados | `btn-open-local-projects` | Lista de projetos | — |
| Sync online | `btn-sync-online` | Sincronizar (hidden) | — |
| Nuvem | `open-wizard-btn` | Menu cloud | — |
| Definições | `btn-cloud-settings` | Painel settings | — |
| Desfazer | `btn-undo-action` | Undo | Ctrl+Z |
| Refazer | `btn-redo-action` | Redo | Ctrl+Y |
| Editar | `btn-toggle-pm-toolbar` | Toolbar Geoman | E |
| Vetorizar | `open-feature-wizard-btn` | Wizard 3-passos | — |
| Importar | `btn-import-geom` | Import ficheiro | — |
| Georef | `btn-georef-mode` | Modo georef (hidden) | — |
| Vet. Assistida | `btn-vetassist` | Wizard AI 7-passos | — |
| Exportar | `btn-open-export-menu` | Menu exportação | — |
| Municípios | `btn-open-municipios` | Painel municípios | — |
| Portal | `btn-portal-bridge` | Painel portal | — |
| Análise | `btn-open-analysis` | Painel análise espacial | — |
| Selecionar | `btn-select-by-attr` | Menu seleção atributo | — |
| Basemap | `btn-basemap` | Menu basemap | — |
| Medir | `btn-ruler` | Ferramenta ruler | — |
| Offline | `btn-offline-define` | Definir área offline | — |
| Feedback | `feedback-nav-btn` | Toast feedback | — |
| Topologia | `btn-topology-warn-toggle` | Toggle warnings (hidden) | — |
| Tema | `theme-toggle` | Claro/Escuro | — |
| Automation | `btn-automation-menu` | Dropdown CAD/Sync (hidden) | — |
| Layout | `layout-add-content-btn` | Adicionar conteúdo (hidden) | — |
| Voltar | `back-link` | index.html | — |

### Sidebar (esquerda)
| Elemento | ID | Função |
|----------|-----|--------|
| Tabs de workspace | `workspace-tabs` | Trocar workspaces |
| Bloco equipa | `team-block` | Card de colaboração (hidden) |
| Resumo features | `feat-summary` | Lista de camadas |
| Mensagem vazio | `empty-msg` | "Nenhuma forma configurada" |
| Painel vector | `shape-panel` | Lista de camadas vetoriais |
| Painel raster | `raster-panel` | Lista de camadas raster |
| Context menu layers | `layer-context-menu` | Zoom, tabela, simbologia, export, remover |

### Mapa
| Elemento | ID | Função |
|----------|-----|--------|
| Mapa Leaflet | `map` | Container principal |
| Barra coordenadas | `coord-bar` | Coordenadas + CRS |
| Banner landing | `landing-banner` | "Pronto a começar?" |
| Coachmark | `gear-coachmark` | Dica de criação |
| Menu settings | `settings-floating-menu` | Settings flutuante |
| Menu sync | `team-sync-floating-menu` | Sync flutuante |
| Painel symbology | `shape-color-attr-row` | Editor de simbologia |
| Toast basemap | `basemap-toast` | Notificação de basemap |
| Context menu feature | `feature-context-menu` | Menu de contexto (medidas) |

### Overlays/Modais
| Overlay | ID | Função |
|---------|-----|--------|
| Wizard vetorização | `wizard-overlay` | 3-passos (nome, atributos, geometria) |
| Form atributos | `attr-form-overlay` | Editor por feature |
| Tabela atributos | `attr-table-overlay` | Tabela completa |
| Exportação | `export-menu-overlay` | GeoJSON/Shapefile + CRS |
| Projetos guardados | `local-projects-overlay` | Lista de projetos |
| Sair | `exit-confirm-overlay` | Confirmação de saída |
| Auto-save suggest | `autosave-suggest-overlay` | Ativar auto-save |
| Análise espacial | `analysis-overlay` | Buffer/Intersect/Union/Difference |
| Vet. Assistida | `va-page` | Wizard AI completo |
| Smart Sync | `smart-sync-page` | Sync Excel/CSV |
| CAD Import | `cad-import-page` | Import DXF/DWG |
| Offline overlay | `offline-overlay` | Download de tiles |
| Offline progress | `offline-progress-overlay` | Progresso do download |
| Offline prompt | `offline-prompt-overlay` | "Área encontrada" |
| Georef topbar | `georef-mode-topbar` | Modo georef ativo |
| Georef image | `georef-image-panel` | Preview da imagem |
| App Alert | `app-alert-overlay` | Alerta customizado |

### Banners (inferior)
| Banner | ID | Função |
|--------|-----|--------|
| Offline rect | `offline-rect-banner` | "Desenha um retângulo" |
| Ruler | `ruler-banner` | "Desenha uma linha" |
| Ruler result | `ruler-result` | Resultado da medição |
| Connectivity | `connectivity-active-banner` | "Modo offline ativo" |
| Georef active | `georef-active-banner` | "Georreferenciamento ativo" |
| VA draw | `va-draw-banner` | "Desenha um retângulo" |
| VA sample | `va-sample-banner` | "Desenha sobre o edifício" |

### Menus Flutuantes
| Menu | ID | Função |
|------|-----|--------|
| Basemap | `basemap-menu` | Satellite, DGT, Claro, OSM + auto |
| Offline areas | `offline-areas-menu` | Áreas guardadas + nova |
| Georef picker | `georef-picker-menu` | Selecionar imagem |
| Raster export | `raster-export-menu` | Exportar rasters |
| Select by attr | `select-by-attr-menu` | Query builder |
| Automation | `automation-menu-dropdown` | CAD + Smart Sync |

### Atalhos de Teclado
| Atalho | Ação |
|--------|------|
| Ctrl+Z | Desfazer |
| Ctrl+Y / Ctrl+Shift+Z | Refazer |
| Ctrl+S | Guardar projeto |
| E | Toggle toolbar editing |
| Ctrl+Shift+I | Verificar integridade |

---

## 8. OPERAÇÕES GIS

### Importação
- **GeoJSON/JSON:** `JSON.parse()` → `L.geoJSON()` → `drawnGroup.addLayer()`
- **Shapefile:** `shp(arrayBuffer)` → `L.geoJSON()` → `drawnGroup.addLayer()`
- **GeoTIFF:** `GeoTIFF.fromArrayBuffer()` → extrair bandas → `L.imageOverlay()` ou canvas
- **DXF/DWG:** `dxf-parser` (dynamic import) → parse entities → `proj4()` transform → `L.geoJSON()`
- **Imagem + world file:** Ler PGW/JGW/TFW → calcular bounds → `L.imageOverlay.rotated()`

### Exportação
- **GeoJSON:** `buildGeoJSON()` → `JSON.stringify()` → download
- **Shapefile:** `shpwrite.zip()` ou `shpwrite.write()` → JSZip → download
- **GeoTIFF:** `GeoTIFF.writeArrayBuffer()` → blob → download
- **PDF/PNG:** html2canvas → jsPDF (para PDF) ou canvas.toBlob() (para imagem)

### Análise Espacial (Turf.js)
- **Buffer:** `turf.buffer(feature, distance, {units:'meters'})`
- **Intersect:** `turf.intersect(geom1, geom2)`
- **Union:** `turf.union(geom1, geom2)`
- **Difference:** `turf.difference(geom1, geom2)`
- **Overlap detection:** `turf.booleanOverlap()`, `turf.booleanContains()`
- **Medição:** `turf.length()` (comprimento), `turf.area()` (área)

### Sistemas de Coordenadas
- **EPSG:4326** (WGS84): Sistema base do Leaflet
- **EPSG:3763** (PT-TM06): Sistema nacional português
- **Conversão:** `proj4('EPSG:4326', 'EPSG:3763', [lng, lat])`

### Workers
- **Auto-Georef Worker:** Recebe ImageData → ORB features → AKAZE matching → RANSAC homography → devolve GCPs
- **Assisted-Vect Worker:** Recebe pixel data do basemap → extrai features espectrais → SLIC → Random Forest → morfologia → vector → devolve GeoJSON

---

## 9. GESTÃO DE ESTADO

### Variáveis Globais Principais (em `05-app-main.js`)
| Variável | Tipo | Descrição |
|----------|------|-----------|
| `map` | L.map | Instância do mapa Leaflet |
| `drawnGroup` | L.FeatureGroup | Grupo de features desenhadas |
| `featuresData` | Map | Map<leafletStamp, entry> — todas as features |
| `activeLayerId` | string | ID da camada ativa |
| `config` | object | Configuração da camada atual |
| `layers` | array | Lista de camadas |
| `layerOrder` | array | Ordem de empilhamento |
| `layerVisible` | Map | Visibilidade por camada |
| `layerCounter` | number | Contador de camadas |
| `featureCounter` | number | Contador de features |
| `projectDirty` | boolean | Alterações por guardar |
| `localProjectState` | object | Estado do projeto local |
| `workspaces` | array | Lista de workspaces |
| `currentWorkspace` | object | Workspace ativo |
| `settings` | object | Definições da app |
| `undoStack` / `redoStack` | array | Histórico de ações |
| `offlineDrawing` | boolean | Modo desenho offline |
| `rulerDrawing` | boolean | Modo ruler |
| `vaDrawingActive` | boolean | Modo desenho VA |
| `georefModeState` | object | Estado do georef |
| `teamState` | object | Estado de sync de equipa |

### Persistência
- **localStorage** para: settings, projetos guardados, workspaces, onboarding
- **IndexedDB** para: tiles offline

### Fluxo de Dados
```
Utilizador → Evento DOM → Handler JS → Modifica estado → Atualiza UI → persistCurrentWorkspaceState()
```

---

## 10. DEPENDÊNCIAS ENTRE COMPONENTES

### Grafo de Dependências
```
01-admin-gate.js          (independente)
02-settings-theme.js      (independente)
03-coords.js              → proj4, map
04-feedback-toast.js      → Formspree API
05-app-main.js            → Leaflet, Geoman, Turf, proj4, shpjs, shp-write, JSZip, geotiff.js, ImageOverlay.Rotated
06-smart-sync.js          → SheetJS, Leaflet, 05-app-main
07-cad-import.js          → dxf-parser, proj4, 05-app-main
08-tools-menu.js          (independente)
09-layouts.js             → html2canvas, jsPDF, Leaflet, 05-app-main
10-portal-bridge.js       → shpjs, 05-app-main
11-georef.js              → ImageOverlay.Rotated, 05-app-main
12-autogeoref.js          → 12b-autogeoref-worker.js, 11-georef.js, 05-app-main
12b-autogeoref-worker.js  (worker independente, pure JS)
14-assisted-vect.js       → 14b-assisted-vect-worker.js, 05-app-main
14b-assisted-vect-worker.js (worker independente, pure JS + ArcGIS tiles)
15-integrity-check.js     → verifica globals de 05-app-main e outros
16-runtime-errors.js      (independente)
17-state-consistency.js   → verifica globals de 05-app-main
```

### Módulos que dependem de `05-app-main.js`
- `06-smart-sync.js` (usa `markProjectDirty`, `importGeoJSONFeatures`, `createLayer`)
- `07-cad-import.js` (usa `markProjectDirty`, `importGeoJSONFeatures`, `createLayer`)
- `09-layouts.js` (usa `map`, `drawnGroup`, `layers`, `workspaces`)
- `10-portal-bridge.js` (usa `importGeoJSONFeatures`, `pbCreateLayerFromFeatureCollection`)
- `11-georef.js` (usa `map`, `georefModeState`)
- `12-autogeoref.js` (usa `map`, `11-georef`)
- `14-assisted-vect.js` (usa `map`, `importGeoJSONFeatures`)
- `15-integrity-check.js` (verifica globals)
- `17-state-consistency.js` (verifica globals)

---

## 11. FUNCIONALIDADES INACABADAS OU EXPERIMENTAIS

### 1. Team Sync (Parcial)
- Botão `btn-sync-online` está com classe `hidden`
- Botão `open-wizard-btn` (nuvem) existe mas painel está vazio
- Team block na sidebar está hidden
- API existe (`datagis-equipa.gispt.workers.dev`) mas não está integrada na UI principal

### 2. Vetorização Assistida — Classes Desativadas
- Apenas "Buildings" está ativo na seleção de classe
- "Roads", "Water", "Vegetation" estão desativados (disabled)

### 3. Automação
- Menu `automation-menu-wrap` está com `display:none`
- Contém CAD Import e Smart Sync como items
- Funcional mas escondido por default

### 4. Topology Warnings Toggle
- Botão `btn-topology-warn-toggle` está hidden
- Funcionalidade existe mas não está exposta na UI

### 5. OpenCV.js
- Referenciado em `12-autogeoref.js` (linha 45) mas não carregado
- Worker reescrito em pure JS — OpenCV.js não é necessário

### 6. Botão "Análise Espacial" (`btn-open-analysis`)
- Elemento não existe no HTML (removido do header), causava `Cannot read properties of null` em `analysis.js:162`
- Corrigido com `?.` — agora é silenciosamente ignorado

### 7. Deteção Automática de Edifícios (Magic Wand)
- **Problema atual:** Flood fill (region growing) por cor ainda produz máscaras fragmentadas em telhados com variação de cor ou sombras.
- **Melhorias aplicadas:**
  - `MW_WINDOW_RADIUS_PX`: 80 → **180px** (cobre edifícios maiores)
  - Tolerâncias: 22/38/55 → **25/42/60** (cobre mais variação)
  - **Edge-stopping**: gradiente Sobel 3x3 pré-computado na ROI; flood fill pára em arestas fortes
  - **Adaptive reference**: cor de referência segue gradualmente o telhado (move 10%/pixel dentro de `tolerance×0.55`)
  - **Close+open**: `closeMask()` preenche buracos antes do `openMask()` cortar pontes
  - **Pós-processamento**: DP 4px → removeCollinear → weldNear (3px) → removeCollinear → [ortho?] → removeCollinear → weldNear (2px) → fecho do anel
- **Por resolver:** Arestas fracas (telhado com pouco contraste com o solo) ainda podem falhar

### 8. Menu Portal DataGis — Estética Inconsistente
- **Antes:** cores, bordas e padding diferentes dos restantes menus (basemap-menu, settings)
- **Agora:** reescrito para usar `var(--line-strong)`, `var(--radius-sm)`, `var(--shadow)`, `var(--paper-deep)` hover, header simplificado com apenas "DATAGIS PORTAL" + ✕
- `<b>Ligar ao Portal</b>` removido do header

### 9. Mobile Block
- `mobile-block` existe mas é `display:none` por default
- CSS em `mobile.css` bloqueia mobile

---

## 12. CÓDIGO MORTO E PROBLEMAS CONHECIDOS

### CSS
- **Blocos duplicados em `base.css`:**
  - `.header-left` (linhas 174 e 191) — definição idêntica repetida
  - `.header-left-actions` (linhas 175 e 192) — definição idêntica repetida
  - `.header-actions` (linhas 177 e 194) — segunda cópia perde `flex:1 1 320px`
  - `.cloud-menu-body` (linhas 71 e 116) — segunda definição sobrescreve scrollbar
- **Variáveis CSS não definidas em `:root`:** `--border`, `--paper-hover`, `--ink-soft`, `--shadow-lg`, `--text`, `--paper-dark`, `--app-icon-size` (usam fallbacks inline)
- **`!important` excessivo:** ~50+ declarações, principalmente em PM toolbar e header
- **`base.css` muito grande:** 1683 linhas com ~30 subsystemas de UI

### JS
- **Ficheiro `05-app-main.js` muito extenso:** ~9150 linhas com ~150+ event listeners
- **`esc()` / `escHtml()` duplicados** em `06-smart-sync.js`, `07-cad-import.js`, `17-state-consistency.js`
- **Menu boilerplate repetido** ~7+ vezes (open/close/toggle pattern)
- **`analysis.js:162`**: `document.getElementById('btn-open-analysis').addEventListener(...)` crashava se elemento não existisse — corrigido com `?.`

### z-index
- Valores extremos: `2147483000` para toasts, `999999999` para admin gate
- Potenciais conflitos entre camadas

---

## 13. RESUMO FINAL

**Engenh/StrongGIS é uma aplicação Web GIS completa e funcional**, construída com tecnologias web puras (HTML/JS/CSS) sem frameworks. O software é capaz de:

1. **Criar e gerir geometrias** (pontos, linhas, polígonos) com atributos
2. **Importar dados** de múltiplos formatos (GeoJSON, Shapefile, GeoTIFF, DXF/DWG, imagem)
3. **Exportar dados** em GeoJSON, Shapefile, GeoTIFF, PDF/PNG
4. **Realizar análises espaciais** (buffer, intersect, union, difference)
5. **Georreferenciar imagens** (manual com GCPs ou automático com ORB/RANSAC)
6. **Vetorizar automaticamente** edifícios a partir de satélite (Random Forest + SLIC)
7. **Trabalhar offline** com download de tiles
8. **Gerir múltiplos workspaces** e projetos
9. **Sincronizar com Excel/CSV** (Smart Sync)
10. **Importar dados CAD** (DXF/DWG com perfis e lote)
11. **Criar composições multi-mapa** (layouts com export PDF)
12. **Conectar ao DataGis Portal** para dados de municípios
13. **Detectar e prevenir erros** (integridade, runtime errors, consistência)

**Pontos fortes:**
- Arquitetura modular com 18 ficheiros JS organizados
- Workers para computação pesada (ML, georef)
- Sistema de temas (claro/escuro) completo
- Design tokens via CSS custom properties
- Pré-boot gate de integridade

**Áreas de melhoria:**
- `05-app-main.js` deveria ser dividido em módulos menores
- Team sync está funcional mas escondido
- Classes de vetorização para além de "buildings" estão desativadas
- Variáveis CSS não centralizadas em `:root`
- Blocos CSS duplicados em `base.css`
