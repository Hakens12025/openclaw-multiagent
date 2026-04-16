// dashboard-bus.js — Lightweight event bus for decoupling cross-module hooks
const _listeners = {};
export function on(event, fn) { (_listeners[event] ||= []).push(fn); }
export function off(event, fn) { const a = _listeners[event]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); } }
export function emit(event, data) { for (const fn of (_listeners[event] || [])) { try { fn(data); } catch(e) { console.error(`[oc:bus] ${event}:`, e); } } }
