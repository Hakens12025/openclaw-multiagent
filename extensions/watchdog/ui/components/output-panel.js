// components/output-panel.js — 透视页「输出」Tab（纯渲染）。
// 数据 = inspect.session_transcript 的 producedFiles/delivery + inspect.contract_seal 的封条态。
// 产物清单（主交付物排前、truncated 如实标记、点击展开正文）+ 投递正文 + 封条徽标。
import { esc } from "../core/html.js";

function renderFileRow(file, openFile, t) {
  const open = openFile === file.name;
  let meta = `<span class="op-meta">${file.chars ?? 0}</span>`;
  if (file.primary) meta += `<span class="op-primary">★</span>`;
  if (file.truncated === true) meta += `<span class="op-truncated">${esc(t("inspect.prompt.truncated"))}</span>`;
  let html = `<div class="op-file-row${open ? " open" : ""}" data-action="toggle-output-file" data-file="${esc(file.name)}">`
    + `<span class="op-file-name">${esc(file.name)}</span>${meta}</div>`;
  if (open && typeof file.content === "string" && file.content) {
    html += `<pre class="op-file-content">${esc(file.content)}</pre>`;
  }
  return html;
}

export function renderOutputPanel(model = {}, t) {
  const { producedFiles = null, delivery = null, seal = null, openFile = null } = model;
  const sealed = seal?.found === true && seal?.latest != null;
  const declaredStatus = sealed ? seal.latest.declaredStatus : null;
  let html = `<div class="output-panel">`;

  // 封条徽标（contract_seal：多跳管线多封条取 latest 终局采信）
  html += `<div class="op-seal ${sealed ? "op-sealed" : "op-unsealed"}">`
    + `${esc(t("inspect.output.seal"))}: ${esc(t(sealed ? "inspect.output.sealed" : "inspect.output.unsealed"))}`
    + (declaredStatus ? ` · ${esc(declaredStatus)}` : "")
    + `</div>`;

  // 产物清单：空态区分「无产物·未采集(直答/失败)」vs「已采集·无文件」——
  // 真值依据(curl 抽查)：成功 TC run producedFiles.available=true+有文件；
  // 直答/失败 run available=false(outbox 未采集,无 manifest)。别让用户把「本就无产物」当「坏了」。
  const files = Array.isArray(producedFiles?.files) ? producedFiles.files : [];
  html += `<div class="op-section-title">${esc(t("inspect.output.producedFiles"))} (${files.length})</div>`;
  if (files.length) {
    for (const file of files) html += renderFileRow(file, openFile, t);
  } else {
    const emptyKey = producedFiles?.available === true ? "inspect.output.filesEmpty" : "inspect.output.noArtifact";
    html += `<div class="op-empty">${esc(t(emptyKey))}</div>`;
  }

  // 投递正文（用户最终接收到的消息）
  html += `<div class="op-section-title">${esc(t("inspect.output.delivery"))}</div>`;
  if (delivery?.available === true && typeof delivery.content === "string" && delivery.content) {
    html += `<pre class="op-delivery-body">${esc(delivery.content)}</pre>`;
  } else {
    html += `<div class="op-empty">${esc(t("inspect.output.noDelivery"))}</div>`;
  }
  return `${html}</div>`;
}
