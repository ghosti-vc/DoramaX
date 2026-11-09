// DoramaX - catálogo de K-dramas en español (TuDorama).
// Solo catálogo: no reproduce nada (catalogOnly), resolve responde not_found.

const TD = "https://tudorama.com";
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

async function listPage(path) {
  const html = await getHtml(TD + path);
  return cards(html);
}

export async function home() {
  await null; // por si algo de abajo lanza: nunca antes del primer await
  const defs = [
    { id: "td-emision", title: tr("En emisión", "Airing"), path: "/genero/emision/", genre: "series" },
    { id: "td-kdramas", title: tr("K-Dramas", "K-Dramas"), path: "/genero/series/", genre: "series" },
    { id: "td-peliculas", title: tr("Películas", "Movies"), path: "/genero/peliculas/", genre: "peliculas" },
  ];
  const res = await Promise.allSettled(defs.map((d) => listPage(d.path)));
  const rows = [];
  res.forEach((r, i) => {
    if (r.status !== "fulfilled") { log("home: falló " + defs[i].id); return; }
    const items = r.value.slice(0, HOME_ROW);
    if (items.length) rows.push({ id: defs[i].id, title: defs[i].title, genre: defs[i].genre, items });
  });
  log("home filas=" + rows.length);
  if (!rows.length) throw kino.error("unavailable", "inicio sin resultados");
  return rows;
}

export async function search(query) {
  await null;
  const q = stripTags(query && query.q).slice(0, 100);
  if (!q) return [];
  const html = await getHtml(TD + "/?s=" + encodeURIComponent(q));
  return cards(html).slice(0, MAX_RESULTS);
}

// Catálogo sin reproducción: los Kino viejos igual llaman a resolve.
export async function resolve(ref) {
  await null;
  throw kino.error("not_found", "este plugin no reproduce", {
    userMessage: tr("DoramaX solo muestra el catálogo; no reproduce videos.", "DoramaX only shows the catalog; it does not play videos."),
  });
}
