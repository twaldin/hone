/* ============ Hairline — the one chart element for this page ============
 *
 * Dependency-free SVG charts drawn in the page's own design system:
 * hairline axes, 10px tabular-numeral tick labels, direct labels instead
 * of legends, one accent color, entrance draw that honors
 * prefers-reduced-motion. Colors come from CSS custom properties
 * (--hl-ink, --hl-grey, --hl-line, --hl-accent, --hl-paper, resolved on
 * the target element), so every chart belongs to the page, not to a
 * charting library.
 *
 * API — one call for every data display on the page:
 *
 *   var chart = Hairline.render(target, spec)
 *     target      element or CSS selector
 *     spec.type   "line" | "funnel" | "dots" | "spark"
 *     spec.height chart height in px (each type has a sane default)
 *     spec.aria   accessible description; set as role="img" aria-label
 *     spec.animate  false to skip the entrance (also skipped when the
 *                   user prefers reduced motion)
 *
 *   type "line"  — trajectories, burn-downs, anything on x/y axes
 *     spec.x / spec.y   {min, max, ticks:[...], label, format(v)}
 *     spec.series       [{points:[[x,y],...], accent, dim, step, smooth,
 *                         width, band:[[x,lo,hi],...], kind:"line"|"dots",
 *                         dots:[[x,y],...], label, labelDy,
 *                         labelAt:"start"|"end",
 *                         labelPos:[x,y] (data coords) + labelAnchor,
 *                         code:true — render label verbatim (no uppercase)}]
 *     spec.marks        [{x, label}] — vertical reference hairlines
 *
 *   type "funnel" — ordered stages as horizontal bars
 *     spec.rows   [{label, value, note, accent}]
 *     spec.format(v) — value formatter; labelWidth caps the label column
 *
 *   type "dots"  — per-group strip plot (small multiples on one axis)
 *     spec.x      {min, max, ticks, label, format}
 *     spec.groups [{label, values:[...]}]
 *     spec.zero   reference value (default 0), marked with an ink rule
 *     spec.zeroLabel  caption above the reference rule
 *     values >= zero render filled; values below render hollow
 *
 *   type "spark" — tiny inline line, no axes, end-dot
 *     spec.points [[x,y],...]   spec.accent   spec.step (step-after)
 *
 *   chart.update(nextSpec) re-renders; chart.destroy() disconnects.
 *
 * Charts re-render on container resize (vector output stays crisp on
 * any display density) and draw themselves in when first scrolled into
 * view — unless reduced motion is requested, in which case they simply
 * appear, complete.
 */
(function (global) {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";
  var reduced = global.matchMedia
    ? global.matchMedia("(prefers-reduced-motion: reduce)")
    : { matches: true };

  /* ---------- helpers ---------- */

  function theme(node) {
    var s = getComputedStyle(node);
    function v(name, fb) {
      var x = s.getPropertyValue(name).trim();
      return x || fb;
    }
    return {
      ink: v("--hl-ink", "#171512"),
      grey: v("--hl-grey", "#6d6b62"),
      line: v("--hl-line", "#dcd9ce"),
      accent: v("--hl-accent", "#c2401d"),
      paper: v("--hl-paper", "#f6f5f0"),
      mono: v("--hl-mono", 'ui-monospace,"SF Mono",Menlo,Consolas,monospace')
    };
  }

  function make(name, attrs, parent) {
    var n = document.createElementNS(NS, name);
    for (var k in attrs) {
      if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(n);
    return n;
  }

  function txt(parent, t, x, y, o) {
    o = o || {};
    var n = make("text", {
      x: x, y: y,
      "text-anchor": o.anchor || "start",
      "font-size": o.size || 10,
      fill: o.fill,
      "letter-spacing": o.tracking || null,
      "dominant-baseline": o.baseline || null
    }, parent);
    n.style.fontFamily = o.font;
    n.style.fontVariantNumeric = "tabular-nums";
    if (o.weight) n.setAttribute("font-weight", o.weight);
    n.textContent = o.upper ? String(t).toUpperCase() : String(t);
    return n;
  }

  function scale(d0, d1, r0, r1) {
    var k = (r1 - r0) / ((d1 - d0) || 1);
    return function (v) { return r0 + (v - d0) * k; };
  }

  function px(v) { return Math.round(v) + 0.5; } /* crisp 1px hairlines */

  function fmt(v, f) {
    if (typeof f === "function") return f(v);
    return String(v);
  }

  function hairline(parent, x1, y1, x2, y2, color, dash) {
    return make("line", {
      x1: x1, y1: y1, x2: x2, y2: y2,
      stroke: color, "stroke-width": 1,
      "stroke-dasharray": dash || null
    }, parent);
  }

  /* line path: straight, step-after, or midpoint-quadratic smoothed */
  function pathFor(pts, opt) {
    var d = "M" + pts[0][0] + " " + pts[0][1];
    var i;
    if (opt.step) {
      for (i = 1; i < pts.length; i++) {
        d += "L" + pts[i][0] + " " + pts[i - 1][1] + "L" + pts[i][0] + " " + pts[i][1];
      }
    } else if (opt.smooth && pts.length > 2) {
      for (i = 1; i < pts.length - 1; i++) {
        var mx = (pts[i][0] + pts[i + 1][0]) / 2;
        var my = (pts[i][1] + pts[i + 1][1]) / 2;
        d += "Q" + pts[i][0] + " " + pts[i][1] + " " + mx + " " + my;
      }
      d += "L" + pts[i][0] + " " + pts[i][1];
    } else {
      for (i = 1; i < pts.length; i++) d += "L" + pts[i][0] + " " + pts[i][1];
    }
    return d;
  }

  /* ---------- shared axis chrome ---------- */

  function frame(svg, t, W, H, spec, pad) {
    var x = spec.x, y = spec.y;
    var yTicks = y.ticks || [y.min, y.max];
    var xTicks = x.ticks || [x.min, x.max];
    var wide = 0;
    yTicks.forEach(function (v) {
      wide = Math.max(wide, fmt(v, y.format).length);
    });
    var ml = Math.max(pad && pad.ml || 0, wide * 6.2 + 14);
    var mr = (pad && pad.mr) || 12;
    var mt = (pad && pad.mt) || (y.label ? 24 : 12);
    var mb = (pad && pad.mb) || 34;
    var p = { x0: ml, x1: W - mr, y0: H - mb, y1: mt };
    var sx = scale(x.min, x.max, p.x0, p.x1);
    var sy = scale(y.min, y.max, p.y0, p.y1);

    yTicks.forEach(function (v) {
      var yy = px(sy(v));
      hairline(svg, p.x0, yy, p.x1, yy, t.line);
      txt(svg, fmt(v, y.format), p.x0 - 8, yy + 3, {
        anchor: "end", fill: t.grey, font: t.mono
      });
    });
    /* baseline */
    hairline(svg, p.x0, px(p.y0), p.x1, px(p.y0), t.ink);

    xTicks.forEach(function (v, i) {
      var xx = px(sx(v));
      hairline(svg, xx, p.y0, xx, p.y0 + 4, t.ink);
      var anchor = i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle";
      txt(svg, fmt(v, x.format), sx(v), p.y0 + 16, {
        anchor: anchor, fill: t.grey, font: t.mono
      });
    });

    if (y.label) {
      txt(svg, y.label, p.x0, mt - 10, {
        fill: t.grey, font: t.mono, tracking: ".08em", upper: true, size: 9
      });
    }
    if (x.label) {
      txt(svg, x.label, p.x1, H - 4, {
        anchor: "end", fill: t.grey, font: t.mono, tracking: ".08em", upper: true, size: 9
      });
    }
    return { sx: sx, sy: sy, p: p };
  }

  /* ---------- painters ---------- */

  function paintLine(svg, t, W, H, spec) {
    var f = frame(svg, t, W, H, spec, spec.pad);
    var sx = f.sx, sy = f.sy, p = f.p;

    (spec.marks || []).forEach(function (m) {
      var xx = px(sx(m.x));
      hairline(svg, xx, p.y1 + 6, xx, p.y0, t.grey, "2 3");
      if (m.label) {
        txt(svg, m.label, sx(m.x), p.y1 + 2, {
          anchor: "middle", fill: t.grey, font: t.mono, size: 9, tracking: ".06em", upper: true
        });
      }
    });

    (spec.series || []).forEach(function (s, si) {
      var color = s.accent ? t.accent : s.dim ? t.grey : t.ink;

      if (s.band && s.band.length > 1) {
        var up = s.band.map(function (b) { return sx(b[0]) + " " + sy(b[2]); });
        var lo = s.band.slice().reverse().map(function (b) { return sx(b[0]) + " " + sy(b[1]); });
        make("polygon", {
          points: up.concat(lo).join(" "),
          fill: t.accent, "fill-opacity": ".09", stroke: "none", "data-fade": ""
        }, svg);
      }

      if (s.kind === "dots") {
        (s.dots || s.points || []).forEach(function (d, i) {
          make("circle", {
            cx: sx(d[0]), cy: sy(d[1]), r: s.r || 2,
            fill: color, "fill-opacity": s.opacity || ".45",
            "data-fade": "", "data-stagger": Math.min(i, 40)
          }, svg);
        });
      } else {
        var pts = s.points.map(function (d) { return [sx(d[0]), sy(d[1])]; });
        make("path", {
          d: pathFor(pts, s),
          fill: "none", stroke: color,
          "stroke-width": s.width || 1.5,
          "stroke-dasharray": s.dash || null,
          "stroke-linejoin": "round", "stroke-linecap": "round",
          "data-draw": ""
        }, svg);
        (s.dots || []).forEach(function (d) {
          make("circle", {
            cx: sx(d[0]), cy: sy(d[1]), r: s.r || 2.5, fill: color, "data-fade": ""
          }, svg);
        });
      }

      if (s.label) {
        var seq = s.points || s.dots;
        var lx, ly, lanchor;
        if (s.labelPos) {           /* hand-placed, in data coordinates */
          lx = sx(s.labelPos[0]); ly = sy(s.labelPos[1]);
          lanchor = s.labelAnchor || "start";
        } else if (s.labelAt === "start") {
          lx = p.x0 + 6; ly = sy(seq[0][1]) + (s.labelDy || -8); lanchor = "start";
        } else {
          lx = p.x1; ly = sy(seq[seq.length - 1][1]) + (s.labelDy || -8); lanchor = "end";
        }
        var n = txt(svg, s.label, lx, ly, {
          anchor: lanchor, fill: color, font: t.mono, size: 10, weight: 700,
          tracking: s.code ? null : ".04em", upper: !s.code
        });
        /* paper halo so direct labels stay legible over grid hairlines */
        n.setAttribute("stroke", t.paper);
        n.setAttribute("stroke-width", "3");
        n.setAttribute("paint-order", "stroke");
      }
    });
  }

  function paintFunnel(svg, t, W, H, spec) {
    var rows = spec.rows;
    var labelW = Math.min(spec.labelWidth || 230, Math.max(110, W * 0.42));
    var valueW = 56;
    var rowH = (H - 8) / rows.length;
    var barH = Math.min(20, rowH - 14);
    var max = rows.reduce(function (m, r) { return Math.max(m, r.value); }, 0);
    var sx = scale(0, max, 0, W - labelW - valueW - 16);

    rows.forEach(function (r, i) {
      var top = 4 + i * rowH;
      var mid = top + rowH / 2;
      var color = r.accent ? t.accent : t.ink;
      hairline(svg, 0, px(top), W, px(top), i === 0 ? t.ink : t.line);

      txt(svg, r.label, 0, mid - (r.note ? 3 : -3), {
        fill: t.ink, font: t.mono, size: 10, tracking: ".06em", upper: true
      });
      if (r.note) {
        txt(svg, r.note, 0, mid + 11, { fill: t.grey, font: t.mono, size: 9 });
      }

      var bw = Math.max(3, sx(r.value));
      make("rect", {
        x: labelW, y: mid - barH / 2, width: bw, height: barH,
        fill: color, "fill-opacity": r.accent ? ".9" : ".14",
        stroke: color, "stroke-width": 1,
        "data-fade": "", "data-stagger": i
      }, svg);
      txt(svg, fmt(r.value, spec.format), labelW + bw + 8, mid + 3.5, {
        fill: r.accent ? t.accent : t.ink, font: t.mono, size: 11, weight: 700
      });
    });
    hairline(svg, 0, px(4 + rows.length * rowH), W, px(4 + rows.length * rowH), t.ink);
  }

  function paintDots(svg, t, W, H, spec) {
    var groups = spec.groups;
    var labelW = spec.labelWidth || Math.min(150, W * 0.3);
    var mb = 30, mt = 16;
    var rowH = (H - mt - mb) / groups.length;
    var x = spec.x;
    var sx = scale(x.min, x.max, labelW, W - 12);
    var zero = spec.zero === undefined ? 0 : spec.zero;

    (x.ticks || [x.min, x.max]).forEach(function (v) {
      var xx = px(sx(v));
      if (v !== zero) hairline(svg, xx, mt, xx, H - mb, t.line);
      txt(svg, fmt(v, x.format), sx(v), H - mb + 14, {
        anchor: "middle", fill: t.grey, font: t.mono
      });
    });
    var zx = px(sx(zero));
    hairline(svg, zx, mt - 4, zx, H - mb, t.ink);
    txt(svg, spec.zeroLabel || "0", sx(zero), mt - 8, {
      anchor: "middle", fill: t.grey, font: t.mono, size: 9, tracking: ".06em", upper: true
    });

    groups.forEach(function (g, gi) {
      var mid = mt + gi * rowH + rowH / 2;
      hairline(svg, labelW, px(mid), W - 12, px(mid), t.line);
      txt(svg, g.label, 0, mid + 3, {
        fill: t.ink, font: t.mono, size: 10, tracking: ".06em", upper: true
      });
      g.values.forEach(function (v, vi) {
        var win = v >= zero;
        make("circle", {
          cx: sx(v), cy: mid, r: 3.2,
          fill: win ? t.ink : t.paper, "fill-opacity": win ? ".72" : "1",
          stroke: win ? null : t.ink, "stroke-width": win ? null : 1.25,
          "data-fade": "", "data-stagger": gi * 3 + vi
        }, svg);
      });
    });

    if (x.label) {
      txt(svg, x.label, W - 12, H - 4, {
        anchor: "end", fill: t.grey, font: t.mono, size: 9, tracking: ".08em", upper: true
      });
    }
  }

  function paintSpark(svg, t, W, H, spec) {
    var xs = spec.points.map(function (d) { return d[0]; });
    var ys = spec.points.map(function (d) { return d[1]; });
    var sx = scale(Math.min.apply(null, xs), Math.max.apply(null, xs), 2, W - 6);
    var sy = scale(Math.min.apply(null, ys), Math.max.apply(null, ys), H - 3, 3);
    var pts = spec.points.map(function (d) { return [sx(d[0]), sy(d[1])]; });
    var color = spec.accent ? t.accent : t.grey;
    make("path", {
      d: pathFor(pts, { smooth: !spec.step, step: spec.step }),
      fill: "none", stroke: color, "stroke-width": 1.25,
      "stroke-linejoin": "round", "stroke-linecap": "round", "data-draw": ""
    }, svg);
    var last = pts[pts.length - 1];
    make("circle", { cx: last[0], cy: last[1], r: 2.2, fill: color, "data-fade": "" }, svg);
  }

  var painters = { line: paintLine, funnel: paintFunnel, dots: paintDots, spark: paintSpark };
  var defaultH = { line: 260, funnel: 210, dots: 240, spark: 26 };

  /* ---------- entrance ---------- */

  function enter(svg) {
    if (reduced.matches) return;
    svg.querySelectorAll("[data-draw]").forEach(function (p) {
      var L;
      try { L = p.getTotalLength(); } catch (e) { return; }
      p.style.strokeDasharray = L + " " + L;
      p.style.strokeDashoffset = L;
      p.getBoundingClientRect();
      p.style.transition = "stroke-dashoffset 900ms cubic-bezier(.22,.61,.36,1)";
      p.style.strokeDashoffset = "0";
    });
    svg.querySelectorAll("[data-fade]").forEach(function (n) {
      var i = Math.min(30, Number(n.getAttribute("data-stagger") || 0));
      var target = n.style.opacity || "";
      n.style.opacity = "0";
      n.getBoundingClientRect();
      n.style.transition = "opacity 360ms ease " + (120 + i * 14) + "ms";
      n.style.opacity = target || "1";
    });
  }

  /* ---------- render ---------- */

  function render(target, spec) {
    var host = typeof target === "string" ? document.querySelector(target) : target;
    if (!host) throw new Error("Hairline: no target for " + target);
    if (!painters[spec.type]) throw new Error("Hairline: unknown type " + spec.type);

    var entered = false;
    var lastW = -1;
    var ro = null, io = null;

    if (spec.aria) {
      host.setAttribute("role", "img");
      host.setAttribute("aria-label", spec.aria);
    }

    function build(animate) {
      var W = Math.max(40, host.clientWidth);
      var H = spec.height || defaultH[spec.type];
      lastW = W;
      host.textContent = "";
      var svg = make("svg", {
        width: W, height: H, viewBox: "0 0 " + W + " " + H, "aria-hidden": "true"
      }, host);
      svg.style.display = "block";
      svg.style.overflow = "visible";
      painters[spec.type](svg, theme(host), W, H, spec);
      if (animate) enter(svg);
      return svg;
    }

    build(false);

    if (spec.animate === false || reduced.matches) {
      entered = true;
    } else if ("IntersectionObserver" in global) {
      io = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting && !entered) {
            entered = true;
            build(true);
            io.disconnect();
          }
        });
      }, { threshold: 0.25 });
      io.observe(host);
      /* hide until entrance so the draw starts from blank */
      host.firstChild.style.visibility = "hidden";
      io.takeRecords();
      var pre = host.firstChild;
      var reveal = function () { if (pre.parentNode) pre.style.visibility = ""; };
      setTimeout(reveal, 1500); /* safety: never leave a chart hidden */
    } else {
      entered = true;
    }

    if ("ResizeObserver" in global) {
      ro = new ResizeObserver(function () {
        var w = host.clientWidth;
        if (Math.abs(w - lastW) > 1 && entered) build(false);
        else if (Math.abs(w - lastW) > 1) build(false);
      });
      ro.observe(host);
    }

    return {
      el: host,
      update: function (next) {
        for (var k in next) spec[k] = next[k];
        build(false);
      },
      destroy: function () {
        if (ro) ro.disconnect();
        if (io) io.disconnect();
        host.textContent = "";
      }
    };
  }

  global.Hairline = { render: render };
})(window);
