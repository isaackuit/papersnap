// Backup / restore everything as one zip. Format:
//   manifest.json  {app, version, exportedAt, docs, pages, folders, settings}
//   blobs/<pageId>.<orig|proc|thumb>.jpg
import JSZip from 'jszip';
import { db, loadSettings, saveSettings } from './db.js';

export async function exportBackup(onProgress) {
  const zip = new JSZip();
  const [docs, pages, folders, settings] = await Promise.all([db.all('docs'), db.all('pages'), db.all('folders'), loadSettings()]);
  const keys = await db.keys('blobs');
  zip.file('manifest.json', JSON.stringify({ app: 'PaperSnap', version: 1, exportedAt: Date.now(), docs, pages, folders, settings }));
  let i = 0;
  for (const key of keys) {
    const blob = await db.get('blobs', key);
    if (blob) zip.file(`blobs/${key.replace(':', '.')}.jpg`, blob, { binary: true });
    onProgress?.(++i / keys.length * 0.5);
  }
  // Images are already compressed — STORE keeps it fast and light on memory.
  return zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/zip' }, (m) => onProgress?.(0.5 + m.percent / 200));
}

// Merges into existing data (same ids are overwritten, nothing else is removed).
export async function importBackup(file, onProgress) {
  const zip = await JSZip.loadAsync(file);
  const mf = zip.file('manifest.json');
  if (!mf) throw new Error('not a PaperSnap backup');
  const m = JSON.parse(await mf.async('string'));
  if (m.app !== 'PaperSnap') throw new Error('not a PaperSnap backup');
  for (const f of m.folders || []) await db.put('folders', f);
  for (const d of m.docs || []) await db.put('docs', d);
  for (const p of m.pages || []) await db.put('pages', { ...p, rendering: false });
  const files = Object.keys(zip.files).filter((n) => n.startsWith('blobs/') && !zip.files[n].dir);
  let i = 0;
  for (const name of files) {
    const base = name.slice(6).replace(/\.jpg$/, '');
    const dot = base.lastIndexOf('.');
    const key = base.slice(0, dot) + ':' + base.slice(dot + 1);
    const data = await zip.file(name).async('blob');
    await db.put('blobs', new Blob([data], { type: 'image/jpeg' }), key);
    onProgress?.(++i / files.length);
  }
  const s = await loadSettings();
  await saveSettings({ ...s, lastBackupAt: Math.max(s.lastBackupAt || 0, m.exportedAt || 0) });
  return { docs: (m.docs || []).length, pages: (m.pages || []).length };
}
