// DGT WMS Proxy Worker — adiciona CORS para tiles de ortofotos
// Corre localmente com: npx wrangler dev
// Uso: /wms?layer=orto2021&bbox=...&width=...&height=...

const DGT_BASE = 'https://cartografia.dgterritorio.gov.pt/wms';

const LAYER_MAP = {
  'orto2021': 'orto2021',
  'orto2018': 'ortos_2018',
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '') {
      return new Response('DGT Proxy OK', {
        headers: { 'Access-Control-Allow-Origin': '*' },
      });
    }

    // Proxy WMS
    console.log('DEBUG pathname:', url.pathname, 'search:', url.search);
    if (url.pathname === '/wms') {
      const layer = url.searchParams.get('layer') || 'orto2021';
      const mapped = LAYER_MAP[layer] || layer;

      const wmsUrl = new URL(DGT_BASE);
      wmsUrl.searchParams.set('service', 'WMS');
      wmsUrl.searchParams.set('version', '1.3.0');
      wmsUrl.searchParams.set('request', 'GetMap');
      wmsUrl.searchParams.set('layers', mapped);
      wmsUrl.searchParams.set('crs', url.searchParams.get('crs') || 'EPSG:3857');
      wmsUrl.searchParams.set('bbox', url.searchParams.get('bbox'));
      wmsUrl.searchParams.set('width', url.searchParams.get('width') || '256');
      wmsUrl.searchParams.set('height', url.searchParams.get('height') || '256');
      wmsUrl.searchParams.set('format', url.searchParams.get('format') || 'image/png');
      wmsUrl.searchParams.set('styles', url.searchParams.get('styles') || '');

      // Parâmetros opcionais
      const opts = ['transparent', 'bgcolor'];
      opts.forEach(k => {
        const v = url.searchParams.get(k);
        if (v) wmsUrl.searchParams.set(k, v);
      });

      const resp = await fetch(wmsUrl.toString());
      const headers = new Headers(resp.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Expose-Headers', '*');

      return new Response(resp.body, {
        status: resp.status,
        headers,
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};
