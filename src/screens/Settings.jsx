import { useEffect, useState } from 'preact/hooks';
import { useApp, IconButton, Icon, Toggle, Progress, ConfirmDialog, pickFiles } from '../ui/common.jsx';
import { t, fmtDate } from '../lib/i18n.js';
import { formatBytes } from '../lib/images.js';
import { exportBackup, importBackup } from '../lib/backup.js';
import { shareFile, saveFile } from '../lib/share.js';
import { OCR_LANGS, prepareLanguages } from '../lib/ocr.js';
import { isIOS, isNative, LANG_BASE_URL } from '../lib/platform.js';
import { db } from '../lib/db.js';
import { emit } from '../lib/bus.js';

const FILTERS = ['original', 'enhance', 'gray', 'bw', 'inksaver'];

export function Settings({ focus }) {
  const app = useApp();
  const { settings: s, setSettings, nav } = app;
  const [usage, setUsage] = useState(null);
  const [persisted, setPersisted] = useState(null);
  const [origBytes, setOrigBytes] = useState(null);
  const [backup, setBackup] = useState(null); // {progress} | {blob, name}
  const [restoreProgress, setRestoreProgress] = useState(null);
  const [ocrDl, setOcrDl] = useState(null);
  const [confirmPurge, setConfirmPurge] = useState(false);

  async function refreshStorage() {
    navigator.storage?.estimate?.().then((e) => setUsage(e)).catch(() => {});
    navigator.storage?.persisted?.().then(setPersisted).catch(() => {});
    let n = 0;
    for (const k of await db.keys('blobs')) if (String(k).endsWith(':orig')) n += (await db.get('blobs', k))?.size || 0;
    setOrigBytes(n);
  }
  useEffect(() => { refreshStorage(); }, []);
  useEffect(() => { if (focus) setTimeout(() => document.getElementById('sec-' + focus)?.scrollIntoView({ behavior: 'smooth' }), 100); }, [focus]);

  async function askPersist() {
    const ok = await navigator.storage?.persist?.().catch(() => false);
    setPersisted(!!ok);
  }

  async function makeBackup() {
    setBackup({ progress: 0 });
    try {
      const blob = await exportBackup((p) => setBackup({ progress: p }));
      const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
      const name = `PaperSnap-backup-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.zip`;
      setBackup({ blob, name });
    } catch (e) { setBackup(null); app.toast(t('backup.failed') + ' ' + e.message); }
  }
  async function backupDone(fn) {
    try {
      const r = await fn(backup.blob, backup.name);
      if (r !== 'cancelled') { await setSettings({ lastBackupAt: Date.now() }); app.toast(t('backup.done')); }
    } catch (e) { app.toast(t('backup.failed') + ' ' + e.message); }
  }

  async function restore() {
    const files = await pickFiles({ multiple: false, accept: '.zip,application/zip' });
    if (!files.length) return;
    setRestoreProgress(0);
    try {
      const r = await importBackup(files[0], setRestoreProgress);
      app.toast(t('backup.restored', { docs: r.docs, pages: r.pages }));
      emit('doc', {});
      refreshStorage();
    } catch (e) { app.toast(t('backup.restoreFailed') + ' ' + e.message); }
    setRestoreProgress(null);
  }

  async function purgeOriginals() {
    setConfirmPurge(false);
    for (const p of await db.all('pages')) {
      if (p.hasOriginal) { await db.del('blobs', `${p.id}:orig`); await db.put('pages', { ...p, hasOriginal: false }); }
    }
    refreshStorage();
    app.toast(t('storage.purged'));
  }

  const selectedBytes = OCR_LANGS.filter((l) => s.ocrLangs.includes(l.code) && !s.ocrDownloaded.includes(l.code)).reduce((a, l) => a + l.bytes, 0);
  const ocrReady = s.ocrLangs.every((c) => s.ocrDownloaded.includes(c));

  async function downloadLangs() {
    if (isNative && !LANG_BASE_URL) { app.toast(t('ocr.noHost')); return; }
    setOcrDl({ progress: 0 });
    try {
      await prepareLanguages(s.ocrLangs, (m) => {
        if (m.status?.includes('loading language')) setOcrDl({ progress: m.progress || 0 });
      });
      await setSettings({ ocrDownloaded: [...new Set([...s.ocrDownloaded, ...s.ocrLangs])] });
      setOcrDl(null);
      app.toast(t('ocr.ready'));
    } catch (e) {
      setOcrDl(null);
      app.toast(t('ocr.downloadFailed') + ' ' + (e.message || ''));
    }
  }

  const toggleLang = (code) => {
    const next = s.ocrLangs.includes(code) ? s.ocrLangs.filter((c) => c !== code) : [...s.ocrLangs, code];
    if (next.length) setSettings({ ocrLangs: next });
  };

  const Seg = ({ value, options, onPick }) => (
    <div class="seg full">{options.map(([v, l]) => <button key={v} class={value === v ? 'on' : ''} onClick={() => onPick(v)}>{l}</button>)}</div>
  );

  return (
    <div class="screen settings">
      <header class="topbar">
        <div class="topbar-row">
          <IconButton icon="back" label={t('common.back')} onClick={() => nav.back()} />
          <div class="topbar-title">{t('settings.title')}</div>
          <span class="icon-btn-spacer" />
        </div>
      </header>

      <div class="settings-body">
        <section class="card">
          <h2>{t('settings.general')}</h2>
          <div class="field-label">{t('settings.language')}</div>
          <Seg value={s.lang || 'en'} options={[['en', 'English'], ['zh', '中文']]} onPick={(v) => setSettings({ lang: v })} />
          <div class="field-label">{t('settings.theme')}</div>
          <Seg value={s.theme} options={[['dark', t('settings.dark')], ['light', t('settings.light')], ['system', t('settings.system')]]} onPick={(v) => setSettings({ theme: v })} />
        </section>

        <section class="card">
          <h2>{t('settings.scanning')}</h2>
          <Toggle checked={s.autoCapture} onChange={(v) => setSettings({ autoCapture: v })} label={t('settings.autoCapture')} />
          <div class="field-label">{t('settings.defaultFilter')}</div>
          <div class="chips wrap">
            {FILTERS.map((f) => <button key={f} class={`chip ${s.defaultFilter === f ? 'on' : ''}`} onClick={() => setSettings({ defaultFilter: f })}>{t('filter.' + f)}</button>)}
          </div>
          <div class="field-label">{t('settings.defaultAspect')}</div>
          <Seg value={s.defaultAspect} options={[['auto', t('settings.aspectAuto')], ['a4', 'A4']]} onPick={(v) => setSettings({ defaultAspect: v })} />
        </section>

        <section class="card" id="sec-storage">
          <h2>{t('storage.title')}</h2>
          <div class="kv"><span>{t('storage.used')}</span><b>{usage ? formatBytes(usage.usage) : '…'}</b></div>
          {usage?.quota ? <div class="kv"><span>{t('storage.available')}</span><b>{formatBytes(usage.quota)}</b></div> : null}
          <div class="kv"><span>{t('storage.originals')}</span><b>{origBytes == null ? '…' : formatBytes(origBytes)}</b></div>
          {!isNative && (
            <div class="kv"><span>{t('storage.persistent')}</span>
              {persisted ? <b class="ok">{t('common.yes')}</b> : <button class="link-btn" onClick={askPersist}>{t('storage.askPersist')}</button>}
            </div>
          )}
          <Toggle checked={s.keepOriginals} onChange={(v) => setSettings({ keepOriginals: v })} label={t('storage.keepOriginals')} />
          <p class="muted small">{t('storage.keepOriginalsNote')}</p>
          {s.keepOriginals && (<>
            <div class="field-label">{t('storage.deleteAfter')}</div>
            <Seg value={s.originalsDays} options={[[7, t('storage.days', { n: 7 })], [30, t('storage.days', { n: 30 })], [90, t('storage.days', { n: 90 })], [0, t('storage.never')]]} onPick={(v) => setSettings({ originalsDays: v })} />
          </>)}
          <button class="btn ghost" onClick={() => setConfirmPurge(true)} disabled={!origBytes}><Icon name="trash" />{t('storage.purgeNow')}</button>
        </section>

        <section class="card" id="sec-backup">
          <h2>{t('backup.title')}</h2>
          <p class="muted small">{isIOS && !isNative ? t('backup.iosWarning') : t('backup.note')}</p>
          <div class="kv"><span>{t('backup.last')}</span><b>{s.lastBackupAt ? fmtDate(s.lastBackupAt) : t('backup.never')}</b></div>
          {backup?.progress != null && <Progress value={backup.progress} />}
          {backup?.blob ? (<>
            <div class="result-line"><Icon name="check" />{backup.name} · {formatBytes(backup.blob.size)}</div>
            <div class="row-2">
              <button class="btn ghost" onClick={() => backupDone(saveFile)}><Icon name="download" />{isNative ? t('export.saveDocuments') : t('export.download')}</button>
              <button class="btn primary" onClick={() => backupDone(shareFile)}><Icon name="share" />{t('export.share')}</button>
            </div>
          </>) : (
            <button class="btn primary" onClick={makeBackup} disabled={backup?.progress != null}>{t('backup.export')}</button>
          )}
          {restoreProgress != null && <Progress value={restoreProgress} />}
          <button class="btn ghost" onClick={restore} disabled={restoreProgress != null}>{t('backup.restore')}</button>
        </section>

        <section class="card" id="sec-ocr">
          <h2>{t('ocr.title')}</h2>
          <Toggle checked={s.ocrEnabled} onChange={(v) => setSettings({ ocrEnabled: v })} label={t('ocr.enable')} />
          <p class="muted small">{t('ocr.note')}</p>
          {s.ocrEnabled && (<>
            <div class="field-label">{t('ocr.languages')}</div>
            <div class="menu">
              {OCR_LANGS.map((l) => (
                <label key={l.code} class="check-row">
                  <input type="checkbox" checked={s.ocrLangs.includes(l.code)} onChange={() => toggleLang(l.code)} />
                  <span class="grow">{l.label}</span>
                  <span class="muted small">{s.ocrDownloaded.includes(l.code) ? t('ocr.downloaded') : formatBytes(l.bytes)}</span>
                </label>
              ))}
            </div>
            {ocrDl && <Progress value={ocrDl.progress} />}
            {!ocrReady && (
              <button class="btn primary" onClick={downloadLangs} disabled={!!ocrDl}>
                <Icon name="download" />{t('ocr.download', { size: formatBytes(selectedBytes) })}
              </button>
            )}
            <Toggle checked={s.ocrAuto} onChange={(v) => setSettings({ ocrAuto: v })} label={t('ocr.auto')} />
            <p class="muted small">{t('ocr.autoNote')}</p>
          </>)}
        </section>

        <section class="card">
          <h2><Icon name="shield" size={18} /> {t('privacy.title')}</h2>
          <p class="muted small">{t('privacy.body')}</p>
          <p class="muted small">PaperSnap 1.0.0</p>
        </section>
      </div>

      <ConfirmDialog open={confirmPurge} danger title={t('storage.purgeTitle')} body={t('storage.purgeBody')} okLabel={t('common.delete')}
        onCancel={() => setConfirmPurge(false)} onOk={purgeOriginals} />
    </div>
  );
}
