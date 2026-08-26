---
name: chart-build
description: viz-master 面对一个可视化/图表请求时的正确处理流程：读懂数据 → 选图表类型（line/bar/pie）→ 把数据装进声明式 chart-spec → emit 恰好一个 apply.chart_create 步骤。viz-master 只产出图表 spec，不画 SVG、不碰平台真值、一个 plan 只建一张图。
---

# 图表构建流程（viz-master 专用）

用户/operator 丢来一个**可视化/图表请求**时（"画个折线图"、"把这组数据做成柱状图"、"用饼图展示占比"），按这套流程产出一个声明式 chart-spec，并 emit 恰好一个 `apply.chart_create` 步骤。

viz-master 只设计图表 **spec**，到 emit `apply.chart_create` 为止。渲染由平台的手写 SVG 渲染器接管，viz-master 不写 SVG、不调样式、不碰真值。

## 1. 何时使用（WHEN）

- 请求是一个**可视化/图表**诉求：把一组数值数据画成 line / bar / pie。
- 数据是**静态的扁平点集**（一组或多组 `{x, y}` 点），或者是**实时折线**——用 `dataBinding: {mode: "sse"}` 绑一个 `inspect.*` 面轮询取数（仅限 line）。
- 只需要一张图。多张图的诉求请拆成多次请求，一个 plan 只建一张。

不适用（交还给 operator 或拒绝）：
- 需要建 agent / 改图边 / 建组 —— 那是 operator 的领域。
- 需要任意 SVG / 自定义绘图 / 交互组件 —— 超出 chart 家族表达上限。

## 2. 声明式 chart-spec schema（version 1）

spec 是一个 NON-truth 控制面产物（charts.json 的成员，knowledge-bases.json 的兄弟）。它只描述手写 SVG 渲染器能画的东西，仅此而已。表达上限被刻意限定：line/bar/pie、扁平点集；实时接线是支持的——`dataBinding: {mode: "sse"}`，仅限 line，轮询一个 `inspect.*` 面。

```
{
  version: 1,                         // 恒为 1（平台填充，可省略）
  id: string,                         // kebab-case，必须匹配 ^[a-z0-9][a-z0-9-]{1,48}$（无路径穿越）
  label: string,                      // 人类可读名（可选，缺省 = id）
  type: "line" | "bar" | "pie",       // 三选一
  title: string,                      // 图表标题（可选）
  series: [                           // 非空数组
    {
      name: string,                   // 系列名（可选，缺省 = series-N）
      points: [                       // 非空数组
        { x: number | string, y: number }   // y 必须是有限数（finite）；x 是有限数或字符串
      ]
    }
  ],
  axes: { x: { label }, y: { label } },   // type === "pie" 时被忽略
  dataBinding:                             // 二选一
    { mode: "static" }                     //   静态内嵌点集（缺省）
    | { mode: "sse", binding: {            //   实时时间序列——仅限 type === "line"
        source: "inspect.*",               //     一个 inspect 面 id（必填）
        field?: "dot.path",                //     取数值的 dot-path；缺省时数组结果取长度、数值结果取本身
        intervalMs?: number,               //     轮询间隔，默认 25000，clamp 5000–300000
        maxPoints?: number,                //     环形缓冲长度，默认 30，clamp 5–200
      } },
  render: { prefer: "declarative", width?: number, height?: number }
}
```

硬性校验规则（来自 `lib/viz/chart-spec-schema.js` validateChartSpec，违反即抛错）：
- `id` 必填且匹配 `^[a-z0-9][a-z0-9-]{1,48}$`（kebab-case，首字符为字母数字，长度 2–49）。
- `type` 必须是 `line` / `bar` / `pie` 之一。
- `series` 必须是**非空**数组；每个系列的 `points` 必须是**非空**数组。
- 每个 point 的 `y` 必须是有限数字（`Number.isFinite`）；`x` 必须是有限数字或字符串。
- `axes` 在 `pie` 类型下被忽略（可省略）。
- `dataBinding.mode` 只能是 `static` 或 `sse`；`sse` **仅限 line**（实时是时间序列），且必须带 `binding.source` = 一个 `inspect.*` 面 id（匹配 `^inspect\.[a-z0-9_.-]+$`）；`intervalMs` clamp 到 5000–300000（默认 25000），`maxPoints` clamp 到 5–200（默认 30）。

## 3. 图表类型决策树

- **line（折线图）**：x 轴是连续/有序维度（时间、序号、步进），强调**趋势与变化**。多系列对比走多条 series。
- **bar（柱状图）**：x 轴是离散类别（分类项、名称），强调**类别间数值比较**。
- **pie（饼图）**：单一系列，强调**整体中各部分的占比**。各 point 的 y 是该分片的数值（x 作分片标签）。pie 不需要 axes。

选不准时：有时间/连续轴 → line；比类别大小 → bar；看占比 → pie。

## 4. 产出：恰好一个 apply.chart_create 步骤

把数据装进合法 spec 后，emit **恰好一个**步骤：

- surface：`apply.chart_create`
- payload：`{ spec }`（即上面定义的 chart-spec 对象）

`apply.chart_create` **没有 verificationCapability**，所以**不要 emit verify 步骤**——chart 家族不跑 verify。

## 5. 红线

- **只用 chart 家族**：viz-master 只拥有 `chart` 这一个 surface 家族（`apply.chart_create` / `apply.chart_move` / `inspect.charts`）。不碰 agent / graph / group / 任何平台真值。
- **不写 SVG**：只产出声明式 spec，渲染交给平台渲染器。
- **一个 plan 一张图**：每次 plan 只 emit 一个 `apply.chart_create`。多图诉求拆成多次。
- **chart 是 NON-truth**：建图表绝不触发结构快照，绝不读写 structure-snapshot / readTruths。
- **不 emit verify**：`apply.chart_create` 无 verify 能力，emit verify 会失败。
