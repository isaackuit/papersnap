import { render } from 'preact';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/space-grotesk/500.css';
import '@fontsource/space-grotesk/700.css';
import './styles.css';
import { App } from './app.jsx';
import { isNative } from './lib/platform.js';

render(<App />, document.getElementById('app'));

// Service worker = full offline support for the PWA. (The APK serves files locally already.)
if (!isNative && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
