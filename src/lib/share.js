// Share / save a generated file.
// iPhone (PWA): Web Share API with files → system share sheet (Files, Drive, WhatsApp, Mail…).
// Android (APK): Capacitor Filesystem + Share; "Save" writes to Documents/PaperSnap.
import { isNative } from './platform.js';

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export function canWebShareFiles(blob, name) {
  try {
    const f = new File([blob], name, { type: blob.type });
    return !!navigator.canShare?.({ files: [f] });
  } catch { return false; }
}

export async function shareFile(blob, name) {
  if (isNative) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const res = await Filesystem.writeFile({ path: name, data: await blobToBase64(blob), directory: Directory.Cache });
    await Share.share({ title: name, files: [res.uri] });
    return 'shared';
  }
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return 'shared';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      throw e;
    }
  }
  download(blob, name);
  return 'downloaded';
}

// Android: Documents/PaperSnap. Web: browser download (iPhone offers "Save to Files").
export async function saveFile(blob, name) {
  if (isNative) {
    const { Filesystem, Directory } = await import('@capacitor/filesystem');
    const path = `PaperSnap/${name}`;
    try {
      await Filesystem.writeFile({ path, data: await blobToBase64(blob), directory: Directory.Documents, recursive: true });
      return 'Documents/' + path;
    } catch (e) {
      // Some devices refuse public Documents — fall back to Downloads via the share sheet.
      await shareFile(blob, name);
      return null;
    }
  }
  download(blob, name);
  return null;
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function safeFileName(name) {
  return (name || 'scan').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'scan';
}
