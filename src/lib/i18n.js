import en from '../i18n/en.json';
import zh from '../i18n/zh.json';

const dicts = { en, zh };
let dict = en;
let lang = 'en';

export function setLang(l) {
  lang = dicts[l] ? l : 'en';
  dict = dicts[lang];
  document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
}
export const getLang = () => lang;

export function t(key, vars) {
  if (vars && vars.n === 1 && dict[key + '.one'] != null) key += '.one'; // English singular
  let s = dict[key] ?? en[key] ?? key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-MY', { day: 'numeric', month: 'short', year: 'numeric' });
}
