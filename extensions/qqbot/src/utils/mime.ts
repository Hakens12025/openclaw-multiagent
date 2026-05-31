/**
 * MIME type helpers for QQ Bot media handling.
 */

/** Map of image file extensions to MIME types supported by QQ Bot. */
export const IMAGE_MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/**
 * Returns the MIME type for the given file extension (lowercase, with dot),
 * or undefined if the extension is not a supported image type.
 */
export function getImageMimeType(ext: string): string | undefined {
  return IMAGE_MIME_TYPES[ext];
}
