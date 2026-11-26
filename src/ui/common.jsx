import { createContext } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons.jsx';
import { t } from '../lib/i18n.js';
import { db } from '../lib/db.js';
import { on } from '../lib/bus.js';

export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function IconButton({ icon, label, onClick, tone, size = 22, disabled, class: cls = '' }) {
  return (
    <button type="button" class={`icon-btn ${tone || ''} ${cls}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export function TopBar({ title, left, right, sub }) {
  return (
    <header class="topbar">
      <div class="topbar-row">
        {left}
        <div class="topbar-title">{title}</div>
        <div class="topbar-right">{right}</div>
      </div>
      {sub}
    </header>
  );
}

// Object URL for a stored blob; refreshes when the page re-renders.
export function useBlobUrl(key, version) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    let u = null, alive = true;
    db.get('blobs', key).then((b) => { if (b && alive) { u = URL.createObjectURL(b); setUrl(u); } else if (alive) setUrl(null); });
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [key, version]);
  return url;
}

export function useBus(type, fn, deps = []) {
  useEffect(() => on(type, fn), deps);
}

export function Thumb({ pageId, version, class: cls = '', alt = '' }) {
  const url = useBlobUrl(`${pageId}:thumb`, version);
  return url ? <img class={cls} src={url} alt={alt} draggable={false} /> : <div class={`${cls} thumb-pending`}><span class="spinner" /></div>;
}

export function Sheet({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div class="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div class="sheet-handle" />
        {title && <div class="sheet-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

export function PromptDialog({ open, title, initial = '', placeholder, onCancel, onOk, okLabel, allowEmpty = false }) {
  const [v, setV] = useState(initial);
  const ref = useRef();
  useEffect(() => { if (open) { setV(initial); setTimeout(() => ref.current?.select(), 50); } }, [open]);
  if (!open) return null;
  return (
    <Sheet open onClose={onCancel} title={title}>
      <form class="stack" onSubmit={(e) => { e.preventDefault(); if (v.trim() || allowEmpty) onOk(v.trim()); }}>
        <input ref={ref} class="field" value={v} placeholder={placeholder} onInput={(e) => setV(e.currentTarget.value)} aria-label={title} />
        <div class="row-2">
          <button type="button" class="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
          <button type="submit" class="btn primary" disabled={!v.trim() && !allowEmpty}>{okLabel || t('common.ok')}</button>
        </div>
      </form>
    </Sheet>
  );
}

export function ConfirmDialog({ open, title, body, danger, okLabel, onCancel, onOk }) {
  if (!open) return null;
  return (
    <Sheet open onClose={onCancel} title={title}>
      {body && <p class="muted">{body}</p>}
      <div class="row-2">
        <button type="button" class="btn ghost" onClick={onCancel}>{t('common.cancel')}</button>
        <button type="button" class={`btn ${danger ? 'danger' : 'primary'}`} onClick={onOk}>{okLabel || t('common.ok')}</button>
      </div>
    </Sheet>
  );
}

export function Toggle({ checked, onChange, label }) {
  return (
    <label class="toggle-row">
      <span>{label}</span>
      <input type="checkbox" class="toggle" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
    </label>
  );
}

export function Progress({ value }) {
  return <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(value * 100)}><div style={{ width: `${Math.round(value * 100)}%` }} /></div>;
}

// Hidden file input helper. capture → system camera fallback.
export function pickFiles({ multiple = true, capture = false, accept = 'image/*' } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    input.onchange = () => { resolve(Array.from(input.files || [])); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
}

export { Icon };
