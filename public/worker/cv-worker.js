/* Classic Web Worker: lazy-loads OpenCV.js (bundled in the app, never a CDN) and runs the pipeline. */
/* global importScripts, PaperSnapProc */
importScripts('imageproc.js');

var cvPromise = null;
function loadCv() {
  if (cvPromise) return cvPromise;
  cvPromise = new Promise(function (resolve, reject) {
    try { importScripts('../vendor/opencv.js'); } catch (e) { reject(e); return; }
    var cv = self.cv;
    var done = false;
    function ready(m) { if (done) return; done = true; self.cv = m; resolve(m); }
    if (cv && cv.Mat) { ready(cv); return; }
    // OpenCV.js 5 exports a Promise that resolves to the module.
    if (cv && typeof cv.then === 'function') { cv.then(ready, reject); return; }
    cv.onRuntimeInitialized = function () { ready(cv); };
    // Guard against the runtime finishing before the hook was attached.
    var t = setInterval(function () { if (self.cv && self.cv.Mat) { clearInterval(t); ready(self.cv); } }, 50);
    setTimeout(function () { clearInterval(t); if (!done) reject(new Error('OpenCV failed to initialise')); }, 60000);
  });
  return cvPromise;
}

function img(o) { return { data: new Uint8ClampedArray(o.data), width: o.width, height: o.height }; }

self.onmessage = function (e) {
  var msg = e.data, id = msg.id, args = msg.args || {};
  loadCv().then(function (cv) {
    var result, transfer = [];
    switch (msg.op) {
      case 'init':
        result = true; break;
      case 'detect':
        result = PaperSnapProc.detectQuad(cv, img(args.img), { maxSide: args.maxSide || 500 });
        break;
      case 'process': {
        var out = PaperSnapProc.processPage(cv, img(args.img), args);
        result = out; transfer = [out.data.buffer];
        break;
      }
      case 'previews': {
        // Small warped image → every filter, for the filter strip thumbnails.
        var base = PaperSnapProc.resizeImg(cv, PaperSnapProc.warp(cv, img(args.img), args.quad, { aspect: args.aspect, maxSide: 900 }), args.size || 220);
        result = PaperSnapProc.FILTERS.map(function (f) {
          var o = PaperSnapProc.rotate(cv, PaperSnapProc.applyFilter(cv, base, f), args.rotation || 0);
          transfer.push(o.data.buffer);
          return { filter: f, img: o };
        });
        break;
      }
      default:
        throw new Error('unknown op ' + msg.op);
    }
    self.postMessage({ id: id, ok: true, result: result }, transfer);
  }).catch(function (err) {
    self.postMessage({ id: id, ok: false, error: String((err && err.message) || err) });
  });
};
