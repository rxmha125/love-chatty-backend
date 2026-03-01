import { config } from "../../server/config.js";

const normalizeBaseUrl = (baseUrl) =>
  String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "");

const unique = (values) => Array.from(new Set(values.filter(Boolean)));

const resolveEndpointCandidates = (baseUrl) => {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return [];
  }

  // Explicit endpoint forms.
  if (/\/api\/chat$/i.test(normalized) || /\/v1\/chat\/completions$/i.test(normalized)) {
    return [normalized];
  }

  // Root or provider base: try Ollama first, then OpenAI-compatible endpoint.
  if (/\/api$/i.test(normalized)) {
    const root = normalized.replace(/\/api$/i, "");
    return unique([`${normalized}/chat`, `${root}/v1/chat/completions`]);
  }

  if (/\/openai\/v1$/i.test(normalized)) {
    return [`${normalized}/chat/completions`];
  }

  if (/\/v1$/i.test(normalized)) {
    const root = normalized.replace(/\/v1$/i, "");
    return unique([`${root}/api/chat`, `${normalized}/chat/completions`]);
  }

  return unique([`${normalized}/api/chat`, `${normalized}/v1/chat/completions`]);
};

const isOllamaEndpoint = (endpoint) => /\/api\/chat$/i.test(String(endpoint || ""));
const isGroqEndpoint = (endpoint) => /api\.groq\.com/i.test(String(endpoint || ""));
const ollamaResolvedModelByEndpoint = new Map();
const ollamaModelCatalogByEndpoint = new Map();
const OLLAMA_CATALOG_TTL_MS = 30_000;
const STREAM_EMIT_INTERVAL_MS = 24;
const OLLAMA_FALLBACK_MODELS = [
  "ministral-3:14b",
  "ministral-3:latest",
  "qwen2.5:32b",
  "qwen2.5:14b",
  "qwen2.5:7b",
  "llama3.1:8b",
  "llama3.2:3b",
];
const GROQ_FALLBACK_MODELS = [
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
];

const toMessageContent = (rawContent, options = {}) => {
  const shouldTrim = options.trim !== false;

  if (typeof rawContent === "string") {
    return shouldTrim ? rawContent.trim() : rawContent;
  }

  if (Array.isArray(rawContent)) {
    const joined = rawContent
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .join("");

    return shouldTrim ? joined.trim() : joined;
  }

  return "";
};

const parsePayloadText = (rawText) => {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) {
    return null;
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
};

const extractErrorMessage = (payload, rawText) => {
  if (typeof payload?.error?.message === "string" && payload.error.message.trim()) {
    return payload.error.message.trim();
  }

  if (typeof payload?.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }

  if (typeof payload?.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }

  const text = String(rawText || "").trim();
  if (text.includes("ERR_NGROK_6024")) {
    return "Ngrok warning page blocked the AI request (ERR_NGROK_6024).";
  }

  if (/<html/i.test(text) && /ngrok/i.test(text)) {
    return "Ngrok served an HTML warning page instead of the AI API response.";
  }

  const shortened = text.replace(/\s+/g, " ").slice(0, 220);
  return shortened || "AI request failed";
};

const collectLinks = (payload, content, thinking) => {
  const urls = new Set();
  const add = (candidate) => {
    const value = String(candidate || "").trim();
    if (/^https?:\/\//i.test(value)) {
      urls.add(value);
    }
  };

  const citations = Array.isArray(payload?.citations) ? payload.citations : [];
  citations.forEach((entry) => {
    if (typeof entry === "string") {
      add(entry);
      return;
    }
    if (entry && typeof entry === "object") {
      add(entry.url);
      add(entry.source);
    }
  });

  const text = `${String(content || "")}\n${String(thinking || "")}`;
  const matches = text.match(/https?:\/\/[^\s)\]}>"']+/gi) || [];
  matches.forEach(add);

  return Array.from(urls).slice(0, 8);
};

const nsToMs = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(numeric / 1_000_000);
};

const extractOllamaMetrics = (payload = {}) => ({
  total_duration_ms: nsToMs(payload?.total_duration),
  load_duration_ms: nsToMs(payload?.load_duration),
  prompt_eval_duration_ms: nsToMs(payload?.prompt_eval_duration),
  eval_duration_ms: nsToMs(payload?.eval_duration),
  prompt_eval_count: Number.isFinite(Number(payload?.prompt_eval_count))
    ? Number(payload.prompt_eval_count)
    : null,
  eval_count: Number.isFinite(Number(payload?.eval_count)) ? Number(payload.eval_count) : null,
});

const extractCompletionPayload = (payload = {}) => {
  const content =
    toMessageContent(payload?.choices?.[0]?.message?.content) ||
    toMessageContent(payload?.message?.content) ||
    toMessageContent(payload?.response) ||
    "";

  const thinking =
    toMessageContent(payload?.choices?.[0]?.message?.reasoning) ||
    toMessageContent(payload?.choices?.[0]?.message?.thinking) ||
    toMessageContent(payload?.reasoning) ||
    toMessageContent(payload?.message?.thinking) ||
    toMessageContent(payload?.thinking) ||
    "";

  const model = String(payload?.model || "").trim() || null;
  const links = collectLinks(payload, content, thinking);
  const ollamaMetrics = extractOllamaMetrics(payload);

  return { content, thinking, model, links, ollamaMetrics };
};

const extractStreamDelta = (payload = {}) => {
  const choice = payload?.choices?.[0] || {};
  const delta = choice?.delta || {};

  const content =
    toMessageContent(delta?.content, { trim: false }) ||
    toMessageContent(payload?.message?.content, { trim: false }) ||
    toMessageContent(payload?.response, { trim: false }) ||
    "";

  const thinking =
    toMessageContent(delta?.reasoning, { trim: false }) ||
    toMessageContent(delta?.reasoning_content, { trim: false }) ||
    toMessageContent(delta?.thinking, { trim: false }) ||
    toMessageContent(payload?.message?.thinking, { trim: false }) ||
    toMessageContent(payload?.thinking, { trim: false }) ||
    "";

  const model = String(payload?.model || "").trim() || null;
  const done = Boolean(payload?.done || choice?.finish_reason);

  return {
    content,
    thinking,
    model,
    done,
  };
};

const buildRequestBody = (endpoint, input, useStream, modelOverride = "") => {
  const modelToUse = String(modelOverride || config.aiModel || "").trim();
  if (isOllamaEndpoint(endpoint)) {
    const keepAlive = String(config.aiKeepAlive || "").trim();
    return {
      model: modelToUse,
      messages: input.messages,
      stream: Boolean(useStream),
      keep_alive: keepAlive || undefined,
      options: {
        temperature: config.aiTemperature,
      },
    };
  }

  return {
    model: modelToUse,
    temperature: config.aiTemperature,
    stream: Boolean(useStream),
    messages: input.messages,
  };
};

const buildHeaders = (apiKeyOverride = "") => {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream, application/x-ndjson",
    "ngrok-skip-browser-warning": "true",
  };

  const resolvedApiKey = String(apiKeyOverride || config.aiApiKey || "").trim();
  if (resolvedApiKey) {
    headers.Authorization = `Bearer ${resolvedApiKey}`;
  }

  return headers;
};

const getConfiguredAiApiKeys = () => {
  const pooled = Array.isArray(config.aiApiKeys)
    ? config.aiApiKeys.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const primary = String(config.aiApiKey || "").trim();
  return unique([...pooled, primary]).filter(Boolean);
};

const shouldRetryWithNextApiKey = (error) => {
  const message = String(error instanceof Error ? error.message : "").toLowerCase();
  if (!message) {
    return false;
  }

  return (
    message.includes("insufficient") ||
    message.includes("credit") ||
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("429") ||
    message.includes("unauthorized") ||
    message.includes("authentication") ||
    message.includes("invalid api key") ||
    (message.includes("api key") && (message.includes("invalid") || message.includes("expired"))) ||
    message.includes("401") ||
    message.includes("403")
  );
};

const shouldRetryEndpointError = (error) => {
  const message = String(error instanceof Error ? error.message : "").toLowerCase();
  return (
    message.includes("404") ||
    message.includes("not found") ||
    message.includes("method not allowed") ||
    message.includes("invalid response") ||
    message.includes("unexpected token") ||
    message.includes("ngrok")
  );
};

const isModelNotFoundError = (error) => {
  const message = String(error instanceof Error ? error.message : "").toLowerCase();
  return message.includes("model") && message.includes("not found");
};

const parseModelFromNotFoundMessage = (error) => {
  const message = String(error instanceof Error ? error.message : "");
  const singleQuoted = message.match(/model\s+'([^']+)'/i);
  if (singleQuoted?.[1]) {
    return singleQuoted[1].trim();
  }

  const doubleQuoted = message.match(/model\s+"([^"]+)"/i);
  if (doubleQuoted?.[1]) {
    return doubleQuoted[1].trim();
  }

  return "";
};

const parseOllamaTagNames = (payload) => {
  const models = Array.isArray(payload?.models) ? payload.models : [];
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const fromModels = models
    .map((entry) => String(entry?.model || entry?.name || entry?.id || "").trim())
    .filter(Boolean);
  const fromData = data
    .map((entry) => String(entry?.id || entry?.model || entry?.name || "").trim())
    .filter(Boolean);
  return unique([...fromModels, ...fromData]);
};

const fetchCatalogNamesFromEndpoint = async (endpoint, signal) => {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      signal,
      headers: {
        Accept: "application/json",
        "ngrok-skip-browser-warning": "true",
      },
    });
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    return [];
  }

  return parseOllamaTagNames(payload);
};

const fetchOllamaModelCatalog = async (endpoint, signal) => {
  if (!isOllamaEndpoint(endpoint)) {
    return [];
  }

  const cached = ollamaModelCatalogByEndpoint.get(endpoint);
  const now = Date.now();
  if (cached && now - cached.cachedAt < OLLAMA_CATALOG_TTL_MS) {
    return cached.models;
  }

  const tagsEndpoint = endpoint.replace(/\/api\/chat$/i, "/api/tags");
  const psEndpoint = endpoint.replace(/\/api\/chat$/i, "/api/ps");
  const v1ModelsEndpoint = endpoint.replace(/\/api\/chat$/i, "/v1/models");

  const [fromTags, fromPs, fromV1] = await Promise.all([
    fetchCatalogNamesFromEndpoint(tagsEndpoint, signal),
    fetchCatalogNamesFromEndpoint(psEndpoint, signal),
    fetchCatalogNamesFromEndpoint(v1ModelsEndpoint, signal),
  ]);

  const models = unique([...fromTags, ...fromPs, ...fromV1]);
  ollamaModelCatalogByEndpoint.set(endpoint, {
    models,
    cachedAt: now,
  });

  return models;
};

const resolveOllamaModel = async (endpoint, desiredModel, signal) => {
  if (!isOllamaEndpoint(endpoint)) {
    return desiredModel;
  }

  const cached = ollamaResolvedModelByEndpoint.get(endpoint);
  if (cached) {
    return cached;
  }

  const installed = await fetchOllamaModelCatalog(endpoint, signal);
  if (installed.length === 0) {
    return desiredModel;
  }

  if (installed.includes(desiredModel)) {
    ollamaResolvedModelByEndpoint.set(endpoint, desiredModel);
    return desiredModel;
  }

  const preferenceOrder = unique([desiredModel, ...OLLAMA_FALLBACK_MODELS]);
  const preferred = preferenceOrder.find((candidate) => installed.includes(candidate));
  const fallback = preferred || installed[0];
  ollamaResolvedModelByEndpoint.set(endpoint, fallback);
  return fallback;
};

const resolveOllamaRetryModels = async (endpoint, desiredModel, failedModel, signal) => {
  const installed = await fetchOllamaModelCatalog(endpoint, signal);
  if (installed.length > 0) {
    const preferredInstalled = unique([desiredModel, ...OLLAMA_FALLBACK_MODELS])
      .filter((candidate) => installed.includes(candidate));
    return unique([...preferredInstalled, ...installed]).filter(
      (candidate) => candidate && candidate !== failedModel,
    );
  }

  return unique([desiredModel, ...OLLAMA_FALLBACK_MODELS]).filter(
    (candidate) => candidate && candidate !== failedModel,
  );
};

const resolveModelRetryCandidates = async (endpoint, desiredModel, failedModel, signal) => {
  if (isOllamaEndpoint(endpoint)) {
    return resolveOllamaRetryModels(endpoint, desiredModel, failedModel, signal);
  }

  const fallbackModels = isGroqEndpoint(endpoint) ? GROQ_FALLBACK_MODELS : OLLAMA_FALLBACK_MODELS;

  // For OpenAI-compatible providers (including Groq), retry with provider-appropriate model fallbacks.
  return unique([desiredModel, ...fallbackModels]).filter(
    (candidate) => candidate && candidate !== failedModel,
  );
};

const buildModelNotFoundError = ({
  endpoint,
  desiredModel,
  attemptedModels,
  discoveredModels,
  sourceError,
}) => {
  const attempted = attemptedModels.filter(Boolean);
  const discovered = discoveredModels.filter(Boolean);
  const attemptedLabel = attempted.length > 0 ? attempted.join(", ") : "none";
  const discoveredLabel = discovered.length > 0 ? discovered.join(", ") : "none";
  const sourceMessage =
    sourceError instanceof Error && sourceError.message ? sourceError.message : "model not found";

  return new Error(
    [
      `Configured model "${desiredModel}" is unavailable on ${endpoint}.`,
      `Tried: ${attemptedLabel}.`,
      `Discovered models: ${discoveredLabel}.`,
      `Source error: ${sourceMessage}.`,
    ].join(" "),
  );
};

const requestSingleEndpoint = async (endpoint, input, signal, modelToUse, apiKeyOverride = "") => {
  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: buildHeaders(apiKeyOverride),
    signal,
    body: JSON.stringify(buildRequestBody(endpoint, input, false, modelToUse)),
  });

  const rawText = await response.text();
  const payload = parsePayloadText(rawText);

  if (!response.ok) {
    throw new Error(extractErrorMessage(payload, rawText));
  }

  if (!payload) {
    throw new Error(extractErrorMessage(payload, rawText) || "AI endpoint returned invalid JSON");
  }

  const completion = extractCompletionPayload(payload);
  if (!completion.content) {
    throw new Error("AI response was empty");
  }

  return {
    ...completion,
    metrics: {
      endpoint,
      stream_mode: "non_stream",
      total_duration_ms: Date.now() - startedAt,
      first_token_ms: Date.now() - startedAt,
      chunk_count: 1,
      output_chars: completion.content.length,
      thinking_chars: completion.thinking.length,
      ...completion.ollamaMetrics,
    },
  };
};

const attachRuntimeMetadataToCompletion = (completion, runtime = {}) => {
  const nextMetrics = {
    ...(completion?.metrics && typeof completion.metrics === "object" ? completion.metrics : {}),
    provider: String(runtime.provider || config.aiProvider || "").trim() || null,
    requested_model: String(runtime.requestedModel || "").trim() || null,
    resolved_model:
      String(completion?.model || runtime.resolvedModel || "").trim() ||
      String(runtime.requestedModel || "").trim() ||
      null,
    model_preset: String(runtime.modelPreset || "").trim() || null,
    fallback_model_used: Boolean(runtime.fallbackModelUsed),
    fallback_api_key_index: Number.isFinite(Number(runtime.apiKeyIndex)) ? Number(runtime.apiKeyIndex) : null,
    fallback_api_key_rotated: Boolean(runtime.apiKeyRotated),
    api_key_pool_size: Number.isFinite(Number(runtime.apiKeyPoolSize)) ? Number(runtime.apiKeyPoolSize) : null,
  };

  return {
    ...completion,
    provider: nextMetrics.provider,
    metrics: nextMetrics,
  };
};

const parseSseFrames = (buffer) => {
  const frames = [];
  let remainder = buffer;

  while (true) {
    const boundaryIndex = remainder.indexOf("\n\n");
    if (boundaryIndex === -1) {
      break;
    }

    const frame = remainder.slice(0, boundaryIndex);
    remainder = remainder.slice(boundaryIndex + 2);
    frames.push(frame);
  }

  return {
    frames,
    remainder,
  };
};

const parseLines = (buffer) => {
  const lines = [];
  let remainder = buffer;

  while (true) {
    const lineIndex = remainder.indexOf("\n");
    if (lineIndex === -1) {
      break;
    }

    const line = remainder.slice(0, lineIndex);
    remainder = remainder.slice(lineIndex + 1);
    lines.push(line);
  }

  return {
    lines,
    remainder,
  };
};

const requestSingleEndpointStream = async (endpoint, input, signal, onProgress, apiKeyOverride = "") => {
  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: buildHeaders(apiKeyOverride),
    signal,
    body: JSON.stringify(buildRequestBody(endpoint, input, true, input.model)),
  });

  if (!response.ok) {
    const rawText = await response.text();
    const payload = parsePayloadText(rawText);
    throw new Error(extractErrorMessage(payload, rawText));
  }

  const reader = response.body?.getReader();
  if (!reader) {
    // If body isn't stream-readable, fallback to non-stream completion.
    return requestSingleEndpoint(endpoint, input, signal, input.model, apiKeyOverride);
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const useSse = contentType.includes("text/event-stream");
  const decoder = new TextDecoder();

  let buffer = "";
  let rawSample = "";
  let parsedChunks = 0;
  let done = false;
  let model = String(input?.model || "").trim() || null;
  let content = "";
  let thinking = "";
  let lastPayload = null;
  let lastEmitAt = 0;
  let firstTokenAt = 0;

  const emitProgress = (isDone = false, error = null) => {
    if (typeof onProgress !== "function") {
      return;
    }

    const elapsedMs = Date.now() - startedAt;
    onProgress({
      content,
      thinking,
      model,
      done: isDone,
      error,
      metrics: {
        endpoint,
        stream_mode: "stream",
        chunk_count: parsedChunks,
        elapsed_ms: elapsedMs,
        first_token_ms: firstTokenAt ? firstTokenAt - startedAt : null,
        output_chars: content.length,
        thinking_chars: thinking.length,
      },
    });
  };

  const processPayload = (payload) => {
    if (!payload || typeof payload !== "object") {
      return;
    }

    parsedChunks += 1;
    lastPayload = payload;

    const delta = extractStreamDelta(payload);
    if (delta.model) {
      model = delta.model;
    }
    if (delta.content) {
      content += delta.content;
      if (!firstTokenAt) {
        firstTokenAt = Date.now();
      }
    }
    if (delta.thinking) {
      thinking += delta.thinking;
      if (!firstTokenAt) {
        firstTokenAt = Date.now();
      }
    }

    const shouldEmit = Boolean(delta.content || delta.thinking || delta.done);
    if (shouldEmit) {
      const now = Date.now();
      if (delta.done || now - lastEmitAt >= STREAM_EMIT_INTERVAL_MS) {
        emitProgress(Boolean(delta.done));
        lastEmitAt = now;
      }
    }

    if (delta.done) {
      done = true;
    }
  };

  const tryProcessJsonLine = (line) => {
    const payload = parsePayloadText(line);
    if (!payload) {
      return;
    }
    processPayload(payload);
  };

  const tryProcessSseFrame = (frame) => {
    const payloadLines = frame
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith(":"))
      .map((line) => (line.startsWith("data:") ? line.slice(5).trim() : line));

    if (payloadLines.length === 0) {
      return;
    }

    const joined = payloadLines.join("\n").trim();
    if (!joined || joined === "[DONE]") {
      done = true;
      return;
    }

    tryProcessJsonLine(joined);
  };

  while (!done) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) {
      break;
    }

    const chunkText = decoder.decode(value, { stream: true }).replace(/\r/g, "");
    if (!chunkText) {
      continue;
    }

    buffer += chunkText;
    if (rawSample.length < 4000) {
      rawSample += chunkText;
    }

    if (useSse) {
      const parsed = parseSseFrames(buffer);
      buffer = parsed.remainder;
      parsed.frames.forEach(tryProcessSseFrame);
      continue;
    }

    const parsed = parseLines(buffer);
    buffer = parsed.remainder;
    parsed.lines.forEach((line) => {
      const normalized = line.trim();
      if (!normalized) {
        return;
      }

      const sseStyle = normalized.startsWith("data:")
        ? normalized.slice(5).trim()
        : normalized;
      if (!sseStyle || sseStyle === "[DONE]") {
        done = true;
        return;
      }

      tryProcessJsonLine(sseStyle);
    });
  }

  const trailing = `${buffer}${decoder.decode().replace(/\r/g, "")}`.trim();
  if (trailing && !done) {
    if (useSse) {
      tryProcessSseFrame(trailing);
    } else {
      tryProcessJsonLine(trailing);
    }
  }

  if (parsedChunks === 0) {
    const fallbackPayload = parsePayloadText(rawSample) || parsePayloadText(trailing);
    if (fallbackPayload) {
      const completion = extractCompletionPayload(fallbackPayload);
      if (!completion.content) {
        throw new Error("AI response was empty");
      }
      content = completion.content;
      thinking = completion.thinking;
      model = completion.model || model;
      if (!firstTokenAt) {
        firstTokenAt = Date.now();
      }
      emitProgress(true);
      return {
        ...completion,
        metrics: {
          endpoint,
          stream_mode: "stream",
          total_duration_ms: Date.now() - startedAt,
          first_token_ms: firstTokenAt ? firstTokenAt - startedAt : null,
          chunk_count: 1,
          output_chars: completion.content.length,
          thinking_chars: completion.thinking.length,
          ...completion.ollamaMetrics,
        },
      };
    }

    throw new Error(extractErrorMessage(null, rawSample || trailing));
  }

  const finalContent = String(content || "").trim();
  if (!finalContent) {
    throw new Error("AI response was empty");
  }

  emitProgress(true);
  const ollamaMetrics = extractOllamaMetrics(lastPayload || {});
  return {
    content: finalContent,
    thinking: String(thinking || "").trim(),
    model: model || String(lastPayload?.model || "").trim() || null,
    links: collectLinks(lastPayload, content, thinking),
    metrics: {
      endpoint,
      stream_mode: "stream",
      total_duration_ms: Date.now() - startedAt,
      first_token_ms: firstTokenAt ? firstTokenAt - startedAt : null,
      chunk_count: parsedChunks,
      output_chars: finalContent.length,
      thinking_chars: String(thinking || "").trim().length,
      ...ollamaMetrics,
    },
  };
};

export const requestAiCompletion = async (input, options = {}) => {
  if (!config.aiBaseUrl) {
    throw new Error("AI endpoint is not configured");
  }

  const endpoints = resolveEndpointCandidates(config.aiBaseUrl);
  if (endpoints.length === 0) {
    throw new Error("AI endpoint is not configured");
  }

  const requestedModel = String(options.model || input?.model || config.aiModel || "").trim() || config.aiModel;
  const requestedModelPreset = String(options.modelPreset || "").trim().toLowerCase() || null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.aiTimeoutMs);
  const shouldStream = Boolean(options.stream);
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : null;
  const configuredApiKeys = getConfiguredAiApiKeys();
  const apiKeyCandidates = configuredApiKeys.length > 0 ? configuredApiKeys : [""];

  try {
    let lastError = null;

    for (let apiKeyAttemptIndex = 0; apiKeyAttemptIndex < apiKeyCandidates.length; apiKeyAttemptIndex += 1) {
      const apiKeyCandidate = apiKeyCandidates[apiKeyAttemptIndex];
      let preferredModelError = null;
      lastError = null;

      for (const endpoint of endpoints) {
        const attemptedModels = [];
        const requestApiKey = isOllamaEndpoint(endpoint) ? "" : apiKeyCandidate;

        try {
          const modelToUse = await resolveOllamaModel(endpoint, requestedModel, controller.signal);
          if (modelToUse) {
            attemptedModels.push(modelToUse);
          }
          const inputWithModel = {
            ...input,
            model: modelToUse,
          };
          const completion = shouldStream
            ? await requestSingleEndpointStream(endpoint, inputWithModel, controller.signal, onProgress, requestApiKey)
            : await requestSingleEndpoint(endpoint, inputWithModel, controller.signal, modelToUse, requestApiKey);

          const enrichedCompletion = attachRuntimeMetadataToCompletion(completion, {
            provider: config.aiProvider,
            requestedModel,
            resolvedModel: modelToUse,
            modelPreset: requestedModelPreset,
            fallbackModelUsed: Boolean(modelToUse && modelToUse !== requestedModel),
            apiKeyIndex: apiKeyAttemptIndex + 1,
            apiKeyRotated: apiKeyAttemptIndex > 0,
            apiKeyPoolSize: apiKeyCandidates.length,
          });

          if (onProgress && !shouldStream) {
            onProgress({
              content: enrichedCompletion.content || "",
              thinking: enrichedCompletion.thinking || "",
              model: enrichedCompletion.model || null,
              done: true,
              error: null,
              metrics: enrichedCompletion.metrics || null,
            });
          }
          return enrichedCompletion;
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            throw new Error("AI request timed out");
          }

          let usedFallbackRetry = false;
          if (isModelNotFoundError(error)) {
            if (isOllamaEndpoint(endpoint)) {
              ollamaResolvedModelByEndpoint.delete(endpoint);
              ollamaModelCatalogByEndpoint.delete(endpoint);
            }
            const failedModel = parseModelFromNotFoundMessage(error);
            const retryModels = await resolveModelRetryCandidates(
              endpoint,
              requestedModel,
              failedModel,
              controller.signal,
            );

            for (const retryModel of retryModels) {
              if (!retryModel || attemptedModels.includes(retryModel)) {
                continue;
              }

              attemptedModels.push(retryModel);
              usedFallbackRetry = true;

              try {
                const retryInput = {
                  ...input,
                  model: retryModel,
                };
                const retryCompletion = shouldStream
                  ? await requestSingleEndpointStream(endpoint, retryInput, controller.signal, onProgress, requestApiKey)
                  : await requestSingleEndpoint(endpoint, retryInput, controller.signal, retryModel, requestApiKey);

                if (isOllamaEndpoint(endpoint)) {
                  ollamaResolvedModelByEndpoint.set(endpoint, retryModel);
                }

                const enrichedRetryCompletion = attachRuntimeMetadataToCompletion(retryCompletion, {
                  provider: config.aiProvider,
                  requestedModel,
                  resolvedModel: retryModel,
                  modelPreset: requestedModelPreset,
                  fallbackModelUsed: Boolean(retryModel && retryModel !== requestedModel),
                  apiKeyIndex: apiKeyAttemptIndex + 1,
                  apiKeyRotated: apiKeyAttemptIndex > 0,
                  apiKeyPoolSize: apiKeyCandidates.length,
                });

                if (onProgress && !shouldStream) {
                  onProgress({
                    content: enrichedRetryCompletion.content || "",
                    thinking: enrichedRetryCompletion.thinking || "",
                    model: enrichedRetryCompletion.model || null,
                    done: true,
                    error: null,
                    metrics: enrichedRetryCompletion.metrics || null,
                  });
                }
                return enrichedRetryCompletion;
              } catch (retryError) {
                lastError = retryError;
                if (retryError instanceof Error && retryError.name === "AbortError") {
                  throw new Error("AI request timed out");
                }
                if (!isModelNotFoundError(retryError)) {
                  break;
                }
              }
            }

            const discoveredModels = isOllamaEndpoint(endpoint)
              ? await fetchOllamaModelCatalog(endpoint, controller.signal)
              : [];
            if (usedFallbackRetry && isModelNotFoundError(lastError || error)) {
              lastError = buildModelNotFoundError({
                endpoint,
                desiredModel: requestedModel,
                attemptedModels,
                discoveredModels,
                sourceError: lastError || error,
              });
              preferredModelError = lastError;
            }
          }

          if (usedFallbackRetry) {
            if (!shouldRetryEndpointError(lastError)) {
              break;
            }
            continue;
          }

          if (preferredModelError && isModelNotFoundError(error)) {
            lastError = preferredModelError;
          } else {
            lastError = error;
          }

          if (!shouldRetryEndpointError(error)) {
            break;
          }
        }
      }

      const canTryNextApiKey =
        apiKeyAttemptIndex < apiKeyCandidates.length - 1 &&
        shouldRetryWithNextApiKey(lastError);

      if (canTryNextApiKey) {
        continue;
      }

      break;
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error("AI request failed");
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("AI request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};
