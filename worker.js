/**
 * DataGIS PT — Worker de "Trabalhar em equipa"
 * ------------------------------------------------
 * Proxy seguro entre o browser e a API do GitHub.
 * O token do GitHub vive só aqui (secret), nunca no frontend.
 *
 * Variáveis de ambiente necessárias (wrangler.toml / dashboard):
 *   GITHUB_OWNER   = "jdsm3011-alt"        (vars, texto normal)
 *   GITHUB_REPO    = "site_ofc"            (vars, texto normal)
 *   GITHUB_BRANCH  = "main"                (vars, texto normal)
 *   GITHUB_TOKEN   = ghp_xxxxxxxx          (secret! wrangler secret put GITHUB_TOKEN)
 *   PASSWORD_SALT  = uma-string-aleatoria  (secret! wrangler secret put PASSWORD_SALT)
 *
 * Limite de tamanho por projeto: 200 MB
 * Tamanho alvo por chunk: ~3 MB (decodificado)
 */

const MAX_PROJECT_BYTES = 200 * 1024 * 1024; // 200 MB
const CHUNK_TARGET_BYTES = 3 * 1024 * 1024;  // 3 MB (só para referência/validação)

// ---------- helpers ----------

function cors(resp, origin) {
  const headers = new Headers(resp.headers);
  headers.set("Access-Control-Allow-Origin", origin || "*");
  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, X-Project-Password");
  return new Response(resp.body, { status: resp.status, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function slugify(name) {
  return name
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // remove acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}

// ---------- GitHub Contents API ----------

class GitHub {
  constructor(env) {
    this.owner = env.GITHUB_OWNER;
    this.repo = env.GITHUB_REPO;
    this.branch = env.GITHUB_BRANCH || "main";
    this.token = env.GITHUB_TOKEN;
  }

  async #req(path, init = {}) {
    const url = `https://api.github.com/repos/${this.owner}/${this.repo}/contents/${path}`;
    const resp = await fetch(url, {
      ...init,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "datagis-pt-worker",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.headers || {}),
      },
    });
    return resp;
  }

  // devolve {content, sha} ou null se não existir
  async getFile(path) {
    const resp = await this.#req(`${path}?ref=${this.branch}`);
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GitHub GET falhou (${resp.status}): ${await resp.text()}`);
    const data = await resp.json();
    return { content: atob(data.content.replace(/\n/g, "")), sha: data.sha };
  }

  // cria ou atualiza um ficheiro
  async putFile(path, contentStr, message, sha = undefined) {
    const body = {
      message,
      content: btoa(unescape(encodeURIComponent(contentStr))),
      branch: this.branch,
    };
    if (sha) body.sha = sha;
    const resp = await this.#req(path, { method: "PUT", body: JSON.stringify(body) });
    if (!resp.ok) throw new Error(`GitHub PUT falhou (${resp.status}): ${await resp.text()}`);
    return resp.json();
  }
}

// ---------- handlers ----------

async function handleCreate(req, env) {
  const { name, password } = await req.json();
  if (!name || !password) return json({ error: "nome e password são obrigatórios" }, 400);

  const slug = slugify(name);
  if (!slug) return json({ error: "nome inválido" }, 400);

  const gh = new GitHub(env);
  const existing = await gh.getFile(`user_data/${slug}/project.json`);
  if (existing) return json({ error: "já existe um projeto com esse nome" }, 409);

  const pwHash = await hashPassword(password, env.PASSWORD_SALT);

  const project = {
    name,
    slug,
    password_hash: pwHash,
    created_at: new Date().toISOString(),
    total_bytes: 0,
    chunk_count: 0,
    status: "in_progress",
  };
  const manifest = { slug, chunks: [], total_bytes: 0, complete: false };

  await gh.putFile(`user_data/${slug}/project.json`, JSON.stringify(project, null, 2), `chore: cria projeto ${slug}`);
  await gh.putFile(`user_data/${slug}/manifest.json`, JSON.stringify(manifest, null, 2), `chore: manifest inicial ${slug}`);

  return json({ ok: true, slug });
}

async function loadProject(gh, slug) {
  const file = await gh.getFile(`user_data/${slug}/project.json`);
  if (!file) return null;
  return { data: JSON.parse(file.content), sha: file.sha };
}

async function checkPassword(env, project, password) {
  const pwHash = await hashPassword(password, env.PASSWORD_SALT);
  return pwHash === project.password_hash;
}

async function handleChunkUpload(req, env, slug) {
  const { index, data, password } = await req.json();
  if (index === undefined || !data || !password) {
    return json({ error: "index, data e password são obrigatórios" }, 400);
  }

  const gh = new GitHub(env);
  const proj = await loadProject(gh, slug);
  if (!proj) return json({ error: "projeto não encontrado" }, 404);
  if (!(await checkPassword(env, proj.data, password))) return json({ error: "password incorreta" }, 401);

  const chunkBytes = new TextEncoder().encode(data).length;
  if (proj.data.total_bytes + chunkBytes > MAX_PROJECT_BYTES) {
    return json({ error: `limite de ${MAX_PROJECT_BYTES / 1024 / 1024}MB excedido` }, 413);
  }

  const chunkName = `chunk_${String(index).padStart(4, "0")}.json`;
  await gh.putFile(`user_data/${slug}/chunks/${chunkName}`, data, `data: chunk ${index} — ${slug}`);

  // atualiza manifest
  const manifestFile = await gh.getFile(`user_data/${slug}/manifest.json`);
  const manifest = JSON.parse(manifestFile.content);
  const already = manifest.chunks.find((c) => c.index === index);
  if (already) {
    manifest.total_bytes += chunkBytes - already.bytes;
    already.bytes = chunkBytes;
  } else {
    manifest.chunks.push({ index, name: chunkName, bytes: chunkBytes });
    manifest.total_bytes += chunkBytes;
  }
  manifest.chunks.sort((a, b) => a.index - b.index);
  await gh.putFile(`user_data/${slug}/manifest.json`, JSON.stringify(manifest, null, 2), `chore: atualiza manifest ${slug}`, manifestFile.sha);

  // atualiza project.json (total_bytes, chunk_count)
  proj.data.total_bytes = manifest.total_bytes;
  proj.data.chunk_count = manifest.chunks.length;
  await gh.putFile(`user_data/${slug}/project.json`, JSON.stringify(proj.data, null, 2), `chore: atualiza contadores ${slug}`, proj.sha);

  return json({ ok: true, total_bytes: manifest.total_bytes, chunk_count: manifest.chunks.length });
}

async function handleFinalize(req, env, slug) {
  const { password } = await req.json();
  const gh = new GitHub(env);
  const proj = await loadProject(gh, slug);
  if (!proj) return json({ error: "projeto não encontrado" }, 404);
  if (!(await checkPassword(env, proj.data, password))) return json({ error: "password incorreta" }, 401);

  const manifestFile = await gh.getFile(`user_data/${slug}/manifest.json`);
  const manifest = JSON.parse(manifestFile.content);
  manifest.complete = true;
  await gh.putFile(`user_data/${slug}/manifest.json`, JSON.stringify(manifest, null, 2), `chore: finaliza ${slug}`, manifestFile.sha);

  proj.data.status = "complete";
  await gh.putFile(`user_data/${slug}/project.json`, JSON.stringify(proj.data, null, 2), `chore: marca completo ${slug}`, proj.sha);

  return json({ ok: true });
}

async function handleResume(req, env) {
  const { name, password } = await req.json();
  const slug = slugify(name);
  const gh = new GitHub(env);
  const proj = await loadProject(gh, slug);
  if (!proj) return json({ error: "projeto não encontrado" }, 404);
  if (!(await checkPassword(env, proj.data, password))) return json({ error: "password incorreta" }, 401);

  const manifestFile = await gh.getFile(`user_data/${slug}/manifest.json`);
  const manifest = JSON.parse(manifestFile.content);

  return json({ ok: true, slug, project: { name: proj.data.name, total_bytes: proj.data.total_bytes }, manifest });
}

async function handleChunkDownload(req, env, slug, index) {
  const password = req.headers.get("X-Project-Password");
  if (!password) return json({ error: "password em falta" }, 401);

  const gh = new GitHub(env);
  const proj = await loadProject(gh, slug);
  if (!proj) return json({ error: "projeto não encontrado" }, 404);
  if (!(await checkPassword(env, proj.data, password))) return json({ error: "password incorreta" }, 401);

  const chunkName = `chunk_${String(index).padStart(4, "0")}.json`;
  const chunkFile = await gh.getFile(`user_data/${slug}/chunks/${chunkName}`);
  if (!chunkFile) return json({ error: "chunk não encontrado" }, 404);

  return json({ ok: true, data: chunkFile.content });
}

async function handleDownloadProxy(req, env) {
  const reqUrl = new URL(req.url);
  const target = reqUrl.searchParams.get("url");
  if (!target) return json({ error: "parâmetro 'url' em falta" }, 400);

  // só deixa fazer proxy a GitHub Releases do próprio repositório (evita open proxy / SSRF)
  const allowedPrefix = `https://github.com/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/download/`;
  if (!target.startsWith(allowedPrefix)) {
    return json({ error: "url não permitido" }, 403);
  }

  let upstream;
  try {
    upstream = await fetch(target, { redirect: "follow" });
  } catch (err) {
    return json({ error: `falha ao contactar o GitHub Releases: ${err.message}` }, 502);
  }
  if (!upstream.ok) {
    return json({ error: `GitHub Releases devolveu ${upstream.status}` }, upstream.status);
  }

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/octet-stream");
  const len = upstream.headers.get("Content-Length");
  if (len) headers.set("Content-Length", len);
  return new Response(upstream.body, { status: 200, headers });
}

/* Proxy dedicado ao WMS de ortofotos da DGT, usado pela autogeoreferenciação
 * (12-autogeoref.js / runAutoGeorefDetection) para obter o tile de referência.
 * Existe separado de handleDownloadProxy porque:
 *   - o browser não consegue fazer fetch() direto ao servidor da DGT (sem
 *     cabeçalhos CORS na resposta);
 *   - handleDownloadProxy está (corretamente) restrito só a GitHub Releases,
 *     por isso nunca serviria para isto;
 *   - proxies públicos gratuitos (allorigins.win, corsproxy.io,
 *     thingproxy.freeboard.io) mostraram-se todos indisponíveis/pouco fiáveis
 *     na prática — não vale a pena depender deles.
 * Restrito só a pedidos GetMap ao domínio/serviço da DGT, para não se tornar
 * um proxy aberto. */
async function handleDgtTileProxy(req, env) {
  const reqUrl = new URL(req.url);
  const target = reqUrl.searchParams.get("url");
  if (!target) return json({ error: "parâmetro 'url' em falta" }, 400);

  const allowedPrefix = "https://cartografia.dgterritorio.gov.pt/wms/";
  let parsedTarget;
  try {
    parsedTarget = new URL(target);
  } catch (err) {
    return json({ error: "url inválido" }, 400);
  }
  const request = (parsedTarget.searchParams.get("request") || "").toUpperCase();
  const service = (parsedTarget.searchParams.get("service") || "").toUpperCase();
  if (!target.startsWith(allowedPrefix) || service !== "WMS" || request !== "GETMAP") {
    return json({ error: "url não permitido" }, 403);
  }

  let upstream;
  try {
    upstream = await fetch(target, { redirect: "follow" });
  } catch (err) {
    return json({ error: `falha ao contactar a DGT: ${err.message}` }, 502);
  }
  if (!upstream.ok) {
    return json({ error: `DGT devolveu ${upstream.status}` }, upstream.status);
  }

  const headers = new Headers();
  headers.set("Content-Type", upstream.headers.get("Content-Type") || "image/jpeg");
  const len = upstream.headers.get("Content-Length");
  if (len) headers.set("Content-Length", len);
  return new Response(upstream.body, { status: 200, headers });
}

// ---------- router ----------

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "*";
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }), origin);

    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["api","projects", ...]

    try {
      // GET /api/download?url=<GitHub Release asset> — proxy sem CORS -> com CORS
      if (parts[0] === "api" && parts[1] === "download" && parts.length === 2 && req.method === "GET") {
        return cors(await handleDownloadProxy(req, env), origin);
      }

      // GET /api/dgt-tile?url=<WMS GetMap da DGT ortos> — proxy sem CORS -> com CORS
      if (parts[0] === "api" && parts[1] === "dgt-tile" && parts.length === 2 && req.method === "GET") {
        return cors(await handleDgtTileProxy(req, env), origin);
      }

      if (parts[0] !== "api" || parts[1] !== "projects") {
        return cors(json({ error: "not found" }, 404), origin);
      }

      // POST /api/projects/create
      if (parts.length === 3 && parts[2] === "create" && req.method === "POST") {
        return cors(await handleCreate(req, env), origin);
      }

      // POST /api/projects/resume
      if (parts.length === 3 && parts[2] === "resume" && req.method === "POST") {
        return cors(await handleResume(req, env), origin);
      }

      // POST /api/projects/:slug/chunk
      if (parts.length === 4 && parts[3] === "chunk" && req.method === "POST") {
        return cors(await handleChunkUpload(req, env, parts[2]), origin);
      }

      // POST /api/projects/:slug/finalize
      if (parts.length === 4 && parts[3] === "finalize" && req.method === "POST") {
        return cors(await handleFinalize(req, env, parts[2]), origin);
      }

      // GET /api/projects/:slug/chunk/:index
      if (parts.length === 5 && parts[3] === "chunk" && req.method === "GET") {
        return cors(await handleChunkDownload(req, env, parts[2], Number(parts[4])), origin);
      }

      return cors(json({ error: "rota desconhecida" }, 404), origin);
    } catch (err) {
      return cors(json({ error: err.message || "erro interno" }, 500), origin);
    }
  },
};
