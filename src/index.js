/**
 * xv_puller — Cloudflare Worker
 *
 * GET /                     — страница-лента (?q=описание)
 * GET /feed?q=...           — та же лента в JSON
 * GET /tags                 — все теги (JSON), ?format=text — построчно
 * GET /pick?tag=daddy&page=5 — случайное видео по тегу
 * GET /random               — случайный тег + страница + видео
 * GET /logs?limit=50        — последние записи лога (NDJSON)
 * GET /a?u=<url>            — прокси картинок (allowed: xv-*.cdn)
 *
 * Секреты: GITHUB_TOKEN (Contents: Read and write)
 * Переменные: BASE_URL, GITHUB_REPO, GITHUB_BRANCH, GITHUB_LOG_PATH
 */

import {
  DEFAULT_BASE, UA, clampPage, getHtml, lastPage, normalizeTag, parseTags, parseVideos,
} from "./site.js";
import { buildFeed } from "./feed.js";
import { renderPage } from "./page.js";

const DEFAULT_REPO = "grok5411-lgtm/xv_puller";
const DEFAULT_BRANCH = "logs";
const DEFAULT_LOG_PATH = "logs/requests.log";
const MAX_LOG_LINES = 300;

const ASSET_HOSTS = ["xvideos-cdn.com", "xv-ru.com", "xvideos.com"];

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
          return await handlePage(base, url, env, ctx, started);
        case "/feed":
          return await handleFeed(base, url, env, ctx, started);
        case "/a":
          return await handleAsset(url);
        case "/tags":
          return await handleTags(base, url);
        case "/pick":
          return await handlePick(base, url, env, ctx, started);
        case "/random":
          return await handleRandom(base, env, ctx, started);
        case "/logs":
          return await handleLogs(env, url);
        default:
          return json({ error: "not found", endpoints: ["/", "/feed", "/tags", "/pick", "/random", "/logs"] }, 404);
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

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function handlePage(base, url, env, ctx, started) {
  if (env.ASSETS) {
    const assetUrl = new URL("/template.html", url);
    const res = await env.ASSETS.fetch(new Request(assetUrl, { headers: request0Headers() }));
    if (res.ok) {
      let html = await res.text();
      html = html.replace(
        /<\/body>/i,
        '<script src="/app.js" defer></script></body>'
      );
      ctx.waitUntil(
        writeLog(env, {
          ts: new Date().toISOString(),
          path: "/",
          q: url.searchParams.get("q") || "",
          status: "ok",
          mode: "template",
          ms: Date.now() - started,
        })
      );
      return new Response(html, {
        headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" },
      });
    }
  }

  const q = (url.searchParams.get("q") || "").trim();
  const seed = url.searchParams.get("seed") || (q ? todayKey() : String(Date.now()));

  let videos = [];
  let tags = [];
  let error = "";

  try {
    const feed = await buildFeed(base, q, seed);
    videos = feed.videos;
    tags = feed.tags;
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }

  ctx.waitUntil(
    writeLog(env, {
      ts: new Date().toISOString(),
      path: "/",
      q,
      seed,
      tags,
      count: videos.length,
      status: error ? "error" : "ok",
      error: error ? error.slice(0, 200) : undefined,
      ms: Date.now() - started,
    })
  );

  const html = renderPage({ query: q, videos, seed, error });
  return new Response(html, {
    headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" },
  });
}

function request0Headers() {
  return { "User-Agent": UA, Accept: "text/html" };
}

async function handleFeed(base, url, env, ctx, started) {
  const q = (url.searchParams.get("q") || "").trim();
  const seed = url.searchParams.get("seed") || (q ? todayKey() : String(Date.now()));
  const size = Math.min(parseInt(url.searchParams.get("size") || "36", 10) || 36, 60);

  const feed = await buildFeed(base, q, seed, size);
  ctx.waitUntil(
    writeLog(env, {
      ts: new Date().toISOString(),
      path: "/feed",
      q,
      tags: feed.tags,
      count: feed.videos.length,
      status: "ok",
      ms: Date.now() - started,
    })
  );

  return json({
    q,
    seed,
    tags: feed.tags,
    count: feed.videos.length,
    videos: feed.videos,
  });
}

async function handleAsset(url) {
  const raw = url.searchParams.get("u");
  if (!raw) return new Response("missing u", { status: 400, headers: CORS });

  let target;
  try {
    target = new URL(raw);
  } catch {
    return new Response("bad u", { status: 400, headers: CORS });
  }
  if (!/^https?:$/.test(target.protocol)) {
    return new Response("bad protocol", { status: 400, headers: CORS });
  }
  const host = target.hostname;
  if (!ASSET_HOSTS.some((h) => host === h || host.endsWith("." + h))) {
    return new Response("host not allowed", { status: 403, headers: CORS });
  }

  const r = await fetch(target.toString(), {
    headers: { "User-Agent": UA, Referer: "https://www.xv-ru.com/" },
    cf: { cacheEverything: true, cacheTtl: 86400 },
  });
  if (!r.ok) return new Response("upstream " + r.status, { status: 502, headers: CORS });

  return new Response(r.body, {
    status: 200,
    headers: {
      ...CORS,
      "Content-Type": r.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

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

  let page = wantedPage ? clampPage(wantedPage, pages) : 1 + Math.floor(Math.random() * pages);
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
      `log: ${entry.path} ${entry.tag || entry.q || "-"} ${entry.page || ""}`.trim());
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

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

export function help(base) {
  return `xv_puller
base: ${base}

GET /                        — лента (?q=описание)
GET /feed?q=...              — лента в JSON
GET /tags                    — список тегов
GET /pick?tag=daddy          — случайное видео
GET /random                  — случайный тег целиком
GET /logs?limit=50           — лог
`;
}
