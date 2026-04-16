function cloneValidate(validate) {
  if (!validate || typeof validate !== "object") return undefined;
  return {
    ...validate,
    ...(Array.isArray(validate.keywords) ? { keywords: [...validate.keywords] } : {}),
  };
}

function cloneSingleCase(testCase) {
  if (!testCase || typeof testCase !== "object") return null;
  return {
    ...testCase,
    validate: cloneValidate(testCase.validate),
  };
}

function cloneConcurrentCase(testCase) {
  if (!testCase || typeof testCase !== "object") return null;
  return {
    ...testCase,
    tasks: Array.isArray(testCase.tasks) ? [...testCase.tasks] : [],
  };
}

const FORMAL_SINGLE_CASE_DEFS = [
  { id: "simple-01",  message: "今天星期几",                                           timeoutMs: 120000, validate: { minBytes: 10 } },
  { id: "simple-02",  message: "现在几点了",                                           timeoutMs: 120000, validate: { minBytes: 10 } },
  { id: "simple-03",  message: "你好",                                                 timeoutMs: 120000, validate: { minBytes: 10 } },
  { id: "complex-01", message: "研究北京最近三天天气并总结趋势",                         timeoutMs: 300000, validate: { minBytes: 100, keywords: ["天气", "趋势"] } },
  { id: "complex-02", message: "对比 React、Vue、Svelte 三个框架的优缺点，写一份报告",  timeoutMs: 300000, validate: { minBytes: 100, keywords: ["React", "Vue"] } },
  { id: "complex-03", message: "分析 OpenClaw 的设计原则，总结核心要点",                timeoutMs: 300000, validate: { minBytes: 100 } },
];

const FORMAL_CONCURRENT_CASE_DEFS = [
  {
    id: "conc-formal-3",
    description: "正式并发模板：2 个轻量请求 + 1 个分析请求",
    tasks: ["simple-01", "simple-03", "complex-02"],
    timeoutMs: 300000,
  },
  { id: "conc-same-3",   description: "单点并发: 同一条消息并发3次 (pool 排队)",      tasks: ["simple-01", "simple-01", "simple-01"], timeoutMs: 240000 },
  { id: "conc-2s",       description: "两个轻量请求并发",                              tasks: ["simple-01", "simple-02"],              timeoutMs: 120000 },
  { id: "conc-1s1c",     description: "轻量请求与复杂请求并发",                        tasks: ["simple-01", "complex-01"],             timeoutMs: 240000 },
  { id: "conc-3m",       description: "三任务混合并发",                                tasks: ["simple-01", "simple-02", "complex-01"],timeoutMs: 300000 },
  { id: "conc-4s-queue", description: "四任务队列并发",                                tasks: ["simple-01", "simple-02", "simple-03", "complex-01"], timeoutMs: 360000 },
];

export const FORMAL_SINGLE_CASES = Object.freeze(
  FORMAL_SINGLE_CASE_DEFS.map((entry) => Object.freeze({
    ...entry,
    validate: entry.validate ? Object.freeze({
      ...entry.validate,
      ...(Array.isArray(entry.validate.keywords)
        ? { keywords: Object.freeze([...entry.validate.keywords]) }
        : {}),
    }) : undefined,
  })),
);

export const FORMAL_CONCURRENT_CASES = Object.freeze(
  FORMAL_CONCURRENT_CASE_DEFS.map((entry) => Object.freeze({
    ...entry,
    tasks: Object.freeze([...entry.tasks]),
  })),
);

const FORMAL_SINGLE_CASE_MAP = new Map(FORMAL_SINGLE_CASES.map((entry) => [entry.id, entry]));
const FORMAL_CONCURRENT_CASE_MAP = new Map(FORMAL_CONCURRENT_CASES.map((entry) => [entry.id, entry]));

export function listFormalSingleCases() {
  return FORMAL_SINGLE_CASES.map(cloneSingleCase);
}

export function listFormalConcurrentCases() {
  return FORMAL_CONCURRENT_CASES.map(cloneConcurrentCase);
}

export function getFormalSingleCaseById(caseId) {
  const entry = FORMAL_SINGLE_CASE_MAP.get(String(caseId || "").trim());
  return cloneSingleCase(entry);
}

export function getFormalConcurrentCaseById(caseId) {
  const entry = FORMAL_CONCURRENT_CASE_MAP.get(String(caseId || "").trim());
  return cloneConcurrentCase(entry);
}
