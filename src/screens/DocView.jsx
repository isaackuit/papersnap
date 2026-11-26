import { useEffect, useRef, useState } from 'preact/hooks';
import { useApp, IconButton, Icon, Thumb, useBus, PromptDialog, ConfirmDialog, Sheet, Progress, pickFiles } from '../ui/common.jsx';
import { t } from '../lib/i18n.js';
import { db, deleteDoc } from '../lib/db.js';
import { ExportSheet } from './ExportSheet.jsx';
import { recognizePage } from '../lib/ocr.js';

export function DocView({ docId }) {
  const app = useApp();
  const { nav, settings } = app;
  const [doc, setDoc] = useState(null);
  const [pages, setPages] = useState({});
  const [folders, setFolders] = useState([]);
  const [order, setOrder] = useState([]);
  const [dragId, setDragId] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [ocr, setOcr] = useState(null); // {progress, label}
  const orderRef = useRef([]);
  orderRef.current = order;
  const autoOcrDone = useRef(new Set());

  async function load() {
    const d = await db.get('docs', docId);
    if (!d) return;
    const ps = await db.pagesOf(docId);
    setDoc(d);
    setPages(Object.fromEntries(ps.map((p) => [p.id, p])));
    if (!dragId) setOrder(d.pageIds);
    setFolders(await db.all('folders'));
  }
  useEffect(() => { load(); }, [docId]);
  useBus('page', (p) => { if (p.docId === docId) load(); }, [docId, dragId]);
  useBus('doc', (d) => { if (d.id === docId) load(); }, [docId, dragId]);

  // Automatic OCR (only if the user switched it on in Settings).
  useEffect(() => {
    if (!settings.ocrEnabled || !settings.ocrAuto || ocr) return;
    const todo = order.map((id) => pages[id]).filter((p) => p && !p.rendering && !p.ocr && !autoOcrDone.current.has(p.id));
    if (todo.length) runOcr(todo, true);
  }, [pages, order]);

  if (!doc) return <div class="screen boot"><span class="spinner" /></div>;

  const pageList = order.map((id) => pages[id]).filter(Boolean);
  const anyRendering = pageList.some((p) => p.rendering);
  const fullText = pageList.map((p) => p.ocr?.text).filter(Boolean).join('\n\n');
  const folder = folders.find((f) => f.id === doc.folderId);

  async function saveDoc(patch) {
    const d = { ...doc, ...patch, updatedAt: Date.now() };
    await db.put('docs', d);
    setDoc(d);
  }

  // --- drag to reorder (grip handle, pointer events) ---
  function onGripDown(e, id) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragId(id);
  }
  function onGripMove(e) {
    if (!dragId) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-page]');
    if (!el) return;
    const target = el.dataset.page;
    if (target === dragId) return;
    const o = orderRef.current.filter((x) => x !== dragId);
    o.splice(o.indexOf(target) + (orderRef.current.indexOf(target) > orderRef.current.indexOf(dragId) ? 1 : 0), 0, dragId);
    setOrder(o);
  }
  async function onGripUp() {
    if (!dragId) return;
    setDragId(null);
    await saveDoc({ pageIds: orderRef.current });
  }

  async function runOcr(list, silent = false) {
    if (!settings.ocrEnabled) { app.toast(t('ocr.enableFirst')); nav.push({ name: 'settings', focus: 'ocr' }); return; }
    try {
      for (let i = 0; i < list.length; i++) {
        autoOcrDone.current.add(list[i].id);
        setOcr({ progress: i / list.length, label: t('ocr.running', { i: i + 1, n: list.length }) });
        await recognizePage(list[i].id, settings.ocrLangs, (m) => {
          if (m.status === 'recognizing text') setOcr({ progress: (i + m.progress) / list.length, label: t('ocr.running', { i: i + 1, n: list.length }) });
          else if (m.status?.includes('loading')) setOcr({ progress: (i + 0.05) / list.length, label: t('ocr.loadingLang') });
        });
      }
      setOcr(null);
      await load();
      if (!silent) setSheet('text');
    } catch (e) {
      setOcr(null);
      app.toast(t('ocr.failed') + ' ' + (e.message || ''));
    }
  }

  async function addFromImport() {
    const files = await pickFiles({ multiple: true });
    if (files.length) await app.importFiles(files, docId);
  }

  async function copyText() {
    try { await navigator.clipboard.writeText(fullText); app.toast(t('ocr.copied')); }
    catch { app.toast(t('ocr.copyFailed')); }
  }

  return (
    <div class="screen docview">
      <header class="topbar">
        <div class="topbar-row">
          <IconButton icon="back" label={t('common.back')} onClick={() => nav.back()} />
          <button class="doc-title-btn" onClick={() => setSheet('rename')} aria-label={t('doc.rename')}>
            <span class="doc-title">{doc.name}</span><Icon name="edit" size={16} />
          </button>
          <IconButton icon="more" label={t('common.more')} onClick={() => setSheet('menu')} />
        </div>
        <div class="doc-sub">
          {t('doc.pages', { n: pageList.length })}
          {folder && <span class="tag"><Icon name="folder" size={14} />{folder.name}</span>}
          {(doc.tags || []).map((tg) => <span key={tg} class="tag">#{tg}</span>)}
        </div>
      </header>

      <div class="page-grid" onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp}>
        {pageList.map((p, i) => (
          <div key={p.id} data-page={p.id} class={`page-tile ${dragId === p.id ? 'dragging' : ''}`}>
            <button class="page-thumb" onClick={() => !dragId && nav.push({ name: 'edit', docId, pageId: p.id })} aria-label={t('doc.editPage', { n: i + 1 })}>
              <Thumb pageId={p.id} version={p.version} />
              {p.rendering && <span class="tile-busy"><span class="spinner small" /></span>}
            </button>
            <div class="page-foot">
              <span class="page-num">{i + 1}{p.ocr ? <Icon name="text" size={14} /> : null}</span>
              <span class="grip" role="button" aria-label={t('doc.dragToReorder')} onPointerDown={(e) => onGripDown(e, p.id)}><Icon name="grip" size={20} /></span>
            </div>
          </div>
        ))}
        <div class="page-tile add-tile">
          <button class="add-btn" onClick={() => nav.push({ name: 'camera', docId })}><Icon name="camera" />{t('doc.addScan')}</button>
          <button class="add-btn" onClick={addFromImport}><Icon name="image" />{t('doc.addImport')}</button>
        </div>
      </div>

      {ocr && <div class="ocr-progress"><div class="small">{ocr.label}</div><Progress value={ocr.progress} /></div>}

      <div class="bottom-bar">
        <button class="btn ghost" onClick={() => (fullText ? setSheet('text') : runOcr(pageList))} disabled={anyRendering || !!ocr}>
          <Icon name="text" />{fullText ? t('ocr.viewText') : t('ocr.recognize')}
        </button>
        <button class="btn primary grow" onClick={() => setSheet('export')} disabled={anyRendering || !pageList.length}>
          {anyRendering ? <><span class="spinner small" />{t('doc.processing')}</> : <><Icon name="share" />{t('export.title')}</>}
        </button>
      </div>

      <ExportSheet open={sheet === 'export'} onClose={() => setSheet(null)} doc={doc} pages={pageList} />

      <Sheet open={sheet === 'text'} onClose={() => setSheet(null)} title={t('ocr.textTitle')}>
        <p class="muted small">{t('ocr.qualityNote')}</p>
        <textarea class="ocr-text" readOnly value={fullText} aria-label={t('ocr.textTitle')} />
        <div class="row-2">
          <button class="btn ghost" onClick={() => runOcr(pageList)}>{t('ocr.rerun')}</button>
          <button class="btn primary" onClick={copyText}><Icon name="copy" />{t('ocr.copy')}</button>
        </div>
      </Sheet>

      <Sheet open={sheet === 'menu'} onClose={() => setSheet(null)} title={doc.name}>
        <div class="menu">
          <button class="menu-item" onClick={() => setSheet('rename')}><Icon name="edit" />{t('doc.rename')}</button>
          <button class="menu-item" onClick={() => setSheet('folder')}><Icon name="folder" />{t('doc.moveToFolder')}</button>
          <button class="menu-item" onClick={() => setSheet('tags')}><Icon name="tag" />{t('doc.tags')}</button>
          <button class="menu-item danger" onClick={() => setSheet('delete')}><Icon name="trash" />{t('doc.delete')}</button>
        </div>
      </Sheet>

      <Sheet open={sheet === 'folder'} onClose={() => setSheet(null)} title={t('doc.moveToFolder')}>
        <div class="menu">
          <button class={`menu-item ${!doc.folderId ? 'on' : ''}`} onClick={() => { saveDoc({ folderId: null }); setSheet(null); }}>{t('folder.none')}</button>
          {folders.map((f) => (
            <button key={f.id} class={`menu-item ${doc.folderId === f.id ? 'on' : ''}`} onClick={() => { saveDoc({ folderId: f.id }); setSheet(null); }}><Icon name="folder" />{f.name}</button>
          ))}
          {!folders.length && <p class="muted small">{t('folder.noneYet')}</p>}
        </div>
      </Sheet>

      <PromptDialog open={sheet === 'rename'} title={t('doc.rename')} initial={doc.name} onCancel={() => setSheet(null)}
        onOk={(name) => { saveDoc({ name }); setSheet(null); }} />
      <PromptDialog open={sheet === 'tags'} title={t('doc.tags')} initial={(doc.tags || []).join(', ')} placeholder={t('doc.tagsPlaceholder')} allowEmpty onCancel={() => setSheet(null)}
        onOk={(v) => { saveDoc({ tags: [...new Set(v.split(/[,，]/).map((s) => s.trim().replace(/^#/, '')).filter(Boolean))] }); setSheet(null); }} />
      <ConfirmDialog open={sheet === 'delete'} danger title={t('doc.deleteTitle')} body={t('doc.deleteBody', { n: pageList.length })} okLabel={t('common.delete')}
        onCancel={() => setSheet(null)} onOk={async () => { await deleteDoc(docId); nav.home(); }} />
    </div>
  );
}
