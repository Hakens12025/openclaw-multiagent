---
name: prompt-craft
description: Use when writing or reviewing OpenClaw SOUL, skills, agent instructions, operator prompts, wake text, task text, or runtime-facing guidance.
metadata: {"clawdbot":{"emoji":"✏️"}}
---

# OpenClaw 提示词标准

OpenClaw prompt 的目标是最小有用：给 agent 完成当前工作所需的身份、输入、出口和产物格式。runtime truth lives in stores, typed envelopes, policy, and operator/admin surfaces.

## 写法

- 用正向任务语言：说明要读取什么、产出什么、交给哪个 runtime 对象消费。
- 每段只服务一个目的：身份、任务输入、输出位置、协作出口、验证标准。
- SOUL 只承载角色本地循环；平台协议真值放在 runtime、stores、typed envelopes、policy、surface。
- 技能按需渐进读取；主提示只列触发条件和入口。
- `[ACTION]` / JSON 是正式协议和 phase/runtime 消费对象；只在对应 skill 或必须产出协议 marker 的场景展示。

## 结构

1. 角色：一句话说明当前 agent 的职责。
2. 输入：列出当前必须读取的文件或字段。
3. 动作：用可执行动词写当前任务。
4. 输出：明确主产物路径、格式和完成信号。
5. 协作：说明使用哪个已加载 skill 或 runtime surface。

## 检查

- 当前文本是否能删掉一句而不影响执行；能删就删。
- 规则是否属于 runtime/harness/path guard；属于硬保证就移出 prompt。
- `[ACTION]` / JSON 是否由 runtime 消费；若只是教学噪声就降级到 skill。
- agent 是否只看到本轮必要信息；大楼地图、图权限、delivery、operator 能力按需读取。
- 文案是否描述目标行为，而非罗列失败姿势。
