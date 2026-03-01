export const AI_ASSISTANT_UUID = "00000000-0000-4000-8000-000000000001";
export const AI_ASSISTANT_EMAIL = "txa1@lovechatty.ai";
export const AI_ASSISTANT_FIRST_NAME = "Txa";
export const AI_ASSISTANT_LAST_NAME = "1";
export const AI_ASSISTANT_DISPLAY_NAME = `${AI_ASSISTANT_FIRST_NAME} ${AI_ASSISTANT_LAST_NAME}`;
export const AI_ASSISTANT_PROFILE_PICTURE_URL = "/ai-contact-logo.png";

// Agent action token format used by the model to ask backend to send a message.
export const AI_DIRECTIVE_REGEX = /<\/message\?user=\{?([a-z0-9_-]+)\}?>/i;
export const AI_SEARCH_DIRECTIVE_REGEX =
  /<search\?\s*(?:query|quary)\s*\?\s*([a-z0-9_-]+)\s*\?\s*=\s*["']([\s\S]*?)["']\s*>/i;

export const AI_STATUS_EVENT = "ai:status";
export const AI_STREAM_EVENT = "ai:stream";
export const AI_METRICS_EVENT = "ai:metrics";
export const AI_HISTORY_LIMIT = 32;
