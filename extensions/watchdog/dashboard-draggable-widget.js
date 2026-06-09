// dashboard-draggable-widget.js — Make an HTML chart panel draggable by its header.
// Plain HTML (clientX/clientY delta), NOT SVG/getScreenCTM. See dashboard-drag.js
// for the SVG-based variant (this is a sibling, not a refactor of it).

// makeDraggable(panelEl, { onCommit }) -> cleanup()
//   - Drag handle is panelEl.querySelector('.chart-panel__header').
//   - mousedown on the handle starts a drag; mousemove updates panelEl.style.left/top
//     by clientX/clientY delta (clamped to >= 0); mouseup ends the drag and, only if
//     the panel actually moved, calls onCommit({ x, y }) with final integer px.
//   - Returns cleanup() removing the document-level listeners.
export function makeDraggable(panelEl, { onCommit } = {}) {
  const handle = panelEl && panelEl.querySelector('.chart-panel__header');
  if (!handle) return () => {};

  let dragging = null;

  function onMouseDown(e) {
    // Only the primary button initiates a drag.
    if (e.button !== 0) return;
    const startLeft = parseFloat(panelEl.style.left) || 0;
    const startTop = parseFloat(panelEl.style.top) || 0;
    dragging = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startLeft,
      startTop,
      x: Math.round(startLeft),
      y: Math.round(startTop),
      moved: false,
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!dragging) return;
    dragging.moved = true;
    const x = Math.max(0, Math.round(dragging.startLeft + (e.clientX - dragging.startClientX)));
    const y = Math.max(0, Math.round(dragging.startTop + (e.clientY - dragging.startClientY)));
    dragging.x = x;
    dragging.y = y;
    panelEl.style.left = `${x}px`;
    panelEl.style.top = `${y}px`;
    e.preventDefault();
  }

  function onMouseUp() {
    if (!dragging) return;
    const { moved, x, y } = dragging;
    dragging = null;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    if (moved && typeof onCommit === 'function') onCommit({ x, y });
  }

  handle.addEventListener('mousedown', onMouseDown);

  return function cleanup() {
    handle.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
}
