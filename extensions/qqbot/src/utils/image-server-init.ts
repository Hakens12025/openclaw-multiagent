/**
 * 图床服务器初始化辅助
 * 依赖常量和 image-server 模块，无 WS 状态
 */
import { startImageServer, isImageServerRunning, type ImageServerConfig } from "../image-server.js";
import { IMAGE_SERVER_PORT, IMAGE_SERVER_DIR } from "../gateway-constants.js";
import type { GatewayContext } from "../types.js";

/**
 * 确保图床服务器已启动，返回 baseUrl 或 null（失败时）
 */
export async function ensureImageServer(
  log?: GatewayContext["log"],
  publicBaseUrl?: string,
): Promise<string | null> {
  if (isImageServerRunning()) {
    return publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`;
  }

  try {
    const config: Partial<ImageServerConfig> = {
      port: IMAGE_SERVER_PORT,
      storageDir: IMAGE_SERVER_DIR,
      // 使用用户配置的公网地址，而不是 0.0.0.0
      baseUrl: publicBaseUrl || `http://0.0.0.0:${IMAGE_SERVER_PORT}`,
      ttlSeconds: 3600, // 1 小时过期
    };
    await startImageServer(config);
    log?.info(`[qqbot] Image server started on port ${IMAGE_SERVER_PORT}, baseUrl: ${config.baseUrl}`);
    return config.baseUrl!;
  } catch (err) {
    log?.error(`[qqbot] Failed to start image server: ${err}`);
    return null;
  }
}
