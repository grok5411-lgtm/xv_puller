/**
 * xv_puller — Cloudflare Worker
 *
 * Прокси к xv-ru.com: случайный тег -> случайная страница -> случайное видео.
 *
 * GET /                 — справка
 * GET /tags             — JSON: все теги со страницы /tags
 * GET /pick?tag=daddy&page=5  — случайное видео с указанной/случайной страницы
 * GET /random           — случайный тег + случайная страница + случайное видео
 * GET /tags?format=text — теги построчно (text/plain)
 *
 * Переменные окружения (wrangler.toml [vars]):
 *   BASE_URL — по умолчанию https://www.xv-ru.com
 */

const DEFAULT_BASE = "https://www.xv-ru.com";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const base = (env.BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      switch (url.pathname) {
        case "/":
          return text(help(base));
        case "/tags":
          return await handleTags(base, url);
        case "/pick":
          return await handlePick(base, url);
        case "/random":
          return await handleRandom(base);
        default:
          return json({ error: "not found", endpoints: ["/tags", "/pick", "/random"] }, 404);
      }
    } catch (e) {
      return json(
        {
          error: String(e && e.message ? e.message : e),
          hint:
            "Если это 403/timeout с xv-ru.com — сайт блокирует IP Cloudflare. " +
            "Нужен исходящий прокси или другой хост.",
        },
        502
      );
    }
  },
};

/* ----------------------------- handlers ----------------------------- */

async function handleTags(base, url) {
  const tags = parseTags(await getHtml(base, "/tags"));
  if (url.searchParams.get("format") === "text") {
    return new Response(tags.join("\n") + "\n", {
      headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  return json({ count: tags.length, tags });
}

async function handlePick(base, url) {
  let tag = (url.searchParams.get("tag") || "").trim();
  if (!tag) {
    const tags = parseTags(await getHtml(base, "/tags"));
    if (!tags.length) throw new Error("не удалось получить список тегов");
    tag = tags[Math.floor(Math.random() * tags.length)];
  }
  tag = normalizeTag(tag);
  const result = await pickForTag(base, tag, url.searchParams.get("page"));
  return json(result);
}

async function handleRandom(base) {
  const tags = parseTags(await getHtml(base, "/tags"));
  if (!tags.length) throw new Error("не удалось получить список тегов");
  const tag = tags[Math.floor(Math.random() * tags.length)];
  const result = await pickForTag(base, tag, null);
  return json(result);
}

/* --------------------------- core logic ----------------------------- */

async function pickForTag(base, tag, wantedPage) {
  const tagPath = "/tags/" + encodeURIComponent(tag);
  const html = await getHtml(base, tagPath);
  const pages = lastPage(html, tagPath);

  let page = wantedPage ? clampPage(wantedPage, pages) : randInt(1, pages);
  let pagePath = page === 1 ? tagPath : `${tagPath}/${page - 1}`;
  let videos = parseVideos(html, base);

  if (page !== 1) {
    try {
      const pageHtml = await getHtml(base, pagePath);
      const parsed = parseVideos(pageHtml, base);
      if (parsed.length) videos = parsed;
      else page = 1;
    } catch {
      page = 1;
      pagePath = tagPath;
    }
  }

  if (!videos.length) throw new Error(`тег ${tag}: видео не найдены`);

  const v = videos[Math.floor(Math.random() * videos.length)];
  return {
    tag,
    page,
    pages,
    pageUrl: base + pagePath,
    video: v,
    candidates: videos.length,
  };
}

function lastPage(html, tagPath) {
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

function parseVideos(html, base) {
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

function parseTags(html) {
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

/* ----------------------------- helpers ------------------------------ */

async function getHtml(base, path) {
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

function normalizeTag(tag) {
  let t = String(tag).trim();
  if (/^https?:\/\//i.test(t)) {
    try {
      t = new URL(t).pathname;
    } catch {}
  }
  t = t.replace(/^\/?tags\//i, "").replace(/\/+$/, "");
  return t;
}

function clampPage(raw, pages) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, pages);
}

function randInt(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(s) {
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

function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function help(base) {
  return `xv_puller
base: ${base}

GET /tags                    — список тегов (JSON)
GET /tags?format=text        — то же, построчно
GET /pick?tag=daddy          — случайная страница + случайное видео
GET /pick?tag=daddy&page=5   — конкретная страница
GET /random                  — случайный тег целиком
`;
}
