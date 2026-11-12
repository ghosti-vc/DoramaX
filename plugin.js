// DoramaX - doramas en español latino: TuDorama, DoramasYT, DoramasLat y DoramasFlix.
// Catálogo, búsqueda, capítulos y reproducción (directa o, si hace falta, con el navegador oculto).
// Cada fuente tiene su límite de tiempo: si una se cuelga, las demás siguen y la pantalla no se queda esperando.

const TD = "https://tudorama.com";
const DY = "https://www.doramasyt.com";
const DL = "https://doramaslat.com";
const DF = "https://doramasflix.io";
const DF_API = "https://user-api.fluxcedene.net/graphql";
const HOME_ROW = 20;
const MAX_RESULTS = 100;
const CAT_VIEW = 60;   // títulos por tanda de "Ver más"
const CAT_MAX = 100;   // tope de Kino por página
const PAGE_MS = 9000;  // espera máxima por una página de catálogo o de búsqueda
const AJAX_MS = 10000;
const EMBED_MS = 8000; // espera máxima por la página de un reproductor
const DAY_MS = 24 * 60 * 60 * 1000;

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

// Sin acentos. normalize puede no existir en el motor del plugin: sin él, el texto queda igual.
function fold(s) {
  let x = String(s || "");
  if (typeof x.normalize === "function") {
    try { x = x.normalize("NFD"); } catch (e) { /* se queda como está */ }
  }
  return x.replace(/[\u0300-\u036f]/g, "");
}

// ---- Almacenamiento pequeño (con vigencia) y tiempos de espera ---------------------------------

function storeGet(key) {
  try {
    const v = kino.storage.get(key);
    return v === undefined || v === null || v === "" ? null : String(v);
  } catch (e) { return null; }
}
function storeSet(key, val, ttlMs) {
  try { kino.storage.set(key, String(val), ttlMs ? { ttlMs } : undefined); } catch (e) { /* sin almacenamiento */ }
}

// kino.sleep solo acepta de 0 a 5000 ms: las esperas largas se hacen por tramos.
async function sleepUpTo(ms) {
  let left = Number(ms) || 0;
  while (left > 0) {
    const t = Math.min(left, 4500);
    await kino.sleep(t);
    left -= t;
  }
  return null;
}

// Devuelve lo que entregue "p" o, si tarda más de "ms", falla con "unavailable" sin esperar más.
function withTimeout(p, ms) {
  if (typeof kino.sleep !== "function") return Promise.resolve(p);
  return new Promise((resolveAll, rejectAll) => {
    let done = false;
    Promise.resolve(p).then(
      (v) => { if (!done) { done = true; resolveAll(v); } },
      (e) => { if (!done) { done = true; rejectAll(e); } }
    );
    sleepUpTo(ms).then(() => {
      if (!done) { done = true; rejectAll(kino.error("unavailable", "una fuente tardó demasiado")); }
    });
  });
}

// ---- Red ---------------------------------------------------------------------------------------

async function getHtml(url, ms) {
  let r;
  try {
    r = await kino.fetch(url, { timeoutMs: ms || PAGE_MS });
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

function formBody(obj) {
  return Object.keys(obj).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(String(obj[k]))).join("&");
}

// Peticiones al servidor de WordPress de TuDorama (admin-ajax).
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
      timeoutMs: AJAX_MS,
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

// ---- Tarjetas de cada sitio ---------------------------------------------------------------------

// TuDorama: enlaces /serie/<slug>/ o /pelicula/<slug>/ (con o sin el dominio escrito).
function cards(html) {
  const byUrl = new Map(); // url -> { kind, slug, title, alt, poster }
  const re = /<a[^>]+href=["']((?:https:\/\/(?:www\.)?tudorama\.com)?\/(serie|pelicula)\/([a-z0-9-]+)\/?)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const url = TD + "/" + m[2] + "/" + m[3] + "/";
    const e = byUrl.get(url) || { kind: m[2], slug: m[3], title: "", alt: "", poster: undefined };
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
    byUrl.set(url, e);
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

// DoramasYT: <a href=".../dorama/<slug>"> ... <img data-src="..."> ... <h3>Título</h3></a>
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

// DoramasLat (Dooplay): listas con <article class="item tvshows"> y búsqueda con .result-item; se leen igual, bloque a bloque.
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

// ---- DoramasFlix: API pública (GraphQL) ---------------------------------------------------------

async function dfQuery(query, variables) {
  let r;
  try {
    r = await kino.fetch(DF_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "application/json", Origin: DF, Referer: DF + "/",
        "x-brand-host": "doramasflix.io", "x-forwarded-host": "doramasflix.io",
      },
      body: JSON.stringify(variables ? { query, variables } : { query }),
      timeoutMs: PAGE_MS,
    });
  } catch (e) {
    log("df fetch falló: " + String((e && e.message) || e).slice(0, 80));
    throw kino.error("unavailable", "DoramasFlix no respondió", { userMessage: tr("DoramasFlix no respondió. Prueba de nuevo en un momento.", "DoramasFlix did not answer. Try again in a moment.") });
  }
  log("df api status=" + r.status);
  if (!r.ok) {
    // Un 400 suele ser una consulta con un campo que el servidor no conoce ("shape"): sirve para saber qué campos existen.
    throw Object.assign(kino.error(r.status === 429 ? "rate_limited" : "unavailable", "DoramasFlix error " + r.status, { userMessage: tr("DoramasFlix respondió con el error " + r.status + ".", "DoramasFlix answered with error " + r.status + ".") }), { shape: r.status === 400 });
  }
  let j;
  try { j = JSON.parse(await r.text()); } catch (e) { j = null; }
  if (!j || !j.data) {
    log("df api sin datos: " + (j && j.errors && j.errors[0] ? String(j.errors[0].message).slice(0, 100) : "respuesta rara"));
    throw Object.assign(kino.error("unavailable", "DoramasFlix devolvió algo inesperado", { userMessage: tr("DoramasFlix devolvió una respuesta que no entiendo.", "DoramasFlix returned a response I can't read.") }), { shape: true });
  }
  if (j.errors && j.errors[0]) log("df api aviso: " + String(j.errors[0].message).slice(0, 100));
  return j.data;
}

// Pide también los idiomas de cada título. Qué campos tiene el servidor se prueba UNA vez y se recuerda una semana;
// si la red falla a medias, no se recuerda nada y esa llamada sigue sin idiomas.
const DF_LANG_SELS = ["code_flix name", "code name"];
async function dfQueryL(make, variables) {
  let sel = storeGet("dflang");
  if (sel === null) {
    for (const s of DF_LANG_SELS) {
      try {
        const d = await dfQuery(make(s), variables);
        storeSet("dflang", s, 7 * DAY_MS);
        log("df: idiomas con campos " + s);
        return d;
      } catch (e) {
        if (!e || !e.shape) return dfQuery(make(""), variables); // la red falló: sin idiomas por esta vez
      }
    }
    storeSet("dflang", "none", 7 * DAY_MS);
    log("df: sin idiomas en la lista");
    return dfQuery(make(""), variables);
  }
  return dfQuery(make(sel === "none" ? "" : sel), variables);
}

function dfPoster(p) {
  if (!p) return undefined;
  p = String(p);
  if (p.charAt(0) === "/") return "https://image.tmdb.org/t/p/w342" + p;
  return /^https?:\/\//i.test(p) ? p : undefined;
}

function dfItem(x, kind) {
  if (!x || !x.slug || !x._id) return null;
  const title = stripTags(x.name_es || x.name);
  if (!title) return null;
  return {
    id: "df-" + String(x.slug).slice(0, 80),
    ref: "df|" + kind + "|" + x.slug + "|" + x._id + (Array.isArray(x.langs) ? "|" + x.langs.filter((l) => l && /lat/i.test(String(l.name || ""))).map((l) => String(l.code_flix != null ? l.code_flix : l.code)).join(",") : ""),
    title: title.slice(0, 200),
    kind: kind === "m" ? "movie" : "series",
    genres: kind === "m" ? ["peliculas", "drama"] : ["series", "drama"],
    poster: dfPoster(x.poster_path || x.poster),
  };
}

function humanSlug(slug) {
  return String(slug || "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- Secciones: cada una junta varias fuentes y quita los títulos repetidos -------------------

// site: "td" = TuDorama, "dy" = DoramasYT, "dl" = DoramasLat, "df" = DoramasFlix.
const SECTIONS = {
  latino: { genre: "doramas", parts: [
    { site: "td", path: "/genero/espanol-latino/" },
    { site: "dy", path: "/buscar?q=latino" },   // sus series en latino llevan "latino" en el nombre
    { site: "dl", path: "/tvshows/" },            // todo DoramasLat es en latino
    { site: "df", kind: "d", latOnly: true },     // DoramasFlix: solo las que traen idioma latino
  ] },
  emision: { genre: "doramas", parts: [
    { site: "td", path: "/genero/emision/" },
    { site: "dy", path: "/emision" },
  ] },
  kdramas: { genre: "doramas", parts: [
    { site: "td", path: "/genero/series/" },
    { site: "df", kind: "d" },
  ] },
  peliculas: { genre: "peliculas", parts: [
    { site: "td", path: "/genero/peliculas/" },
    { site: "dl", path: "/movies/" },
    { site: "df", kind: "m" },
  ] },
};

// Una página de una fuente concreta.
async function partPage(part, n) {
  if (part.site === "df") {
    const field = part.kind === "m" ? "paginationMovie" : "paginationDorama";
    const d = await dfQueryL((L) => "query C($page:Int,$limit:Int){" + field + "(page:$page,limit:$limit){pageInfo{hasNextPage} items{_id slug name name_es poster_path poster" + (L ? " langs{" + L + "}" : "") + "}}}", { page: n, limit: part.latOnly ? 48 : 24 });
    const o = (d && d[field]) || {};
    let items = (o.items || []).map((x) => dfItem(x, part.kind)).filter(Boolean);
    if (part.latOnly) items = items.filter((x) => /\|[0-9]+(,[0-9]+)*$/.test(x.ref));
    return { items, hasNext: !!(o.pageInfo && o.pageInfo.hasNextPage) };
  }
  if (part.site === "dy") {
    const sep = part.path.indexOf("?") >= 0 ? "&" : "?";
    const html = await getHtml(DY + part.path + (n > 1 ? sep + "p=" + n : ""));
    return { items: dyCards(html), hasNext: html.indexOf("p=" + (n + 1)) !== -1 };
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
  return fold(t).toLowerCase().replace(/\blatino\b/g, "").replace(/[^a-z0-9]+/g, "");
}

// Títulos sencillos: sin acentos ni ¡ ¿ (la ñ se queda), para que Kino los empareje con su catálogo.
function plainTitle(t) {
  let x = String(t || "");
  if (typeof x.normalize === "function") {
    try {
      x = x.normalize("NFD").replace(/n\u0303/g, "\u0001").replace(/N\u0303/g, "\u0002").replace(/[\u0300-\u036f]/g, "").replace(/\u0001/g, "ñ").replace(/\u0002/g, "Ñ");
    } catch (e) { /* se queda como está */ }
  }
  return x.replace(/[¡¿]/g, "").replace(/\s+/g, " ").trim();
}

// Junta los títulos repetidos (mismo nombre, aunque vengan de fuentes distintas) en UNA sola tarjeta.
// La tarjeta conserva todas las direcciones ("mx|a||b"); al abrirla, episodes() elige la que tenga más capítulos.
const SRC_PRIO = { df: -1, td: 0, dl: 1, dy: 2 };

function mergeDupes(items) {
  const groups = new Map();
  const order = [];
  for (const x of items) {
    const k = normTitle(x.title) || x.id;
    let g = groups.get(k);
    if (!g) { g = []; groups.set(k, g); order.push(k); }
    g.push(x);
  }
  const fix = (x) => Object.assign({}, x, { title: plainTitle(x.title) || x.title });
  return order.map((k) => {
    const g = groups.get(k);
    if (g.length === 1) return fix(g[0]);
    g.sort((a, b) => (SRC_PRIO[a.ref.slice(0, 2)] || 0) - (SRC_PRIO[b.ref.slice(0, 2)] || 0));
    const first = Object.assign({}, g[0]);
    if (!first.poster) { const p = g.find((y) => y.poster); if (p) first.poster = p.poster; }
    const refs = [];
    for (const y of g) if (refs.indexOf(y.ref) < 0) refs.push(y.ref);
    if (refs.length > 1) first.ref = "mx|" + refs.join("||");
    return fix(first);
  });
}

// Una página de una sección: pide todas sus fuentes a la vez (cada una con su límite de tiempo), intercala sus
// títulos (uno de cada una, por turnos) y quita los repetidos. Si una fuente falla, tarda o ya no tiene esa página, se sigue con las demás.
async function sectionPage(ref, n) {
  await null;
  const sec = SECTIONS[ref];
  const res = await Promise.allSettled(sec.parts.map((p) => withTimeout(partPage(p, n), PAGE_MS + 2000)));
  const ok = res.filter((r) => r.status === "fulfilled");
  if (!ok.length) throw res[0].reason;
  const lists = ok.map((r) => r.value.items);
  const mixed = [];
  const longest = Math.max.apply(null, lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const l of lists) if (l[i]) mixed.push(l[i]);
  }
  return { items: mergeDupes(mixed), hasNext: ok.some((r) => r.value.hasNext) };
}

// ---- Carátulas: DoramasYT bloquea sus imágenes, así que sus títulos se buscan en TMDB (solo si el nombre coincide) ----

const ART_KEY = "art1:";
const BLOCKED_POSTER = /doramasyt\.com/i;

async function lookupPoster(it) {
  const key = ART_KEY + normTitle(it.title);
  if (storeGet(key) !== null) return null;
  try {
    const query = String(it.title).slice(0, 120);
    const res = await kino.tmdb(it.kind === "movie" ? "/search/movie" : "/search/tv", { query, language: "es-MX" });
    const list = res && Array.isArray(res.results) ? res.results : [];
    const n = normTitle(it.title);
    const pick = list.slice(0, 6).find((r) => r && r.poster_path && [r.name, r.original_name, r.title, r.original_title].some((x) => x && normTitle(x) === n));
    const url = pick ? "https://image.tmdb.org/t/p/w342" + pick.poster_path : "";
    storeSet(key, url || "-", url ? 30 * DAY_MS : 2 * DAY_MS);
  } catch (e) {
    log("carátula: TMDB no respondió (" + ((e && (e.code || e.message)) || "?") + ")");
  }
  return null;
}

// Pone la carátula de TMDB en los títulos que no tienen una buena. "budget" = cuántas búsquedas nuevas se permiten por llamada.
async function addArt(items, budget) {
  if (typeof kino.tmdb !== "function") return items;
  const need = (it) => it && (!it.poster || BLOCKED_POSTER.test(String(it.poster))) && normTitle(it.title);
  const todo = [];
  const seen = new Set();
  for (const it of items) {
    if (!need(it)) continue;
    const key = normTitle(it.title);
    if (seen.has(key) || storeGet(ART_KEY + key) !== null) continue;
    seen.add(key);
    todo.push(it);
  }
  let spent = 0;
  while (todo.length && spent < (budget || 12)) {
    const batch = todo.splice(0, Math.min(6, (budget || 12) - spent));
    spent += batch.length;
    await Promise.allSettled(batch.map(lookupPoster));
  }
  for (const it of items) {
    if (!need(it)) continue;
    const hit = storeGet(ART_KEY + normTitle(it.title));
    if (hit && hit !== "-") it.poster = hit;
  }
  return items;
}

// ---- Entradas: inicio, "Ver más", categorías y búsqueda ----------------------------------------

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
  if (!rows.length) throw kino.error("unavailable", "inicio sin resultados", { userMessage: tr("No se pudo cargar el inicio. Prueba de nuevo en un momento.", "Could not load the home. Try again in a moment.") });
  try { await withTimeout(addArt([].concat(...rows.map((r) => r.items)), 16), 5000); } catch (e) { /* las carátulas son un extra */ }
  return rows;
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
  try { await withTimeout(addArt(page.items, 16), 5000); } catch (e) { /* las carátulas son un extra */ }
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
  const qa = fold(q).replace(/[¡!¿?:,.]/g, " ").replace(/\s+/g, " ").trim() || q;
  const enc = encodeURIComponent(qa);
  const slug = qa.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Si el buscador de DoramasLat no la encuentra, se prueba la dirección directa de la serie.
  const dlDirect = async () => {
    if (!slug) return [];
    const u = DL + "/tvshows/" + slug + "-doramas-latino/";
    const html = await getHtml(u);
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
    const title = h1 ? stripTags(h1[1]).replace(/\s*[–-]\s*Doramas\s+Latino\s*$/i, "").trim() : "";
    if (!title || !/episodios|\/episodes\//i.test(html)) return [];
    const img = /<div class=["']poster["'][^>]*>\s*<img[^>]*?(?:data-src|src)=["']([^"']+)["']/i.exec(html);
    return [{ id: "dl-" + slug + "-doramas-latino", ref: "dl|" + u, title: title.slice(0, 200), kind: "series", genres: ["series", "drama"], poster: img ? img[1] : undefined }];
  };
  // Lo mismo con TuDorama: dirección directa de la serie o de la película.
  const tdDirect = async () => {
    if (!slug) return [];
    for (const kind of ["serie", "pelicula"]) {
      let html;
      try { html = await getHtml(TD + "/" + kind + "/" + slug + "/"); } catch (e) { continue; }
      const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
      const title = h1 ? stripTags(h1[1]).trim() : "";
      if (!title || !/\/ver\//i.test(html)) continue;
      const og = /property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(html);
      return [{ id: "td-" + slug, ref: "td|" + TD + "/" + kind + "/" + slug + "/", title: title.slice(0, 200), kind: kind === "serie" ? "series" : "movie", genres: kind === "serie" ? ["series", "drama"] : ["peliculas", "drama"], poster: og ? og[1] : undefined }];
    }
    return [];
  };
  const dfSearch = async () => {
    const d = await dfQueryL((L) => "query S($input:String,$limit:Int){searchDorama(input:$input,limit:$limit){_id slug name name_es poster_path poster" + (L ? " langs{" + L + "}" : "") + "} searchMovie(input:$input,limit:$limit){_id slug name name_es poster_path poster" + (L ? " langs{" + L + "}" : "") + "}}", { input: qa, limit: 20 });
    return ((d && d.searchDorama) || []).map((x) => dfItem(x, "d")).concat(((d && d.searchMovie) || []).map((x) => dfItem(x, "m"))).filter(Boolean);
  };
  // Las 4 fuentes a la vez; cada una con su límite de tiempo, para que una lenta no deje la búsqueda sin nada.
  const [a, b, c, f] = await Promise.allSettled([
    withTimeout(getHtml(TD + "/?s=" + enc).then(cards).then((r) => (r.length ? r : tdDirect().catch(() => []))), PAGE_MS + 3000),
    withTimeout(getHtml(DY + "/buscar?q=" + enc).then(dyCards), PAGE_MS + 1000),
    withTimeout(getHtml(DL + "/?s=" + enc).then(dlCards).then((r) => (r.length ? r : dlDirect().catch(() => []))), PAGE_MS + 3000),
    withTimeout(dfSearch(), PAGE_MS + 2000),
  ]);
  if (a.status === "rejected" && b.status === "rejected" && c.status === "rejected" && f.status === "rejected") throw a.reason;
  const all = [];
  for (const r of [f, a, b, c]) {
    if (r.status !== "fulfilled") { log("búsqueda: una fuente falló"); continue; }
    for (const x of r.value) all.push(x);
  }
  log("búsqueda: " + all.length + " resultados");
  const out = mergeDupes(all).slice(0, MAX_RESULTS);
  try { await withTimeout(addArt(out, 10), 3500); } catch (e) { /* las carátulas son un extra */ }
  return out;
}
