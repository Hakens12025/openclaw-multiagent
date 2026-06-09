// Input-field definitions for apply.chart_* admin surfaces.
// viz-master 经 CLI-system 写 chart 控制面(charts.json,非真值,knowledge-bases.json 同级)。
// payload 必须 schema 化,否则 planner 盲猜 spec/chartId/x/y,validator 抓不到缺失必填项。
// Handlers: lib/admin/chart-operations.js createChartDefinition / moveChartPosition。

export const CHART_INPUT_FIELDS = Object.freeze({
  "apply.chart_create": [
    {
      key: "spec",
      label: "CHART SPEC (JSON)",
      type: "textarea",
      required: true,
      placeholder: '{"id":"daily-pnl","type":"line","title":"Daily PnL","series":[{"name":"pnl","points":[{"x":"Mon","y":12}]}]}',
      description: "声明式图表 spec(validateChartSpec 契约): id(kebab-case) + type(line|bar|pie) + 非空 series。upsert(同 id 覆盖)。",
    },
  ],
  "apply.chart_move": [
    {
      key: "chartId",
      label: "CHART ID",
      type: "text",
      required: true,
      aliases: ["id"],
      placeholder: "daily-pnl",
      description: "要移动的已存在 chart id(不存在则失败)。",
    },
    {
      key: "x",
      label: "X",
      type: "number",
      required: true,
      placeholder: "0",
      description: "看板新位置 x 坐标。",
    },
    {
      key: "y",
      label: "Y",
      type: "number",
      required: true,
      placeholder: "0",
      description: "看板新位置 y 坐标。",
    },
  ],
});
