export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const DEFAULT_BASE = "https://www.xv-ru.com";

export async function getHtml(base, path) {
  const r = await fetch(base + path, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.7",
      Referer: base + "/",
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} для ${path}`);
  return await r.text();
}

export function lastPage(html, tagPath) {
  let pages = 1;

  const m = html.match(/class="last-page"[^>]*>\s*(\d+)\s*</i);
  if (m) pages = Math.max(pages, parseInt(m[1], 10));

  const re = new RegExp(escapeRe(tagPath) + "/(\\d+)", "g");
  let x;
  while ((x = re.exec(html))) {
    pages = Math.max(pages, parseInt(x[1], 10) + 1);
  }
  return pages;
}

export function parseVideos(html, base) {
  const starts = [];
  const re = /<div[^>]*\bid="video_([\w-]+)"/g;
  let m;
  while ((m = re.exec(html))) starts.push({ at: m.index, id: m[1] });

  const out = [];
  const seen = new Set();

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i].at;
    const end = i + 1 < starts.length ? starts[i + 1].at : Math.min(html.length, start + 5000);
    const block = html.slice(start, end);

    const a =
      block.match(/<a\s+href="(\/video\.[^"]+)"[^>]*?\btitle="([^"]*)"/s) ||
      block.match(/<a\s+[^>]*?\btitle="([^"]*)"[^>]*?\bhref="(\/video\.[^"]+)"/s);
    let href, title;
    if (a) {
      if (a[0].indexOf("href=") < a[0].indexOf("title=")) {
        href = a[1];
        title = a[2];
      } else {
        title = a[1];
        href = a[2];
      }
    } else {
      const h = block.match(/href="(\/video\.[^"]+)"/);
      if (!h) continue;
      href = h[1];
      const t = block.match(/\btitle="([^"]*)"/);
      title = t ? t[1] : "";
    }
    if (seen.has(href)) continue;
    seen.add(href);

    const thumb =
      (block.match(/data-src="(https?:\/\/[^"]+)"/) || [])[1] ||
      (block.match(/<img[^>]+src="(https?:\/\/[^"]+\.(?:jpe?g|webp))"/) || [])[1] ||
      (block.match(/data-mzl="(https?:\/\/[^"]+)"/) || [])[1] ||
      "";
    const duration = ((block.match(/<span class="duration">([^<]+)<\/span>/) || [])[1] || "").trim();
    const quality = ((block.match(/video-(?:hd|sd)-mark">([^<]+)</) || [])[1] || "").trim();

    out.push({
      id: starts[i].id,
      url: base + href,
      title: decodeEntities(title).trim(),
      thumbnail: thumb,
      duration,
      quality,
    });
  }
  return out;
}

export function parseTags(html) {
  const out = [];
  const seen = new Set();
  const re = /\/tags\/([A-Za-z0-9][A-Za-z0-9\-_.%]*)/g;
  let m;
  while ((m = re.exec(html))) {
    let slug;
    try {
      slug = decodeURIComponent(m[1]).replace(/^\/+|\/+$/g, "");
    } catch {
      slug = m[1];
    }
    if (slug.length <= 2 || /^\d+$/.test(slug)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

export function normalizeTag(tag) {
  let t = String(tag).trim();
  if (/^https?:\/\//i.test(t)) {
    try {
      t = new URL(t).pathname;
    } catch {}
  }
  t = t.replace(/^\/?tags\//i, "").replace(/\/+$/, "");
  return t;
}

export function clampPage(raw, pages) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, pages);
}

export function randInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

export function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}
