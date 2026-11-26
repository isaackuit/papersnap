import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, IconButton, Icon, ConfirmDialog, useBlobUrl } from '../ui/common.jsx';
import { t } from '../lib/i18n.js';
import { db, deletePage } from '../lib/db.js';
import { decode, encode } from '../lib/images.js';
import { filterPreviews, processImage, cvReady } from '../lib/cv.js';
import { renderPage } from '../lib/pages.js';

const FILTERS = ['original', 'enhance', 'gray', 'bw', 'inksaver'];
const ZOOM = 2.5;

export function Editor({ docId, pageId, fresh = false }) {
  const app = useApp();
  const { nav } = app;
  const [page, setPage] = useState(null);
  const [doc, setDoc] = useState(null);
  const [origUrl, setOrigUrl] = useState(null);
  const [natural, setNatural] = useState(null);
  const [quad, setQuad] = useState(null);
  const [rotation, setRotation] = useState(0);
  const [filter, setFilter] = useState('enhance');
  const [aspect, setAspect] = useState('auto');
  const [applyAll, setApplyAll] = useState(false);
  const [previews, setPreviews] = useState({});
  const [resultUrl, setResultUrl] = useState(null);
  const [showResult, setShowResult] = useState(false);
  const [drag, setDrag] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const stageRef = useRef();
  const smallRef = useRef(null);
  const procUrl = useBlobUrl(`${pageId}:proc`, page?.version);

  useEffect(() => {
    let url;
    (async () => {
      const [p, d] = await Promise.all([db.get('pages', pageId), db.get('docs', docId)]);
      setPage(p); setDoc(d);
      setRotation(p.rotation || 0); setFilter(p.filter); setAspect(p.aspect || 'auto');
      setQuad(p.quad || [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
      const orig = p.hasOriginal ? await db.get('blobs', `${pageId}:orig`) : null;
      if (orig) {
        url = URL.createObjectURL(orig);
        setOrigUrl(url);
        smallRef.current = await decode(orig, 1000);
        setNatural({ w: smallRef.current.width, h: smallRef.current.height });
        cvReady();
      }
    })();
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [pageId]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [origUrl, showResult]);

  // Filter thumbnails + result preview, debounced, never while dragging.
  useEffect(() => {
    if (!smallRef.current || !quad || drag) return;
    let alive = true;
    const urls = [];
    const timer = setTimeout(async () => {
      const src = smallRef.current;
      const list = await filterPreviews({ data: new Uint8ClampedArray(src.data), width: src.width, height: src.height }, { quad, aspect, rotation, size: 200 });
      const out = {};
      for (const it of list) { const u = URL.createObjectURL(await encode(it.img, 'image/jpeg', 0.8)); urls.push(u); out[it.filter] = u; }
      if (alive) setPreviews(out);
    }, 250);
    return () => { alive = false; clearTimeout(timer); setTimeout(() => urls.forEach(URL.revokeObjectURL), 2000); };
  }, [quad, aspect, rotation, drag, natural]);

  useEffect(() => {
    if (!showResult || !smallRef.current) return;
    let alive = true, u;
    (async () => {
      const src = smallRef.current;
      const out = await processImage({ data: new Uint8ClampedArray(src.data), width: src.width, height: src.height }, { quad, aspect, rotation, filter, maxSide: 1400 });
      u = URL.createObjectURL(await encode(out, 'image/jpeg', 0.85));
      if (alive) setResultUrl(u);
    })();
    return () => { alive = false; if (u) setTimeout(() => URL.revokeObjectURL(u), 2000); };
  }, [showResult, quad, aspect, rotation, filter]);

  if (!page || !doc) return <div class="screen boot"><span class="spinner" /></div>;

  const index = doc.pageIds.indexOf(pageId);
  const canEdit = !!origUrl;

  // Image box inside the stage (object-fit: contain).
  let fit = null;
  if (natural && stage.w) {
    const s = Math.min(stage.w / natural.w, stage.h / natural.h);
    fit = { s, w: natural.w * s, h: natural.h * s, x: (stage.w - natural.w * s) / 2, y: (stage.h - natural.h * s) / 2 };
  }
  const toPx = (p) => [fit.x + p.x * fit.w, fit.y + p.y * fit.h];

  function pointerPos(e) {
    const r = stageRef.current.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left - fit.x) / fit.w)), y: Math.min(1, Math.max(0, (e.clientY - r.top - fit.y) / fit.h)) };
  }

  function onDown(e, kind, i) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind, i, start: pointerPos(e), quad: quad.map((p) => ({ ...p })), at: quad[i] });
  }
  function onMove(e) {
    if (!drag) return;
    const pos = pointerPos(e);
    const q = drag.quad.map((p) => ({ ...p }));
    if (drag.kind === 'corner') {
      q[drag.i] = pos;
      setDrag({ ...drag, at: pos });
    } else {
      const dx = pos.x - drag.start.x, dy = pos.y - drag.start.y;
      const a = drag.i, b = (drag.i + 1) % 4;
      q[a] = { x: clamp(drag.quad[a].x + dx), y: clamp(drag.quad[a].y + dy) };
      q[b] = { x: clamp(drag.quad[b].x + dx), y: clamp(drag.quad[b].y + dy) };
      setDrag({ ...drag, at: { x: (q[a].x + q[b].x) / 2, y: (q[a].y + q[b].y) / 2 } });
    }
    setQuad(q);
  }
  function onUp() { setDrag(null); }

  async function save() {
    setSaving(true);
    const geometryChanged = JSON.stringify(quad) !== JSON.stringify(page.quad) || rotation !== page.rotation || aspect !== page.aspect;
    const next = { ...page, quad, rotation, filter, aspect, rendering: true };
    if (geometryChanged || filter !== page.filter) next.ocr = null;
    await db.put('pages', next);
    await renderPage(pageId);
    if (applyAll) {
      for (const pid of doc.pageIds) {
        if (pid === pageId) continue;
        const p = await db.get('pages', pid);
        if (p && p.filter !== filter && p.hasOriginal) {
          await db.put('pages', { ...p, filter, ocr: null, rendering: true });
          renderPage(pid);
        }
      }
    }
    if (fresh) nav.replace({ name: 'doc', docId });
    else nav.back();
  }

  async function doDelete() {
    await deletePage(pageId);
    const d = await db.get('docs', docId);
    if (d && d.pageIds.length === 0) { await db.del('docs', docId); nav.home(); return; }
    if (fresh) nav.replace({ name: 'doc', docId }); else nav.back();
  }

  const handles = fit && quad ? quad.map(toPx) : null;
  const mids = handles ? handles.map((p, i) => { const n = handles[(i + 1) % 4]; return [(p[0] + n[0]) / 2, (p[1] + n[1]) / 2, Math.atan2(n[1] - p[1], n[0] - p[0])]; }) : null;

  // Magnifier sits in the corner away from the finger.
  let loupe = null;
  if (drag && fit && drag.at) {
    const [px, py] = toPx(drag.at);
    const size = 120;
    const left = px < stage.w / 2 ? stage.w - size - 12 : 12;
    loupe = {
      left, top: 12, size,
      bg: { backgroundImage: `url(${origUrl})`, backgroundSize: `${fit.w * ZOOM}px ${fit.h * ZOOM}px`, backgroundPosition: `${size / 2 - (px - fit.x) * ZOOM}px ${size / 2 - (py - fit.y) * ZOOM}px` },
    };
  }

  return (
    <div class="screen editor">
      <header class="editor-top">
        <IconButton icon="back" label={t('common.back')} onClick={() => (fresh ? nav.replace({ name: 'doc', docId }) : nav.back())} />
        <div class="editor-title">{t('editor.pageOf', { i: index + 1, n: doc.pageIds.length })}</div>
        <IconButton icon="rotate" label={t('editor.rotate')} onClick={() => setRotation((r) => (r + 1) % 4)} />
        <IconButton icon="camera" label={t('editor.retake')} onClick={() => nav.push({ name: 'camera', docId, retakePageId: pageId })} />
        <IconButton icon="trash" label={t('editor.delete')} tone="danger" onClick={() => setConfirmDelete(true)} />
      </header>

      <div class="editor-stage" ref={stageRef} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {canEdit && !showResult && (<>
          <img src={origUrl} class="editor-img" alt="" draggable={false} style={fit ? { left: fit.x + 'px', top: fit.y + 'px', width: fit.w + 'px', height: fit.h + 'px' } : { display: 'none' }} />
          {handles && (
            <svg class="editor-overlay" width={stage.w} height={stage.h}>
              <path class="editor-shade" fill-rule="evenodd" d={`M0,0H${stage.w}V${stage.h}H0Z M${handles.map((p) => p.join(',')).join(' L')} Z`} />
              <polygon class="editor-quad" points={handles.map((p) => p.join(',')).join(' ')} />
            </svg>
          )}
          {handles && handles.map((p, i) => (
            <button key={'c' + i} class="handle corner" style={{ left: p[0] + 'px', top: p[1] + 'px' }} aria-label={t('editor.corner')}
              onPointerDown={(e) => onDown(e, 'corner', i)} />
          ))}
          {mids && mids.map((m, i) => (
            <button key={'m' + i} class="handle edge" style={{ left: m[0] + 'px', top: m[1] + 'px', transform: `translate(-50%,-50%) rotate(${m[2]}rad)` }} aria-label={t('editor.edge')}
              onPointerDown={(e) => onDown(e, 'edge', i)} />
          ))}
          {loupe && (
            <div class="loupe" style={{ left: loupe.left + 'px', top: loupe.top + 'px', width: loupe.size + 'px', height: loupe.size + 'px', ...loupe.bg }}>
              <div class="loupe-cross" />
            </div>
          )}
        </>)}
        {canEdit && showResult && (resultUrl ? <img src={resultUrl} class="editor-result" alt={t('editor.preview')} /> : <span class="spinner" />)}
        {!canEdit && (<>
          {procUrl && <img src={procUrl} class="editor-result" alt="" style={{ transform: `rotate(${(rotation - (page.renderedRotation || 0)) * 90}deg)` }} />}
          <div class="editor-note">{t('editor.noOriginal')}</div>
        </>)}
      </div>

      {canEdit && (
        <div class="editor-tools">
          <div class="seg small">
            <button class={!showResult ? 'on' : ''} onClick={() => setShowResult(false)}><Icon name="crop" size={18} />{t('editor.corners')}</button>
            <button class={showResult ? 'on' : ''} onClick={() => setShowResult(true)}>{t('editor.preview')}</button>
            <button class={aspect === 'a4' ? 'on' : ''} onClick={() => setAspect(aspect === 'a4' ? 'auto' : 'a4')} aria-pressed={aspect === 'a4'}>A4</button>
          </div>
          <div class="filter-strip" role="radiogroup" aria-label={t('editor.filter')}>
            {FILTERS.map((f) => (
              <button key={f} role="radio" aria-checked={filter === f} class={`filter ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
                <span class="filter-thumb">{previews[f] ? <img src={previews[f]} alt="" /> : <span class="spinner small" />}</span>
                <span>{t('filter.' + f)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div class="editor-bottom">
        {canEdit && doc.pageIds.length > 1 && (
          <label class="check-pill"><input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.currentTarget.checked)} />{t('editor.applyAll')}</label>
        )}
        <button class="btn primary grow" onClick={save} disabled={saving}>{saving ? <span class="spinner small" /> : t('common.save')}</button>
      </div>

      <ConfirmDialog open={confirmDelete} danger title={t('editor.deleteTitle')} okLabel={t('common.delete')} onCancel={() => setConfirmDelete(false)} onOk={doDelete} />
    </div>
  );
}

const clamp = (v) => Math.min(1, Math.max(0, v));
