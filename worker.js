const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
const INDEX_KEY = "_index.json";
const ALLOWED_TYPES = ["audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg", "audio/mp4", "audio/aac", "audio/flac", "audio/webm"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type"
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, CORS_HEADERS)
  });
}

function unauthorized() {
  return new Response(JSON.stringify({ error: "Usuário ou senha inválidos." }), {
    status: 401,
    headers: Object.assign({
      "content-type": "application/json; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="Ritmo dos Blocos"'
    }, CORS_HEADERS)
  });
}

function checkAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch (e) {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return user === env.UPLOAD_USER && pass === env.UPLOAD_PASS;
}

async function readIndex(env) {
  const obj = await env.SONGS_BUCKET.get(INDEX_KEY);
  if (!obj) return { totalBytes: 0, songs: [] };
  try {
    return await obj.json();
  } catch (e) {
    return { totalBytes: 0, songs: [] };
  }
}

async function writeIndex(env, index) {
  await env.SONGS_BUCKET.put(INDEX_KEY, JSON.stringify(index), {
    httpMetadata: { contentType: "application/json" }
  });
}

async function listSongs(env) {
  const index = await readIndex(env);
  return json({
    totalBytes: index.totalBytes,
    maxBytes: MAX_TOTAL_BYTES,
    songs: index.songs.map(function (s) {
      return { id: s.id, name: s.name, size: s.size, uploadedAt: s.uploadedAt };
    })
  });
}

async function uploadSong(request, env) {
  if (!checkAuth(request, env)) return unauthorized();

  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: "Não consegui ler o envio." }, 400);
  }
  const file = form.get("file");
  const name = (form.get("name") || (file && file.name) || "musica").toString().slice(0, 120);
  if (!file || typeof file === "string") return json({ error: "Nenhum arquivo enviado." }, 400);

  const contentType = file.type || "application/octet-stream";
  if (ALLOWED_TYPES.indexOf(contentType) === -1 && !/\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(name)) {
    return json({ error: "Formato de áudio não reconhecido." }, 400);
  }

  const size = file.size;
  const index = await readIndex(env);
  if (index.totalBytes + size > MAX_TOTAL_BYTES) {
    return json({
      error: "Isso passaria do limite de 2GB de músicas salvas (" +
        Math.round((MAX_TOTAL_BYTES - index.totalBytes) / (1024 * 1024)) + "MB livres)."
    }, 413);
  }

  const id = crypto.randomUUID();
  const bytes = await file.arrayBuffer();
  await env.SONGS_BUCKET.put(id, bytes, { httpMetadata: { contentType: contentType } });

  index.songs.push({ id: id, name: name, size: size, contentType: contentType, uploadedAt: Date.now() });
  index.totalBytes += size;
  await writeIndex(env, index);

  return json({ id: id, name: name, size: size, totalBytes: index.totalBytes, maxBytes: MAX_TOTAL_BYTES });
}

async function getSong(env, id) {
  const obj = await env.SONGS_BUCKET.get(id);
  if (!obj) return json({ error: "Música não encontrada." }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(obj.body, { headers: headers });
}

async function deleteSong(request, env, id) {
  if (!checkAuth(request, env)) return unauthorized();
  const index = await readIndex(env);
  const entry = index.songs.find(function (s) { return s.id === id; });
  if (!entry) return json({ error: "Música não encontrada." }, 404);
  await env.SONGS_BUCKET.delete(id);
  index.songs = index.songs.filter(function (s) { return s.id !== id; });
  index.totalBytes = Math.max(0, index.totalBytes - entry.size);
  await writeIndex(env, index);
  return json({ ok: true, totalBytes: index.totalBytes });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/") && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/songs" && request.method === "GET") {
      return listSongs(env);
    }
    if (url.pathname === "/api/songs" && request.method === "POST") {
      return uploadSong(request, env);
    }
    const m = url.pathname.match(/^\/api\/songs\/([a-zA-Z0-9-]+)$/);
    if (m && request.method === "GET") {
      return getSong(env, m[1]);
    }
    if (m && request.method === "DELETE") {
      return deleteSong(request, env, m[1]);
    }

    return env.ASSETS.fetch(request);
  }
};
