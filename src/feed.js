import taxonomy from "./taxonomy.json";
import { getHtml, lastPage, parseVideos } from "./site.js";

/* ------------------------- seeded randomness ------------------------ */

export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* --------------------------- persona -> tags ------------------------ */

/** Разбирает запрос вроде "история просмотра альтушки готки" в набор тегов. */
export function personaTags(query) {
  const q = String(query || "").toLowerCase();
  if (!q.trim()) return [];

  const hits = taxonomy.clusters
    .map((c) => ({
      cluster: c,
      pos: Math.min(
        ...c.aliases.map((a) => {
          const i = q.indexOf(a);
          return i < 0 ? Infinity : i;
        })
      ),
    }))
    .filter((h) => h.pos !== Infinity)
    .sort((a, b) => a.pos - b.pos);

  const tags = [];
  for (const { cluster } of hits) {
    for (const t of cluster.tags) if (!tags.includes(t)) tags.push(t);
  }
  return tags;
}

/* ------------------------------ feed -------------------------------- */

const MAX_PAGES = 4;

export async function buildFeed(base, query, seedStr, size = 36) {
  const rng = mulberry32(hashStr(`${query}|${seedStr}`));

  let tags = personaTags(query);
  if (!tags.length) tags = shuffle(taxonomy.chaos, rng);

  const chosen = tags.slice(0, MAX_PAGES);
  if (chosen.length < MAX_PAGES) {
    for (const t of shuffle(taxonomy.chaos, rng)) {
      if (chosen.length >= MAX_PAGES) break;
      if (!chosen.includes(t)) chosen.push(t);
    }
  }

  const results = await Promise.allSettled(
    chosen.map((tag) => videosFromTag(base, tag, rng))
  );

  const seen = new Set();
  const all = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const v of r.value) {
      if (seen.has(v.url)) continue;
      seen.add(v.url);
      all.push(v);
    }
  }

  const videos = shuffle(all, rng).slice(0, size);
  return { tags: chosen, videos, found: all.length };
}

async function videosFromTag(base, tag, rng) {
  const tagPath = "/tags/" + encodeURIComponent(tag);
  const html = await getHtml(base, tagPath);
  const pages = lastPage(html, tagPath);

  const page = pages > 1 ? 1 + Math.floor(rng() * pages) : 1;
  if (page === 1) return parseVideos(html, base);

  try {
    const pageHtml = await getHtml(base, `${tagPath}/${page - 1}`);
    const v = parseVideos(pageHtml, base);
    return v.length ? v : parseVideos(html, base);
  } catch {
    return parseVideos(html, base);
  }
}
