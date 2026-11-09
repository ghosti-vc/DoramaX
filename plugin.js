// DoramaX - catálogo de K-dramas en español (TuDorama).
// Reproduce desde los servidores del sitio (directos o con el navegador oculto).

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

async function listPage(path) {
  const html = await getHtml(TD + path);
  return cards(html);
}

export async function home() {
  await null; // por si algo de abajo lanza: nunca antes del primer await
  const defs = [
    { id: "td-emision", title: tr("En emisión", "Airing"), path: "/genero/emision/", genre: "series" },
    { id: "td-latino", title: tr("En Latino", "In Latin Spanish"), path: "/genero/espanol-latino/", genre: "series" },
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

export async function episodes(ref) {
  await null;
  const raw = String(ref || "");
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

function absUrl(u) {
  let x = String(u || "").trim();
  if (x.startsWith("//")) x = "https:" + x;
  return /^https:\/\//i.test(x) ? x : "";
}

async function captureEmbed(embedUrl, ms) {
  if (typeof kino === "undefined" || !kino.browser || typeof kino.browser.capture !== "function") return null;
  const page = await kino.browser.capture(embedUrl, { timeoutMs: ms, headers: { Referer: TD + "/" } });
  const media = page && Array.isArray(page.media) ? page.media : [];
  const first = media.find((x) => x && typeof x.url === "string" && /^https?:\/\//.test(x.url));
  if (!first) return null;
  const out = { url: first.url, mime: first.mime || first.mimeType || (/\.m3u8(\?|$)/i.test(first.url) ? "application/x-mpegurl" : "video/mp4") };
  if (first.headers && typeof first.headers === "object") out.headers = first.headers;
  return out;
}

export async function resolve(ref) {
  await null;
  const t0 = Date.now();
  const raw = String(ref || "");
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
  log("resolve: servidores=" + list.length + " " + list.map((x) => (x.lang || "-") + "/" + (x.type || "embed") + "/" + hostOf(absUrl(x.link || x.url))).join(", "));
  if (!list.length) {
    throw kino.error("unavailable", "servidores vacíos", {
      userMessage: tr("Este capítulo aún no tiene servidores.", "This episode has no servers yet."),
    });
  }
  // Español latino primero, luego subtitulado; dentro de cada idioma, los directos primero.
  const rank = (x) => (x.lang === "es" ? 0 : 1) * 10 + ((x.type === "direct" || x.type === "video") ? 0 : 1);
  list.sort((a, b) => rank(a) - rank(b));
  const label = (x) => (x.lang === "es" ? "Latino" : tr("Subtitulado", "Subbed")) + " · " + String(x.name || "").split(":")[0].trim();

  let tried = 0;
  for (const x of list) {
    const link = absUrl(x.link || x.url);
    if (!link) continue;
    if (x.type === "direct" || x.type === "video") {
      const out = { url: link, mime: /\.m3u8(\?|$)/i.test(link) ? "application/x-mpegurl" : "video/mp4", label: label(x) };
      out.headers = { Referer: TD + "/" };
      return out;
    }
    // Reproductor embebido: se intenta con el navegador oculto, con tope de tiempo total.
    const left = 17000 - (Date.now() - t0);
    if (left < 5000 || tried >= 2) break;
    tried++;
    try {
      const s = await captureEmbed(link, Math.min(8000, left - 1500));
      if (s) { s.label = label(x); return s; }
      log("resolve: sin video en " + hostOf(link));
    } catch (e) {
      log("resolve: falló " + hostOf(link) + " " + String((e && e.message) || e).slice(0, 60));
    }
  }
  throw kino.error("unavailable", "ningún servidor entregó el video", {
    userMessage: tr(
      "Ningún servidor de este capítulo se pudo abrir desde aquí. Prueba otro capítulo o título.",
      "No server for this episode could be opened from here. Try another episode or title."
    ),
  });
}
