/**
 * QQ Bot 文本过滤工具
 * 纯函数，无副作用，无状态
 */

/**
 * 解析 QQ 表情标签，将 <faceType=1,faceId="13",ext="base64..."> 格式
 * 替换为 【表情: 中文名】 格式
 * ext 字段为 Base64 编码的 JSON，格式如 {"text":"呲牙"}
 */
export function parseFaceTags(text: string): string {
  if (!text) return text;

  // 匹配 <faceType=...,faceId="...",ext="..."> 格式的表情标签
  return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_match, ext: string) => {
    try {
      const decoded = Buffer.from(ext, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      const faceName = parsed.text || "未知表情";
      return `【表情: ${faceName}】`;
    } catch {
      return _match;
    }
  });
}

/**
 * 过滤内部标记（如 [[reply_to: xxx]]）
 * 这些标记可能被 AI 错误地学习并输出，需要在发送前移除
 */
export function filterInternalMarkers(text: string): string {
  if (!text) return text;

  // 过滤 [[xxx: yyy]] 格式的内部标记
  // 例如: [[reply_to: ROBOT1.0_kbc...]]
  let result = text.replace(/\[\[[a-z_]+:\s*[^\]]*\]\]/gi, "");

  // 清理可能产生的多余空行
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}
