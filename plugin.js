// DoramaX - catálogo de K-dramas en español (TuDorama, DoramasYT y DoramasLat).
// Reproduce desde los servidores del sitio (directos o con el navegador oculto).

const TD = "https://tudorama.com";
const DY = "https://www.doramasyt.com";
const DL = "https://doramaslat.com";
const HOME_ROW = 20;
const MAX_RESULTS = 100;

function log(...args) {
  try { kino.log(...args); } catch { /* el registro no debe romper nada */ }
}

// Textos que lee la persona: español por defecto, inglés si kino.lang es "en-US".
function tr(es, en) {
  return (typeof kino !== "undefined" && kino.lang === "en-US") ? en : es;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripTags(s) {
  return decodeEntities(String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));
}

async function getHtml(url) {
  let r;
  try {
    r = await kino.fetch(url);
  } catch (e) {
    log("fetch falló: " + String((e && e.message) || e).slice(0, 80));
    throw kino.error("unavailable", "fetch falló", {
      userMessage: tr("No se pudo abrir el sitio. Prueba de nuevo en un momento.", "Could not open the site. Try again in a moment."),
    });
  }
  log("fetch status=" + r.status);
  if (!r.ok) {
    const um = { userMessage: tr("El sitio respondió con el error " + r.status + ".", "The site answered with error " + r.status + ".") };
    if (r.status === 404) throw kino.error("not_found", "el sitio respondió 404", um);
    if (r.status === 429) throw kino.error("rate_limited", "el sitio respondió 429", um);
    throw kino.error("unavailable", "el sitio respondió " + r.status, um);
  }
  return r.text();
}

// Lee tarjetas de un trozo de HTML: enlaces /serie/<slug>/ o /pelicula/<slug>/.
// OJO: el HTML real del sitio no se ha comprobado; hay que probarlo con node sdk/run.mjs.
function cards(html) {
  const byUrl = new Map(); // url -> { kind, slug, title, alt, poster }
  const re = /<a[^>]+href=["'](https:\/\/tudorama\.com\/(serie|pelicula)\/([a-z0-9-]+)\/)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const e = byUrl.get(m[1]) || { kind: m[2], slug: m[3], title: "", alt: "", poster: undefined };
    const text = stripTags(m[4]);
    if (text && !e.title) e.title = text;
    const img = /<img[^>]*(?:data-src|src)=["']([^"']+)["'][^>]*>/i.exec(m[4]);
    if (img) {
      if (!e.poster) e.poster = img[1];
      const alt = /alt=["']([^"']+)["']/i.exec(img[0]);
      if (alt && !e.alt) e.alt = decodeEntities(alt[1]);
    }
    if (!e.poster) {
      // la imagen suele estar en el mismo bloque <article>/<li> que el enlace
      const back = html.lastIndexOf("<article", m.index);
      const block = back >= 0 && m.index - back < 4000 ? html.slice(back, m.index + m[0].length + 1500) : "";
      const bi = /<img[^>]*(?:data-src|src)=["']([^"']+)["']/i.exec(block);
      if (bi) e.poster = bi[1];
    }
    byUrl.set(m[1], e);
  }
  const items = [];
  for (const [url, e] of byUrl) {
    const title = e.title || e.alt;
    if (!title) continue;
    items.push({
      id: "td-" + e.kind + "-" + e.slug.slice(0, 80),
      ref: "td|" + url,
      title: title.slice(0, 200),
      kind: e.kind === "pelicula" ? "movie" : "series",
      genres: e.kind === "pelicula" ? ["peliculas", "drama"] : ["series", "drama"],
      poster: e.poster,
    });
  }
  return items;
}

// Secciones del sitio; "ref" de una fila o mosaico = la clave de aquí.
// Cada sección junta varias fuentes: una sola fila/catálogo por nombre, sin repetir títulos.
// site: "td" = TuDorama, "dy" = DoramasYT, "dl" = DoramasLat.
const SECTIONS = {
  latino: { genre: "series", parts: [
    { site: "td", path: "/genero/espanol-latino/" },
    { site: "dy", path: "/buscar?q=latino" },   // sus series en latino llevan "latino" en el nombre
    { site: "dl", path: "/tvshows/" },            // todo DoramasLat es en latino
  ] },
  emision: { genre: "series", parts: [
    { site: "td", path: "/genero/emision/" },
    { site: "dy", path: "/emision" },
  ] },
  kdramas: { genre: "series", parts: [
    { site: "td", path: "/genero/series/" },
  ] },
  peliculas: { genre: "peliculas", parts: [
    { site: "td", path: "/genero/peliculas/" },
    { site: "dl", path: "/movies/" },
  ] },
};
const CAT_VIEW = 60;  // títulos por tanda de "Ver más"
const CAT_MAX = 100;  // tope de Kino por página

// ---- DoramasYT: tarjetas ---------------------------------------------------------------------

// Cada ficha: <a href=".../dorama/<slug>"> ... <img data-src="..."> ... <h3 class="title_cap">Título</h3></a>
function dyCards(html) {
  const byUrl = new Map();
  const re = /<a[^>]+href=["'](https:\/\/www\.doramasyt\.com\/(dorama|pelicula)\/([a-z0-9-]+))["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const e = byUrl.get(m[1]) || { kind: m[2], slug: m[3], title: "", alt: "", poster: undefined };
    const h3 = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(m[4]);
    const text = h3 ? stripTags(h3[1]) : "";
    if (text && !e.title) e.title = text;
    const img = /<img[^>]*>/i.exec(m[4]);
    if (img) {
      const ds = /data-src=["']([^"']+)["']/i.exec(img[0]);
      const sr = /\ssrc=["']([^"']+)["']/i.exec(img[0]);
      if (!e.poster) e.poster = ds ? ds[1] : (sr && !/\/img\//.test(sr[1]) ? sr[1] : undefined);
      const alt = /alt=["']([^"']+)["']/i.exec(img[0]);
      if (alt && !e.alt) e.alt = decodeEntities(alt[1]).replace(/^Ver\s+/i, "").replace(/\s+online.*$/i, "");
    }
    byUrl.set(m[1], e);
  }
  const items = [];
  for (const [url, e] of byUrl) {
    const title = e.title || e.alt;
    if (!title) continue;
    items.push({
      id: "dy-" + e.slug.slice(0, 80),
      ref: "dy|" + url,
      title: title.slice(0, 200),
      kind: e.kind === "pelicula" ? "movie" : "series",
      genres: e.kind === "pelicula" ? ["peliculas", "drama"] : ["series", "drama"],
      poster: e.poster,
    });
  }
  return items;
}

// ---- DoramasLat (Dooplay): tarjetas ---------------------------------------------------------

// Listas: <article class="item tvshows"> con <div class="poster"><img> y <h3><a href=".../tvshows/<slug>/">.
// Búsqueda: <article> dentro de .result-item con <div class="title"><a>. Se leen los dos igual, bloque a bloque.
function dlCards(html) {
  const items = [];
  const seen = new Set();
  const parts = html.split(/<article/i).slice(1);
  for (const raw of parts) {
    const block = raw.split(/<\/article>/i)[0];
    const a = /<a[^>]+href=["'](https:\/\/doramaslat\.com\/(tvshows|movies)\/([a-z0-9-]+)\/)["']/i.exec(block);
    if (!a || seen.has(a[1])) continue;
    const h = /<(?:h[1-6]|div)[^>]*(?:class=["'][^"']*title[^"']*["'])?[^>]*>\s*<a[^>]+href=["']https:\/\/doramaslat\.com\/(?:tvshows|movies)\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
    const img = /<img[^>]*>/i.exec(block);
    let title = h ? stripTags(h[1]) : "";
    let poster;
    if (img) {
      const ds = /data-(?:lazy-)?src=["']([^"']+)["']/i.exec(img[0]);
      const sr = /\ssrc=["']([^"']+)["']/i.exec(img[0]);
      poster = ds ? ds[1] : (sr ? sr[1] : undefined);
      if (!title) { const al = /alt=["']([^"']+)["']/i.exec(img[0]); if (al) title = decodeEntities(al[1]); }
    }
    title = title.replace(/\s*[–-]\s*Doramas\s+Latino\s*$/i, "").trim();
    if (!title) continue;
    seen.add(a[1]);
    items.push({
      id: "dl-" + a[3].slice(0, 80),
      ref: "dl|" + a[1],
      title: title.slice(0, 200),
      kind: a[2] === "movies" ? "movie" : "series",
      genres: a[2] === "movies" ? ["peliculas", "drama"] : ["series", "drama"],
      poster,
    });
  }
  return items;
}

export async function home() {
  await null; // por si algo de abajo lanza: nunca antes del primer await
  const defs = [
    { id: "row-latino", ref: "latino", title: tr("En Latino", "In Latin Spanish") },
    { id: "row-emision", ref: "emision", title: tr("En emisión", "Airing") },
    { id: "row-kdramas", ref: "kdramas", title: tr("K-Dramas", "K-Dramas") },
    { id: "row-peliculas", ref: "peliculas", title: tr("Películas", "Movies") },
  ];
  const res = await Promise.allSettled(defs.map((d) => sectionPage(d.ref, 1)));
  const rows = [];
  res.forEach((r, i) => {
    if (r.status !== "fulfilled") { log("home: falló " + defs[i].id); return; }
    const items = r.value.items.slice(0, HOME_ROW);
    if (items.length) rows.push({ id: defs[i].id, title: defs[i].title, genre: SECTIONS[defs[i].ref].genre, ref: defs[i].ref, items });
  });
  log("home filas=" + rows.length);
  if (!rows.length) throw kino.error("unavailable", "inicio sin resultados");
  return rows;
}

// Una página de una sección: /genero/<x>/ (+ page/N/).
// Una página de una fuente concreta.
async function partPage(part, n) {
  if (part.site === "dy") {
    const sep = part.path.indexOf("?") >= 0 ? "&" : "?";
    const html = await getHtml(DY + part.path + (n > 1 ? sep + "page=" + n : ""));
    return { items: dyCards(html), hasNext: html.indexOf("page=" + (n + 1)) !== -1 };
  }
  if (part.site === "dl") {
    const html = await getHtml(DL + part.path + (n > 1 ? "page/" + n + "/" : ""));
    return { items: dlCards(html), hasNext: html.indexOf("/page/" + (n + 1) + "/") !== -1 };
  }
  const html = await getHtml(TD + part.path + (n > 1 ? "page/" + n + "/" : ""));
  return { items: cards(html), hasNext: html.indexOf("/page/" + (n + 1) + "/") !== -1 };
}

// Para detectar el mismo título en fuentes distintas: sin acentos, sin "latino", solo letras y números.
function normTitle(t) {
  return String(t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\blatino\b/g, "").replace(/[^a-z0-9]+/g, "");
}

// Una página de una sección: pide todas sus fuentes a la vez, intercala sus títulos (uno de cada una,
// por turnos) y quita los repetidos. Si una fuente falla o ya no tiene esa página, se sigue con las demás.
async function sectionPage(ref, n) {
  const sec = SECTIONS[ref];
  const res = await Promise.allSettled(sec.parts.map((p) => partPage(p, n)));
  const ok = res.filter((r) => r.status === "fulfilled");
  if (!ok.length) throw res[0].reason;
  const lists = ok.map((r) => r.value.items);
  const items = [];
  const seen = new Set();
  const longest = Math.max.apply(null, lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const l of lists) {
      const x = l[i];
      if (!x) continue;
      const k = normTitle(x.title) || x.id;
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(x);
    }
  }
  return { items, hasNext: ok.some((r) => r.value.hasNext) };
}

// "Ver más" y catálogos: el cursor es el número de página; cada tanda junta varias páginas.
export async function browse(ref, cursor) {
  await null;
  const r = String(ref || "");
  if (!SECTIONS[r]) throw kino.error("not_found", "catálogo desconocido");
  const n = Math.max(1, parseInt(cursor, 10) || 1);
  const items = [];
  const seen = new Set();
  let p = n;
  let last = n - 1;
  let hasNext = true;
  let rounds = 0;
  while (hasNext && items.length < CAT_VIEW && rounds < 3) {
    rounds++;
    const batch = await Promise.allSettled([0, 1, 2].map((k) => sectionPage(r, p + k)));
    let stop = false;
    for (let k = 0; k < batch.length; k++) {
      const res = batch[k];
      if (res.status !== "fulfilled") {
        if (last < n) throw res.reason; // ni la primera página cargó: error de verdad
        stop = true;
        break;
      }
      const fresh = res.value.items.filter((x) => !seen.has(x.id));
      if (items.length && items.length + fresh.length > CAT_MAX) { stop = true; break; }
      for (const x of fresh) { seen.add(x.id); items.push(x); }
      last = p + k;
      hasNext = res.value.hasNext;
      if (!hasNext || items.length >= CAT_VIEW) { stop = true; break; }
    }
    if (stop) break;
    p += 3;
  }
  const page = { items: items.slice(0, CAT_MAX) };
  if (hasNext && items.length) page.next = String(last + 1);
  return page;
}

// Mosaicos de la sección Categorías; cada uno abre browse(ref, null).
export async function categories() {
  await null;
  const defs = [
    { id: "latino", title: tr("En Latino", "In Latin Spanish") },
    { id: "emision", title: tr("En emisión", "Airing") },
    { id: "kdramas", title: tr("K-Dramas", "K-Dramas") },
    { id: "peliculas", title: tr("Películas", "Movies") },
  ];
  const first = await Promise.allSettled(defs.map((d) => sectionPage(d.id, 1)));
  return defs.map((d, i) => {
    const r = first[i];
    const art = r.status === "fulfilled" && r.value.items[0] ? r.value.items[0].poster : undefined;
    return art ? { id: d.id, title: d.title, ref: d.id, art } : { id: d.id, title: d.title, ref: d.id };
  });
}

export async function search(query) {
  await null;
  const q = stripTags(query && query.q).slice(0, 100);
  if (!q) return [];
  const enc = encodeURIComponent(q);
  const [a, b, c] = await Promise.allSettled([
    getHtml(TD + "/?s=" + enc).then(cards),
    getHtml(DY + "/buscar?q=" + enc).then(dyCards),
    getHtml(DL + "/?s=" + enc).then(dlCards),
  ]);
  if (a.status === "rejected" && b.status === "rejected" && c.status === "rejected") throw a.reason;
  const out = [];
  const seen = new Set();
  for (const r of [a, b, c]) {
    if (r.status !== "fulfilled") { log("búsqueda: una fuente falló"); continue; }
    for (const x of r.value) if (!seen.has(x.id)) { seen.add(x.id); out.push(x); }
  }
  return out.slice(0, MAX_RESULTS);
}

// ---- Peticiones al servidor de WordPress (admin-ajax) -----------------------------------------

function formBody(obj) {
  return Object.keys(obj).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(obj[k]))).join("&");
}

async function ajax(params, referer) {
  let r;
  try {
    r = await kino.fetch(TD + "/wp-admin/admin-ajax.php", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: referer || TD + "/",
      },
      body: formBody(params),
    });
  } catch (e) {
    log("ajax falló: " + String((e && e.message) || e).slice(0, 80));
    throw kino.error("unavailable", "ajax falló", {
      userMessage: tr("No se pudo hablar con el sitio. Prueba de nuevo en un momento.", "Could not talk to the site. Try again in a moment."),
    });
  }
  log("ajax " + params.action + " status=" + r.status);
  if (!r.ok) throw kino.error(r.status === 429 ? "rate_limited" : "unavailable", "ajax " + r.status);
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (e) {
    log("ajax: respuesta no es JSON, bytes=" + txt.length);
    throw kino.error("unavailable", "ajax sin JSON");
  }
}

function attr(tag, name) {
  const a = new RegExp(name + "=([\"'])([^\"']*)\\1", "i").exec(tag);
  return a ? a[2] : "";
}

// ---- Episodios --------------------------------------------------------------------------------

// ---- DoramasYT: episodios y reproducción ------------------------------------------------------

async function dyEpisodes(url) {
  const html = await getHtml(url);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  const og = /property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html);
  const title = h1 ? stripTags(h1[1]).replace(/^Ver\s+/i, "").replace(/\s+(online|en español).*$/i, "") : url;
  const eps = new Map();
  const re = /href=["'](https:\/\/www\.doramasyt\.com\/ver\/[a-z0-9-]+-episodio-(\d+))["']/gi;
  let m;
  while ((m = re.exec(html))) {
    if (eps.has(m[1])) continue;
    eps.set(m[1], { season: 1, number: Number(m[2]), ref: "dy|" + m[1], title: tr("Episodio ", "Episode ") + m[2] });
  }
  log("dy episodes: " + eps.size);
  if (!eps.size) throw kino.error("not_found", "no se encontró la lista de episodios", {
    userMessage: tr("No se encontró la lista de capítulos de este título.", "No episode list found for this title."),
  });
  const list = Array.from(eps.values()).sort((a, b) => a.number - b.number);
  return { series: { title, poster: og ? og[1] : undefined }, episodes: list };
}

// Orden de preferencia de los servidores de DoramasYT (los que más a menudo entregan el video).
const DY_RANK = ["voe", "streamtape", "mp4upload", "lulu", "savefiles", "mxdrop", "doodstream", "filemoon", "mega"];

async function dyResolve(url) {
  const html = await getHtml(url);
  const btns = [];
  const re = /<button[^>]*data-player=["']([^"']+)["'][^>]*>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(html))) btns.push({ token: m[1], name: stripTags(m[2]).toLowerCase() });
  log("dy resolve: servidores=" + btns.map((b) => b.name).join(","));
  if (!btns.length) throw kino.error("unavailable", "sin servidores", {
    userMessage: tr("Este capítulo no trae servidores disponibles.", "This episode has no servers available."),
  });
  const rank = (b) => { const i = DY_RANK.indexOf(b.name); return i < 0 ? 50 : i; };
  const cands = btns.filter((b) => b.name !== "mega").sort((a, b) => rank(a) - rank(b)).slice(0, 4);
  const lat = /-latino-/i.test(url);
  const label = (b) => (lat ? "Latino" : tr("Subtitulado", "Subbed")) + " · " + b.name;
  // El reproductor de la página es un iframe a /reproductor?video=<código>&player=<nombre>.
  const tasks = cands.map((b) => {
    const pu = DY + "/reproductor?video=" + b.token + "&player=" + encodeURIComponent(b.name) + "&token=";
    return embedFromHtml(pu, 0, url).then((v) => (v ? Object.assign(v, { label: label(b) }) : null));
  });
  const first = await firstSuccess(tasks);
  if (first) return first.v;
  throw kino.error("unavailable", "ningún servidor entregó el video", {
    userMessage: tr(
      "Ningún servidor de este capítulo se pudo abrir desde aquí. Prueba otro capítulo o título.",
      "No server for this episode could be opened from here. Try another episode or title."
    ),
  });
}

// ---- DoramasLat: episodios y reproducción -------------------------------------------------------

async function dlEpisodes(url) {
  const html = await getHtml(url);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  const og = /property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html);
  const title = (h1 ? stripTags(h1[1]) : url).replace(/\s*[–-]\s*Doramas\s+Latino\s*$/i, "");
  const poster = og ? og[1] : undefined;
  if (/\/movies\//.test(url)) {
    return { series: { title, poster }, episodes: [{ season: 1, number: 1, ref: "dl|" + url, title }] };
  }
  const eps = new Map();
  const re = /<li[^>]*>[\s\S]*?<div class=['"]numerando['"]>\s*(\d+)\s*-\s*(\d+)\s*<\/div>[\s\S]*?<a href=['"](https:\/\/doramaslat\.com\/episodes\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (eps.has(m[3])) continue;
    eps.set(m[3], { season: Number(m[1]) || 1, number: Number(m[2]) || eps.size + 1, ref: "dl|" + m[3], title: stripTags(m[4]) || tr("Episodio ", "Episode ") + m[2] });
  }
  log("dl episodes: " + eps.size);
  if (!eps.size) throw kino.error("not_found", "no se encontró la lista de episodios", {
    userMessage: tr("No se encontró la lista de capítulos de este título.", "No episode list found for this title."),
  });
  const list = Array.from(eps.values()).sort((a, b) => (a.season - b.season) || (a.number - b.number));
  return { series: { title, poster }, episodes: list };
}

// Dooplay: cada opción pide /wp-json/dooplayer/v2/<post>/<tipo>/<nume> y recibe { embed_url }.
async function dlResolve(url) {
  const html = await getHtml(url);
  const opts = [];
  const re = /<li[^>]*class=['"][^'"]*dooplay_player_option[^'"]*['"][^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const post = attr(tag, "data-post");
    const type = attr(tag, "data-type") || "tv";
    const nume = attr(tag, "data-nume");
    if (!post || !nume) continue;
    const t = /class=['"]title['"]>([\s\S]*?)<\/span>/i.exec(m[1]);
    const name = t ? stripTags(t[1]) : "";
    const latino = /flags\/mx\.png/i.test(m[1]) || /latino/i.test(name);
    opts.push({ post, type, nume, name, latino });
  }
  log("dl resolve: opciones=" + opts.map((o) => (o.latino ? "lat" : "otro") + ":" + o.nume).join(","));
  if (!opts.length) throw kino.error("unavailable", "sin opciones", {
    userMessage: tr("Este capítulo no trae servidores disponibles.", "This episode has no servers available."),
  });
  opts.sort((a, b) => (b.latino ? 1 : 0) - (a.latino ? 1 : 0));
  const label = (o) => (o.latino ? "Latino" : tr("Subtitulado", "Subbed")) + " · " + (o.name || o.nume);

  const one = async (o) => {
    const r = await kino.fetch(DL + "/wp-json/dooplayer/v2/" + o.post + "/" + o.type + "/" + encodeURIComponent(o.nume), { headers: { Referer: url } });
    log("dl dooplayer " + o.nume + " status=" + r.status);
    if (!r.ok) return null;
    let j;
    try { j = JSON.parse(await r.text()); } catch (e) { return null; }
    let emb = j && (j.embed_url || j.url) ? String(j.embed_url || j.url) : "";
    const fr = /src=["']([^"']+)["']/i.exec(emb);
    if (fr) emb = fr[1];
    emb = absUrl(emb);
    if (!emb) return null;
    log("dl embed: " + hostOf(emb) + pathShape(emb));
    if (/\.(?:m3u8|mp4)(\?|$)/i.test(emb) && !isDemo(emb)) {
      return { url: emb, mime: /\.m3u8/i.test(emb) ? "application/x-mpegurl" : "video/mp4", headers: { Referer: DL + "/" }, label: label(o) };
    }
    const v = await embedFromHtml(emb, 0, url);
    return v ? Object.assign(v, { label: label(o) }) : null;
  };
  const first = await firstSuccess(opts.slice(0, 3).map(one));
  if (first) return first.v;
  throw kino.error("unavailable", "ningún servidor entregó el video", {
    userMessage: tr(
      "Ningún servidor de este capítulo se pudo abrir desde aquí. Prueba otro capítulo o título.",
      "No server for this episode could be opened from here. Try another episode or title."
    ),
  });
}

export async function episodes(ref) {
  await null;
  const raw = String(ref || "");
  if (raw.startsWith("dl|")) return dlEpisodes(raw.slice(3));
  if (raw.startsWith("dy|")) return dyEpisodes(raw.slice(3));
  if (!raw.startsWith("td|")) throw kino.error("not_found", "referencia desconocida");
  const url = raw.slice(3);
  const html = await getHtml(url);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  const og = /property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html);
  const title = h1 ? stripTags(h1[1]) : url;

  // Película: un solo "capítulo" que reproduce la misma página.
  if (/\/pelicula\//.test(url)) {
    return { series: { title, poster: og ? og[1] : undefined }, episodes: [{ season: 1, number: 1, ref: raw, title }] };
  }

  const eps = new Map();
  const addEp = (permalink, season, number, t) => {
    if (!permalink || eps.has(permalink)) return;
    eps.set(permalink, {
      season: Number(season) || 1,
      number: Number(number) || eps.size + 1,
      ref: "td|" + permalink,
      title: t || (tr("Episodio ", "Episode ") + number),
    });
  };
  // 1) Enlaces /ver/<slug>-s1x9/ que ya vienen en la página.
  const re = /href=["'](https:\/\/tudorama\.com\/ver\/[a-z0-9-]+-s(\d+)x(\d+)\/)["']/gi;
  let m;
  while ((m = re.exec(html))) addEp(m[1], m[2], m[3]);

  // 2) El sitio carga el resto por tandas (botón "load-eps" y botones de temporadas).
  const box = /<[^>]*class=["'][^"']*\beps\b[^"']*["'][^>]*>/i.exec(html);
  if (box) {
    const nonce = attr(box[0], "data-nonce");
    const results = attr(box[0], "data-results") || "10";
    const order = attr(box[0], "data-order") || "asc";
    const defSeason = attr(box[0], "data-season-number") || "1";
    const tmdb = attr(box[0], "data-tmdb-id");
    const seasons = [];
    const sre = /<button[^>]*data-season=["'](\d+)["'][^>]*>/gi;
    while ((m = sre.exec(html))) seasons.push({ n: m[1], id: attr(m[0], "data-series-id") || tmdb });
    if (!seasons.length && tmdb) seasons.push({ n: defSeason, id: tmdb });
    log("episodes: temporadas=" + seasons.length + " ya=" + eps.size);
    let calls = 0;
    for (const se of seasons) {
      let page = 0;
      while (calls < 20) {
        const offset = (Number(results) || 10) * page;
        if (page === 0 && eps.size && se.n === defSeason) { page = 1; continue; } // la primera tanda ya vino en la página
        calls++;
        let j;
        try {
          j = await ajax({ action: "corvus_get_episodes", nonce, post_id: se.id, season: se.n, results, offset, order }, url);
        } catch (e) { break; }
        const list = j && j.success && j.data && Array.isArray(j.data.results) ? j.data.results : [];
        for (const e of list) addEp(e.permalink, e.season_number, e.episode_number, e.title ? stripTags(e.title) : "");
        if (!list.length || !(j.data && j.data.hasMore)) break;
        page++;
      }
    }
  }
  if (!eps.size) throw kino.error("not_found", "no se encontró la lista de episodios", {
    userMessage: tr("No se encontró la lista de capítulos de este título.", "No episode list found for this title."),
  });
  const list = Array.from(eps.values()).sort((a, b) => (a.season - b.season) || (a.number - b.number));
  return { series: { title, poster: og ? og[1] : undefined }, episodes: list };
}

// ---- Reproducción -----------------------------------------------------------------------------

function hostOf(u) {
  const m = /^https?:\/\/([^\/?#]+)/i.exec(String(u || ""));
  return m ? m[1] : "";
}

// Forma de la ruta sin el código: /e/xxxx -> "/e/". Sirve para el registro sin filtrar enlaces.
function pathShape(u) {
  const m = /^https?:\/\/[^\/?#]+(\/[^?#]*)?/i.exec(String(u || ""));
  const p = m && m[1] ? m[1] : "";
  return p.replace(/[A-Za-z0-9_-]{8,}/g, "~").slice(0, 40);
}

function absUrl(u) {
  let x = String(u || "").trim();
  if (x.startsWith("//")) x = "https:" + x;
  return /^https:\/\//i.test(x) ? x : "";
}

// -- Lectura de reproductores embebidos ---------------------------------------------------------
// Muchos reproductores esconden el video: dentro de un script "empaquetado" (eval(function(p,a,c,k,e,d)...)
// o en un texto en base64 (atob). Aquí se desarman, sin ejecutar nada, para buscar el .m3u8 / .mp4.

const MEDIA_RE = /["'`]((?:https?:)?\/\/[^"'`\s<>\\]+?\.(?:m3u8|mp4)(?:\?[^"'`\s<>\\]*)?)["'`]/i;

// Videos de prueba que traen los reproductores y sus librerías (Big Buck Bunny y compañía).
// Nunca son el capítulo: se descartan para no mostrarlos por error.
const DEMO_MEDIA = /big[_-]?buck[_-]?bunny|\bbbb[_-]|sintel|elephants?[_-]?dream|tears[_-]?of[_-]?steel|gtv-videos-bucket|commondatastorage|test-?streams|bitdash|bitmovin|mux\.dev|zencdn|oceans\.mp4|flowplayer\.com|jwplatform|\/samples?\/|(?:googleapis|gstatic|jsdelivr|cdnjs|unpkg)\./i;
const isDemo = (u) => DEMO_MEDIA.test(String(u || ""));

function normText(s) {
  return String(s || "").replace(/\\\//g, "/").replace(/\\u0026/gi, "&").replace(/&amp;/g, "&");
}

// Desarma un script empaquetado con el método clásico "p,a,c,k,e,d".
function unpackPacked(src) {
  const re = /\}\s*\(\s*(['"])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])((?:\\[\s\S]|(?!\5)[^\\])*)\5\s*\.split\(\s*['"]\|['"]\s*\)/;
  const m = re.exec(src);
  if (!m) return null;
  const payload = m[2].replace(/\\(['"\\])/g, "$1").replace(/\\n/g, "\n");
  const radix = Number(m[3]);
  let count = Number(m[4]);
  if (!(radix >= 2 && radix <= 62) || !(count > 0 && count < 100000)) return null;
  const dict = m[6].split("|");
  const enc = (c) => (c < radix ? "" : enc(Math.floor(c / radix))) + ((c = c % radix) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
  const map = {};
  while (count--) map[enc(count)] = dict[count] || enc(count);
  return payload.replace(/\b\w+\b/g, (w) => (map[w] != null ? map[w] : w));
}

function unpackAll(html) {
  const out = [];
  let i = 0;
  while (out.length < 4) {
    const k = html.indexOf("eval(function(p,a,c,k,e", i);
    if (k < 0) break;
    const u = unpackPacked(html.slice(k, k + 80000));
    if (u) out.push(u);
    i = k + 20;
  }
  return out;
}

function base64Texts(html) {
  const out = [];
  const re = /atob\(\s*["']([A-Za-z0-9+\/=_-]{16,})["']\s*\)/g;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    try { out.push(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))); } catch (e) { /* no era base64 */ }
  }
  return out;
}

function findMedia(text) {
  const re = new RegExp(MEDIA_RE.source, "gi");
  const t = normText(text);
  let m;
  while ((m = re.exec(t))) {
    const u = absUrl(m[1]);
    if (u && !isDemo(u)) return u;
    if (u) log("video de muestra descartado: " + hostOf(u) + pathShape(u));
  }
  return "";
}

// Igual, pero sin exigir comillas: el texto que sale de un base64 suele ser el enlace "pelado".
function findMediaLoose(text) {
  const re = /((?:https?:)?\/\/[^\s"'`<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'`<>\\]*)?)/gi;
  const t = normText(text);
  let m;
  while ((m = re.exec(t))) {
    const u = absUrl(m[1]);
    if (u && !isDemo(u)) return u;
    if (u) log("video de muestra descartado: " + hostOf(u) + pathShape(u));
  }
  return "";
}

// Busca el video escrito en la página, en sus scripts empaquetados o en sus textos base64.
function deepMedia(html) {
  let u = findMedia(html);
  if (u) return u;
  for (const t of unpackAll(html)) { u = findMedia(t); if (u) return u; }
  for (const t of base64Texts(html)) { u = findMediaLoose(t); if (u) return u; }
  return "";
}

const SKIP_HOST = /(google|gstatic|facebook|doubleclick|googletagmanager|cloudflare|jsdelivr|cdnjs|jquery|bootstrap|fontawesome|histats|yandex)/i;

// Enlaces a otras páginas de reproductor que esta página abre o inserta (iframes y textos de script).
function embedLinks(html, base) {
  const texts = [html].concat(unpackAll(html), base64Texts(html));
  const out = [];
  const add = (u) => {
    const a = absUrl(u);
    if (!a || a === base || out.indexOf(a) >= 0) return;
    if (SKIP_HOST.test(hostOf(a))) return;
    if (/\.(?:js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf)(\?|$)/i.test(a)) return;
    out.push(a);
  };
  const decoded = base64Texts(html);
  for (const raw of texts) {
    const t = normText(raw);
    const fr = /<iframe[^>]*src=["']([^"']+)["']/gi;
    let f;
    while ((f = fr.exec(t))) add(f[1]);
    const ur = /["'`]((?:https?:)?\/\/[^"'`\s<>\\]+)["'`]/g;
    let u;
    while ((u = ur.exec(t))) {
      if (/\/(?:e|embed|v|f|play|player|stream|d)\/[A-Za-z0-9_-]{6,}/i.test(u[1])) add(u[1]);
    }
  }
  // Lo que sale de un base64 suele ser el enlace "pelado", sin comillas.
  for (const raw of decoded) {
    const bare = /(?:https?:)?\/\/[^\s"'`<>\\]+/g;
    let b;
    while ((b = bare.exec(normText(raw)))) add(b[0]);
  }
  return out.slice(0, 4);
}

function redact(s) {
  return String(s || "")
    .replace(/https?:\/\/[^\s"'<>]+/g, (u) => hostOf(u) + pathShape(u))
    .replace(/[A-Za-z0-9+\/=_-]{16,}/g, "~")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

// Radiografía de una página de reproductor para el registro (sin códigos ni enlaces completos).
function diag(html, depth, found) {
  const title = /<title[^>]*>([^<]*)/i.exec(html);
  const scripts = [];
  const sre = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let s;
  while ((s = sre.exec(html))) scripts.push({ attrs: s[1], body: s[2] });
  const ext = scripts.map((x) => attr("<s " + x.attrs + ">", "src")).filter(Boolean).map((x) => hostOf(absUrl(x))).filter(Boolean);
  const inline = scripts.filter((x) => x.body.trim()).sort((a, b) => b.body.length - a.body.length);
  const links = embedLinks(html, "").map((u) => hostOf(u) + pathShape(u));
  log("embed[" + depth + "] bytes=" + html.length + " titulo=" + (title ? title[1].trim().slice(0, 40) : "-") +
    " video=" + (found ? "si" : "no") + " packed=" + unpackAll(html).length + " atob=" + base64Texts(html).length +
    " tagVideo=" + /<video[\s>]/i.test(html) + " iframes=" + (html.split("<iframe").length - 1) +
    " scriptsExt=" + ext.slice(0, 4).join(",") + " scriptsInline=" + inline.length + " enlaces=" + links.join(","));
  if (!found && inline.length) log("embed[" + depth + "] script mayor: " + redact(inline[0].body));
}

// Lee la página de un reproductor y busca el video; si no está, sigue los reproductores que esa
// página abre (hasta 2 niveles), porque el de TuDorama suele ser solo una envoltura.
const innerHosts = new Map(); // envoltura -> a qué reproductores apunta

async function embedFromHtml(embedUrl, depth, referer) {
  const d = depth || 0;
  const r = await kino.fetch(embedUrl, { headers: { Referer: referer || TD + "/" } });
  log("embed[" + d + "] " + hostOf(embedUrl) + pathShape(embedUrl) + " status=" + r.status);
  if (!r.ok) return null;
  let html = await r.text();
  let u = deepMedia(html);
  if (d === 0) innerHosts.set(embedUrl, embedLinks(html, embedUrl).map(hostOf));
  // Una página diminuta, sin video ni enlaces, suele ser una pantalla de comprobación del servidor:
  // con la cookie que acaba de dejar, el segundo intento trae la página real. Un solo reintento.
  if (!u && d >= 1 && html.length < 3000 && !/byse/i.test(hostOf(embedUrl)) && !embedLinks(html, embedUrl).length) {
    log("embed[" + d + "] página diminuta (" + html.length + " bytes): reintento");
    if (typeof kino.sleep === "function") await kino.sleep(900);
    const r2 = await kino.fetch(embedUrl, { headers: { Referer: referer || TD + "/" } });
    if (r2.ok) {
      const h2 = await r2.text();
      if (h2.length > html.length) { html = h2; u = deepMedia(html); }
    }
  }
  diag(html, d, !!u);
  if (u) {
    log("embed[" + d + "] video elegido: " + hostOf(u) + pathShape(u));
    return { url: u, mime: /\.m3u8/i.test(u) ? "application/x-mpegurl" : "video/mp4", headers: { Referer: embedUrl } };
  }
  if (d >= 2) return null;
  const links = embedLinks(html, embedUrl).filter((l) => !/byse/i.test(hostOf(l))).slice(0, d === 0 ? 3 : 2);
  for (const l of links) {
    try {
      const got = await embedFromHtml(l, d + 1, embedUrl);
      if (got) return got;
    } catch (e) {
      log("embed[" + (d + 1) + "] falló: " + String((e && e.message) || e).slice(0, 60));
    }
  }
  return null;
}

async function captureEmbed(embedUrl, ms) {
  if (typeof kino === "undefined" || !kino.browser || typeof kino.browser.capture !== "function") return null;
  const page = await kino.browser.capture(embedUrl, { timeoutMs: ms, headers: { Referer: TD + "/" } });
  const media = page && Array.isArray(page.media) ? page.media : [];
  const first = media.find((x) => x && typeof x.url === "string" && /^https?:\/\//.test(x.url) && !isDemo(x.url));
  if (!first) return null;
  const out = { url: first.url, mime: first.mime || first.mimeType || (/\.m3u8(\?|$)/i.test(first.url) ? "application/x-mpegurl" : "video/mp4") };
  if (first.headers && typeof first.headers === "object") out.headers = first.headers;
  return out;
}

// Devuelve el primer resultado que llegue (no el último): { v, i } o null si ninguno entrega nada.
function firstSuccess(tasks) {
  return new Promise((resolveAll) => {
    let pending = tasks.length;
    if (!pending) { resolveAll(null); return; }
    tasks.forEach((t, i) => {
      Promise.resolve(t).then((v) => { if (v) resolveAll({ v, i }); }, () => {}).then(() => {
        pending--;
        if (pending === 0) resolveAll(null);
      });
    });
  });
}

export async function resolve(ref) {
  await null;
  const t0 = Date.now();
  const raw = String(ref || "");
  if (raw.startsWith("dl|")) return dlResolve(raw.slice(3));
  if (raw.startsWith("dy|")) return dyResolve(raw.slice(3));
  if (!raw.startsWith("td|")) throw kino.error("not_found", "referencia desconocida");
  const url = raw.slice(3);
  const html = await getHtml(url);
  const box = /<[^>]*class=["'][^"']*(?:ep__dropdown|servers)[^"']*["'][^>]*>/i.exec(html);
  const id = box ? attr(box[0], "data-id") : "";
  const nonce = box ? attr(box[0], "data-nonce") : "";
  if (!id || !nonce) {
    log("resolve: sin data-id/data-nonce");
    throw kino.error("unavailable", "sin lista de servidores", {
      userMessage: tr("Este capítulo no trae servidores disponibles.", "This episode has no servers available."),
    });
  }
  const j = await ajax({ action: "corvus_get_servers", nonce, post_id: id }, url);
  const list = (Array.isArray(j) ? j : []).filter((x) => x && (x.link || x.url));
  log("resolve: servidores=" + list.length + " " + list.map((x) => (x.lang || "-") + "/" + (x.type || "embed") + "/" + hostOf(absUrl(x.link || x.url)) + pathShape(x.link || x.url)).join(", "));
  if (!list.length) {
    throw kino.error("unavailable", "servidores vacíos", {
      userMessage: tr("Este capítulo aún no tiene servidores.", "This episode has no servers yet."),
    });
  }
  // Español latino primero, luego subtitulado; dentro de cada idioma: Pixeldrain (enlace directo),
  // otros directos, los reproductores embebidos y, al final, Abyss (el más difícil de abrir).
  const kindRank = (x) => {
    const l = absUrl(x.link || x.url);
    const h = hostOf(l);
    if (/(^|\.)pixeldrain\.(com|net)$/i.test(h)) return 0;
    if (x.type === "direct" || x.type === "video") return 1;
    if (/abyss/i.test(l)) return 3;
    return 2;
  };
  list.sort((a, b) => ((a.lang === "es" ? 0 : 1) - (b.lang === "es" ? 0 : 1)) || (kindRank(a) - kindRank(b)));
  const label = (x) => (x.lang === "es" ? "Latino" : tr("Subtitulado", "Subbed")) + " · " + String(x.name || "").split(":")[0].trim();

  const isPixel = (x) => /pixeldrain\.(?:com|net)\/(?:u|api\/file)\//i.test(absUrl(x.link || x.url));
  const isDirect = (x) => x.type === "direct" || x.type === "video";
  const embedAll = list.filter((x) => absUrl(x.link || x.url) && !isDirect(x) && !isPixel(x));
  const hasLater = list.some((x) => isDirect(x) || isPixel(x));
  const browserOk = typeof kino.sleep === "function" && kino.browser && typeof kino.browser.capture === "function";

  // Navegador oculto: se prefiere una envoltura que NO apunte a reproductores que se quedan en "Loading..."
  // (byse, hgcloud) ni a Abyss, porque con esos casi nunca ve el video.
  const weak = (x) => {
    const l = absUrl(x.link || x.url);
    return /abyss/i.test(l) || /byse|hgcloud|abyss/i.test((innerHosts.get(l) || []).join(","));
  };
  const runCapture = async () => {
    const left = 18000 - (Date.now() - t0);
    const fe = embedAll.find((x) => !weak(x)) || embedAll[0];
    if (!fe || left < 5000) return null;
    try {
      const sres = await captureEmbed(absUrl(fe.link || fe.url), Math.min(12000, left - 1500));
      if (sres) { sres.label = label(fe); return sres; }
      log("resolve: el navegador no vio video");
    } catch (e) {
      log("resolve: captura falló " + String((e && e.message) || e).slice(0, 60));
    }
    return null;
  };

  let embedsDone = false;
  let captureStarted = false;
  for (const x of list) {
    const link = absUrl(x.link || x.url);
    if (!link) continue;

    // Pixeldrain: el archivo se pide directo en /api/file/<id>.
    const px = /pixeldrain\.(?:com|net)\/(?:u|api\/file)\/([A-Za-z0-9]+)/i.exec(link);
    if (px) {
      return { url: "https://pixeldrain.com/api/file/" + px[1], mime: "video/mp4", label: label(x) };
    }

    if (isDirect(x)) {
      return { url: link, mime: /\.m3u8(\?|$)/i.test(link) ? "application/x-mpegurl" : "video/mp4", label: label(x), headers: { Referer: TD + "/" } };
    }

    if (embedsDone) continue;
    // Reproductores embebidos, por idioma (primero Latino): se leen hasta 4 a la vez y gana el PRIMERO
    // que entregue el video, sin esperar a los demás. Si a los 4 s nadie ha entregado nada, el navegador
    // oculto arranca en paralelo (solo si no hay un enlace directo más abajo en la lista).
    const langs = [];
    for (const y of embedAll) if (langs.indexOf(y.lang) < 0) langs.push(y.lang);
    for (const lg of langs) {
      const group = embedAll.filter((y) => y.lang === lg).slice(0, 4);
      const staticP = firstSuccess(group.map((y) =>
        embedFromHtml(absUrl(y.link || y.url), 0, TD + "/").then((v) => (v ? Object.assign(v, { label: label(y) }) : null))
      ));
      let winner = null;
      if (browserOk && !hasLater && !captureStarted) {
        const first = await Promise.race([staticP, kino.sleep(4000).then(() => "slow")]);
        if (first && first !== "slow") {
          winner = first.v;
        } else if (first === "slow") {
          captureStarted = true;
          log("resolve: 4 s sin video, el navegador oculto arranca en paralelo");
          const both = await firstSuccess([staticP.then((r) => (r ? r.v : null)), runCapture()]);
          winner = both ? both.v : null;
        }
      } else {
        const r = await staticP;
        winner = r ? r.v : null;
      }
      if (winner) return winner;
    }
    embedsDone = true; // sigue la lista por si hay un Pixeldrain o directo más abajo
  }
  // Último recurso: el navegador oculto (si no arrancó ya), con lo que quede de tiempo.
  if (!captureStarted) {
    const sres = await runCapture();
    if (sres) return sres;
  }
  throw kino.error("unavailable", "ningún servidor entregó el video", {
    userMessage: tr(
      "Ningún servidor de este capítulo se pudo abrir desde aquí. Prueba otro capítulo o título.",
      "No server for this episode could be opened from here. Try another episode or title."
    ),
  });
}