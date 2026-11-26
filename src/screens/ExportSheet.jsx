import { useEffect, useState } from 'preact/hooks';
import { useApp, Sheet, Icon, Progress, Toggle } from '../ui/common.jsx';
import { t } from '../lib/i18n.js';
import { buildPdf, estimatePdfSize, pageImage } from '../lib/pdf.js';
import { formatBytes } from '../lib/images.js';
import { shareFile, saveFile, safeFileName } from '../lib/share.js';
import { isNative } from '../lib/platform.js';

export function ExportSheet({ open, onClose, doc, pages }) {
  const app = useApp();
  const [format, setFormat] = useState('pdf');
  const [pageSize, setPageSize] = useState('a4');
  const [quality, setQuality] = useState('standard');
  const [textLayer, setTextLayer] = useState(true);
  const [pageIndex, setPageIndex] = useState(0);
  const [estimate, setEstimate] = useState(null);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null); // {blob, name}

  const hasOcr = pages.some((p) => p.ocr?.words?.length);

  useEffect(() => { if (open) { setResult(null); setProgress(null); } }, [open, format, pageSize, quality, textLayer, pageIndex]);

  useEffect(() => {
    if (!open || format !== 'pdf') return;
    let alive = true;
    setEstimate(null);
    estimatePdfSize(pages, quality).then((n) => alive && setEstimate(n)).catch(() => {});
    return () => { alive = false; };
  }, [open, format, quality, pages.length]);

  async function create() {
    try {
      setProgress(0);
      const base = safeFileName(doc.name);
      let blob, name;
      if (format === 'pdf') {
        blob = await buildPdf(doc, pages, { pageSize, quality, textLayer: textLayer && hasOcr }, setProgress);
        name = base + '.pdf';
      } else {
        blob = await pageImage(pages[pageIndex].id, format);
        name = `${base}${pages.length > 1 ? ` p${pageIndex + 1}` : ''}.${format === 'png' ? 'png' : 'jpg'}`;
      }
      setProgress(null);
      setResult({ blob, name });
    } catch (e) {
      setProgress(null);
      app.toast(t('export.failed') + ' ' + (e.message || ''));
    }
  }

  // Called straight from a tap so iPhone Safari keeps the user gesture for navigator.share.
  async function share() {
    try {
      const r = await shareFile(result.blob, result.name);
      if (r === 'downloaded') app.toast(t('export.downloaded'));
    } catch (e) { app.toast(t('export.shareFailed') + ' ' + (e.message || '')); }
  }
  async function save() {
    try {
      const where = await saveFile(result.blob, result.name);
      app.toast(where ? t('export.savedTo', { path: where }) : t('export.downloaded'));
    } catch (e) { app.toast(t('export.failed') + ' ' + (e.message || '')); }
  }

  const Opt = ({ value, set, options }) => (
    <div class="seg full">
      {options.map(([v, label]) => <button key={v} class={value === v ? 'on' : ''} onClick={() => set(v)}>{label}</button>)}
    </div>
  );

  return (
    <Sheet open={open} onClose={onClose} title={t('export.title')}>
      <div class="stack">
        <Opt value={format} set={setFormat} options={[['pdf', 'PDF'], ['jpg', 'JPG'], ['png', 'PNG']]} />
        {format === 'pdf' ? (<>
          <div class="field-label">{t('export.pageSize')}</div>
          <Opt value={pageSize} set={setPageSize} options={[['a4', 'A4'], ['letter', 'Letter'], ['fit', t('export.fitImage')]]} />
          <div class="field-label">{t('export.quality')}</div>
          <Opt value={quality} set={setQuality} options={[['small', t('export.qSmall')], ['standard', t('export.qStandard')], ['high', t('export.qHigh')]]} />
          {hasOcr && <Toggle checked={textLayer} onChange={setTextLayer} label={t('export.textLayer')} />}
          {hasOcr && textLayer && <p class="muted small">{t('export.textLayerNote')}</p>}
          <div class="estimate">{t('export.estimate')}: <b>{estimate == null ? '…' : '~' + formatBytes(estimate)}</b> · {t('doc.pages', { n: pages.length })}</div>
        </>) : (<>
          <div class="field-label">{t('export.whichPage')}</div>
          <div class="chips wrap">
            {pages.map((p, i) => <button key={p.id} class={`chip ${pageIndex === i ? 'on' : ''}`} onClick={() => setPageIndex(i)}>{i + 1}</button>)}
          </div>
        </>)}

        {progress != null && <Progress value={progress} />}

        {!result ? (
          <button class="btn primary" onClick={create} disabled={progress != null}>
            <Icon name="pdf" />{format === 'pdf' ? t('export.createPdf') : t('export.createImage')}
          </button>
        ) : (<>
          <div class="result-line"><Icon name="check" />{result.name} · {formatBytes(result.blob.size)}</div>
          <div class="row-2">
            <button class="btn ghost" onClick={save}><Icon name="download" />{isNative ? t('export.saveDocuments') : t('export.download')}</button>
            <button class="btn primary" onClick={share}><Icon name="share" />{t('export.share')}</button>
          </div>
        </>)}
      </div>
    </Sheet>
  );
}
