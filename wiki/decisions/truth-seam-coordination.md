# 真值层协调缝 (Truth-Seam Coordination)

> 多个在飞计划同时撞向"系统真值层"；先建一道声明式"协调缝"让它们靠加表项接入，而非各改过程式代码。（RAG 侧裁定见 [RAG 主线落地](rag-land-2026-06.md)；本页聚焦协调缝 D-α 与 meta 旁路 D-δ。）

## 决策

设计已批准，实施计划见备忘录123 §十：

- **D-α 先建协调缝**：把 `structure-snapshot.js` 的过程式 4 真值枚举（readTruths/restore/restored，2 文件 6 处）抽成**声明式 `STRUCTURAL_TRUTHS` 表**；把 `cli-surface-executor.js` 的 `actor!=="operator"` 裸门升级成 **meta-agent 所有权注册表**（`META_AGENT_IDS` 单一源派生 CONTROL_PLANE/PROTECTED）。两个硬冲突 → 后续计划靠加一行表项接入。
- **D-δ operator-hub 星型 meta 旁路可行**：控制面（operator + meta-agents）与 worker 传送带**已代码物理隔离**（`agent-plane-policy.js` `autoWakeEligible:false` + 派工/唤醒双拒投）。operator 经所有权表路由把活委派给 owning meta-agent（如 viz-master owns chart）；投递两段式——slice-1 进程内直调，异步票据（system-action delivery ticket + pending-signal + 心跳）作演进。

（**D-β 知识库≠真值**、**D-γ RAG 不建 agent** 已并入 [RAG 主线落地](rag-land-2026-06.md)。）

## 原因

三方各自 bolt-on = 在同一段字面量反复编辑，违反 [硬路径与软路径](../concepts/hard-soft-path.md) 的"一条路径原则" + [传送带原则](../concepts/conveyor-belt.md) 的"禁止硬编码 agent 名"。真值层当时静默无在飞改动 = 安全窗口。所有权表是**双重身份**：既是写授权门，也是 operator 的 meta-委派路由器。"旁路"非第二 transport——控制面本就是独立 substrate，且已有票据投递原语（勘探 w6qvp8s9z 证伪了"旁路=违规"的早先担心）。

## 替代方案

各计划自行 bolt-on（最快但违反一条路径、漂移风险高）/ 只升所有权门不动真值层（折中，真值层债延后）— 均否决，取"先建缝"。graph-edge 投递 meta 委派被否（会重入 worker 传送带）。

## 影响

- [CLI System](../concepts/cli-system.md) actor 门、[Operator](../concepts/operator.md) 执行循环、structure-snapshot 真值层、[Graph Edge](../concepts/graph-edge.md) 授权语义。
- viz-master 成为第 2 个 meta-agent（owns chart）；为未来 kb-master 铺路（D-γ 通用机已预留）。

## 出处

备忘录123（workflow w5y3y977c + w6qvp8s9z，file:line 坐实）。讨论日期: 2026-06-05/09。
