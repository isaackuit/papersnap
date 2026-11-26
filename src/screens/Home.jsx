import { useEffect, useMemo, useState } from 'preact/hooks';
import { useApp, IconButton, Icon, Thumb, useBus, PromptDialog, ConfirmDialog, Sheet, pickFiles } from '../ui/common.jsx';
import { db, uid } from '../lib/db.js';
import { t, fmtDate } from '../lib/i18n.js';
import { formatBytes } from '../lib/images.js';
import { isIOS, isNative } from '../lib/platform.js';

const BACKUP_NAG_DAYS = 14;

export function Home() {
  const app = useApp();
  const { settings, nav } = app;
  const [docs, setDocs] = useState([]);
  const [pages, setPages] = useState({});
  const [folders, setFolders] = useState([]);
  const [filter, setFilter] = useState({ type: 'all' });
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [usage, setUsage] = useState(null);
  const [dialog, setDialog] = useState(null);

  async function load() {
    const [d, p, f] = await Promise.all([db.all('docs'), db.all('pages'), db.all('folders')]);
    setDocs(d);
    setPages(Object.fromEntries(p.map((x) => [x.id, x])));
    setFolders(f.sort((a, b) => a.name.localeCompare(b.name)));
    navigator.storage?.estimate?.().then((e) => setUsage(e.usage)).catch(() => {});
  }
  useEffect(() => { load(); }, []);
  useBus('page', load);
  useBus('doc', load);

  const tags = useMemo(() => [...new Set(docs.flatMap((d) => d.tags || []))].sort(), [docs]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = docs.filter((d) => {
      if (filter.type === 'folder' && d.folderId !== filter.id) return false;
      if (filter.type === 'tag' && !(d.tags || []).includes(filter.tag)) return false;
      if (!q) return true;
      if (d.name.toLowerCase().includes(q)) return true;
      if ((d.tags || []).some((tg) => tg.toLowerCase().includes(q))) return true;
      return d.pageIds.some((pid) => pages[pid]?.ocr?.text?.toLowerCase().includes(q));
    });
    const s = settings.sort;
    list.sort((a, b) => s === 'old' ? a.createdAt - b.createdAt : s === 'name' ? a.name.localeCompare(b.name) : b.updatedAt - a.updatedAt);
    return list;
  }, [docs, pages, filter, query, settings.sort]);

  const needsBackup = docs.length > 0 && Date.now() - (settings.lastBackupAt || 0) > BACKUP_NAG_DAYS * 86400000;
  const sortLabel = { new: t('sort.new'), old: t('sort.old'), name: t('sort.name') }[settings.sort];
  const nextSort = { new: 'old', old: 'name', name: 'new' }[settings.sort];

  async function onImport() {
    const files = await pickFiles({ multiple: true });
    if (!files.length) return;
    const docId = await app.importFiles(files);
    if (docId) nav.push({ name: 'doc', docId });
  }

  const currentFolder = filter.type === 'folder' ? folders.find((f) => f.id === filter.id) : null;

  return (
    <div class="screen home">
      <header class="home-head">
        <div class="home-title-row">
          <h1 class="brand">PaperSnap</h1>
          <div class="row gap-8">
            <IconButton icon="search" label={t('home.search')} onClick={() => { setSearching(!searching); setQuery(''); }} />
            <IconButton icon="settings" label={t('settings.title')} onClick={() => nav.push({ name: 'settings' })} />
          </div>
        </div>
        <div class="muted small">{t('home.summary', { n: docs.length, size: usage != null ? formatBytes(usage) : '…' })}</div>
        {searching && (
          <label class="search">
            <Icon name="search" size={20} />
            <input autoFocus type="search" value={query} placeholder={settings.ocrEnabled ? t('home.searchPlaceholderOcr') : t('home.searchPlaceholder')}
              onInput={(e) => setQuery(e.currentTarget.value)} aria-label={t('home.search')} />
          </label>
        )}
      </header>

      {needsBackup && (
        <div class="banner">
          <div>
            <div class="banner-title">{settings.lastBackupAt ? t('backup.nagDays', { n: Math.floor((Date.now() - settings.lastBackupAt) / 86400000) }) : t('backup.nagNever')}</div>
            {isIOS && !isNative && <div class="small">{t('backup.iosWarning')}</div>}
          </div>
          <button class="btn small primary" onClick={() => nav.push({ name: 'settings', focus: 'backup' })}>{t('backup.now')}</button>
        </div>
      )}

      <div class="chips" role="tablist">
        <button role="tab" class={`chip ${filter.type === 'all' ? 'on' : ''}`} onClick={() => setFilter({ type: 'all' })}>{t('home.all')}</button>
        {folders.map((f) => (
          <button role="tab" key={f.id} class={`chip ${filter.id === f.id ? 'on' : ''}`} onClick={() => setFilter({ type: 'folder', id: f.id })}>
            <Icon name="folder" size={16} />{f.name}
          </button>
        ))}
        {tags.map((tg) => (
          <button role="tab" key={tg} class={`chip ${filter.tag === tg ? 'on' : ''}`} onClick={() => setFilter({ type: 'tag', tag: tg })}>#{tg}</button>
        ))}
        <button class="chip dashed" onClick={() => setDialog({ kind: 'newFolder' })}><Icon name="plus" size={16} />{t('folder.new')}</button>
      </div>

      <div class="list-head">
        <span class="section-label">{currentFolder ? currentFolder.name : filter.type === 'tag' ? '#' + filter.tag : t('home.recent')}</span>
        <div class="row gap-8">
          {currentFolder && <button class="link-btn" onClick={() => setDialog({ kind: 'folderMenu', folder: currentFolder })}>{t('folder.manage')}</button>}
          <button class="link-btn" onClick={() => app.setSettings({ sort: nextSort })}><Icon name="sort" size={16} />{sortLabel}</button>
        </div>
      </div>

      <div class="doc-list">
        {visible.map((d) => {
          const first = pages[d.pageIds[0]];
          const folder = folders.find((f) => f.id === d.folderId);
          return (
            <button key={d.id} class="doc-row" onClick={() => nav.push({ name: 'doc', docId: d.id })}>
              <div class="doc-thumb">{first ? <Thumb pageId={first.id} version={first.version} /> : <div class="thumb-pending" />}</div>
              <div class="doc-info">
                <div class="doc-name">{d.name}</div>
                <div class="doc-meta">{t('doc.pages', { n: d.pageIds.length })} · {fmtDate(d.updatedAt)}{folder ? ` · ${folder.name}` : ''}</div>
                {d.tags?.length > 0 && <div class="doc-tags">{d.tags.map((tg) => <span key={tg} class="tag">#{tg}</span>)}</div>}
              </div>
            </button>
          );
        })}
        {visible.length === 0 && (
          <div class="empty">
            {docs.length === 0 ? (<><div class="empty-title">{t('home.emptyTitle')}</div><div class="muted">{t('home.emptyBody')}</div></>)
              : <div class="muted">{t('home.noMatch')}</div>}
          </div>
        )}
      </div>

      <div class="fab-bar">
        <button class="fab-secondary" aria-label={t('home.import')} onClick={onImport}><Icon name="image" size={24} /></button>
        <button class="fab" aria-label={t('home.scan')} onClick={() => nav.push({ name: 'camera', folderId: currentFolder?.id || null })}>
          <Icon name="scan" size={30} stroke={2.2} /><span>{t('home.scan')}</span>
        </button>
      </div>

      <PromptDialog open={dialog?.kind === 'newFolder'} title={t('folder.new')} placeholder={t('folder.namePlaceholder')}
        onCancel={() => setDialog(null)}
        onOk={async (name) => { const f = { id: uid(), name, createdAt: Date.now() }; await db.put('folders', f); setDialog(null); await load(); setFilter({ type: 'folder', id: f.id }); }} />
      <PromptDialog open={dialog?.kind === 'renameFolder'} title={t('folder.rename')} initial={dialog?.folder?.name}
        onCancel={() => setDialog(null)}
        onOk={async (name) => { await db.put('folders', { ...dialog.folder, name }); setDialog(null); load(); }} />
      <Sheet open={dialog?.kind === 'folderMenu'} title={dialog?.folder?.name} onClose={() => setDialog(null)}>
        <div class="menu">
          <button class="menu-item" onClick={() => setDialog({ kind: 'renameFolder', folder: dialog.folder })}><Icon name="edit" />{t('folder.rename')}</button>
          <button class="menu-item danger" onClick={() => setDialog({ kind: 'deleteFolder', folder: dialog.folder })}><Icon name="trash" />{t('folder.delete')}</button>
        </div>
      </Sheet>
      <ConfirmDialog open={dialog?.kind === 'deleteFolder'} danger title={t('folder.deleteTitle', { name: dialog?.folder?.name })} body={t('folder.deleteBody')} okLabel={t('common.delete')}
        onCancel={() => setDialog(null)}
        onOk={async () => {
          for (const d of docs.filter((x) => x.folderId === dialog.folder.id)) await db.put('docs', { ...d, folderId: null });
          await db.del('folders', dialog.folder.id); setDialog(null); setFilter({ type: 'all' }); load();
        }} />
    </div>
  );
}
