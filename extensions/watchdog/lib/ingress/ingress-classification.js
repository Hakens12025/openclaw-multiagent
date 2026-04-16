// lib/ingress-classification.js — Standard ingress shaping helpers

export function isSimpleTask(message) {
  const text = String(message).trim();
  // Contains task keywords → non-simple (needs tools)
  if (/研究|报告|分析|调研|论文|对比|总结|方案|评估|规划|设计|架构|重构|代码|编写|写[一个]*[代段]|开发|实现|修复|部署|删除|迁移|清理|重启|升级|回滚|发布|搜索|搜一下|查一下|查询|新闻|摘要|爬取|抓取|整理|汇总|翻译|天气|价格|股票|帮我/.test(text)) {
    return false;
  }
  // No task keywords → simple (chat, emojis, greetings, etc.)
  return true;
}

export function isFastTrackTask(message) {
  const text = String(message).trim();
  if (text.length > 80) return false;
  // Complex keywords → needs planning, not fast-track
  if (/研究|报告|分析|调研|论文|对比|总结|方案|评估|规划|设计|架构|重构|代码|编写|开发|实现|修复|部署|迁移/.test(text)) return false;
  // Short search/lookup tasks → fast-track to dispatch targets directly
  if (/查一下|搜一下|搜索|查询|帮我查|帮我搜|帮我找|天气|新闻|价格|股票|翻译/.test(text)) return true;
  return false;
}

export function normalizeIngressPhases(phases) {
  if (!Array.isArray(phases)) return null;
  const normalized = phases
    .map((phase) => {
      if (typeof phase === "string" && phase.trim()) {
        return phase.trim();
      }
      if (phase && typeof phase === "object" && typeof phase.name === "string" && phase.name.trim()) {
        return {
          ...phase,
          name: phase.name.trim(),
          ...(typeof phase.description === "string" && phase.description.trim()
            ? { description: phase.description.trim() }
            : {}),
        };
      }
      return null;
    })
    .filter(Boolean);
  return normalized.length > 0 ? normalized : null;
}
