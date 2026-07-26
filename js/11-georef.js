/* ============================================================
   11-GEOREF.JS — Georreferenciação de imagens (JPG/PNG/TIFF)
   ------------------------------------------------------------
   FASE 0 (preparação / spike técnico)
   Este ficheiro ainda NÃO está ligado à interface da aplicação.
   Serve só para validar, isoladamente, as duas peças de maior
   risco técnico antes de construir o módulo todo:

     1) o cálculo dos 6 parâmetros da transformação afim a partir
        de N pontos de controlo (mínimos quadrados);
     2) a colocação de uma imagem no mapa Leaflet nessa posição,
        usando o plugin Leaflet.ImageOverlay.Rotated (que aceita
        exatamente 3 cantos = uma transformação afim).

   Nada aqui corre automaticamente. As funções ficam disponíveis
   em `window.Georef` para seres usadas manualmente na consola,
   e para servirem de base às fases seguintes (UI, GCPs, etc.).
   ============================================================ */

(function(){

  /* ------------------------------------------------------------
     1) SOLVER: mínimos quadrados para uma transformação afim 2D
     ------------------------------------------------------------
     Mapeia um ponto em pixels da imagem (x,y) para um ponto no
     mapa (X,Y), com:

        X = a*x + b*y + c
        Y = d*x + e*y + f

     Isto são duas regressões lineares independentes (uma para X,
     outra para Y) que partilham a mesma matriz de desenho, por
     isso resolve-se com um único sistema 3x3 (equações normais)
     para cada uma.

     Parâmetros:
       gcps: [{ img:{x,y}, map:{lng,lat} }, ...]   (mínimo 3 pontos)

     Devolve:
       { a,b,c,d,e,f, rms }
       rms = erro quadrático médio dos resíduos, nas unidades de
       `map` (graus, se estiveres a usar lat/lng diretamente — para
       ter o erro em metros, converte os pontos para uma projeção
       métrica, ex. EPSG:3763, antes de chamar isto).
     ------------------------------------------------------------ */
  function solveAffineLeastSquares(gcps){
    if(!Array.isArray(gcps) || gcps.length < 3){
      throw new Error('São necessários pelo menos 3 pontos de controlo.');
    }

    let Sxx=0, Sxy=0, Sx=0, Syy=0, Sy=0;
    let SxX=0, SyX=0, SX=0;   // regressão para X (=lng)
    let SxY=0, SyY=0, SY=0;   // regressão para Y (=lat)
    const n = gcps.length;

    gcps.forEach(p=>{
      const x = p.img.x, y = p.img.y;
      const X = p.map.lng, Y = p.map.lat;
      Sxx += x*x; Sxy += x*y; Sx += x;
      Syy += y*y; Sy += y;
      SxX += x*X; SyX += y*X; SX += X;
      SxY += x*Y; SyY += y*Y; SY += Y;
    });

    // matriz de equações normais (M^T M), igual para as duas regressões
    const A = [
      [Sxx, Sxy, Sx],
      [Sxy, Syy, Sy],
      [Sx,  Sy,  n ]
    ];
    const bX = [SxX, SyX, SX];
    const bY = [SxY, SyY, SY];

    const [a, b, c] = solve3x3(A, bX);
    const [d, e, f] = solve3x3(A, bY);

    // erro quadrático médio dos resíduos (qualidade do ajuste)
    let sumSq = 0;
    gcps.forEach(p=>{
      const x = p.img.x, y = p.img.y;
      const predX = a*x + b*y + c;
      const predY = d*x + e*y + f;
      const dx = predX - p.map.lng;
      const dy = predY - p.map.lat;
      sumSq += dx*dx + dy*dy;
    });
    const rms = Math.sqrt(sumSq / n);

    return {a, b, c, d, e, f, rms};
  }

  /* resolve um sistema linear 3x3 por regra de Cramer — é só isto que
     precisamos aqui, não vale a pena trazer uma lib de álgebra linear */
  function solve3x3(A, b){
    const det3 = (M)=> (
        M[0][0]*(M[1][1]*M[2][2] - M[1][2]*M[2][1])
      - M[0][1]*(M[1][0]*M[2][2] - M[1][2]*M[2][0])
      + M[0][2]*(M[1][0]*M[2][1] - M[1][1]*M[2][0])
    );
    const D = det3(A);
    if(Math.abs(D) < 1e-9){
      throw new Error('Sistema mal-condicionado — os pontos de controlo estão colineares ou repetidos.');
    }
    const withCol = (col, vec)=> A.map((row, i)=> row.map((v, j)=> j === col ? vec[i] : v));
    const Dx = det3(withCol(0, b));
    const Dy = det3(withCol(1, b));
    const Dz = det3(withCol(2, b));
    return [Dx/D, Dy/D, Dz/D];
  }

  /* ------------------------------------------------------------
     2) Converte os 6 parâmetros afins nos 3 cantos que o plugin
        Leaflet.ImageOverlay.Rotated espera (topleft, topright,
        bottomleft), a partir da largura/altura da imagem original
        em pixels.
     ------------------------------------------------------------ */
  function affineToCorners(transform, imgWidth, imgHeight){
    const apply = (x, y)=> L.latLng(
      transform.d*x + transform.e*y + transform.f,   // lat
      transform.a*x + transform.b*y + transform.c    // lng
    );
    return {
      topleft:    apply(0, 0),
      topright:   apply(imgWidth, 0),
      bottomleft: apply(0, imgHeight)
    };
  }

  /* ------------------------------------------------------------
     3) SPIKE MANUAL — a correr à mão na consola do browser, ainda
        sem UI nenhuma, só para confirmar visualmente que uma imagem
        fica corretamente posicionada no mapa a partir de GCPs.

        Uso (na consola, com a app aberta):

          Georef.spikeTest({
            imageUrl: 'file:///caminho/para/uma/imagem.jpg',
            imgWidth: 1200,          // largura da imagem em pixels
            imgHeight: 800,          // altura da imagem em pixels
            gcps: [
              { img:{x:50,  y:60},  map:{lng:-8.30, lat:41.55} },
              { img:{x:1100,y:70},  map:{lng:-8.28, lat:41.55} },
              { img:{x:60,  y:740}, map:{lng:-8.30, lat:41.53} },
              { img:{x:1080,y:730}, map:{lng:-8.28, lat:41.53} }
            ]
          });

        Isto usa o `map` global já criado pela app (05-app-main.js).
        Devolve o overlay adicionado, para poderes removê-lo com
        map.removeLayer(overlay) depois de confirmares o resultado.
     ------------------------------------------------------------ */
  function spikeTest({imageUrl, imgWidth, imgHeight, gcps}){
    if(typeof map === 'undefined' || !map){
      throw new Error('O mapa da aplicação ainda não está pronto.');
    }
    if(typeof L.imageOverlay.rotated !== 'function'){
      throw new Error('O plugin Leaflet.ImageOverlay.Rotated não foi carregado.');
    }

    const transform = solveAffineLeastSquares(gcps);
    const corners = affineToCorners(transform, imgWidth, imgHeight);

    const overlay = L.imageOverlay.rotated(imageUrl, corners.topleft, corners.topright, corners.bottomleft, {
      opacity: 0.85,
      interactive: false
    }).addTo(map);

    try{ map.fitBounds(overlay.getBounds()); }catch(err){ /* ignora se os bounds ainda não estiverem prontos */ }

    console.log('[Georef spike] transformação afim:', transform);
    console.log('[Georef spike] RMS (unidades de mapa, tipicamente graus se usares lat/lng diretamente):', transform.rms);
    console.log('[Georef spike] cantos calculados:', corners);
    console.log('[Georef spike] overlay adicionado ao mapa — para remover: map.removeLayer(overlay)');

    return overlay;
  }

  window.Georef = {
    solveAffineLeastSquares,
    affineToCorners,
    spikeTest
  };

})();
