import test from "node:test";
import assert from "node:assert/strict";
import { renderOutputPanel } from "../ui/components/output-panel.js";
import { createI18n } from "../ui/core/i18n.js";

const i18n = createI18n({ lang: "en-US" });

const model = {
  producedFiles: {
    available: true,
    files: [
      { name: "report.md", path: "/out/report.md", chars: 120, truncated: false, content: "# Report body", primary: true },
      { name: "raw.json", path: "/out/raw.json", chars: 90000, truncated: true, content: "{...}", primary: false },
    ],
  },
  delivery: { isTerminal: true, available: true, content: "final delivery text", outputPath: "/out/report.md" },
  seal: { found: true, latest: { declaredStatus: "completed", primary: "report.md" } },
};

test("output-panel: 产物清单 + 投递正文 + 封条徽标", () => {
  const html = renderOutputPanel(model, i18n.t);
  assert.match(html, /op-file-row/, "产物清单");
  assert.match(html, /report\.md/);
  assert.match(html, /op-primary/, "主交付物标记");
  assert.match(html, /op-truncated/, "截断标记");
  assert.match(html, /op-delivery-body/, "投递正文");
  assert.match(html, /final delivery text/);
  assert.match(html, /op-seal op-sealed/, "已封徽标");
  assert.match(html, /completed/, "declaredStatus 透出");
});

test("output-panel ⑤: 未采集(available=false,直答/失败) → 无产物空态 + 无投递正文", () => {
  const html = renderOutputPanel({
    producedFiles: { available: false, files: [], manifest: null },
    delivery: { isTerminal: false },
    seal: { found: false },
  }, i18n.t);
  assert.match(html, /op-seal op-unsealed/, "未封徽标");
  assert.match(html, /op-empty/);
  // available=false → 「无产物·未采集(直答/失败)」而非泛化「no output」
  assert.match(html, /no artifact collected/, "available=false 报无产物·未采集");
  assert.match(html, /no delivery body/, "无投递正文专属文案");
  assert.doesNotMatch(html, /op-delivery-body/, "无投递正文不出正文槽");
});

test("output-panel ⑤: 已采集但无文件(available=true,files=[]) → 区分于未采集", () => {
  const html = renderOutputPanel({
    producedFiles: { available: true, files: [] },
    delivery: { isTerminal: true, available: false, content: null },
    seal: { found: false },
  }, i18n.t);
  // available=true 空 → 「已采集·无产物文件」，反证:不能落到未采集文案
  assert.match(html, /collected . no product files/, "available=true 空态专属文案");
  assert.doesNotMatch(html, /no artifact collected/, "已采集态不报未采集");
});

test("output-panel: 点产物展开正文", () => {
  const html = renderOutputPanel({ ...model, openFile: "report.md" }, i18n.t);
  assert.match(html, /data-action="toggle-output-file" data-file="report\.md"/);
  assert.match(html, /op-file-content/, "展开文件正文槽");
  assert.match(html, /# Report body/);
});
