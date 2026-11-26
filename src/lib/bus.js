// Tiny event bus so screens refresh when background processing finishes.
const handlers = new Map();
export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => handlers.get(type).delete(fn);
}
export function emit(type, payload) {
  handlers.get(type)?.forEach((fn) => { try { fn(payload); } catch (e) { console.error(e); } });
}
