/*
 * PaperSnap image pipeline. Pure functions over OpenCV.js + RGBA buffers.
 * Loaded by cv-worker.js (browser Web Worker) and by tests/run-pipeline.mjs (Node).
 * Every Mat is deleted in a finally block — Safari crashes fast on leaked wasm memory.
 *
 * Image shape everywhere: { data: Uint8ClampedArray (RGBA), width, height }
 * Quad: [{x,y} TL, TR, BR, BL], normalized 0..1 relative to the source image.
 */
(function (global) {
  'use strict';

  var MAX_SIDE = 4096;
  var FILTERS = ['original', 'enhance', 'gray', 'bw', 'inksaver'];

  function toMat(cv, img) {
    return cv.matFromImageData({ data: img.data, width: img.width, height: img.height });
  }

  function fromMat(cv, mat) {
    var rgba = mat;
    var tmp = null;
    if (mat.channels() === 1) { tmp = new cv.Mat(); cv.cvtColor(mat, tmp, cv.COLOR_GRAY2RGBA); rgba = tmp; }
    else if (mat.channels() === 3) { tmp = new cv.Mat(); cv.cvtColor(mat, tmp, cv.COLOR_RGB2RGBA); rgba = tmp; }
    var out = { data: new Uint8ClampedArray(rgba.data), width: rgba.cols, height: rgba.rows };
    if (tmp) tmp.delete();
    return out;
  }

  function fullQuad() {
    return [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  }

  // Order 4 points TL, TR, BR, BL.
  function orderPoints(pts) {
    var bySum = pts.slice().sort(function (a, b) { return (a.x + a.y) - (b.x + b.y); });
    var tl = bySum[0], br = bySum[3];
    var rest = [bySum[1], bySum[2]];
    var tr = rest[0].x - rest[0].y > rest[1].x - rest[1].y ? rest[0] : rest[1];
    var bl = tr === rest[0] ? rest[1] : rest[0];
    return [tl, tr, br, bl];
  }

  function polyArea(p) {
    var a = 0;
    for (var i = 0; i < p.length; i++) { var j = (i + 1) % p.length; a += p[i].x * p[j].y - p[j].x * p[i].y; }
    return Math.abs(a) / 2;
  }

  function matToPoints(m) {
    var pts = [];
    for (var i = 0; i < m.rows; i++) pts.push({ x: m.data32S[i * 2], y: m.data32S[i * 2 + 1] });
    return pts;
  }

  // Find the largest convex quadrilateral among contours of a binary edge map.
  function bestQuadFromEdges(cv, edges, minArea) {
    var contours = new cv.MatVector();
    var hierarchy = new cv.Mat();
    var best = null, bestArea = 0;
    try {
      cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (var i = 0; i < contours.size(); i++) {
        var c = contours.get(i);
        var area = cv.contourArea(c);
        if (area < minArea) { c.delete(); continue; }
        var hull = new cv.Mat();
        cv.convexHull(c, hull, false, true);
        var peri = cv.arcLength(hull, true);
        var eps = [0.02, 0.03, 0.05];
        for (var k = 0; k < eps.length; k++) {
          var approx = new cv.Mat();
          cv.approxPolyDP(hull, approx, eps[k] * peri, true);
          if (approx.rows === 4 && cv.isContourConvex(approx)) {
            var pts = matToPoints(approx);
            var a = polyArea(pts);
            if (a > bestArea && a >= minArea) { bestArea = a; best = pts; }
            approx.delete();
            break;
          }
          approx.delete();
        }
        hull.delete();
        c.delete();
      }
    } finally {
      contours.delete();
      hierarchy.delete();
    }
    return best ? { pts: best, area: bestArea } : null;
  }

  /*
   * Edge detection: downscale → gray → blur → Canny → dilate → findContours → approxPolyDP.
   * Falls back to an Otsu (bright paper on darker surface) pass, then to the whole image.
   */
  function detectQuad(cv, img, opts) {
    opts = opts || {};
    var target = opts.maxSide || 500;
    var src = toMat(cv, img);
    var small = new cv.Mat(), gray = new cv.Mat(), blur = new cv.Mat(), edges = new cv.Mat(), dil = new cv.Mat(), bin = new cv.Mat();
    var kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    try {
      var scale = Math.min(1, target / Math.max(img.width, img.height));
      cv.resize(src, small, new cv.Size(Math.round(img.width * scale), Math.round(img.height * scale)), 0, 0, cv.INTER_AREA);
      cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
      var W = small.cols, H = small.rows, minArea = W * H * 0.12;

      var found = null;
      var thresholds = [[30, 90], [50, 150], [75, 200]];
      for (var t = 0; t < thresholds.length && !found; t++) {
        cv.Canny(blur, edges, thresholds[t][0], thresholds[t][1]);
        cv.dilate(edges, dil, kernel, new cv.Point(-1, -1), 2);
        found = bestQuadFromEdges(cv, dil, minArea);
      }
      if (!found) {
        cv.threshold(blur, bin, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
        cv.morphologyEx(bin, bin, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 3);
        found = bestQuadFromEdges(cv, bin, minArea);
      }
      // A quad that is basically the frame border is not a real detection.
      if (found && found.area > W * H * 0.97) found = null;
      if (!found) return { found: false, quad: fullQuad() };
      var q = orderPoints(found.pts).map(function (p) { return { x: clamp01(p.x / W), y: clamp01(p.y / H) }; });
      return { found: true, quad: q, coverage: found.area / (W * H) };
    } finally {
      src.delete(); small.delete(); gray.delete(); blur.delete(); edges.delete(); dil.delete(); bin.delete(); kernel.delete();
    }
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  /* Perspective-correct at source resolution. aspect: 'auto' follows the quad, 'a4' forces 1:√2. */
  function warp(cv, img, quad, opts) {
    opts = opts || {};
    var maxSide = Math.min(opts.maxSide || MAX_SIDE, MAX_SIDE);
    var p = quad.map(function (q) { return { x: q.x * img.width, y: q.y * img.height }; });
    var w = Math.max(dist(p[0], p[1]), dist(p[3], p[2]));
    var h = Math.max(dist(p[0], p[3]), dist(p[1], p[2]));
    if (opts.aspect === 'a4') {
      if (h >= w) w = h / Math.SQRT2; else h = w / Math.SQRT2;
    }
    var s = Math.min(1, maxSide / Math.max(w, h));
    w = Math.max(16, Math.round(w * s)); h = Math.max(16, Math.round(h * s));

    var src = toMat(cv, img), dst = new cv.Mat();
    var sp = cv.matFromArray(4, 1, cv.CV_32FC2, [p[0].x, p[0].y, p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y]);
    var dp = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
    var M = cv.getPerspectiveTransform(sp, dp);
    try {
      cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
      return fromMat(cv, dst);
    } finally { src.delete(); dst.delete(); sp.delete(); dp.delete(); M.delete(); }
  }

  function rotate(cv, img, quarterTurns) {
    var q = ((quarterTurns % 4) + 4) % 4;
    if (!q) return img;
    var src = toMat(cv, img), dst = new cv.Mat();
    try {
      var code = q === 1 ? cv.ROTATE_90_CLOCKWISE : q === 2 ? cv.ROTATE_180 : cv.ROTATE_90_COUNTERCLOCKWISE;
      cv.rotate(src, dst, code);
      return fromMat(cv, dst);
    } finally { src.delete(); dst.delete(); }
  }

  // Percentile from a 256-bin histogram.
  function pct(hist, total, p) {
    var target = total * p, acc = 0;
    for (var i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
    return 255;
  }

  function stretchLut(lo, hi, gamma) {
    var lut = new Uint8ClampedArray(256);
    var range = Math.max(1, hi - lo);
    for (var i = 0; i < 256; i++) {
      var v = (i - lo) / range;
      v = v < 0 ? 0 : v > 1 ? 1 : v;
      lut[i] = Math.round(Math.pow(v, gamma || 1) * 255);
    }
    return lut;
  }

  /* Background field (paper + lighting + shadows) of a gray Mat, at full size. Caller deletes. */
  function estimateBackground(cv, gray) {
    var W = gray.cols, H = gray.rows;
    var s = Math.min(1, 800 / Math.max(W, H));
    var small = new cv.Mat(), bg = new cv.Mat(), bgFull = new cv.Mat();
    var k = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
    try {
      cv.resize(gray, small, new cv.Size(Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s))), 0, 0, cv.INTER_AREA);
      cv.dilate(small, bg, k, new cv.Point(-1, -1), 2);   // erase dark text strokes
      cv.medianBlur(bg, bg, 21);                         // smooth into a lighting field
      cv.resize(bg, bgFull, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
      return bgFull;
    } finally { small.delete(); bg.delete(); k.delete(); }
  }

  /* Shadow-free gray: gray / background. Caller deletes. */
  function flattenShadows(cv, gray) {
    var bg = estimateBackground(cv, gray), flat = new cv.Mat();
    try { cv.divide(gray, bg, flat, 255, -1); return flat; } finally { bg.delete(); }
  }

  /* Enhanced colour: relight by the background field (removes shadows and colour cast = white balance),
     then per-channel contrast stretch and a mild saturation boost. */
  function enhance(cv, img) {
    var src = toMat(cv, img), gray = new cv.Mat(), bg = null;
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      bg = estimateBackground(cv, gray);
      var d = img.data, b = bg.data, n = d.length / 4;
      var relit = new Uint8ClampedArray(d.length);
      for (var i = 0, o = 0; i < n; i++, o += 4) {
        var g = 240 / Math.max(b[i], 16); if (g > 4) g = 4; if (g < 1) g = 1;
        relit[o] = d[o] * g; relit[o + 1] = d[o + 1] * g; relit[o + 2] = d[o + 2] * g; relit[o + 3] = 255;
      }
      var hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
      var step = Math.max(1, Math.floor(n / 250000)), count = 0;
      for (var j = 0; j < n; j += step) { var q = j * 4; hr[relit[q]]++; hg[relit[q + 1]]++; hb[relit[q + 2]]++; count++; }
      var lr = stretchLut(pct(hr, count, 0.01), pct(hr, count, 0.97), 1.1);
      var lg = stretchLut(pct(hg, count, 0.01), pct(hg, count, 0.97), 1.1);
      var lb = stretchLut(pct(hb, count, 0.01), pct(hb, count, 0.97), 1.1);
      for (var k = 0; k < relit.length; k += 4) {
        var r = lr[relit[k]], gg = lg[relit[k + 1]], bb = lb[relit[k + 2]];
        var y = 0.299 * r + 0.587 * gg + 0.114 * bb;
        relit[k] = y + (r - y) * 1.2; relit[k + 1] = y + (gg - y) * 1.2; relit[k + 2] = y + (bb - y) * 1.2;
      }
      return { data: relit, width: img.width, height: img.height };
    } finally { src.delete(); gray.delete(); if (bg) bg.delete(); }
  }

  function grayStretch(cv, gray) {
    // In-place-ish contrast stretch on a gray Mat via JS LUT.
    var d = gray.data, hist = new Uint32Array(256), step = Math.max(1, Math.floor(d.length / 250000)), c = 0;
    for (var i = 0; i < d.length; i += step) { hist[d[i]]++; c++; }
    var lut = stretchLut(pct(hist, c, 0.01), pct(hist, c, 0.99), 1);
    for (var j = 0; j < d.length; j++) d[j] = lut[d[j]];
  }

  function documentBW(cv, img, light) {
    var src = toMat(cv, img), gray = new cv.Mat(), bin = new cv.Mat(), flat = null;
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      flat = flattenShadows(cv, gray);
      cv.GaussianBlur(flat, flat, new cv.Size(3, 3), 0);  // tame sensor noise (low light)
      var minSide = Math.min(img.width, img.height);
      var block = Math.max(15, Math.round(minSide / 45)) | 1;
      cv.adaptiveThreshold(flat, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, light ? 18 : 12);
      cv.medianBlur(bin, bin, 3); // speckle clean-up
      // Paper edges / leftover desk at the border read as black bars — whiten a thin margin.
      var m = Math.max(2, Math.round(minSide * 0.006));
      cv.rectangle(bin, new cv.Point(0, 0), new cv.Point(bin.cols - 1, bin.rows - 1), new cv.Scalar(255), m);
      if (light) {
        var b = bin.data;
        for (var i = 0; i < b.length; i++) if (b[i] < 128) b[i] = 120; // lighter ink
      }
      return fromMat(cv, bin);
    } finally { src.delete(); gray.delete(); bin.delete(); if (flat) flat.delete(); }
  }

  function grayscale(cv, img) {
    var src = toMat(cv, img), gray = new cv.Mat();
    try {
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      grayStretch(cv, gray);
      return fromMat(cv, gray);
    } finally { src.delete(); gray.delete(); }
  }

  function applyFilter(cv, img, filter) {
    switch (filter) {
      case 'enhance': return enhance(cv, img);
      case 'gray': return grayscale(cv, img);
      case 'bw': return documentBW(cv, img, false);
      case 'inksaver': return documentBW(cv, img, true);
      default: return img;
    }
  }

  /* Whole page: warp → filter → rotate. */
  function processPage(cv, img, opts) {
    var warped = warp(cv, img, opts.quad || fullQuad(), { aspect: opts.aspect, maxSide: opts.maxSide });
    var filtered = applyFilter(cv, warped, opts.filter || 'original');
    return rotate(cv, filtered, opts.rotation || 0);
  }

  function resizeImg(cv, img, maxSide) {
    var s = Math.min(1, maxSide / Math.max(img.width, img.height));
    if (s >= 1) return img;
    var src = toMat(cv, img), dst = new cv.Mat();
    try {
      cv.resize(src, dst, new cv.Size(Math.round(img.width * s), Math.round(img.height * s)), 0, 0, cv.INTER_AREA);
      return fromMat(cv, dst);
    } finally { src.delete(); dst.delete(); }
  }

  var api = {
    FILTERS: FILTERS, MAX_SIDE: MAX_SIDE,
    detectQuad: detectQuad, warp: warp, rotate: rotate, applyFilter: applyFilter,
    processPage: processPage, resizeImg: resizeImg, fullQuad: fullQuad, orderPoints: orderPoints
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.PaperSnapProc = api;
})(typeof self !== 'undefined' ? self : globalThis);
