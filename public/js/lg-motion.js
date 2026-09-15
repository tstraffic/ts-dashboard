/* Atomis — Liquid Glass motion layer.
   1. Sliding glass thumb under any [data-lg-segment] container: the thumb is
      an absolutely positioned sibling appended AFTER the buttons (so clicks
      still land on the buttons) and is repositioned whenever the active child
      changes (class / aria-selected / aria-pressed), the container resizes or
      scrolls, or the window resizes. Add data-lg-segment="underline" for a
      2px bar variant (fleet detail tabs).
   2. #globalFab.is-open mirrors the menu's hidden state so CSS can morph the
      toggle into the sheet above it.
   Everything bails under prefers-reduced-motion: reduce (the CSS keeps the
   native active fills in that case). No dependencies. */
(function () {
  'use strict';
  var mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  if (mq && mq.matches) return;

  var ACTIVE = '[aria-selected="true"], .is-active, .active, [aria-pressed="true"]';
  var segments = [];

  function activeChild(el) {
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.classList.contains('lg-seg-thumb')) continue;
      if (k.matches(ACTIVE)) return k;
    }
    return null;
  }

  function place(seg, immediate) {
    var el = seg.el, thumb = seg.thumb;
    var active = activeChild(el);
    if (!active) { thumb.style.width = '0px'; return; }
    var cr = el.getBoundingClientRect();
    var ar = active.getBoundingClientRect();
    var x = (ar.left - cr.left) + el.scrollLeft - (parseFloat(getComputedStyle(el).borderLeftWidth) || 0);
    if (immediate) thumb.style.transition = 'none';
    thumb.style.width = ar.width + 'px';
    thumb.style.transform = 'translateX(' + x + 'px)';
    if (immediate) {
      // flush, then hand transitions back to the stylesheet
      void thumb.offsetWidth;
      thumb.style.transition = '';
    }
  }

  function initSegment(el) {
    if (el.__lgSeg) return;
    var thumb = document.createElement('span');
    thumb.className = 'lg-seg-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    el.appendChild(thumb);
    var seg = { el: el, thumb: thumb };
    el.__lgSeg = seg;
    segments.push(seg);
    place(seg, true);
    requestAnimationFrame(function () { el.classList.add('lg-seg-ready'); });
    var mo = new MutationObserver(function () { place(seg, false); });
    mo.observe(el, { attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-pressed'], subtree: true, childList: true });
    if (window.ResizeObserver) new ResizeObserver(function () { place(seg, true); }).observe(el);
    el.addEventListener('scroll', function () { place(seg, true); }, { passive: true });
    // Fonts can land after first paint and change widths.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { place(seg, true); });
  }

  function refresh() {
    var list = document.querySelectorAll('[data-lg-segment]');
    for (var i = 0; i < list.length; i++) initSegment(list[i]);
  }

  window.addEventListener('resize', function () {
    for (var i = 0; i < segments.length; i++) place(segments[i], true);
  });

  function initFab() {
    var fab = document.getElementById('globalFab');
    var menu = document.getElementById('globalFabMenu');
    if (!fab || !menu) return;
    var sync = function () { fab.classList.toggle('is-open', !menu.classList.contains('hidden')); };
    new MutationObserver(sync).observe(menu, { attributes: true, attributeFilter: ['class'] });
    sync();
  }

  function boot() { refresh(); initFab(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.lgMotion = { refresh: refresh };
})();
