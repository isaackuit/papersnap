import { Capacitor } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();
export const isAndroid = Capacitor.getPlatform() === 'android' || /Android/i.test(navigator.userAgent);
export const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

// Where OCR language packs live. PWA: next to the app. APK: the PWA's static host.
export const LANG_BASE_URL = isNative
  ? (import.meta.env.VITE_LANG_BASE_URL || '').replace(/\/$/, '')
  : new URL('ocr/lang', document.baseURI).href.replace(/\/$/, '');

export const appUrl = (path) => new URL(path, document.baseURI).href;
