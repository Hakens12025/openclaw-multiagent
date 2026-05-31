// dashboard-contract-lane.js — Adaptive FIFO lane layout for contract cards.

const CARD_SIZE = 18;
const GAP = 4;
const MAX_STACK_VISIBLE_ITEMS = 4;
const STACK_STEP_X = 7;
const STACK_STEP_Y = 0;

export class ContractLaneView {
  constructor({ contractCardView }) {
    this.contractCardView = contractCardView;
  }

  render(parent, laneModel) {
    const items = Array.isArray(laneModel?.items) ? laneModel.items : [];
    if (!parent) return [];

    const laneKey = this.resolveLaneKey(laneModel);
    this.removeStaleLaneElements(parent, laneKey, new Set(items.map((item) => item?.contractId).filter(Boolean)));
    if (items.length === 0) return [];

    const laneGroup = this.resolveLaneGroup(parent, laneModel, laneKey);

    const visibleLimit = this.resolveVisibleStackLimit(laneModel);
    const rendered = [];

    const visibleItems = items.slice(0, visibleLimit);
    for (let index = visibleItems.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      const collapsed = this.collapsedPositionFor(laneModel, index, visibleLimit);
      const existing = laneGroup.querySelector?.(`[data-contract-id="${this.escapeSelectorValue(item.contractId)}"]`) || null;
      const el = this.contractCardView.render(laneGroup, {
        ...item,
        lane: laneModel.lane,
        primary: index === 0,
        x: collapsed.x,
        y: collapsed.y,
        opacity: 1,
        width: CARD_SIZE,
        height: CARD_SIZE,
      }, { existing });
      if (el) rendered.push(el);
    }

    this.removeStaleLaneElements(parent, laneKey, new Set(visibleItems.map((item) => item?.contractId).filter(Boolean)));
    if (items.length > visibleLimit) {
      rendered.push(this.renderOverflow(laneGroup, laneModel, items.length - visibleLimit, laneKey));
    } else {
      this.removeOverflow(parent, laneKey);
    }

    return rendered.filter(Boolean);
  }

  resolveLaneKey(laneModel) {
    const anchor = laneModel?.anchor || {};
    return [
      laneModel?.lane || 'unknown',
      anchor.side || 'center',
      anchor.direction || 'left_to_right',
      Math.round(anchor.x || 0),
      Math.round(anchor.y || 0),
    ].join(':');
  }

  buildLaneKey(laneModel) {
    return this.resolveLaneKey(laneModel);
  }

  removeInactiveLaneGroups(parent, activeLaneKeys = new Set()) {
    if (!parent) return;
    for (const laneGroup of parent.querySelectorAll?.('[data-contract-lane-key]') || []) {
      const laneKey = laneGroup.getAttribute?.('data-contract-lane-key');
      if (!activeLaneKeys.has(laneKey)) laneGroup.remove();
    }
    for (const overflow of parent.querySelectorAll?.('[data-contract-lane-overflow]') || []) {
      const laneKey = overflow.getAttribute?.('data-contract-lane-overflow');
      if (!activeLaneKeys.has(laneKey)) overflow.remove();
    }
  }

  resolveLaneGroup(parent, laneModel, laneKey) {
    const selector = `[data-contract-lane-key="${this.escapeSelectorValue(laneKey)}"]`;
    const existing = parent.querySelector?.(selector) || null;
    if (existing) {
      existing.setAttribute('class', `lane-${laneModel.lane}`);
      return existing;
    }
    return this.contractCardView.svgEl('g', {
      className: `lane-${laneModel.lane}`,
      'data-contract-lane-key': laneKey,
    }, parent);
  }

  removeStaleLaneElements(parent, laneKey, activeContractIds) {
    const selector = `[data-contract-lane-key="${this.escapeSelectorValue(laneKey)}"]`;
    const laneGroup = parent.querySelector?.(selector) || null;
    if (!laneGroup) return;
    for (const card of laneGroup.querySelectorAll?.('.contract-flow-card') || []) {
      const contractId = card.getAttribute?.('data-contract-id');
      if (!activeContractIds.has(contractId)) card.remove();
    }
  }

  resolveVisibleStackLimit(laneModel) {
    const width = Number(laneModel?.width) || CARD_SIZE;
    return Math.min(MAX_STACK_VISIBLE_ITEMS, Math.max(1, Math.floor((width + GAP) / (STACK_STEP_X + GAP))));
  }

  collapsedPositionFor(laneModel, index, visibleLimit) {
    const anchor = laneModel.anchor || { x: 0, y: 0 };
    const stackIndex = Math.min(index, Math.max(visibleLimit - 1, 0));
    return {
      x: anchor.x + stackIndex * STACK_STEP_X,
      y: anchor.y + stackIndex * STACK_STEP_Y,
    };
  }

  renderOverflow(parent, laneModel, overflowCount, laneKey) {
    const anchor = laneModel.anchor || { x: 0, y: 0 };
    const selector = `[data-contract-lane-overflow="${this.escapeSelectorValue(laneKey)}"]`;
    const overflow = parent.querySelector?.(selector)
      || this.contractCardView.svgEl('text', {}, parent);
    this.contractCardView.applyAttributes(overflow, {
      x: anchor.x + CARD_SIZE + 12,
      y: anchor.y + CARD_SIZE - 3,
      textContent: `+${overflowCount}`,
      className: 'contract-flow-overflow',
      'data-contract-lane-overflow': laneKey,
    });
    return overflow;
  }

  removeOverflow(parent, laneKey) {
    const selector = `[data-contract-lane-overflow="${this.escapeSelectorValue(laneKey)}"]`;
    parent.querySelector?.(selector)?.remove();
  }

  escapeSelectorValue(value) {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
    return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  }
}
