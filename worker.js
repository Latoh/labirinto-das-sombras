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

const CURIOSITIES_KEY = "_curiosities.json";
const WIKI_UA = "labirinto-das-sombras-curiosidades/1.0 (site pessoal; contato: mosquito38@gmail.com)";

async function readCuriosities(env) {
  const obj = await env.SONGS_BUCKET.get(CURIOSITIES_KEY);
  if (!obj) return { topics: [] };
  try {
    return await obj.json();
  } catch (e) {
    return { topics: [] };
  }
}

async function writeCuriosities(env, data) {
  await env.SONGS_BUCKET.put(CURIOSITIES_KEY, JSON.stringify(data), {
    httpMetadata: { contentType: "application/json" }
  });
}

async function fetchWikiSummary(topic) {
  const title = topic.trim().replace(/\s+/g, "_");
  const res = await fetch(
    "https://pt.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title),
    { headers: { "User-Agent": WIKI_UA, "accept": "application/json" } }
  );
  if (!res.ok) throw new Error("wiki-not-found");
  const data = await res.json();
  if (data.type === "disambiguation") throw new Error("wiki-ambiguous");
  return {
    title: data.title,
    extract: data.extract || "",
    thumbnail: data.thumbnail ? data.thumbnail.source : null,
    original: data.originalimage ? data.originalimage.source : null,
    wikiUrl: data.content_urls && data.content_urls.desktop ? data.content_urls.desktop.page : null
  };
}

async function fetchExtraImages(title, limit) {
  try {
    const listRes = await fetch(
      "https://pt.wikipedia.org/w/api.php?action=query&titles=" + encodeURIComponent(title) +
      "&prop=images&imlimit=40&format=json&origin=*",
      { headers: { "User-Agent": WIKI_UA } }
    );
    if (!listRes.ok) return [];
    const listData = await listRes.json();
    const pages = listData.query && listData.query.pages ? Object.values(listData.query.pages) : [];
    let files = [];
    pages.forEach(function (p) { if (p.images) files = files.concat(p.images.map(function (i) { return i.title; })); });
    files = files.filter(function (f) {
      var lower = f.toLowerCase();
      return /\.(jpe?g|png)$/.test(lower) &&
        lower.indexOf("logo") === -1 && lower.indexOf("icon") === -1 &&
        lower.indexOf("edit") === -1 && lower.indexOf("disambig") === -1 &&
        lower.indexOf("question") === -1 && lower.indexOf("commons") === -1;
    }).slice(0, (limit || 3) + 1);
    if (files.length === 0) return [];

    const infoRes = await fetch(
      "https://pt.wikipedia.org/w/api.php?action=query&titles=" + encodeURIComponent(files.join("|")) +
      "&prop=imageinfo&iiprop=url&iiurlwidth=500&format=json&origin=*",
      { headers: { "User-Agent": WIKI_UA } }
    );
    if (!infoRes.ok) return [];
    const infoData = await infoRes.json();
    const infoPages = infoData.query && infoData.query.pages ? Object.values(infoData.query.pages) : [];
    return infoPages
      .map(function (p) { return p.imageinfo && p.imageinfo[0] ? (p.imageinfo[0].thumburl || p.imageinfo[0].url) : null; })
      .filter(Boolean)
      .slice(0, limit || 3);
  } catch (e) {
    return [];
  }
}

async function fetchFullExtract(title) {
  try {
    const res = await fetch(
      "https://pt.wikipedia.org/w/api.php?action=query&titles=" + encodeURIComponent(title) +
      "&prop=extracts&explaintext=1&format=json&origin=*",
      { headers: { "User-Agent": WIKI_UA } }
    );
    if (!res.ok) return "";
    const data = await res.json();
    const pages = data.query && data.query.pages ? Object.values(data.query.pages) : [];
    return pages[0] && pages[0].extract ? pages[0].extract : "";
  } catch (e) {
    return "";
  }
}

async function generateKidText(env, topic, extract) {
  const prompt = [
    "Voce e um contador de historias que explica coisas pra uma crianca de 7 anos, em portugues do Brasil.",
    "Regras: frases curtas e simples, nada de palavras dificeis, use comparacoes divertidas do dia a dia",
    "(tamanhos, animais, coisas conhecidas), tom animado e curioso, baseie-se SOMENTE no texto fornecido,",
    "nao invente fatos. Escreva de 4 a 6 frases curtas. Nao use titulos nem listas, so o texto corrido.",
    "",
    "Assunto: " + topic,
    "Texto da Wikipedia: " + extract.slice(0, 1800),
    "",
    "Explicacao divertida pra crianca de 7 anos:"
  ].join("\n");

  const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 400
  });
  return (result && result.response ? result.response : "").trim();
}

async function generateDetailedKidText(env, topic, fullExtract) {
  const prompt = [
    "Voce e um professor super divertido que adora explicar coisas pra uma crianca de 7 anos, em portugues do Brasil.",
    "Regras: frases curtas e simples, vocabulario facil, tom animado e cheio de comparacoes com coisas que",
    "uma crianca conhece (bichos, brinquedos, tamanhos do dia a dia). Baseie-se SOMENTE no texto fornecido,",
    "nao invente fatos que nao estao nele. Organize em 3 partes curtas, cada uma com um titulo BEM simples",
    "(2 a 4 palavras, sem dois-pontos) seguido de 2 a 3 frases. A ultima parte deve ser uma curiosidade",
    "surpreendente ou engracada. Formate assim, exatamente:",
    "TITULO 1",
    "texto da parte 1",
    "TITULO 2",
    "texto da parte 2",
    "TITULO 3",
    "texto da parte 3",
    "",
    "Assunto: " + topic,
    "Texto da Wikipedia: " + fullExtract.slice(0, 4000),
    "",
    "Explicacao completa e divertida pra crianca de 7 anos:"
  ].join("\n");

  const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 900
  });
  const raw = (result && result.response ? result.response : "").trim();

  var lines = raw.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
  var sections = [];
  var current = null;
  lines.forEach(function (line) {
    var isHeading = line.length < 40 && !/[.!?]$/.test(line);
    if (isHeading) {
      current = { heading: line.replace(/^[#\-*\d.]+\s*/, ""), body: "" };
      sections.push(current);
    } else if (current) {
      current.body += (current.body ? " " : "") + line;
    } else {
      current = { heading: "", body: line };
      sections.push(current);
    }
  });
  return sections.filter(function (s) { return s.body; });
}

async function listCuriosities(env) {
  const data = await readCuriosities(env);
  return json({ topics: data.topics });
}

async function addCuriosity(request, env) {
  if (!checkAuth(request, env)) return unauthorized();
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Envio inválido." }, 400);
  }
  const topic = (body.topic || "").toString().trim().slice(0, 100);
  if (!topic) return json({ error: "Escreva um tema." }, 400);

  let summary;
  try {
    summary = await fetchWikiSummary(topic);
  } catch (e) {
    return json({ error: "Não achei esse assunto na Wikipédia. Tente outro nome." }, 404);
  }
  if (!summary.extract) {
    return json({ error: "Esse assunto não tem texto suficiente na Wikipédia." }, 404);
  }

  let funText;
  try {
    funText = await generateKidText(env, topic, summary.extract);
  } catch (e) {
    return json({ error: "Não consegui transformar esse texto agora. Tente de novo." }, 500);
  }
  if (!funText) {
    return json({ error: "Não consegui transformar esse texto agora. Tente de novo." }, 500);
  }

  const fullExtract = await fetchFullExtract(summary.title) || summary.extract;
  let detailSections = [];
  try {
    detailSections = await generateDetailedKidText(env, topic, fullExtract);
  } catch (e) {
    detailSections = [];
  }

  const images = [];
  if (summary.original) images.push(summary.original);
  else if (summary.thumbnail) images.push(summary.thumbnail);
  const extra = await fetchExtraImages(summary.title, 6);
  extra.forEach(function (u) { if (images.indexOf(u) === -1) images.push(u); });

  const data = await readCuriosities(env);
  const entry = {
    id: crypto.randomUUID(),
    topic: summary.title || topic,
    funText: funText,
    detailSections: detailSections,
    images: images.slice(0, 7),
    wikiUrl: summary.wikiUrl,
    addedAt: Date.now()
  };
  data.topics.push(entry);
  await writeCuriosities(env, data);
  return json(entry);
}

async function deleteCuriosity(request, env, id) {
  if (!checkAuth(request, env)) return unauthorized();
  const data = await readCuriosities(env);
  const before = data.topics.length;
  data.topics = data.topics.filter(function (t) { return t.id !== id; });
  if (data.topics.length === before) return json({ error: "Tema não encontrado." }, 404);
  await writeCuriosities(env, data);
  return json({ ok: true });
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

    if (url.pathname === "/api/curiosities" && request.method === "GET") {
      return listCuriosities(env);
    }
    if (url.pathname === "/api/curiosities" && request.method === "POST") {
      return addCuriosity(request, env);
    }
    const cm = url.pathname.match(/^\/api\/curiosities\/([a-zA-Z0-9-]+)$/);
    if (cm && request.method === "DELETE") {
      return deleteCuriosity(request, env, cm[1]);
    }

    return env.ASSETS.fetch(request);
  }
};
