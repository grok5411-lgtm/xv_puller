(function () {
  const params = new URLSearchParams(location.search);
  const q = params.get("q") || "";
  const seed = params.get("seed") || "";
  const p = params.get("p") || "";

  const form = document.getElementById("xv-search-form");
  if (form) {
    const input = form.querySelector('input[name="k"]');
    if (input) input.value = q;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const v = input ? input.value.trim() : "";
      location.href = "/?q=" + encodeURIComponent(v);    });
  }

  document.querySelectorAll(".search-premium-tabs, .search-filters, .pagination").forEach(function (el) {
    el.remove();
  });

  const grid = document.querySelector(".mozaique");
  if (!grid) return;

  const title = document.querySelector("h2.page-title");
  grid.innerHTML = '<div style="padding:40px;color:#999">Загрузка…</div>';

  let reserve = [];
  let persona = "guest_00";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function thumbUrl(u) {
    if (!u) return "";
    try {
      const h = new URL(u).hostname;
      if (/(^|\.)xvideos-cdn\.com$/.test(h) || /(^|\.)xv-ru\.com$/.test(h)) {
        return "/a?u=" + encodeURIComponent(u);
      }
    } catch (e) {}
    return u;
  }

  function card(v) {
    const thumb = thumbUrl(v.thumbnail);
    const q = v.quality
      ? '<span class="top-right-tags"><span class="video-hd-mark">' + esc(v.quality) + "</span></span>"
      : "";
    const dur = v.duration ? '<span class="duration">' + esc(v.duration) + "</span>" : "";
    return (
      '<div id="video_' + esc(v.id) + '" class="frame-block thumb-block tb_full_init tbm-init-ok" data-vid="' + esc(v.url) + '">' +
        '<div class="thumb-inside"><div class="thumb">' +
          '<a href="' + esc(v.url) + '" target="_blank" rel="noopener noreferrer">' +
            (thumb ? '<img src="' + esc(thumb) + '" loading="lazy" alt="">' : "") +
            q + dur +
          "</a></div></div>" +
        '<div class="thumb-under">' +
          '<p class="title"><a href="' + esc(v.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(v.title) + '">' +
            esc(v.title) + "</a></p>" +
          '<p class="metadata"><span class="bg">' + dur + "</span></p>" +
        "</div>" +
      "</div>"
    );
  }

  function swapBroken(img) {
    const block = img.closest(".thumb-block");
    if (!block) return;
    const next = reserve.shift();
    if (!next) { block.remove(); return; }
    block.outerHTML = card(next);
    bindFallback(block.parentNode);
  }

  function bindFallback(root) {
    root.querySelectorAll(".thumb img").forEach(function (img) {
      if (img.dataset.bound) return;
      img.dataset.bound = "1";
      img.addEventListener("error", function () { swapBroken(img); });
    });
  }

  function setTitle(n) {
    const html = 'Ваша история <span class="sub">(аккаунт: ' + esc(persona) + ")</span>";
    if (title) title.innerHTML = html;
    document.title = "Ваша история (аккаунт: " + persona + ")";
    const sub = title && title.querySelector(".sub");
    if (sub && n != null) sub.textContent = "(аккаунт: " + persona + ")";
  }

  function load(url, append) {
    return fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.videos) throw new Error(data && data.error || "ошибка");
        persona = data.persona || persona;
        reserve = reserve.concat(data.reserve || []);
        const html = data.videos.map(card).join("");
        if (append) grid.insertAdjacentHTML("beforeend", html);
        else grid.innerHTML = html;
        setTitle();
        bindFallback(grid);
        return data;
      })
      .catch(function (e) {
        grid.innerHTML = '<div style="padding:40px;color:#c66">Не удалось загрузить ленту: ' + esc(e.message) + "</div>";
      });
  }

  function feedUrl(s) {
    return (
      "/feed?q=" + encodeURIComponent(q) +
      (p ? "&p=" + encodeURIComponent(p) : "") +
      (s ? "&seed=" + encodeURIComponent(s) : "")
    );
  }

  setTitle();
  load(feedUrl(seed), false);

  const more = document.createElement("button");
  more.textContent = "Показать ещё";
  more.className = "btn btn-default";
  more.style.cssText = "display:block;margin:24px auto;padding:10px 24px;cursor:pointer";
  more.addEventListener("click", function () {
    more.disabled = true;
    load(feedUrl(String(Math.floor(Math.random() * 1e9))), true)
      .finally(function () { more.disabled = false; });
  });
  grid.parentNode.insertBefore(more, grid.nextSibling);
})();
