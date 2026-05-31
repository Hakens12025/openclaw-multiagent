// dashboard-contract-card.js — Small SVG contract cards used inside graph agent nodes.

export class ContractCardView {
  constructor({ svgEl, workItems = {}, focusWorkItem = null }) {
    this.svgEl = svgEl;
    this.workItems = workItems;
    this.focusWorkItem = focusWorkItem;
  }

  render(parent, card, { existing = null } = {}) {
    if (!parent || !card?.contractId) return null;
    const statusClass = card.status === 'blocked' ? 'status-blocked' : '';

    const groupAttrs = {
      className: [
        'contract-flow-card',
        `lane-${card.lane}`,
        statusClass,
        card.primary ? 'primary' : '',
      ].filter(Boolean).join(' '),
      'data-contract-id': card.contractId,
      transform: `translate(${card.x},${card.y})`,
      opacity: card.opacity ?? 1,
    };
    const group = existing || this.svgEl('g', groupAttrs, parent);
    this.applyAttributes(group, groupAttrs);
    parent.appendChild(group);

    const visualAttrs = {
      className: 'contract-flow-card-visual',
    };
    const visual = group.querySelector?.('.contract-flow-card-visual')
      || this.svgEl('g', visualAttrs, group);
    this.applyAttributes(visual, visualAttrs);

    const rectAttrs = {
      x: 0,
      y: 0,
      width: card.width,
      height: card.height,
      rx: 2,
      className: 'contract-flow-card-box',
    };
    const box = visual.querySelector?.('.contract-flow-card-box')
      || this.svgEl('rect', rectAttrs, visual);
    this.applyAttributes(box, rectAttrs);

    const detail = this.buildTooltip(card);
    const title = Array.from(group.children || []).find((child) => child.tagName?.toLowerCase?.() === 'title') || null;
    if (detail && title) {
      title.textContent = detail;
    } else if (detail) {
      this.svgEl('title', { textContent: detail }, group);
    } else if (title) {
      title.remove();
    }

    group.onclick = (event) => {
      event?.stopPropagation?.();
      this.focusWorkItem?.(card.contractId);
    };

    return group;
  }

  applyAttributes(element, attrs) {
    if (!element) return;
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === 'textContent') {
        element.textContent = String(value ?? '');
      } else if (key === 'className') {
        element.setAttribute('class', String(value ?? ''));
      } else {
        element.setAttribute(key, String(value ?? ''));
      }
    }
  }

  buildTooltip(card) {
    const workItem = this.workItems[card.contractId] || null;
    return [
      card.contractId,
      card.lane ? `lane: ${card.lane}` : null,
      card.status ? `status: ${card.status}` : null,
      workItem?.task ? `task: ${workItem.task}` : null,
    ].filter(Boolean).join('\n');
  }
}
