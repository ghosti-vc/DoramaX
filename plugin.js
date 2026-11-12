
// =====================================================================================================
// PARTE FINAL: capítulos y reproducción. Va pegada justo después de la función search().
// =====================================================================================================

// ---- Utilidades de reproducción ----------------------------------------------------------------

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

// Las cabeceras que el reproductor manda con el video: la página del reproductor como Referer
// y su origen como Origin (algunos servidores, como Mixdrop, responden 403 si falta alguno).
function playHeaders(embedUrl) {
  const m = /^(https?:\/\/[^\/?#]+)/i.exec(String(embedUrl || ""));
  const h = { Referer: embedUrl };
  if (m) h.Origin = m[1];
  return h;
}

// Servidores que por lo visto casi nunca se pueden abrir desde aquí: Byse se queda en "Loading...",
// DoodStream pide un captcha (no se salta) y Abyss es muy cerrado.
const DEAD_HOST = /byse|dood|do7go|d0000d|d000d|dsvplay|abyss/i;

// Orden de preferencia de los servidores (los que más a menudo entregan el video).
const SERVER_RANK = ["voe", "streamtape", "mp4upload", "lulu", "savefiles", "mxdrop", "uqload", "ok.ru", "filemoon", "mega"];

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

const NO_VIDEO = () => kino.error("unavailable", "ningún servidor entregó el video", {
  userMessage: tr(
    "Ningún servidor de este capítulo se pudo abrir desde aquí. Prueba otro capítulo o título.",
    "No server for this episode could be opened from here. Try another episode or title."
  ),
});

// -- Lectura de reproductores embebidos ---------------------------------------------------------
// Muchos reproductores esconden el video: dentro de un script "empaquetado" (eval(function(p,a,c,k,e,d)...)
// o en un texto en base64 (atob). Aquí se desarman, sin ejecutar nada, para buscar el .m3u8 / .mp4.

const MEDIA_RE = /["'`]((?:https?:)?\/\/[^"'`\s<>\\]+?\.(?:m3u8|mp4)(?:\?[^"'`\s<>\\]*)?)["'`]/i;

// Videos de prueba que traen los reproductores y sus librerías (Big Buck Bunny y compañía). Nunca son el capítulo.
const DEMO_MEDIA = /big[_-]?buck[_-]?bunny|\bbbb[_-]|sintel|elephants?[_-]?dream|tears[_-]?of[_-]?steel|gtv-videos-bucket|commondatastorage|test-?streams|test-videos\.co\.uk|bitdash|bitmovin|mux\.dev|zencdn|oceans\.mp4|flowplayer\.com|jwplatform|\/samples?\/|(?:googleapis|gstatic|jsdelivr|cdnjs|unpkg)\./i;
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

// VOE esconde sus datos en un <script type="application/json"> con un texto en varias capas
// (ROT13, símbolos de relleno, base64, desplazamiento de letras, reverso y base64 otra vez).
// OJO: este método cambia con el tiempo y no se ha comprobado contra el sitio real; si ya no coincide,
// simplemente no encuentra nada y el plugin sigue con los demás servidores.
function rot13(s) {
  return String(s).replace(/[A-Za-z]/g, (c) => {
    const b = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });
}
function voeDecode(enc) {
  try {
    let s = rot13(enc);
    for (const p of ["@$", "^^", "~@", "%?", "*~", "!!", "#&"]) s = s.split(p).join("");
    s = atob(s);
    let t = "";
    for (let i = 0; i < s.length; i++) t += String.fromCharCode(s.charCodeAt(i) - 3);
    t = t.split("").reverse().join("");
    return JSON.parse(atob(t));
  } catch (e) { return null; }
}
function jsonScripts(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 6) out.push(m[1].trim());
  return out;
}
function voeMedia(html) {
  for (const body of jsonScripts(html)) {
    let v;
    try { v = JSON.parse(body); } catch (e) { continue; }
    const enc = Array.isArray(v) ? v[0] : v;
    if (typeof enc !== "string" || enc.length < 40) continue;
    const j = voeDecode(enc);
    if (!j || typeof j !== "object") continue;
    for (const k of ["source", "direct_access_url", "file", "hls"]) {
      const u = absUrl(j[k]);
      if (u && !isDemo(u)) return u;
    }
  }
  return "";
}

// OK.ru: la página trae un data-options con un JSON que lista el video en varias calidades.
const OK_ORDER = ["mobile", "lowest", "low", "sd", "hd", "full", "quad", "ultra"];
function okMedia(html) {
  const attrs = /data-options="([^"]*)"/.exec(html) || /data-options='([^']*)'/.exec(html);
  if (!attrs) return "";
  let md = null;
  try {
    const opts = JSON.parse(decodeEntities(attrs[1]));
    md = opts && opts.flashvars ? opts.flashvars.metadata : null;
    if (typeof md === "string") md = JSON.parse(md);
  } catch (e) { return ""; }
  if (!md || typeof md !== "object") return "";
  const vids = (Array.isArray(md.videos) ? md.videos : [])
    .filter((v) => v && typeof v.url === "string" && /^https:\/\//.test(v.url) && OK_ORDER.indexOf(v.name) >= 0)
    .sort((a, b) => OK_ORDER.indexOf(b.name) - OK_ORDER.indexOf(a.name)); // la mejor primero
  const limit = OK_ORDER.indexOf("full");
  const best = vids.find((v) => OK_ORDER.indexOf(v.name) <= limit) || vids[0];
  if (best) return best.url;
  const hls = md.hlsManifestUrl || md.ondemandHls || md.hlsMasterPlaylistUrl;
  return typeof hls === "string" && /^https:\/\//.test(hls) ? hls : "";
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
  u = voeMedia(html);
  if (u) return u;
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
  const inline = scripts.filter((x) => x.body.trim()).sort((a, b) => b.body.length - a.body.length);
  const links = embedLinks(html, "").map((u) => hostOf(u) + pathShape(u));
  const js = jsonScripts(html).map((b) => b.length);
  log("embed[" + depth + "] bytes=" + html.length + " titulo=" + (title ? title[1].trim().slice(0, 40) : "-") +
    " video=" + (found ? "si" : "no") + " packed=" + unpackAll(html).length + " atob=" + base64Texts(html).length +
    " json=" + (js.length ? js.join("/") : "0") + " iframes=" + (html.split("<iframe").length - 1) +
    " scriptsInline=" + inline.length + " enlaces=" + links.join(","));
  if (!found && inline.length) log("embed[" + depth + "] script mayor: " + redact(inline[0].body));
}

// Lee la página de un reproductor y busca el video; si no está, sigue los reproductores que esa
// página abre (hasta 2 niveles), porque el de TuDorama suele ser solo una envoltura.
const innerHosts = new Map(); // envoltura -> a qué reproductores apunta

async function embedFromHtml(embedUrl, depth, referer) {
  const d = depth || 0;
  const r = await kino.fetch(embedUrl, { headers: { Referer: referer || TD + "/" }, timeoutMs: EMBED_MS });
  log("embed[" + d + "] " + hostOf(embedUrl) + pathShape(embedUrl) + " status=" + r.status);
  if (!r.ok) return null;
  let html = await r.text();

  // OK.ru: el video sale de su data-options, no de un .mp4 escrito en la página.
  if (/(^|\.)ok\.ru$/i.test(hostOf(embedUrl))) {
    const ok = okMedia(html);
    log("embed[" + d + "] ok.ru video=" + (ok ? "si" : "no"));
    if (ok) return { url: ok, mime: /\.m3u8/i.test(ok) ? "application/x-mpegurl" : "video/mp4", headers: { Referer: "https://ok.ru/", Origin: "https://ok.ru" } };
    return null;
  }

  let u = deepMedia(html);
  if (d === 0) innerHosts.set(embedUrl, embedLinks(html, embedUrl).map(hostOf));
  // Una página diminuta, sin video ni enlaces, suele ser una pantalla de comprobación del servidor:
  // con la cookie que acaba de dejar, el segundo intento trae la página real. Un solo reintento.
  if (!u && d >= 1 && html.length < 3000 && !/byse/i.test(hostOf(embedUrl)) && !embedLinks(html, embedUrl).length) {
    log("embed[" + d + "] página diminuta (" + html.length + " bytes): reintento");
    if (typeof kino.sleep === "function") await kino.sleep(900);
    const r2 = await kino.fetch(embedUrl, { headers: { Referer: referer || TD + "/" }, timeoutMs: EMBED_MS });
    if (r2.ok) {
      const h2 = await r2.text();
      if (h2.length > html.length) { html = h2; u = deepMedia(html); }
    }
  }
  diag(html, d, !!u);
  if (u) {
    log("embed[" + d + "] video elegido: " + hostOf(u) + pathShape(u));
    return { url: u, mime: /\.m3u8/i.test(u) ? "application/x-mpegurl" : "video/mp4", headers: playHeaders(embedUrl) };
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

// ---- DoramasYT: episodios y reproducción -------------------------------------------------------

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

async function dyResolve(url) {
  // Una película de DoramasYT es una ficha /dorama/ con un solo capítulo: se busca ese capítulo.
  if (/\/dorama\//.test(url)) {
    const e = await dyEpisodes(url);
    if (!e.episodes.length) throw NO_VIDEO();
    url = e.episodes[0].ref.slice(3);
  }
  const html = await getHtml(url);
  const btns = [];
  const re = /<button[^>]*data-player=["']([^"']+)["'][^>]*>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = re.exec(html))) btns.push({ token: m[1], name: stripTags(m[2]).toLowerCase() });
  log("dy resolve: servidores=" + btns.map((b) => b.name).join(","));
  if (!btns.length) throw kino.error("unavailable", "sin servidores", {
    userMessage: tr("Este capítulo no trae servidores disponibles.", "This episode has no servers available."),
  });
  const rank = (b) => { const i = SERVER_RANK.indexOf(b.name); return (DEAD_HOST.test(b.name) ? 100 : 0) + (i < 0 ? 50 : i); };
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
  throw NO_VIDEO();
}

// ---- DoramasLat: episodios y reproducción ------------------------------------------------------

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
    const r = await kino.fetch(DL + "/wp-json/dooplayer/v2/" + o.post + "/" + o.type + "/" + encodeURIComponent(o.nume), { headers: { Referer: url }, timeoutMs: EMBED_MS });
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
  throw NO_VIDEO();
}

// ---- DoramasFlix: episodios y reproducción -----------------------------------------------------
// La dirección de un título o capítulo de DoramasFlix lleva al final, si las hay, las claves de sus idiomas latinos:
//   df|d|<slug>|<id>|<claves>   df|m|<slug>|<id>|<claves>   df|e|<id>|<claves>

async function dfEpisodes(spec) {
  const parts = spec.split("|");
  const kind = parts[0], slug = parts[1], id = parts[2];
  const tail = parts[3] ? "|" + parts[3] : "";
  const title = humanSlug(slug);
  if (kind === "m") return { series: { title }, episodes: [{ season: 1, number: 1, ref: "df|m|" + slug + "|" + id + tail, title }] };
  const season = async (n) => {
    const out = [];
    for (let page = 1; page <= 3; page++) {
      const d = await dfQuery('{paginationEpisode(filter:{serie_id:' + JSON.stringify(id) + ',season_number:' + n + '},page:' + page + ',limit:100){items{_id slug episode_number name name_es still_path backdrop} pageInfo{hasNextPage}}}');
      const o = d && d.paginationEpisode;
      if (!o || !o.items) break;
      for (const e of o.items) out.push({ n, e });
      if (!(o.pageInfo && o.pageInfo.hasNextPage)) break;
    }
    return out;
  };
  const res = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((n) => withTimeout(season(n), PAGE_MS + 2000)));
  const list = [];
  for (const r of res) {
    if (r.status !== "fulfilled") continue;
    for (const { n, e } of r.value) {
      if (!e || !e._id) continue;
      const num = Number(e.episode_number) || list.length + 1;
      list.push({ season: n, number: num, ref: "df|e|" + e._id + tail, title: stripTags(e.name_es || e.name) || tr("Episodio ", "Episode ") + num, poster: dfPoster(e.still_path || e.backdrop) });
    }
  }
  log("df episodes: " + list.length);
  if (!list.length) throw kino.error("not_found", "sin capítulos en DoramasFlix", { userMessage: tr("No se encontró la lista de capítulos de este título.", "No episode list found for this title.") });
  list.sort((a, b) => (a.season - b.season) || (a.number - b.number));
  return { series: { title }, episodes: list };
}

// Los enlaces "embedshortener" llevan el enlace real escondido en base64 (sin ejecutar nada).
function dfUnwrap(u) {
  try {
    if (hostOf(u).indexOf("embedshortener") < 0) return u;
    const tok = String(u).split("/").pop().split(".")[1];
    const j = JSON.parse(atob(tok.replace(/-/g, "+").replace(/_/g, "/")));
    const t = atob(String(j.link).replace(/-/g, "+").replace(/_/g, "/"));
    return /^https?:\/\//i.test(t) ? t : u;
  } catch (e) { return u; }
}

// DoramasFlix guarda los idiomas como números (lang). Los nombres vienen en los datos de su página.
let dfLangs = null;
async function dfLangNames() {
  if (dfLangs) return dfLangs;
  const map = {};
  try {
    const r = await kino.fetch(DF + "/", { timeoutMs: EMBED_MS });
    const html = r.ok ? String(await r.text()).replace(/\\"/g, '"') : "";
    const i = html.indexOf('"langs":[');
    if (i >= 0) {
      let d = 0, j = i + 8, end = -1;
      for (; j < html.length; j++) { const c = html.charAt(j); if (c === "[") d++; else if (c === "]") { d--; if (!d) { end = j; break; } } }
      if (end > 0) for (const x of JSON.parse(html.slice(i + 8, end + 1))) if (x && x.code_flix != null) map[String(x.code_flix)] = String(x.name || "");
    }
  } catch (e) { log("df idiomas: no se pudieron leer"); }
  log("df idiomas: " + JSON.stringify(map).slice(0, 160));
  dfLangs = map;
  return map;
}

async function dfResolve(spec) {
  const parts = spec.split("|");
  const isMovie = parts[0] === "m";
  const id = isMovie ? parts[2] : parts[1];
  const latCodes = String((isMovie ? parts[3] : parts[2]) || "").split(",").filter(Boolean);
  const field = isMovie ? "getMovieLinks" : "getEpisodeLinks";
  const d = await dfQuery("{" + field + "(id:" + JSON.stringify(id) + "){links_online{link server lang}}}");
  const raw = (d && d[field] && d[field].links_online) || [];
  // Orden de prueba: los servidores que sí suelen abrir primero; los "muertos" (Byse, DoodStream, Abyss) al final.
  const rank = (u) => { const h = hostOf(u); const i = SERVER_RANK.findIndex((n) => h.indexOf(n) >= 0); return (DEAD_HOST.test(h) ? 100 : 0) + (i < 0 ? 50 : i); };
  const names = await dfLangNames();
  const all = raw.map((x) => ({ u: dfUnwrap(String((x && x.link) || "")), lang: String((x && x.lang) == null ? "" : x.lang) }))
    .filter((x) => /^https?:\/\//i.test(x.u) && hostOf(x.u).indexOf("primeload") < 0);
  // Por lo visto en los registros: el idioma 38 es el latino y el 13109 el subtitulado.
  for (const x of all) {
    x.name = names[x.lang] || (x.lang === "38" ? "Latino" : x.lang === "13109" ? tr("Subtitulado", "Subbed") : "");
    x.latino = /lat/i.test(x.name) || latCodes.indexOf(x.lang) >= 0;
    if (x.latino && !/lat/i.test(x.name)) x.name = "Latino";
  }
  all.sort((a, b) => ((b.latino ? 1 : 0) - (a.latino ? 1 : 0)) || (rank(a.u) - rank(b.u)));
  log("df resolve: enlaces=" + all.map((x) => hostOf(x.u) + ":lang" + x.lang + (x.name ? "(" + x.name + ")" : "")).join(","));
  const links = all.map((x) => x.u);
  const langOf = {};
  for (const x of all) langOf[x.u] = x.name;
  const one = async (u) => {
    if (/\.(?:m3u8|mp4)(\?|$)/i.test(u) && !isDemo(u)) return { url: u, mime: /\.m3u8/i.test(u) ? "application/x-mpegurl" : "video/mp4", headers: { Referer: DF + "/" }, label: "DoramasFlix" };
    const v = await embedFromHtml(u, 0, DF + "/");
    return v ? Object.assign(v, { label: (langOf[u] ? langOf[u] + " · " : "DoramasFlix · ") + hostOf(u) }) : null;
  };
  // Primero solo los servidores en latino; si ninguno abre, se prueban los demás.
  const lat = all.filter((x) => x.latino).map((x) => x.u);
  const otros = all.filter((x) => !x.latino).map((x) => x.u);
  if (lat.length) {
    const fl = await firstSuccess(lat.slice(0, 3).map(one));
    if (fl) return fl.v;
    log("df resolve: el latino no abrió, se prueba el otro idioma");
  }
  const first = await firstSuccess((lat.length ? otros : links).slice(0, 4).map(one));
  if (first) return first.v;
  throw NO_VIDEO();
}

// ---- Entradas: episodes() y resolve() ----------------------------------------------------------

// Los SRC_PRIO ya están definidos arriba (df, td, dl, dy).
export async function episodes(ref) {
  await null;
  const raw = String(ref || "");
  // Tarjeta combinada: se piden las listas de todas las fuentes a la vez y gana la que tenga más capítulos.
  if (raw.startsWith("mx|")) {
    const refs = raw.slice(3).split("||").filter(Boolean).slice(0, 4);
    const res = await Promise.allSettled(refs.map((r) => withTimeout(episodes(r), PAGE_MS + 6000)));
    let best = null;
    let bestI = -1;
    res.forEach((r, i) => {
      if (r.status !== "fulfilled" || !r.value || !r.value.episodes) { log("episodes: falló " + refs[i].slice(0, 2)); return; }
      log("episodes: " + refs[i].slice(0, 2) + "=" + r.value.episodes.length);
      if (!best || r.value.episodes.length > best.episodes.length) { best = r.value; bestI = i; }
    });
    if (!best) throw res[0].reason || kino.error("not_found", "sin lista de episodios");
    // Cada capítulo recuerda los mismos capítulos (misma temporada y número) de las otras fuentes,
    // para poder pasar a otra si la primera no entrega el video.
    const byKey = res.map((r) => {
      const m = new Map();
      if (r.status === "fulfilled" && r.value && r.value.episodes) for (const e of r.value.episodes) m.set(e.season + "x" + e.number, e.ref);
      return m;
    });
    const eps = best.episodes.map((e) => {
      const alts = [e.ref];
      byKey.forEach((m, i) => { if (i !== bestI) { const o = m.get(e.season + "x" + e.number); if (o && alts.indexOf(o) < 0) alts.push(o); } });
      alts.sort((x, y) => (SRC_PRIO[x.slice(0, 2)] || 0) - (SRC_PRIO[y.slice(0, 2)] || 0));
      return alts.length > 1 ? Object.assign({}, e, { ref: "mx|" + alts.join("||") }) : e;
    });
    return Object.assign({}, best, { episodes: eps });
  }
  if (raw.startsWith("df|")) return dfEpisodes(raw.slice(3));
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

// Capítulo con varias fuentes: se prueba la primera y, si falla o tarda, se pasa a la siguiente.
// Prioridad a latino: si una fuente solo entrega subtitulado, se prueban las demás por si alguna lo tiene
// en latino; si ninguna, se queda con el subtitulado.
async function resolveAny(refs) {
  const t0 = Date.now();
  let lastErr = null;
  let fallback = null;
  const canRace = typeof kino.sleep === "function";
  const isSub = (s) => /^(Subtitulado|Subbed)/.test(String((s && s.label) || ""));
  for (let i = 0; i < refs.length; i++) {
    const left = 19000 - (Date.now() - t0);
    if (left < 3500) break;
    const cap = i === refs.length - 1 ? left : Math.min(left, 9000);
    log("resolve: fuente " + (i + 1) + "/" + refs.length + " (" + refs[i].slice(0, 2) + ")");
    const attempt = resolve(refs[i]).catch((e) => { lastErr = e; log("resolve: " + refs[i].slice(0, 2) + " falló"); return null; });
    const got = canRace ? await Promise.race([attempt, sleepUpTo(cap)]) : await attempt;
    if (got && !isSub(got)) return got;
    if (got && !fallback) { fallback = got; log("resolve: solo subtitulado en " + refs[i].slice(0, 2) + ", se busca latino en las otras fuentes"); }
  }
  if (fallback) return fallback;
  throw lastErr || NO_VIDEO();
}

export async function resolve(ref) {
  await null;
  const t0 = Date.now();
  const raw = String(ref || "");
  if (raw.startsWith("mx|")) return resolveAny(raw.slice(3).split("||").filter(Boolean).slice(0, 3));
  if (raw.startsWith("df|")) return dfResolve(raw.slice(3));
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
  throw NO_VIDEO();
}
