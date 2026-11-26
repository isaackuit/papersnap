import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, IconButton, Icon, pickFiles } from '../ui/common.jsx';
import { t } from '../lib/i18n.js';
import { createDoc, db } from '../lib/db.js';
import { addPage, replaceOriginal } from '../lib/pages.js';
import { cvReady, detect } from '../lib/cv.js';
import { videoFrameData, videoFrameBlob, MAX_SIDE } from '../lib/images.js';
import { isAndroid, isIOS, isNative } from '../lib/platform.js';

const DETECT_SIDE = 360;
const STABLE_MS = 1000;
const STABLE_TOL = 0.02;

const maxMove = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

export function Camera({ docId: existingDocId = null, retakePageId = null, folderId = null }) {
  const app = useApp();
  const { settings, nav } = app;
  const videoRef = useRef();
  const boxRef = useRef();
  const streamRef = useRef(null);
  const docRef = useRef(existingDocId);
  const [status, setStatus] = useState('starting'); // starting | live | denied | unavailable
  const [errorMsg, setErrorMsg] = useState('');
  const [cvState, setCvState] = useState('loading');
  const [quad, setQuad] = useState(null);
  const [torch, setTorch] = useState({ supported: false, on: false });
  const [auto, setAuto] = useState(settings.autoCapture);
  const [mode, setMode] = useState(retakePageId ? 'single' : 'batch');
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const history = useRef([]);
  const lastAuto = useRef(0);
  const capturing = useRef(false);

  // --- camera start / stop ---
  async function start() {
    setStatus('starting');
    if (!navigator.mediaDevices?.getUserMedia) { setStatus('unavailable'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
      });
      streamRef.current = stream;
      const v = videoRef.current;
      v.srcObject = stream;
      await v.play().catch(() => {});
      const track = stream.getVideoTracks()[0];
      const caps = track.getCapabilities?.() || {};
      setTorch({ supported: !!caps.torch, on: false });
      setStatus('live');
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
        setStatus('denied');
      } else {
        setErrorMsg(e.message || e.name);
        setStatus('unavailable');
      }
    }
  }

  useEffect(() => {
    start();
    cvReady().then(() => setCvState('ready')).catch(() => setCvState('error'));
    return () => streamRef.current?.getTracks().forEach((tr) => tr.stop());
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- live edge detection loop ---
  useEffect(() => {
    if (status !== 'live' || cvState !== 'ready') return;
    let alive = true, timer;
    async function tick() {
      const v = videoRef.current;
      if (!alive) return;
      if (v && v.videoWidth && !capturing.current) {
        try {
          const det = await detect(videoFrameData(v, DETECT_SIDE));
          if (!alive) return;
          const now = performance.now();
          if (det.found) {
            setQuad(det.quad);
            history.current.push({ q: det.quad, at: now });
            history.current = history.current.filter((h) => now - h.at <= STABLE_MS + 200);
            const span = now - history.current[0].at;
            const stable = span >= STABLE_MS && history.current.every((h) => maxMove(h.q, det.quad) < STABLE_TOL);
            if (auto && stable && now - lastAuto.current > 2500) {
              lastAuto.current = now;
              history.current = [];
              capture();
            }
          } else {
            setQuad(null);
            history.current = [];
          }
        } catch { /* skip frame */ }
      }
      timer = setTimeout(tick, 120);
    }
    tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [status, cvState, auto, mode]);

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch.on }] });
      setTorch({ ...torch, on: !torch.on });
    } catch { app.toast(t('camera.torchFailed')); }
  }

  async function grabPhoto() {
    const v = videoRef.current;
    const track = streamRef.current?.getVideoTracks()[0];
    // Chrome / Android WebView: full-resolution still from the sensor.
    if (track && 'ImageCapture' in window && isAndroid) {
      try {
        const ic = new window.ImageCapture(track);
        const blob = await Promise.race([ic.takePhoto(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
        if (blob?.size) return blob;
      } catch { /* fall back to the video frame */ }
    }
    return videoFrameBlob(v, MAX_SIDE);
  }

  async function ensureDoc() {
    if (!docRef.current) {
      const d = await createDoc({ folderId });
      docRef.current = d.id;
    }
    return docRef.current;
  }

  async function handleBlob(blob) {
    if (retakePageId) {
      setBusy(true);
      await replaceOriginal(retakePageId, blob, settings);
      nav.back();
      return;
    }
    const docId = await ensureDoc();
    if (mode === 'single') {
      setBusy(true);
      const page = await addPage(docId, blob, { settings });
      nav.replace({ name: 'edit', docId, pageId: page.id, fresh: true });
      return;
    }
    addPage(docId, blob, { settings }).catch((e) => app.toast(t('error.process') + ' ' + e.message));
    setCount((c) => c + 1);
  }

  async function capture() {
    if (capturing.current || busy) return;
    capturing.current = true;
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
    try {
      const blob = await grabPhoto();
      await handleBlob(blob);
    } catch (e) {
      app.toast(t('camera.captureFailed') + ' ' + (e.message || ''));
    } finally {
      capturing.current = false;
    }
  }

  async function useSystemCamera() {
    const files = await pickFiles({ capture: true, multiple: false });
    if (!files.length) return;
    await handleBlob(files[0]);
  }

  async function importPhotos() {
    const files = await pickFiles({ multiple: !retakePageId });
    if (!files.length) return;
    if (retakePageId) { await handleBlob(files[0]); return; }
    const docId = await ensureDoc();
    await app.importFiles(files, docId);
    nav.replace({ name: 'doc', docId });
  }

  function finish() {
    if (docRef.current && count > 0) nav.replace({ name: 'doc', docId: docRef.current });
    else nav.back();
  }

  // Map normalized quad (video frame space) → overlay (object-fit: cover).
  let poly = null;
  const v = videoRef.current;
  if (quad && v?.videoWidth && box.w) {
    const s = Math.max(box.w / v.videoWidth, box.h / v.videoHeight);
    const ox = (box.w - v.videoWidth * s) / 2, oy = (box.h - v.videoHeight * s) / 2;
    poly = quad.map((p) => [ox + p.x * v.videoWidth * s, oy + p.y * v.videoHeight * s]);
  }

  return (
    <div class="screen camera">
      <div class="viewfinder" ref={boxRef}>
        <video ref={videoRef} playsInline muted autoPlay class="video" />
        {poly && (
          <svg class="quad-overlay" width={box.w} height={box.h} aria-hidden="true">
            <polygon points={poly.map((p) => p.join(',')).join(' ')} class="quad-fill" />
            {poly.map((p, i) => {
              const a = poly[(i + 3) % 4], b = poly[(i + 1) % 4], L = 26;
              const u = (q) => { const dx = q[0] - p[0], dy = q[1] - p[1], d = Math.hypot(dx, dy) || 1; return [p[0] + dx / d * L, p[1] + dy / d * L]; };
              const pa = u(a), pb = u(b);
              return <path key={i} class="quad-corner" d={`M${pa[0]},${pa[1]} L${p[0]},${p[1]} L${pb[0]},${pb[1]}`} />;
            })}
          </svg>
        )}
        {flash && <div class="shutter-flash" />}

        <div class="cam-top">
          <IconButton icon="close" label={t('common.close')} onClick={finish} tone="glass" />
          <button class={`pill ${auto ? 'accent' : 'glass'}`} onClick={() => { setAuto(!auto); app.setSettings({ autoCapture: !auto }); }} aria-pressed={auto}>
            {auto ? t('camera.autoOn') : t('camera.autoOff')}
          </button>
          {torch.supported
            ? <IconButton icon="flash" label={t('camera.torch')} onClick={toggleTorch} tone={torch.on ? 'accent' : 'glass'} />
            : <span class="icon-btn-spacer" />}
        </div>

        {status === 'live' && (
          <div class="cam-hint">
            {cvState === 'loading' ? t('camera.preparing') : quad ? (auto ? t('camera.holdStill') : t('camera.found')) : t('camera.searching')}
          </div>
        )}

        {status !== 'live' && (
          <div class="cam-message">
            {status === 'starting' && <span class="spinner" />}
            {status === 'denied' && (<>
              <div class="cam-message-title">{t('camera.deniedTitle')}</div>
              <p>{isNative ? t('camera.deniedAndroid') : isIOS ? t('camera.deniedIOS') : t('camera.deniedWeb')}</p>
              <button class="btn primary" onClick={start}>{t('common.tryAgain')}</button>
            </>)}
            {status === 'unavailable' && (<>
              <div class="cam-message-title">{t('camera.unavailableTitle')}</div>
              <p>{t('camera.unavailableBody')}{errorMsg ? ` (${errorMsg})` : ''}</p>
            </>)}
            {(status === 'denied' || status === 'unavailable') && (
              <div class="stack">
                <button class="btn ghost" onClick={useSystemCamera}><Icon name="camera" />{t('camera.systemCamera')}</button>
                <button class="btn ghost" onClick={importPhotos}><Icon name="image" />{t('home.import')}</button>
              </div>
            )}
          </div>
        )}
        {busy && <div class="busy-overlay"><span class="spinner" />{t('camera.processing')}</div>}
      </div>

      <div class="cam-bottom">
        {!retakePageId && (
          <div class="seg">
            <button class={mode === 'single' ? 'on' : ''} onClick={() => setMode('single')}>{t('camera.single')}</button>
            <button class={mode === 'batch' ? 'on' : ''} onClick={() => setMode('batch')}>{count ? t('camera.batchN', { n: count }) : t('camera.batch')}</button>
            <button onClick={importPhotos}>{t('camera.photos')}</button>
          </div>
        )}
        <div class="cam-controls">
          <button class="cam-count" aria-label={t('camera.pagesCaptured', { n: count })} onClick={finish} disabled={!count}>
            {count > 0 ? <span>{count}</span> : <Icon name="image" />}
          </button>
          <button class="shutter" aria-label={t('camera.capture')} onClick={capture} disabled={status !== 'live' || busy}><span /></button>
          <button class="cam-done" aria-label={t('common.done')} onClick={finish} disabled={!count && !retakePageId}><Icon name="check" size={26} stroke={2.4} /></button>
        </div>
      </div>
    </div>
  );
}
