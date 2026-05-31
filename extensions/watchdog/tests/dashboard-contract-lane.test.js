import test from "node:test";
import assert from "node:assert/strict";

import { ContractCardView } from "../dashboard-contract-card.js";
import { ContractLaneView } from "../dashboard-contract-lane.js";

class MockClassList {
  constructor(element) {
    this.element = element;
    this.tokens = new Set();
  }

  add(...tokens) {
    tokens.forEach((token) => this.tokens.add(token));
    this.element.attributes.class = [...this.tokens].join(" ");
  }
}

function matchesSelector(element, selector) {
  const normalized = String(selector || "");
  if (normalized.startsWith(".")) {
    return normalized.slice(1).split(".").every((token) => element.classList.tokens.has(token));
  }
  if (normalized.startsWith("[")) {
    const [name, rawValue] = normalized.slice(1, -1).split("=");
    const expected = rawValue?.replace(/^"|"$/gu, "");
    return expected == null ? element.attributes[name] !== undefined : element.attributes[name] === expected;
  }
  return false;
}

function collect(element, selector, results = []) {
  for (const child of element.children) {
    if (matchesSelector(child, selector)) results.push(child);
    collect(child, selector, results);
  }
  return results;
}

class MockElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = {};
    this.children = [];
    this.parentNode = null;
    this.classList = new MockClassList(this);
    this.textContent = "";
  }

  appendChild(child) {
    if (child?.parentNode) {
      child.parentNode.children = child.parentNode.children.filter((entry) => entry !== child);
    }
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === "class") {
      this.classList.tokens = new Set(String(value).split(/\s+/u).filter(Boolean));
    }
  }

  getAttribute(name) {
    return this.attributes[name];
  }

  querySelector(selector) {
    return collect(this, selector)[0] || null;
  }

  querySelectorAll(selector) {
    return collect(this, selector);
  }
}

function svgEl(tag, attrs = {}, parent = null) {
  const element = new MockElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "textContent") element.textContent = String(value);
    else if (key === "className") element.setAttribute("class", value);
    else element.setAttribute(key, value);
  }
  if (parent) parent.appendChild(element);
  return element;
}

test("contract lane update reuses stable contract card DOM nodes", () => {
  const parent = svgEl("g");
  const lane = new ContractLaneView({
    contractCardView: new ContractCardView({ svgEl }),
  });
  const model = {
    lane: "incoming",
    anchor: { x: 10, y: 20 },
    width: 64,
    items: [
      { contractId: "TC-STABLE-1", status: "queued" },
      { contractId: "TC-STABLE-2", status: "queued" },
    ],
  };

  lane.render(parent, model);
  const firstCard = parent.querySelector('[data-contract-id="TC-STABLE-1"]');
  assert.ok(firstCard, "expected initial card");
  firstCard.__hoverProbe = "still-mounted";

  lane.render(parent, model);

  const updatedCard = parent.querySelector('[data-contract-id="TC-STABLE-1"]');
  assert.equal(updatedCard, firstCard);
  assert.equal(updatedCard.__hoverProbe, "still-mounted");
  assert.equal(parent.querySelectorAll(".contract-flow-card.lane-incoming").length, 2);
});

test("contract lane reorder keeps primary queue card painted last", () => {
  const parent = svgEl("g");
  const lane = new ContractLaneView({
    contractCardView: new ContractCardView({ svgEl }),
  });
  const model = {
    lane: "incoming",
    anchor: { x: 10, y: 20 },
    width: 64,
    items: [
      { contractId: "TC-ORDER-1", status: "queued" },
      { contractId: "TC-ORDER-2", status: "queued" },
    ],
  };

  lane.render(parent, model);
  const laneGroup = parent.querySelector("[data-contract-lane-key]");
  const firstCard = laneGroup.querySelector('[data-contract-id="TC-ORDER-1"]');
  const secondCard = laneGroup.querySelector('[data-contract-id="TC-ORDER-2"]');

  lane.render(parent, {
    ...model,
    items: [
      { contractId: "TC-ORDER-2", status: "queued" },
      { contractId: "TC-ORDER-1", status: "queued" },
    ],
  });

  const cards = laneGroup.querySelectorAll(".contract-flow-card");
  assert.equal(cards[0], firstCard);
  assert.equal(cards[1], secondCard);
  assert.equal(cards[cards.length - 1].getAttribute("data-contract-id"), "TC-ORDER-2");
  assert.equal(cards[cards.length - 1], secondCard);
});
