# oh-my-pi 借鉴 (2026-06)

> oh-my-pi 与 OpenClaw 是 Pi 的两个反向分叉；去 cargo-cult 后只 3 个原语值得为"编排平台"借鉴，最深的教训是"把 Harness Problem 对准自己"。

## 决策

研究 oh-my-pi（can1357，Pi 的"全家桶"编码 agent 分叉）对 OpenClaw 的可借鉴点，分层落地：

- **TIER-1（已做，v161）**：声明式 provider 兜底链 → [Provider 兜底链](../concepts/provider-fallback-chain.md)。
- **TIER-2（待）**：worker `outputSchema` 校验（多 handoff 平台拦错/空字段，对位 v133 镜像 bug 失败类）；实现休眠 `diff_capture` 采集器——**defer**：无"产 diff 的编码 worker"消费者（2026-06-09 确认），等真有再建。
- **SKIP（cargo-cult）**：环检测拒绝（与我们 [环 vs 注册 loop](cycle-vs-registered-loop.md) **相反**：omp 拒环，我们把环编译成 GAN 判别 loop）、ACP 权限弹窗（我们机器门更强）、IRC 实时 prose（破坏单一 transport）、git 原子提交、SDK/RPC、配置继承、大部分 Hindsight/checkpoint（worker 无状态）。

## 原因

Pi = 极简引擎（read/write/edit/bash）。OpenClaw（多 agent 编排平台）与 oh-my-pi（单 agent 深度编码工具）走相反方向。判据：原语**对编排平台**有增量，而非"单 agent 编码工具的特性"。只有"价值随 agent 数 + 在线时长增长"的（兜底链）才是真借鉴。

**最高杠杆教训**：oh-my-pi 的"Harness Problem"= harness（尤其编辑/产出格式）能压过模型本身能力（光改编辑格式把同权重通过率拉到 2.1×）。OpenClaw 核心身份就是"有自评 [Harness](../concepts/harness.md)"，所以这是面镜子：我们多在**声明** harness 能力（diff_capture 只是标签、handoff 只查长度不查 shape）而非**度量**它。最高杠杆不是抄功能，是让 harness 度量它现在只命名的东西（= 两个 TIER-2）。

## 替代方案

整体迁移 omp / 抄全部亮点 — 否决：大量 omp 特性（TUI、浏览器、Rust 本地性能、DAP 调试）对 headless 编排网关不相关。环检测尤其会**删掉**我们的核心 loop 原语。

## 影响

- 新增 [Provider 兜底链](../concepts/provider-fallback-chain.md)。
- TIER-2 进 status 待办。
- 补充 [外部参考吸收策略](external-reference-absorption.md)：oh-my-pi = 第三个被选择性吸收的外部参考。

## 出处

备忘录125（workflow w8klkfne3，5 agent 对抗综合，OpenClaw 现状全 file:line 坐实）。讨论日期: 2026-06-09。
