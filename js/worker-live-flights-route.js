/**
 * worker-live-flights-route.js
 * ---------------------------------------------------------------------------
 * Rota a integrar no teu Cloudflare Worker existente (datagis-equipa).
 * Faz de proxy autenticado à OpenSky Network API, resolvendo:
 *
 *   1) CORS — a OpenSky só responde com Access-Control-Allow-Origin para
 *      o próprio domínio deles. O browser nunca conseguiria chamar a API
 *      diretamente a partir do teu site. O worker chama a OpenSky
 *      server-to-server (sem CORS) e devolve os dados com CORS liberado
 *      para o teu domínio.
 *
 *   2) Segredo exposto — o client_secret OAuth2 nunca deve viver no
 *      frontend. Aqui fica só como Worker Secret, nunca visível ao browser.
 *
 * ---------------------------------------------------------------------------
 * SETUP (uma vez, via wrangler):
 *
 *   wrangler secret put OPENSKY_CLIENT_ID
 *   wrangler secret put OPENSKY_CLIENT_SECRET
 *
 * Se não quiseres criar conta OpenSky já, deixa os secrets por definir —
 * a rota cai automaticamente para modo anónimo (funciona, com limites
 * mais baixos).
 * ---------------------------------------------------------------------------
 * INTEGRAÇÃO no worker.js existente:
 *
 *   Dentro do teu `fetch(request, env, ctx)` / router atual, adiciona:
 *
 *     if (url.pathname === '/api/live-flights') {
 *       return handleLiveFlights(request, env);
 *     }
 *
 *   E cola as funções abaixo (handleLiveFlights, getOpenSkyToken) no
 *   ficheiro do worker. Ajusta ALLOWED_ORIGIN para o teu domínio real.
 * ---------------------------------------------------------------------------
 */

const ALLOWED_ORIGIN = 'https://site-ofc.pages.dev'; // <-- ajusta ao teu domínio de produção
const OPENSKY_AUTH_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';

// Bounding box de Portugal continental (ajusta se precisares de Açores/Madeira)
const DEFAULT_BBOX = { lamin: 36.8, lamax: 42.2, lomin: -9.6, lomax: -6.0 };

// Cache em memória do token, partilhado entre pedidos no mesmo isolate.
// Como os tokens duram ~30min e o polling do frontend é a cada 20s,
// isto evita autenticar em quase todos os pedidos.
let _cachedToken = null;
let _cachedTokenExpiresAt = 0;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  };
}

async function getOpenSkyToken(env) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) {
    return null; // sem credenciais -> pedido anónimo à OpenSky
  }

  const now = Date.now();
  if (_cachedToken && now < _cachedTokenExpiresAt) {
    return _cachedToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.OPENSKY_CLIENT_ID,
    client_secret: env.OPENSKY_CLIENT_SECRET,
  });

  const resp = await fetch(OPENSKY_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Falha na autenticação OpenSky (HTTP ${resp.status})`);
  }

  const data = await resp.json();
  _cachedToken = data.access_token;
  _cachedTokenExpiresAt = now + ((data.expires_in || 1800) - 30) * 1000;

  return _cachedToken;
}

async function handleLiveFlights(request, env) {
  const origin = request.headers.get('Origin') || ALLOWED_ORIGIN;

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(origin) });
  }

  try {
    const url = new URL(request.url);
    const bbox = {
      lamin: url.searchParams.get('lamin') || DEFAULT_BBOX.lamin,
      lamax: url.searchParams.get('lamax') || DEFAULT_BBOX.lamax,
      lomin: url.searchParams.get('lomin') || DEFAULT_BBOX.lomin,
      lomax: url.searchParams.get('lomax') || DEFAULT_BBOX.lomax,
    };

    const token = await getOpenSkyToken(env);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};

    const statesUrl = `${OPENSKY_STATES_URL}?${new URLSearchParams(bbox).toString()}`;
    const openSkyResp = await fetch(statesUrl, { headers });

    if (openSkyResp.status === 429) {
      return new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    if (!openSkyResp.ok) {
      return new Response(JSON.stringify({ error: `opensky_http_${openSkyResp.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const data = await openSkyResp.json();

    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'proxy_error', message: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
  }
}

// Se o teu worker usar `export default { fetch }` em vez de um router,
// exporta também isto para poderes importar/testar a rota isoladamente:
export { handleLiveFlights, getOpenSkyToken };
