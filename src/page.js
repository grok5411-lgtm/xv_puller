import { escapeHtml } from "./site.js";

const ALLOWED_HOSTS = ["xvideos-cdn.com", "xv-ru.com", "xvideos.com"];

export function assetUrl(u) {
  if (!u) return "";
  if (u.startsWith("/a?")) return u;
  let abs = u;
  if (abs.startsWith("//")) abs = "https:" + abs;
  if (!/^https?:\/\//i.test(abs)) return "";
  try {
    const host = new URL(abs).hostname;
    if (!ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h))) return "";
  } catch {
    return "";
  }
  return "/a?u=" + encodeURIComponent(abs);
}

export function renderCard(v) {
  const thumb = assetUrl(v.thumbnail);
  const img = thumb
    ? `<img src="${escapeHtml(thumb)}" loading="lazy" alt="">`
    : "";
  const quality = v.quality
    ? `<span class="top-right-tags"><span class="video-hd-mark">${escapeHtml(v.quality)}</span></span>`
    : "";
  const duration = v.duration
    ? `<span class="duration">${escapeHtml(v.duration)}</span>`
    : "";

  return `<div class="frame-block thumb-block tb_full_init">
  <div class="thumb-inside"><div class="thumb">
    <a href="${escapeHtml(v.url)}" target="_blank" rel="noopener noreferrer">${img}</a>
    ${quality}${duration}
  </div></div>
  <p><a class="title" href="${escapeHtml(v.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(v.title || "Без названия")}</a></p>
</div>`;
}

export function renderPage({ query, videos, seed }) {
  const cards = videos.map(renderCard).join("\n");
  const nextSeed = Math.floor(Math.random() * 1e9);
  const q = escapeHtml(query || "");

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Свежие видео</title>
<link rel="stylesheet" href="/css/base.css">
<link rel="stylesheet" href="/css/spec.css">
<style>
  body{background:#1a1a1a;color:#eee;margin:0;font-family:Arial,Helvetica,sans-serif}
  #header{position:sticky;top:0;z-index:10;background:#111;border-bottom:1px solid #2c2c2c}
  .header-wrap{max-width:1400px;margin:0 auto;display:flex;gap:18px;align-items:center;padding:12px 16px;flex-wrap:wrap}
  .logo{color:#fff;font:bold 26px/1 Arial;text-decoration:none;letter-spacing:-1px}
  .logo b{color:#f90}
  .search{display:flex;flex:1;min-width:260px;gap:8px}
  .search input{flex:1;background:#222;border:1px solid #333;color:#eee;padding:10px 12px;border-radius:4px;font-size:15px;outline:none}
  .search input:focus{border-color:#f90}
  .search button{background:#f90;border:0;color:#000;font-weight:bold;padding:0 18px;border-radius:4px;cursor:pointer;font-size:15px}
  #content{max-width:1400px;margin:0 auto;padding:18px 16px 60px}
  .mozaique{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
  .thumb-block{background:transparent;margin:0}
  .thumb{position:relative;overflow:hidden;border-radius:4px;background:#000;aspect-ratio:16/9}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .thumb .duration{position:absolute;right:6px;bottom:6px;background:rgba(0,0,0,.75);color:#fff;font-size:12px;padding:2px 5px;border-radius:3px}
  .top-right-tags{position:absolute;right:6px;top:6px}
  .video-hd-mark{background:#f90;color:#000;font-size:11px;font-weight:bold;padding:2px 5px;border-radius:3px}
  .title{display:block;color:#ddd;font-size:13px;line-height:1.35;text-decoration:none;margin-top:6px;max-height:2.7em;overflow:hidden}
  .title:hover{color:#f90}
  .bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;color:#999;font-size:13px}
  .bar a{color:#f90;text-decoration:none}
  .empty{padding:60px 20px;text-align:center;color:#888}
  footer{max-width:1400px;margin:0 auto;padding:20px 16px;color:#666;font-size:12px;border-top:1px solid #2c2c2c}
</style>
</head>
<body>
<header id="header">
  <div class="header-wrap">
    <a class="logo" href="/">X<b>VIDEOS</b></a>
    <form class="search" action="/" method="get">
      <input type="search" name="q" value="${q}" placeholder="Опиши, что хочешь посмотреть" autocomplete="off">
      <button type="submit">Смотреть</button>
    </form>
  </div>
</header>
<main id="content">
  <div class="bar"><span>${videos.length} видео</span><a href="/?q=${encodeURIComponent(query || "")}&seed=${nextSeed}">Обновить ленту</a></div>
  ${cards ? `<div class="mozaique cust-nb-cols">${cards}</div>` : `<div class="empty">Ничего не нашлось. Попробуй описать иначе.</div>`}
</main>
<footer>xv_puller · лента генерируется процедурно</footer>
</body>
</html>`;
}
