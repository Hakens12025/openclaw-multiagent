# test-runner 大修:可审查报告 + 错误码注册表 + 8 预设重置

> 一次执行 → 一份 failures-first 报告;每个检查带 E-* 错误码与排查 hint;19 个旧预设全删,按当前系统信号面重设 8 个。

## 决策

- **CheckResult 四态模型**:每个检查产 `{id, subsystem, status: pass|fail|skip|blocked, code, evidence, hint, durationMs}`;fail/blocked/skip 必带注册表错误码(add 时校验,未注册即抛)。
- **错误码单源注册表** `lib/formal-runtime/error-codes.js`(~91 码,`E-<SUBSYS>-<NNN>`):每码带 meaning + 排查 hint(指向具体文件/路由/真值源)。agent 读报告即可定位,无需监视进程。
- **四层可测性**:TIER-0 NODE(进程内,零网关)→ TIER-1 GW(活网关确定性,零 LLM)→ TIER-2 LLM(真派工)→ TIER-3 EMBED(ollama 门控)。
- **8 个新预设**:`health`(TIER-0+1 全量体检,~70 检查 5 秒,**新默认**)/ `dispatch`(最小派工,**verify 门由 "single" 切到它**)/ `pipeline` / `loop` / `system-action` / `operator` / `knowledge` / `full`。(后续 2026-08-12 重组改名并扩至 14;2026-08-18 回路退役删掉 `loop` 预设,现为 13 预设 / `full`=12 suite。清单以 `--list` live 为准。)
- **报告 failures-first**:VERDICT 顶置 → 失败展开(code/evidence/hint)→ 子系统分节 pass 一行;`.txt` + `.json` 机器镜像双落盘,文件名 `devtool-<presetId>-<ts>` 不变。
- **CLI**:`--list`/`--help` 新增,无参默认 health;`--suite/--filter/--clean` 维持硬报错。

## 原因

- 旧体系是早期设计:19 个 preset 堆叠(qq/random 家族居多)但执行器只有 3 类;报告靠静态 ISSUE_CATALOG(且有两份重复副本),无 per-check 错误码,排查要 tail 日志看进程。
- 系统已长出大量新信号面(inspect 30+ 面/harness catalog/operator surface/knowledge/prompt 六层/确认闸),旧 preset 完全不覆盖。
- 「可审查」是 test-runner 的初心:跑一次、读一份报告、知道哪坏了。错误码 + hint 把排查路径写进报告本身。

## 否决的替代方案

- **保留 preset id "single" 兼容 verify 门** —— 否决。id 延续旧语义混淆;改 `admin-surface-registry.js` verificationCapability → "dispatch"(45 个 apply surface 验证),已持久化的旧 change-set draft 的 recommended-verify 按钮自然过期。
- **网关不可达时 CLI 本地降级跑 TIER-0** —— 否决。需在 CLI 复制 suite 加载逻辑,破坏一条路径;网关不可达 → 明确 E-RUNNER-003 + 全部 GW 检查 blocked。
- **pin 精确 surface/模块计数** —— 否决。加 surface 就红;改用下限 + 注册表内部一致性校验。
- **mutation 检查独立成第 9 预设** —— 否决。守护式往返(try/finally 恢复,graph md5 字节级验证)并入 health 并显式标注 [MUTATION]。

## 实战自证(落地当天)

1. `health` 首跑即检出 **E-GRAPH-003**:researcher1/worker3/reviewer1 从入口不可达(真实图缺边)。
2. 检出 **E-SCHEDULE-001**:`cron edit` 不支持 `--json` 而 materializer 带了它 → schedule 启停物化全坏(真实版本漂移 bug,当场修复:edit 去旗标 + 用已知 jobId 不解析 stdout)。
3. `dispatch` 检出 **E-CONTRACT-003**:terminal=failed,hint 30 秒内引导到根因 = provider 全线 `FailoverError: LLM request timed out`(外部故障),blocked 链正确指向 prerequisite。

## 影响

- **test-system**:概念页重写(见 [测试系统](../concepts/test-system.md));`inspect.test_runs`/`test_runs.start`/`test.inject` 面与 `replyTo.kind:"test_run"`/SSE 事件名保持不变(四方消费契约)。
- **operator**:apply 后强制 verify 跑 `dispatch`;operator-knowledge 内嵌文档同步。
- **删除**:random/qq 家族、direct-service 旧探针、suite-single、tsp、case-catalog 及其测试(~25 文件);`test-locks.js` 原地保留(18 个无关测试依赖)。
- 全 gate 1910/1910 绿;live 验证 health 5s/70 检查。
