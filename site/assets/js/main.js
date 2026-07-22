/* Hone / RelayBench landing — progressive enhancement only.
   The page is fully functional with JS disabled. */
(function () {
  "use strict";

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Staggered scroll reveal */
  var revealed = document.querySelectorAll(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    revealed.forEach(function (el) { el.classList.add("is-visible"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        var siblings = Array.prototype.filter.call(
          el.parentElement.children,
          function (c) { return c.classList.contains("reveal"); }
        );
        var idx = siblings.indexOf(el);
        el.style.transitionDelay = Math.min(idx, 4) * 70 + "ms";
        el.classList.add("is-visible");
        io.unobserve(el);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    revealed.forEach(function (el) { io.observe(el); });
  }

  /* Active-section highlight in nav */
  var navLinks = Array.prototype.slice.call(
    document.querySelectorAll(".site-nav a[href^='#']")
  );
  var sections = navLinks
    .map(function (a) { return document.getElementById(a.hash.slice(1)); })
    .filter(Boolean);
  if (sections.length && "IntersectionObserver" in window) {
    var current = null;
    var nav = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        current = entry.target.id;
        navLinks.forEach(function (a) {
          a.classList.toggle("is-active", a.hash === "#" + current);
        });
      });
    }, { rootMargin: "-30% 0px -60% 0px" });
    sections.forEach(function (s) { nav.observe(s); });
  }
})();
