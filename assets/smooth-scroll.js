// Smooth wheel scrolling.
//
// Many mice scroll in notches: each click jumps the page ~100px in a single
// frame, so the page moves in chunks. This turns wheel input into a glide:
// wheel deltas add up into a target position, and every frame the page moves
// a fraction of the way there (an exponential ease, ~0.35 s to settle), so a
// burst of notches becomes one continuous motion. The same approach as
// libraries like Lenis, in a few lines.
//
// Only the wheel is handled. Keyboard, scrollbar dragging, touch, anchor
// links and the cards' own scrollIntoView keep their native behaviour; when
// they move the page, the target simply follows. Ctrl/⌘ + wheel (zoom) and
// horizontal scrolling pass through, and nothing changes for visitors who
// prefer reduced motion.

(function () {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  var EASE = 10;          // per second; higher settles faster (10 ≈ 0.35 s)
  var LINE = 33;          // px per "line" for wheels that report lines (Firefox)
  var root = document.scrollingElement || document.documentElement;
  var target = window.scrollY, current = window.scrollY;
  var running = false, last = 0, ours = false;

  function maxScroll() { return Math.max(0, root.scrollHeight - window.innerHeight); }

  // Something inside the page that can still scroll in this direction gets
  // the wheel natively (none today, but future cards or code blocks might).
  function nestedScroller(el, dy) {
    for (; el && el !== document.body && el !== root; el = el.parentElement) {
      var style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY) || el.scrollHeight <= el.clientHeight) continue;
      if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
    }
    return false;
  }

  function onWheel(e) {
    if (e.ctrlKey || e.metaKey || e.defaultPrevented) return;          // zoom, or someone else's
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;               // horizontal
    var dy = e.deltaY * (e.deltaMode === 1 ? LINE : e.deltaMode === 2 ? window.innerHeight : 1);
    if (nestedScroller(e.target, dy)) return;
    e.preventDefault();
    if (!running) { current = window.scrollY; target = current; }
    target = Math.min(maxScroll(), Math.max(0, target + dy));
    start();
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(step);
  }

  function step(now) {
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    target = Math.min(maxScroll(), target);
    current += (target - current) * (1 - Math.exp(-EASE * dt));
    if (Math.abs(target - current) < 0.5) current = target;
    ours = true;
    window.scrollTo({ top: current, behavior: "instant" });            // not the CSS smooth scroll
    if (current === target) { running = false; return; }
    requestAnimationFrame(step);
  }

  // Any other scroll (keys, scrollbar, anchors, scrollIntoView) takes over.
  function cancel() { running = false; target = current = window.scrollY; }
  window.addEventListener("scroll", function () {
    if (ours) { ours = false; return; }
    if (running && Math.abs(window.scrollY - current) > 2) cancel();
    else if (!running) target = current = window.scrollY;
  }, { passive: true });
  window.addEventListener("keydown", cancel);
  window.addEventListener("pointerdown", function (e) { if (e.pointerType === "mouse") cancel(); });
  window.addEventListener("wheel", onWheel, { passive: false });
})();
