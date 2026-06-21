/* 끌림의 해부 — 테마 토글 · 활성 내비 · 스크롤 리빌 · 체크리스트 저장 */
(function () {
  var root = document.documentElement;
  var KEY_THEME = "magnetism-theme";
  var KEY_CHECK = "magnetism-check";

  /* ---- 테마: 저장값 > 시스템 > 다크 ---- */
  function applyTheme(t) { root.setAttribute("data-theme", t); }
  var saved = null;
  try { saved = localStorage.getItem(KEY_THEME); } catch (e) {}
  if (saved === "light" || saved === "dark") {
    applyTheme(saved);
  } else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) {
    applyTheme("light");
  } else {
    applyTheme("dark");
  }

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
    try { localStorage.setItem(KEY_THEME, next); } catch (er) {}
  });

  /* ---- 활성 내비 ---- */
  var here = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  if (here === "" ) here = "index.html";
  document.querySelectorAll(".nav a").forEach(function (a) {
    var href = (a.getAttribute("href") || "").toLowerCase();
    if (href === here || (here === "index.html" && (href === "./" || href === "index.html"))) {
      a.classList.add("active");
    }
  });

  /* ---- 스크롤 리빌 ---- */
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---- 체크리스트(종합 페이지) ---- */
  var list = document.querySelector("[data-check-list]");
  if (list) {
    var state = {};
    try { state = JSON.parse(localStorage.getItem(KEY_CHECK) || "{}") || {}; } catch (e) { state = {}; }
    var items = Array.prototype.slice.call(list.querySelectorAll(".check-item"));
    var progEl = document.querySelector("[data-check-prog]");

    function save() { try { localStorage.setItem(KEY_CHECK, JSON.stringify(state)); } catch (e) {} }
    function paint() {
      var done = 0;
      items.forEach(function (it) {
        var id = it.getAttribute("data-id");
        var on = !!state[id];
        it.setAttribute("aria-checked", on ? "true" : "false");
        if (on) done++;
      });
      if (progEl) progEl.innerHTML = "<b>" + done + "</b> / " + items.length;
    }
    items.forEach(function (it) {
      it.setAttribute("role", "checkbox"); it.setAttribute("tabindex", "0");
      function toggle() {
        var id = it.getAttribute("data-id");
        state[id] = !state[id];
        save(); paint();
      }
      it.addEventListener("click", toggle);
      it.addEventListener("keydown", function (e) {
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); }
      });
    });
    var reset = document.querySelector("[data-check-reset]");
    if (reset) reset.addEventListener("click", function () { state = {}; save(); paint(); });
    paint();
  }
})();
