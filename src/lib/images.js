// Decode / encode helpers. iPhone Safari has tight canvas memory limits, so:
// long side ≤ 4096, canvases are shrunk to 0×0 and ImageBitmaps closed right after use.
export const MAX_SIDE = 4096;

function freeCanvas(c) { c.width = 0; c.height = 0; }

function loadImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.decoding = 'async';
    im.onload = () => resolve({ im, url });
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    im.src = url;
  });
}

// Blob → {data, width, height} (RGBA), long side capped. EXIF orientation is applied by the browser.
export async function decode(blob, maxSide = MAX_SIDE) {
  const { im, url } = await loadImg(blob);
  try {
    const s = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
    const w = Math.max(1, Math.round(im.naturalWidth * s)), h = Math.max(1, Math.round(im.naturalHeight * s));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0, w, h);
    const id = ctx.getImageData(0, 0, w, h);
    freeCanvas(c);
    return { data: id.data, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function imageSize(blob) {
  const { im, url } = await loadImg(blob);
  URL.revokeObjectURL(url);
  return { width: im.naturalWidth, height: im.naturalHeight };
}

// RGBA → Blob. type 'image/jpeg' | 'image/png'
export function encode(img, type = 'image/jpeg', quality = 0.9, maxSide = 0) {
  return new Promise((resolve, reject) => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.width * img.height * 4), img.width, img.height), 0, 0);
    let out = c;
    if (maxSide && Math.max(img.width, img.height) > maxSide) {
      const s = maxSide / Math.max(img.width, img.height);
      out = document.createElement('canvas');
      out.width = Math.round(img.width * s); out.height = Math.round(img.height * s);
      const ctx = out.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(c, 0, 0, out.width, out.height);
      freeCanvas(c);
    }
    out.toBlob((b) => { freeCanvas(out); b ? resolve(b) : reject(new Error('encode failed')); }, type, quality);
  });
}

// Re-encode an existing image blob (resize + quality), used for export presets & thumbnails.
export async function reencode(blob, maxSide, type = 'image/jpeg', quality = 0.85) {
  const { im, url } = await loadImg(blob);
  try {
    const s = Math.min(1, maxSide / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(im.naturalWidth * s)); c.height = Math.max(1, Math.round(im.naturalHeight * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(im, 0, 0, c.width, c.height);
    return await new Promise((res, rej) => c.toBlob((b) => { freeCanvas(c); b ? res(b) : rej(new Error('encode failed')); }, type, quality));
  } finally { URL.revokeObjectURL(url); }
}

// Rotate an encoded image by quarter turns (used when the original is gone).
export async function rotateBlob(blob, quarterTurns) {
  const q = ((quarterTurns % 4) + 4) % 4;
  if (!q) return blob;
  const { im, url } = await loadImg(blob);
  try {
    const w = im.naturalWidth, h = im.naturalHeight;
    const c = document.createElement('canvas');
    c.width = q % 2 ? h : w; c.height = q % 2 ? w : h;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((q * Math.PI) / 2);
    ctx.drawImage(im, -w / 2, -h / 2);
    return await new Promise((res, rej) => c.toBlob((b) => { freeCanvas(c); b ? res(b) : rej(new Error('encode failed')); }, 'image/jpeg', 0.92));
  } finally { URL.revokeObjectURL(url); }
}

export function grabVideoFrame(video, maxSide) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.min(1, maxSide / Math.max(vw, vh));
  const c = document.createElement('canvas');
  c.width = Math.round(vw * s); c.height = Math.round(vh * s);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, c.width, c.height);
  return { canvas: c, ctx, free: () => freeCanvas(c) };
}

export function videoFrameData(video, maxSide) {
  const f = grabVideoFrame(video, maxSide);
  const id = f.ctx.getImageData(0, 0, f.canvas.width, f.canvas.height);
  f.free();
  return { data: id.data, width: id.width, height: id.height };
}

export function videoFrameBlob(video, maxSide = MAX_SIDE) {
  const f = grabVideoFrame(video, maxSide);
  return new Promise((res, rej) => f.canvas.toBlob((b) => { f.free(); b ? res(b) : rej(new Error('capture failed')); }, 'image/jpeg', 0.95));
}

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
