/**
 * xv_puller — Cloudflare Worker
 *
 * GET /                 — справка
 * GET /tags             — все теги (JSON), ?format=text — построчно
 * GET /pick?tag=daddy&page=5 — случайное видео
 * GET /random           — случайный тег + страница + видео
 * GET /logs?limit=50    — последние записи лога
 *
 * Секреты (wrangler secret put):
 *   GITHUB_TOKEN — fine-grained PAT, Contents: Read and write
 * Переменные ([vars]):
 *   BASE_URL, GITHUB_REPO, GITHUB_BRANCH, GITHUB_LOG_PATH
 */

const DEFAULT_BASE = "https://www.xv-ru.com";
const DEFAULT_REPO = "grok5411-lgtm/xv_puller";
const DEFAULT_BRANCH = "logs";
const DEFAULT_LOG_PATH = "logs/requests.log";
const MAX_LOG_LINES = 300;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const base = (env.BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const started = Date.now();

    try {
      switch (url.pathname) {
        case "/":
          return text(help(base));
        case "/tags":
          return await handleTags(base, url);
        case "/pick":
          return await handlePick(base, url, env, ctx, started);
        case "/random":
          return await handleRandom(base, env, ctx, started);
        case "/logs":
          return await handleLogs(env, url);
        default:
          return json({ error: "not found", endpoints: ["/tags", "/pick", "/random", "/logs"] }, 404);
      }
    } catch (e) {
      const message = String(e && e.message ? e.message : e);
      ctx.waitUntil(
        writeLog(env, {
          ts: new Date().toISOString(),
          path: url.pathname,
          query: url.search,
          status: "error",
          error: message.slice(0, 300),
          ms: Date.now() - started,
        })
      );
      return json(
        {
          error: message,
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

async function handlePick(base, url, env, ctx, started) {
  let tag = (url.searchParams.get("tag") || "").trim();
  if (!tag) {
    const tags = parseTags(await getHtml(base, "/tags"));
    if (!tags.length) throw new Error("не удалось получить список тегов");
    tag = tags[Math.floor(Math.random() * tags.length)];
  }
  tag = normalizeTag(tag);
  const result = await pickForTag(base, tag, url.searchParams.get("page"));

  ctx.waitUntil(
    writeLog(env, {
      ts: new Date().toISOString(),
      path: "/pick",
      tag: result.tag,
      page: result.page,
      pages: result.pages,
      video: result.video.url,
      title: result.video.title.slice(0, 120),
      ms: Date.now() - started,
    })
  );
  return json(result);
}

async function handleRandom(base, env, ctx, started) {
  const tags = parseTags(await getHtml(base, "/tags"));
  if (!tags.length) throw new Error("не удалось получить список тегов");
  const tag = tags[Math.floor(Math.random() * tags.length)];
  const result = await pickForTag(base, tag, null);

  ctx.waitUntil(
    writeLog(env, {
      ts: new Date().toISOString(),
      path: "/random",
      tag: result.tag,
      page: result.page,
      pages: result.pages,
      video: result.video.url,
      title: result.video.title.slice(0, 120),
      ms: Date.now() - started,
    })
  );
  return json(result);
}

async function handleLogs(env, url) {
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const branch = env.GITHUB_BRANCH || DEFAULT_BRANCH;
  const path = env.GITHUB_LOG_PATH || DEFAULT_LOG_PATH;
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, MAX_LOG_LINES);

  const file = await ghGet(env, repo, path, branch);
  if (!file) return json({ count: 0, log: [] });
  const lines = file.text.split("\n").filter(Boolean).slice(-limit);
  return new Response(lines.join("\n") + "\n", {
    headers: { ...CORS, "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
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

/* ------------------------------ logs -------------------------------- */

async function writeLog(env, entry) {
  const token = env.GITHUB_TOKEN;
  if (!token) return;

  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const branch = env.GITHUB_BRANCH || DEFAULT_BRANCH;
  const path = env.GITHUB_LOG_PATH || DEFAULT_LOG_PATH;

  try {
    const file = await ghGet(env, repo, path, branch);
    const old = file ? file.text.split("\n").filter(Boolean) : [];
    const lines = old.concat(JSON.stringify(entry)).slice(-MAX_LOG_LINES);
    const body = lines.join("\n") + "\n";

    await ghPut(env, repo, path, branch, body, file ? file.sha : null,
      `log: ${entry.path} ${entry.tag || "-"} ${entry.page || "-"}`);
  } catch {
    // логи не должны ломать ответ
  }
}

async function ghGet(env, repo, path, ref) {
  const r = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    { headers: ghHeaders(env) }
  );
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`gh get ${r.status}`);
  const data = await r.json();
  return { sha: data.sha, text: b64decode(data.content || "") };
}

async function ghPut(env, repo, path, branch, body, sha, message) {
  const payload = {
    message,
    content: b64encode(body),
    branch,
    ...(sha ? { sha } : {}),
  };
  let r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders(env),
    body: JSON.stringify(payload),
  });

  if (r.status === 404 || r.status === 409 || r.status === 422) {
    await ensureBranch(env, repo, branch);
    r = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
      method: "PUT",
      headers: ghHeaders(env),
      body: JSON.stringify({ ...payload, sha: undefined }),
    });
  }
  if (!r.ok) throw new Error(`gh put ${r.status}`);
}

async function ensureBranch(env, repo, branch) {
  const ref = await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/main`, {
    headers: ghHeaders(env),
  });
  if (!ref.ok) return;
  const { object } = await ref.json();
  await fetch(`https://api.github.com/repos/${repo}/git/refs`, {
    method: "POST",
    headers: ghHeaders(env),
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: object.sha }),
  });
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "xv-puller-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function b64encode(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s) {
  const bin = atob(s.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
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
GET /logs?limit=50           — последние записи лога (NDJSON)
`;
}
