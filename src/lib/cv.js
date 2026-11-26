// Promise RPC to the image Web Worker. The worker (and OpenCV.js inside it) is
// created on first use only — opening the app never pays for the 13 MB wasm.
import { appUrl } from './platform.js';

let worker = null;
let seq = 0;
const pending = new Map();
let readyPromise = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(appUrl('worker/cv-worker.js'));
  worker.onmessage = (e) => {
    const { id, ok, result, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    ok ? p.resolve(result) : p.reject(new Error(error));
  };
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(e.message || 'worker error'));
    pending.clear();
  };
  return worker;
}

function call(op, args, transfer = []) {
  const w = getWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ id, op, args }, transfer);
  });
}

export const cvReady = () => (readyPromise ||= call('init'));

export function detect(img) {
  return call('detect', { img }, [img.data.buffer]);
}

// opts: {quad, rotation, filter, aspect}
export function processImage(img, opts) {
  return call('process', { img, ...opts }, [img.data.buffer]);
}

export function filterPreviews(img, opts) {
  return call('previews', { img, ...opts }, [img.data.buffer]);
}
