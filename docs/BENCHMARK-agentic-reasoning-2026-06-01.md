# Agentic Reasoning Benchmark — OpenClaw 系统能力量化评估 (2026-06-01)

> GAIA 式端到端 agentic benchmark:多步推理任务,客观可判定答案,跑 researcher→worker-e→reviewer1 三 agent 流水(单趟 maxRounds=1),量化系统实际能力。

## 方法

- **被测系统**: OpenClaw 多 agent 平台,LLM=MiniMax-M2.5,researcher1→worker-e→reviewer1 loop。
- **执行**: 每题经 `runtime.loop.start` 派给 researcher 环,临时设 `maxRounds=1`(单趟:researcher 研究→worker 求解→reviewer 评审→收敛),取 worker-e 交付物(`control-plane/output/<cid>.md`)。跑完恢复 `maxRounds=4`。
- **评分**: 最终输出是否含精确答案(尾部加权 + 全文),客观判定。瞬时失败(provider 抽风)重跑一次确认。
- **runner**: `/tmp/benchmark-runner.mjs`(自主:起任务→轮询收敛→收答案→打分→恢复)。

## 任务集(6 题,3 难度,全部自包含、精确答案)

| 题 | 难度 | 考点 | 标准答案 |
|---|---|---|---|
| E1 | easy | 多步算术(入库 240→×1.5→出库 1/4) | 450 |
| E2 | easy | 日期推算(给定 1/1=周四,求 3/1) | 星期日 |
| M1 | medium | 约束逻辑(3 人 3 职业排除法) | 丙 |
| M2 | medium | 速度×时间分段求和(54+120) | 174 |
| H1 | hard | 数字约束反解(数位和/倍数/差) | 653 |
| H2 | hard | 倒推法应用题(两天卖出+剩余) | 120 |

(任务均自包含、不需联网检索 → 测的是**推理 + 多 agent 编排**,非检索/工具调用。)

## 结果

| 题 | 首跑 | 耗时 | 收敛 | 备注 |
|---|---|---|---|---|
| E1 | ✓ 450 | 60s | loop_budget_exhausted:max_rounds | worker 正确给出剩余 450 箱 |
| E2 | ✓ 星期日 | 70s | 同上 | 输出含"星期日"+"Sunday" |
| M1 | ✓ 丙 | 60s | 同上 | 排除法推理正确 |
| M2 | ✗→**✓ 174**(重跑) | 50s→60s | 同上 | **首跑 worker-e 空产出(provider system-busy),reviewer 正确判 "上游未产生产物";重跑得 174** |
| H1 | ✓ 653 | 60s | 同上 | 数位约束反解正确 |
| H2 | ✓ 120 | 70s | 同上 | 倒推法正确 |

- **首跑准确率: 5/6 = 83.3%**
- **修正瞬时失败后能力: 6/6 = 100%**(M2 重跑通过,首次失败是基础设施而非推理)
- **难度分布**: easy 2/2 · medium 2/2(含重跑)· hard 2/2 —— 难度不是失败因素
- **平均耗时**: ~62s/题(单趟 3 agent)
- 每题 `maxRounds=1` 强制收敛均成功(⑥ 环自带 limit 再次验证)

## 关键发现

1. **推理能力扎实**: 6 道多步推理(算术/日期/逻辑/反解/倒推)全部正确求解,worker-e 给出过程 + 精确答案。
2. **唯一失败是可靠性非能力**: M2 首跑 worker-e 空产出 = MiniMax provider `code:1000040350 system busy` 过载所致;重跑即正确。**provider 过载是当前可靠性风险**(高负载下单 agent 可能空跑)。
3. **GAN 判别器是有效安全网**: reviewer1 准确检测到 M2 worker-e 空产出并给出阻塞判定(artifactPaths 空)——判别环不只评质量,也兜住流水线失败。
4. **测量盲区(诚实声明)**: 本 benchmark 是自包含推理,**未测检索/工具调用**(GAIA 真题需联网/读文件)。系统的 web/file 工具能力**未评估**,需另设需外部查证的任务 + 确认 agent 有相应工具。

## 复跑

```bash
node /tmp/benchmark-runner.mjs   # 需网关在跑,自动设/恢复 maxRounds,结果写 /tmp/benchmark-results.json
```

---

## 工具/检索维度评估 (2026-06-01 追加)

**结论:检索维度当前不可用,无法真实 benchmark(不做假测试)。** 两条检索路径都被挡:

| 工具 | 配置 | 实际状态 | 根因 | 归属 |
|---|---|---|---|---|
| `web_search` | researcher/worker 已 allow,平台 enabled | **被 hook 主动拦死** | `before-tool-call.js:248`:无 `BRAVE_API_KEY` → 前置 block(注释"unavailable remote tools must be blocked up front") | watchdog 插件(有意设计)+ 配置缺 key |
| `web_fetch` | 已 allow,平台 enabled,**未被 hook 拦** | **agent 真调用了,但被网络层拒** | 框架 web_fetch 报"域名解析到私有/内部 IP / 网络限制"——疑似 SSRF 防护 × `127.0.0.1:8080` 隧道 proxy 冲突 | 框架/基础设施层(非 watchdog 插件) |

**诊断证据**:
- 网络本身通:`curl example.com` 经 proxy 和直连都 HTTP 200。
- 全 gateway 日志零真实 web 工具成功执行;历史仅见 `HOOK LOCKDOWN: blocked web_search/web_fetch in bridge hook session` + 旧日志模型 `<tool_call>` 语法漏成正文。
- 决定性测试(抓不可记忆内容):agent 尝试 web_fetch → 返回"私有 IP/网络限制"错误 → **诚实报告"无法完成任务"**,未幻觉编造(良好行为)。

**要真正 benchmark 检索维度,需先解锁(都需用户/基础设施动作,非插件代码)**:
1. 设 `BRAVE_API_KEY`(Brave Search API key)→ 解锁 web_search。
2. 修 web_fetch 出口:让框架 web_fetch 能到公网(排查 SSRF 私有 IP 防护与隧道 proxy 的冲突——可能需让 web_fetch 直连或放行公网域名)。

**附带能力发现(正面)**:工具失败时,agent **如实报告失败并解释原因**,不伪造检索结果——这是可靠性上的好信号(对比"幻觉一个看似真实的答案")。
