import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { AppCtx } from './ui/common.jsx';
import { loadSettings, saveSettings, purgeOldOriginals, createDoc } from './lib/db.js';
import { setLang, t } from './lib/i18n.js';
import { isNative } from './lib/platform.js';
import { addPage } from './lib/pages.js';
import { Home } from './screens/Home.jsx';
import { Camera } from './screens/Camera.jsx';
import { DocView } from './screens/DocView.jsx';
import { Editor } from './screens/Editor.jsx';
import { Settings } from './screens/Settings.jsx';

function applyTheme(theme) {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#121417' : '#F4F5F7');
}

export function App() {
  const [settings, setSettingsState] = useState(null);
  const [stack, setStack] = useState([{ name: 'home' }]);
  const [toast, setToast] = useState(null);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const toastTimer = useRef();

  useEffect(() => {
    loadSettings().then((s) => {
      setLang(s.lang || 'en');
      applyTheme(s.theme);
      setSettingsState(s);
      purgeOldOriginals(s).catch(() => {});
    });
    navigator.storage?.persist?.().catch(() => {});
  }, []);

  // Browser / iOS swipe back.
  useEffect(() => {
    history.replaceState({ depth: 0 }, '');
    const onPop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Android hardware back.
  useEffect(() => {
    if (!isNative) return;
    let handle;
    import('@capacitor/app').then(({ App: CapApp }) => {
      handle = CapApp.addListener('backButton', () => {
        if (stackRef.current.length > 1) history.back();
        else CapApp.exitApp();
      });
    });
    return () => handle?.then?.((h) => h.remove());
  }, []);

  const nav = useMemo(() => ({
    push(route) { history.pushState({ depth: stackRef.current.length }, ''); setStack((s) => [...s, route]); },
    replace(route) { setStack((s) => [...s.slice(0, -1), route]); },
    back() { if (stackRef.current.length > 1) history.back(); },
    home() {
      const n = stackRef.current.length - 1;
      if (n > 0) history.go(-n);
    },
  }), []);

  const app = useMemo(() => ({
    settings,
    nav,
    async setSettings(patch) {
      const next = { ...settings, ...patch };
      if (patch.lang) setLang(patch.lang);
      if (patch.theme) applyTheme(patch.theme);
      setSettingsState(next);
      await saveSettings(next);
      if ('keepOriginals' in patch || 'originalsDays' in patch) purgeOldOriginals(next).catch(() => {});
    },
    toast(msg) {
      clearTimeout(toastTimer.current);
      setToast(msg);
      toastTimer.current = setTimeout(() => setToast(null), 2800);
    },
    // Import photos into a new or existing document.
    async importFiles(files, docId) {
      const images = files.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name));
      if (!images.length) { app.toast(t('import.none')); return null; }
      const doc = docId ? { id: docId } : await createDoc();
      for (const f of images) {
        addPage(doc.id, f, { settings }).catch((e) => app.toast(t('error.process') + ' ' + e.message));
      }
      return doc.id;
    },
  }), [settings, nav]);

  if (!settings) return <div class="boot"><span class="spinner" /></div>;

  const route = stack[stack.length - 1];
  let screen;
  switch (route.name) {
    case 'camera': screen = <Camera {...route} />; break;
    case 'doc': screen = <DocView key={route.docId} {...route} />; break;
    case 'edit': screen = <Editor key={route.pageId} {...route} />; break;
    case 'settings': screen = <Settings {...route} />; break;
    default: screen = <Home />;
  }

  return (
    <AppCtx.Provider value={app}>
      {screen}
      {toast && <div class="toast" role="status">{toast}</div>}
    </AppCtx.Provider>
  );
}
