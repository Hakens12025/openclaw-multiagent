// 固定 15 城市 TSP 任务定义 —— 纯数据 + 任务文本编码。
// 坐标 / 已知最优 / 基线是评分的唯一真值源；运行时与评分都从这里读，禁止别处再字面量化。
//
// KNOWN_OPTIMAL 由 Held-Karp 精确动态规划离线算出（2^15·15^2，确定性可复算）：
//   tour = [0,10,8,6,11,5,4,9,3,12,2,7,14,1,13,0]
// NEAREST_NEIGHBOR_BASELINE 为从城市 0 出发的贪心最近邻巡回长度（"好启发式"参考线）。

export const TSP_POINTS = Object.freeze([
  [20, 20], [60, 15], [90, 30], [85, 70], [50, 90],
  [15, 75], [40, 50], [70, 50], [25, 45], [75, 85],
  [10, 40], [55, 60], [95, 55], [35, 10], [65, 35],
].map((point) => Object.freeze(point)));

export const TSP_POINT_COUNT = TSP_POINTS.length; // 15
export const TSP_START_CITY = 0;

// Held-Karp 精确最优长度（满精度，使最优巡回得分恰好 100）。
export const KNOWN_OPTIMAL = 348.08984652215247;
export const KNOWN_OPTIMAL_TOUR = Object.freeze([0, 10, 8, 6, 11, 5, 4, 9, 3, 12, 2, 7, 14, 1, 13, 0]);

// 最近邻贪心基线（参考"好启发式"线，用于 beatsNearestNeighbor 诊断）。
export const NEAREST_NEIGHBOR_BASELINE = 378.81865032840716;

// 评分零分锚点：2× 最优 ≈ index 顺序 / 随机巡回水平。最优=1.0→100 分，2.0→0 分。
export const SCORING_ZERO_RATIO = 2.0;

// 把固定坐标 + 目标拼成自然语言任务文本，作为 runtime.loop.start 的 requestedTask 注入 entry agent。
// 只描述问题与产出格式约定，不泄露最优解。
export function buildTspTaskMessage() {
  const rows = TSP_POINTS.map((point, index) => `  城市 ${index}: (${point[0]}, ${point[1]})`).join("\n");
  return [
    "解一个固定的 15 城市旅行商问题 (TSP)，使用欧氏距离。",
    "",
    "城市坐标：",
    rows,
    "",
    `从城市 ${TSP_START_CITY} 出发，访问每座城市恰好一次，最后回到城市 ${TSP_START_CITY}，使巡回总路程最短。`,
    "可以多轮迭代改进（例如最近邻初始化后做 2-opt / 邻域交换）。",
    "",
    "本任务的【最终交付物】必须包含一行机器可解析的巡回，格式严格如下：",
    `  TOUR: ${TSP_START_CITY} -> a -> b -> ... -> ${TSP_START_CITY}`,
    `其中 a, b, ... 是 1..${TSP_POINT_COUNT - 1} 的一个排列，用 ' -> ' 分隔，首尾都是 ${TSP_START_CITY}。`,
    `例如：TOUR: ${TSP_START_CITY} -> 5 -> 3 -> 11 -> ... -> ${TSP_START_CITY}`,
    "（这是对最终交付物的格式要求；每个环节按自身职责产出，谁产出最终交付物谁写这一行。）",
  ].join("\n");
}
