import { randomUUID } from "crypto";
import { Message } from "../../server/models/Message.js";
import { User } from "../../server/models/User.js";
import { sendPushToUser } from "../../server/notifications/push.js";
import { userRoom } from "../../server/realtime/presence.js";
import { buildDisplayName, toClientMessage } from "../../server/utils/transformers.js";
import { AiMemory } from "../../server/models/AiMemory.js";
import { AiTask } from "../../server/models/AiTask.js";
import {
  AI_ASSISTANT_EMAIL,
  AI_ASSISTANT_FIRST_NAME,
  AI_ASSISTANT_LAST_NAME,
  AI_ASSISTANT_PROFILE_PICTURE_URL,
  AI_ASSISTANT_UUID,
  AI_DIRECTIVE_REGEX,
  AI_SEARCH_DIRECTIVE_REGEX,
  AI_HISTORY_LIMIT,
} from "./constants.js";
import { loadAiInstructions } from "./instructions.js";
import { requestAiCompletion } from "./provider.js";
import { emitAiMetrics, emitAiStatus, emitAiStreamState, emitAiTyping } from "./events.js";
import { runAgentTools } from "./tools.js";
import { executeSerperSearch } from "./search.js";
import {
  assertAiRequestBudgetAllowed,
  assertAiSearchBudgetAllowed,
  recordAiTurnUsage,
  resolveAiTurnControls,
} from "./controls.js";

const activeRunsByUser = new Map();

const createIdentifier = (prefix) => {
  try {
    return randomUUID();
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
};

const normalizeUsernamePart = (value = "") =>
  String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const deriveUsername = (user) => {
  const fromNames = normalizeUsernamePart(`${user?.firstName || ""}${user?.lastName || ""}`);
  if (fromNames) {
    return fromNames;
  }

  const emailPrefix = String(user?.email || "").split("@")[0] || "";
  const fromEmail = normalizeUsernamePart(emailPrefix);
  if (fromEmail) {
    return fromEmail;
  }

  const fromUuid = normalizeUsernamePart(String(user?.uuid || ""));
  return fromUuid || "user";
};

const messageContentForPrompt = (message) => {
  const text = String(message?.content || "").trim();
  if (text) {
    return text.slice(0, 2400);
  }

  if (message?.fileType === "image") {
    return "[image attachment]";
  }
  if (message?.fileType === "video") {
    return "[video attachment]";
  }
  if (message?.fileType === "audio") {
    return "[voice note]";
  }
  if (message?.fileUrl) {
    return "[file attachment]";
  }

  return "";
};

const toPromptHistory = (historyRows, userUuid) =>
  historyRows
    .slice()
    .reverse()
    .map((row) => {
      const content = messageContentForPrompt(row);
      if (!content) {
        return null;
      }

      return {
        role: row.senderUuid === userUuid ? "user" : "assistant",
        content,
      };
    })
    .filter(Boolean);

const buildRuntimeContextInstruction = ({ currentUser, contacts, taskContext, memoryContext }) => {
  const contactLines =
    contacts.length > 0
      ? contacts
          .map(
            (contact) =>
              `- username: ${contact.username} | name: ${contact.displayName} | uuid: ${contact.uuid}`,
          )
          .join("\n")
      : "- No contacts available";

  const taskLines =
    taskContext.length > 0
      ? taskContext
          .map((task, index) => {
            const dueLabel = task.dueAt ? new Date(task.dueAt).toISOString().slice(0, 16).replace("T", " ") : "none";
            return `- #${index + 1} ${task.title} | due: ${dueLabel}`;
          })
          .join("\n")
      : "- No pending tasks";

  const memoryLines =
    memoryContext.length > 0
      ? memoryContext.map((entry) => `- ${entry.key}: ${entry.value}`).join("\n")
      : "- No saved memory";

  return [
    "Runtime context:",
    `- Current user uuid: ${currentUser.uuid}`,
    `- Current user name: ${buildDisplayName(currentUser)}`,
    "- Available contacts (for message-send actions):",
    contactLines,
    "- Pending tasks/reminders:",
    taskLines,
    "- Saved memory:",
    memoryLines,
    "",
    "Agent capability: SEND_MESSAGE_TO_CONTACT",
    "When the user explicitly asks you to send a message to a contact:",
    "1) Output exactly one line with this token: </message?user={username}>",
    "2) On the next line(s), write the exact message body to send.",
    "3) Use only usernames from the contact list.",
    "",
    "If no send action is requested, do not output the directive token.",
  ].join("\n");
};

const parseDirective = (responseText) => {
  const text = String(responseText || "");
  const match = text.match(AI_DIRECTIVE_REGEX);
  if (!match) {
    return {
      hasDirective: false,
      username: "",
      cleanedText: text.trim(),
      sendText: "",
    };
  }

  const username = normalizeUsernamePart(match[1] || "");
  const tokenIndex = text.indexOf(match[0]);
  const beforeToken = tokenIndex > 0 ? text.slice(0, tokenIndex).trim() : "";
  const afterToken = tokenIndex >= 0 ? text.slice(tokenIndex + match[0].length).trim() : "";
  const cleanedText = [beforeToken, afterToken].filter(Boolean).join("\n").trim();

  return {
    hasDirective: true,
    username,
    cleanedText,
    sendText: afterToken || cleanedText,
  };
};

const parseSearchDirective = (responseText) => {
  const text = String(responseText || "");
  const match = text.match(AI_SEARCH_DIRECTIVE_REGEX);
  if (!match) {
    return {
      hasDirective: false,
      mode: "",
      query: "",
      cleanedText: text.trim(),
    };
  }

  const mode = String(match[1] || "").trim().toLowerCase();
  const rawQuery = String(match[2] || "").trim();
  let query = rawQuery;
  if (query.startsWith("{") && query.endsWith("}")) {
    query = query.slice(1, -1).trim();
  }

  const cleanedText = text.replace(match[0], "").trim();
  return {
    hasDirective: true,
    mode,
    query,
    cleanedText,
  };
};

const normalizeAiMetaForStorage = (rawMeta) => {
  if (!rawMeta || typeof rawMeta !== "object") {
    return null;
  }

  const source = rawMeta;
  const rawMetrics = source.metrics && typeof source.metrics === "object" ? source.metrics : {};

  return {
    thinking: source.thinking ? String(source.thinking) : null,
    model: source.model ? String(source.model) : null,
    links: Array.isArray(source.links) ? source.links.filter((entry) => typeof entry === "string" && entry.trim()) : [],
    toolsUsed: Array.isArray(source.tools_used)
      ? source.tools_used.filter((entry) => typeof entry === "string" && entry.trim())
      : Array.isArray(source.toolsUsed)
        ? source.toolsUsed.filter((entry) => typeof entry === "string" && entry.trim())
        : [],
    toolPayload:
      source.tool_payload && typeof source.tool_payload === "object"
        ? source.tool_payload
        : source.toolPayload && typeof source.toolPayload === "object"
          ? source.toolPayload
          : null,
    metrics: {
      endpoint: rawMetrics.endpoint ? String(rawMetrics.endpoint) : null,
      streamMode: rawMetrics.stream_mode ? String(rawMetrics.stream_mode) : rawMetrics.streamMode || null,
      totalDurationMs: Number.isFinite(Number(rawMetrics.total_duration_ms))
        ? Number(rawMetrics.total_duration_ms)
        : Number.isFinite(Number(rawMetrics.totalDurationMs))
          ? Number(rawMetrics.totalDurationMs)
          : null,
      firstTokenMs: Number.isFinite(Number(rawMetrics.first_token_ms))
        ? Number(rawMetrics.first_token_ms)
        : Number.isFinite(Number(rawMetrics.firstTokenMs))
          ? Number(rawMetrics.firstTokenMs)
          : null,
      chunkCount: Number.isFinite(Number(rawMetrics.chunk_count))
        ? Number(rawMetrics.chunk_count)
        : Number.isFinite(Number(rawMetrics.chunkCount))
          ? Number(rawMetrics.chunkCount)
          : null,
      outputChars: Number.isFinite(Number(rawMetrics.output_chars))
        ? Number(rawMetrics.output_chars)
        : Number.isFinite(Number(rawMetrics.outputChars))
          ? Number(rawMetrics.outputChars)
          : null,
      thinkingChars: Number.isFinite(Number(rawMetrics.thinking_chars))
        ? Number(rawMetrics.thinking_chars)
        : Number.isFinite(Number(rawMetrics.thinkingChars))
          ? Number(rawMetrics.thinkingChars)
          : null,
      evalCount: Number.isFinite(Number(rawMetrics.eval_count))
        ? Number(rawMetrics.eval_count)
        : Number.isFinite(Number(rawMetrics.evalCount))
          ? Number(rawMetrics.evalCount)
          : null,
      promptEvalCount: Number.isFinite(Number(rawMetrics.prompt_eval_count))
        ? Number(rawMetrics.prompt_eval_count)
        : Number.isFinite(Number(rawMetrics.promptEvalCount))
          ? Number(rawMetrics.promptEvalCount)
          : null,
      evalDurationMs: Number.isFinite(Number(rawMetrics.eval_duration_ms))
        ? Number(rawMetrics.eval_duration_ms)
        : Number.isFinite(Number(rawMetrics.evalDurationMs))
          ? Number(rawMetrics.evalDurationMs)
          : null,
      promptEvalDurationMs: Number.isFinite(Number(rawMetrics.prompt_eval_duration_ms))
        ? Number(rawMetrics.prompt_eval_duration_ms)
        : Number.isFinite(Number(rawMetrics.promptEvalDurationMs))
          ? Number(rawMetrics.promptEvalDurationMs)
          : null,
      loadDurationMs: Number.isFinite(Number(rawMetrics.load_duration_ms))
        ? Number(rawMetrics.load_duration_ms)
        : Number.isFinite(Number(rawMetrics.loadDurationMs))
          ? Number(rawMetrics.loadDurationMs)
          : null,
      provider: rawMetrics.provider ? String(rawMetrics.provider) : null,
      requestedModel: rawMetrics.requested_model
        ? String(rawMetrics.requested_model)
        : rawMetrics.requestedModel
          ? String(rawMetrics.requestedModel)
          : null,
      resolvedModel: rawMetrics.resolved_model
        ? String(rawMetrics.resolved_model)
        : rawMetrics.resolvedModel
          ? String(rawMetrics.resolvedModel)
          : null,
      modelPreset: rawMetrics.model_preset
        ? String(rawMetrics.model_preset)
        : rawMetrics.modelPreset
          ? String(rawMetrics.modelPreset)
          : null,
      fallbackModelUsed:
        typeof rawMetrics.fallback_model_used === "boolean"
          ? rawMetrics.fallback_model_used
          : typeof rawMetrics.fallbackModelUsed === "boolean"
            ? rawMetrics.fallbackModelUsed
            : null,
      fallbackApiKeyIndex: Number.isFinite(Number(rawMetrics.fallback_api_key_index))
        ? Number(rawMetrics.fallback_api_key_index)
        : Number.isFinite(Number(rawMetrics.fallbackApiKeyIndex))
          ? Number(rawMetrics.fallbackApiKeyIndex)
          : null,
      fallbackApiKeyRotated:
        typeof rawMetrics.fallback_api_key_rotated === "boolean"
          ? rawMetrics.fallback_api_key_rotated
          : typeof rawMetrics.fallbackApiKeyRotated === "boolean"
            ? rawMetrics.fallbackApiKeyRotated
            : null,
      apiKeyPoolSize: Number.isFinite(Number(rawMetrics.api_key_pool_size))
        ? Number(rawMetrics.api_key_pool_size)
        : Number.isFinite(Number(rawMetrics.apiKeyPoolSize))
          ? Number(rawMetrics.apiKeyPoolSize)
          : null,
      webSearched:
        typeof rawMetrics.web_searched === "boolean"
          ? rawMetrics.web_searched
          : typeof rawMetrics.webSearched === "boolean"
            ? rawMetrics.webSearched
            : null,
      webSearchedAt: rawMetrics.web_searched_at
        ? String(rawMetrics.web_searched_at)
        : rawMetrics.webSearchedAt
          ? String(rawMetrics.webSearchedAt)
          : null,
      twoPassSearch:
        typeof rawMetrics.two_pass_search === "boolean"
          ? rawMetrics.two_pass_search
          : typeof rawMetrics.twoPassSearch === "boolean"
            ? rawMetrics.twoPassSearch
            : null,
      searchStrategy: rawMetrics.search_strategy
        ? String(rawMetrics.search_strategy)
        : rawMetrics.searchStrategy
          ? String(rawMetrics.searchStrategy)
          : null,
      searchQuery: rawMetrics.search_query
        ? String(rawMetrics.search_query)
        : rawMetrics.searchQuery
          ? String(rawMetrics.searchQuery)
          : null,
      searchMode: rawMetrics.search_mode
        ? String(rawMetrics.search_mode)
        : rawMetrics.searchMode
          ? String(rawMetrics.searchMode)
          : null,
      searchResultCount: Number.isFinite(Number(rawMetrics.search_result_count))
        ? Number(rawMetrics.search_result_count)
        : Number.isFinite(Number(rawMetrics.searchResultCount))
          ? Number(rawMetrics.searchResultCount)
          : null,
      searchSourcesCount: Number.isFinite(Number(rawMetrics.search_sources_count))
        ? Number(rawMetrics.search_sources_count)
        : Number.isFinite(Number(rawMetrics.searchSourcesCount))
          ? Number(rawMetrics.searchSourcesCount)
          : null,
    },
  };
};

const buildGroundingContextFromSearchPayload = (searchPayload, baseSummary = "") => {
  const search = searchPayload && typeof searchPayload === "object" ? searchPayload : {};
  const mode = String(search.mode || "text").trim() || "text";
  const query = String(search.query || "").trim();
  const strategy = String(search.strategy || "").trim() || "direct";
  const searchedAt = String(search.searched_at || search.searchedAt || "").trim() || new Date().toISOString();
  const items = Array.isArray(search.items) ? search.items.slice(0, 8) : [];
  const sources = Array.isArray(search.sources)
    ? search.sources.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 12)
    : [];

  const itemLines = items
    .map((item, index) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const row = item;
      const title = String(row.title || `Result ${index + 1}`).trim();
      const snippet = String(row.snippet || "").trim();
      const link = String(row.link || row.image_url || "").trim();
      const source = String(row.source || "").trim();
      const publishedAt = String(row.published_at || "").trim();
      const parts = [
        `${index + 1}. ${title}`,
        source ? `source=${source}` : "",
        publishedAt ? `date=${publishedAt}` : "",
        link ? `url=${link}` : "",
      ].filter(Boolean);
      return [parts.join(" | "), snippet].filter(Boolean).join("\n   ");
    })
    .filter(Boolean);

  const sourceLines = sources.map((url, index) => `${index + 1}. ${url}`);

  return {
    mode,
    query,
    strategy,
    searchedAt,
    itemCount: items.length,
    sourceCount: sources.length,
    contextText: [
      "Web grounding package:",
      `- searched_at: ${searchedAt}`,
      `- mode: ${mode}`,
      query ? `- query: ${query}` : "- query: (none)",
      `- strategy: ${strategy}`,
      `- items: ${items.length}`,
      `- sources: ${sources.length}`,
      baseSummary ? "" : "",
      baseSummary ? "Search summary:" : "",
      baseSummary ? String(baseSummary).trim().slice(0, 4000) : "",
      itemLines.length > 0 ? "" : "",
      itemLines.length > 0 ? "Top results:" : "",
      ...itemLines,
      sourceLines.length > 0 ? "" : "",
      sourceLines.length > 0 ? "Source URLs:" : "",
      ...sourceLines,
    ]
      .filter(Boolean)
      .join("\n"),
  };
};

const runGroundedSynthesisPass = async ({
  instructionText,
  runtimeContextInstruction,
  history,
  latestUserMessage,
  searchPayload,
  baseSummary,
  model,
  modelPreset,
}) => {
  const grounding = buildGroundingContextFromSearchPayload(searchPayload, baseSummary);

  const synthesisResult = await requestAiCompletion(
    {
      messages: [
        { role: "system", content: instructionText },
        {
          role: "system",
          content: [
            runtimeContextInstruction,
            "",
            "Grounded answer mode (web):",
            "- Use ONLY the provided web grounding package for factual claims.",
            "- If results are weak/missing, say that clearly.",
            "- Prefer concise, structured answers with source-backed statements.",
            "- Do NOT output search directive tokens.",
            "- Keep the response user-facing and polished.",
          ].join("\n"),
        },
        ...history.slice(-8),
        { role: "system", content: grounding.contextText },
        {
          role: "user",
          content: [
            `Original request: ${String(latestUserMessage || "").trim()}`,
            "Synthesize a grounded answer using the web results above and cite/mention sources naturally.",
          ].join("\n"),
        },
      ],
    },
    {
      stream: false,
      model,
      modelPreset,
    },
  );

  return {
    result: synthesisResult,
    grounding,
  };
};

const createAndEmitMessage = async (
  io,
  { senderUuid, receiverUuid, content, status = "sent", messageType = "chat", aiMeta = null },
) => {
  const created = await Message.create({
    senderUuid,
    receiverUuid,
    content,
    status,
    messageType,
    aiMeta: normalizeAiMetaForStorage(aiMeta),
  });

  const clientMessage = toClientMessage(created);
  io.to(userRoom(senderUuid)).emit("message:new", clientMessage);
  io.to(userRoom(receiverUuid)).emit("message:new", clientMessage);
  return created;
};

const notifyUserForForwardedMessage = async ({ sender, receiverUuid, content }) => {
  const senderName = sender ? buildDisplayName(sender) : "New message";
  const bodyPreview = String(content || "").trim().slice(0, 120) || "Sent a message";

  try {
    await sendPushToUser(receiverUuid, {
      title: senderName,
      body: bodyPreview,
      tag: `message:${sender?.uuid || "unknown"}`,
      data: {
        type: "message",
        fromUserUuid: sender?.uuid || "",
        url: `/chat/${sender?.uuid || ""}`,
      },
      icon: sender?.profilePictureUrl || "/logo_new.png",
    });
  } catch {
    // Ignore push failures and keep chat flow non-blocking.
  }
};

const toSafeMetrics = (metrics = {}) => ({
  endpoint: metrics.endpoint || null,
  stream_mode: metrics.stream_mode || null,
  total_duration_ms: Number.isFinite(Number(metrics.total_duration_ms))
    ? Number(metrics.total_duration_ms)
    : null,
  first_token_ms: Number.isFinite(Number(metrics.first_token_ms))
    ? Number(metrics.first_token_ms)
    : null,
  chunk_count: Number.isFinite(Number(metrics.chunk_count)) ? Number(metrics.chunk_count) : null,
  output_chars: Number.isFinite(Number(metrics.output_chars)) ? Number(metrics.output_chars) : null,
  thinking_chars: Number.isFinite(Number(metrics.thinking_chars)) ? Number(metrics.thinking_chars) : null,
  eval_count: Number.isFinite(Number(metrics.eval_count)) ? Number(metrics.eval_count) : null,
  prompt_eval_count: Number.isFinite(Number(metrics.prompt_eval_count))
    ? Number(metrics.prompt_eval_count)
    : null,
  eval_duration_ms: Number.isFinite(Number(metrics.eval_duration_ms))
    ? Number(metrics.eval_duration_ms)
    : null,
  prompt_eval_duration_ms: Number.isFinite(Number(metrics.prompt_eval_duration_ms))
    ? Number(metrics.prompt_eval_duration_ms)
    : null,
  load_duration_ms: Number.isFinite(Number(metrics.load_duration_ms))
    ? Number(metrics.load_duration_ms)
    : null,
  provider: metrics.provider ? String(metrics.provider) : null,
  requested_model: metrics.requested_model ? String(metrics.requested_model) : null,
  resolved_model: metrics.resolved_model ? String(metrics.resolved_model) : null,
  model_preset: metrics.model_preset ? String(metrics.model_preset) : null,
  fallback_model_used:
    typeof metrics.fallback_model_used === "boolean" ? metrics.fallback_model_used : null,
  fallback_api_key_index: Number.isFinite(Number(metrics.fallback_api_key_index))
    ? Number(metrics.fallback_api_key_index)
    : null,
  fallback_api_key_rotated:
    typeof metrics.fallback_api_key_rotated === "boolean" ? metrics.fallback_api_key_rotated : null,
  api_key_pool_size: Number.isFinite(Number(metrics.api_key_pool_size))
    ? Number(metrics.api_key_pool_size)
    : null,
  web_searched: typeof metrics.web_searched === "boolean" ? metrics.web_searched : null,
  web_searched_at: metrics.web_searched_at ? String(metrics.web_searched_at) : null,
  two_pass_search: typeof metrics.two_pass_search === "boolean" ? metrics.two_pass_search : null,
  search_strategy: metrics.search_strategy ? String(metrics.search_strategy) : null,
  search_query: metrics.search_query ? String(metrics.search_query) : null,
  search_mode: metrics.search_mode ? String(metrics.search_mode) : null,
  search_result_count: Number.isFinite(Number(metrics.search_result_count))
    ? Number(metrics.search_result_count)
    : null,
  search_sources_count: Number.isFinite(Number(metrics.search_sources_count))
    ? Number(metrics.search_sources_count)
    : null,
});

const isRunActive = (userUuid, runId) => activeRunsByUser.get(userUuid) === runId;

export const isAiAssistantUuid = (uuid) => String(uuid || "").trim() === AI_ASSISTANT_UUID;

export const ensureAiAssistantUser = async () => {
  const existing = await User.findOne({ uuid: AI_ASSISTANT_UUID });
  if (existing) {
    let hasChanges = false;
    if (existing.email !== AI_ASSISTANT_EMAIL) {
      existing.email = AI_ASSISTANT_EMAIL;
      hasChanges = true;
    }
    if (existing.firstName !== AI_ASSISTANT_FIRST_NAME) {
      existing.firstName = AI_ASSISTANT_FIRST_NAME;
      hasChanges = true;
    }
    if (existing.lastName !== AI_ASSISTANT_LAST_NAME) {
      existing.lastName = AI_ASSISTANT_LAST_NAME;
      hasChanges = true;
    }
    if (existing.profilePictureUrl !== AI_ASSISTANT_PROFILE_PICTURE_URL) {
      existing.profilePictureUrl = AI_ASSISTANT_PROFILE_PICTURE_URL;
      hasChanges = true;
    }
    if (hasChanges) {
      await existing.save();
    }
    return existing;
  }

  return User.create({
    uuid: AI_ASSISTANT_UUID,
    email: AI_ASSISTANT_EMAIL,
    firstName: AI_ASSISTANT_FIRST_NAME,
    lastName: AI_ASSISTANT_LAST_NAME,
    profilePictureUrl: AI_ASSISTANT_PROFILE_PICTURE_URL,
    emailVerifiedAt: new Date(),
  });
};

export const processAiTurn = async ({ io, userUuid, latestUserMessage }) => {
  if (!io || !userUuid) {
    return;
  }

  const runId = createIdentifier("ai-run");
  activeRunsByUser.set(userUuid, runId);
  const streamId = createIdentifier("ai-stream");

  const emitStatus = (status, payload = {}) => {
    if (!isRunActive(userUuid, runId)) {
      return;
    }
    emitAiStatus(io, userUuid, {
      streamId,
      status,
      ...payload,
    });
  };

  try {
    const currentUser = await User.findOne({ uuid: userUuid });
    if (!currentUser || !isRunActive(userUuid, runId)) {
      return;
    }

    const [historyRows, instructionText, contactsRaw, taskContextRaw, memoryContextRaw, aiControls] = await Promise.all([
      Message.find({
        $or: [
          { senderUuid: userUuid, receiverUuid: AI_ASSISTANT_UUID },
          { senderUuid: AI_ASSISTANT_UUID, receiverUuid: userUuid },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(AI_HISTORY_LIMIT),
      loadAiInstructions(),
      User.find({
        uuid: { $nin: [userUuid, AI_ASSISTANT_UUID] },
      }),
      AiTask.find({ userUuid, status: "pending" }).sort({ dueAt: 1, createdAt: 1 }).limit(8),
      AiMemory.find({ userUuid }).sort({ updatedAt: -1 }).limit(8),
      resolveAiTurnControls(userUuid),
    ]);

    if (!isRunActive(userUuid, runId)) {
      return;
    }

    const contacts = contactsRaw.map((contact) => ({
      uuid: contact.uuid,
      username: deriveUsername(contact),
      displayName: buildDisplayName(contact),
      user: contact,
    }));

    const taskContext = taskContextRaw.map((task) => ({
      id: String(task._id),
      title: task.title,
      dueAt: task.dueAt || null,
    }));

    const memoryContext = memoryContextRaw.map((entry) => ({
      key: entry.key,
      value: entry.value,
    }));

    assertAiRequestBudgetAllowed(aiControls);

    const runtimeContextInstruction = buildRuntimeContextInstruction({
      currentUser,
      contacts,
      taskContext,
      memoryContext,
    });

    const history = toPromptHistory(historyRows, userUuid);
    if (history.length === 0 && latestUserMessage) {
      history.push({
        role: "user",
        content: String(latestUserMessage).trim(),
      });
    }

    emitAiTyping(io, userUuid, true);
    emitStatus("thinking", { message: "Analyzing your request..." });

    const toolStartedAt = Date.now();
    const toolResult = await runAgentTools({
      userUuid,
      latestUserMessage,
      contacts,
      sendMessageToContact: async (receiverUuid, content) => {
        await createAndEmitMessage(io, {
          senderUuid: userUuid,
          receiverUuid,
          content,
        });
        await notifyUserForForwardedMessage({
          sender: currentUser,
          receiverUuid,
          content,
        });
      },
      beforeWebSearch: async () => {
        assertAiSearchBudgetAllowed(aiControls);
      },
    });

    if (!isRunActive(userUuid, runId)) {
      return;
    }

    if (toolResult?.handled) {
      const toolPayloadValue =
        toolResult.payload && typeof toolResult.payload === "object"
          ? { ...toolResult.payload }
          : null;
      if (toolPayloadValue?.search && typeof toolPayloadValue.search === "object") {
        toolPayloadValue.search = { ...toolPayloadValue.search };
      }

      const toolSearchPayload =
        toolPayloadValue?.search && typeof toolPayloadValue.search === "object"
          ? toolPayloadValue.search
          : null;
      const searchUsed = Boolean(toolSearchPayload && !toolSearchPayload.error);
      const searchStartedAt = searchUsed ? Date.now() : null;

      let safeReply = String(toolResult.reply || "").trim() || "Done.";
      let synthesizedAiResult = null;
      let synthesizedGrounding = null;
      const toolsUsed = Array.isArray(toolResult.toolsUsed) ? [...toolResult.toolsUsed] : [];

      if (searchUsed && toolSearchPayload) {
        try {
          const synthesized = await runGroundedSynthesisPass({
            instructionText,
            runtimeContextInstruction,
            history,
            latestUserMessage,
            searchPayload: toolSearchPayload,
            baseSummary: safeReply,
            model: aiControls.model,
            modelPreset: aiControls.modelPreset,
          });
          if (synthesized?.result?.content) {
            safeReply = String(synthesized.result.content).trim() || safeReply;
            synthesizedAiResult = synthesized.result;
            synthesizedGrounding = synthesized.grounding;
            toolsUsed.push("grounded_synthesis");
            toolPayloadValue.search = {
              ...toolPayloadValue.search,
              web_searched: true,
              two_pass_search: true,
              searched_at: synthesized.grounding?.searchedAt || toolPayloadValue.search.searched_at || new Date().toISOString(),
              synthesized_at: new Date().toISOString(),
              synthesized_model: String(synthesized.result.model || "").trim() || null,
            };
          }
        } catch {
          // Fall back to the direct search summary if synthesis fails.
        }
      }

      const searchMetrics = toolSearchPayload
        ? {
            web_searched: searchUsed,
            web_searched_at:
              String(
                toolSearchPayload.searched_at ||
                  synthesizedGrounding?.searchedAt ||
                  "",
              ).trim() || null,
            two_pass_search: Boolean(synthesizedAiResult),
            search_strategy: String(toolSearchPayload.strategy || "direct").trim() || null,
            search_query: String(toolSearchPayload.query || "").trim() || null,
            search_mode: String(toolSearchPayload.mode || "").trim() || null,
            search_result_count: Number.isFinite(Number(toolSearchPayload.result_count))
              ? Number(toolSearchPayload.result_count)
              : null,
            search_sources_count: Array.isArray(toolSearchPayload.sources)
              ? toolSearchPayload.sources.length
              : null,
          }
        : {};

      const baseToolMetrics = {
        stream_mode: synthesizedAiResult ? "two_pass_search" : "tool_only",
        total_duration_ms: Date.now() - toolStartedAt,
        first_token_ms: synthesizedAiResult
          ? Number(synthesizedAiResult?.metrics?.first_token_ms ?? synthesizedAiResult?.metrics?.firstTokenMs ?? 0) || 0
          : 0,
        chunk_count: synthesizedAiResult
          ? Number(synthesizedAiResult?.metrics?.chunk_count ?? synthesizedAiResult?.metrics?.chunkCount ?? 1) || 1
          : 0,
        output_chars: safeReply.length,
        thinking_chars: synthesizedAiResult ? String(synthesizedAiResult.thinking || "").length : 0,
        ...(synthesizedAiResult?.metrics || {}),
        ...searchMetrics,
      };
      const toolMetrics = toSafeMetrics(baseToolMetrics);
      const searchLinks = Array.isArray(toolPayloadValue?.search?.sources)
        ? toolPayloadValue.search.sources.filter((entry) => typeof entry === "string" && entry.trim())
        : [];
      const modelLinks = Array.isArray(synthesizedAiResult?.links)
        ? synthesizedAiResult.links.filter((entry) => typeof entry === "string" && entry.trim())
        : [];
      const aiMeta = {
        thinking: synthesizedAiResult ? String(synthesizedAiResult.thinking || "").trim() || null : null,
        model: synthesizedAiResult ? String(synthesizedAiResult.model || "").trim() || null : "tool-chain",
        links: Array.from(new Set([...modelLinks, ...searchLinks])).slice(0, 8),
        tools_used: toolsUsed,
        tool_payload: toolPayloadValue,
        metrics: toolMetrics,
      };

      emitStatus("streaming", {
        model: aiMeta.model,
        message: synthesizedAiResult ? "Synthesizing grounded answer..." : "Preparing response...",
        metrics: toolMetrics,
      });
      emitAiMetrics(io, userUuid, {
        streamId,
        metrics: toolMetrics,
      });

      await createAndEmitMessage(io, {
        senderUuid: AI_ASSISTANT_UUID,
        receiverUuid: userUuid,
        content: safeReply,
        aiMeta,
      });

      try {
      await recordAiTurnUsage({
          userUuid,
          controls: aiControls,
          provider: synthesizedAiResult?.provider || null,
          model: aiMeta.model,
          modelPreset: aiControls.modelPreset,
          inputChars: String(latestUserMessage || "").length,
          outputChars: safeReply.length + String(aiMeta.thinking || "").length,
          searchUsed,
          toolOnly: !synthesizedAiResult,
          metrics: toolMetrics,
        });
      } catch {
        // Keep AI reply delivery non-blocking if usage accounting fails.
      }

      emitStatus("done", {
        model: aiMeta.model,
        message: synthesizedAiResult ? "Grounded response sent" : "Handled via agent tools",
        metrics: toolMetrics,
      });
      return;
    }

    const aiResult = await requestAiCompletion(
      {
        messages: [
          { role: "system", content: instructionText },
          {
            role: "system",
            content: runtimeContextInstruction,
          },
          ...history,
        ],
      },
      {
        stream: false,
        model: aiControls.model,
        modelPreset: aiControls.modelPreset,
      },
    );

    if (!isRunActive(userUuid, runId)) {
      return;
    }

    let effectiveAiResult = aiResult;
    const rawAiResponse = String(aiResult?.content || "");
    const searchDirective = parseSearchDirective(rawAiResponse);
    const directive = parseDirective(searchDirective.cleanedText || rawAiResponse);
    let finalReply = directive.cleanedText || searchDirective.cleanedText || rawAiResponse.trim();
    const toolsUsed = [];
    const toolPayload = {};
    let searchLinks = [];
    let searchItems = [];
    let searchUsed = false;
    let searchGrounding = null;
    let usedTwoPassSearch = false;

    if (searchDirective.hasDirective) {
      toolsUsed.push("web_retrieval");
      try {
        assertAiSearchBudgetAllowed(aiControls);
        const searchResult = await executeSerperSearch({
          mode: searchDirective.mode,
          query: searchDirective.query,
        });
        const searchSummary = String(searchResult.summary || "").trim();
        searchLinks = Array.isArray(searchResult.links) ? searchResult.links : [];
        searchItems = Array.isArray(searchResult.items)
          ? searchResult.items
              .slice(0, 8)
              .map((item) => ({
                title: String(item?.title || "").trim(),
                snippet: String(item?.snippet || "").trim(),
                link: String(item?.link || "").trim(),
                source: String(item?.source || "").trim(),
                image_url: String(item?.image_url || "").trim(),
                published_at: String(item?.published_at || "").trim(),
              }))
          : [];
        const searchedAt = new Date().toISOString();
        toolPayload.search = {
          mode: searchResult.mode,
          query: searchResult.query,
          endpoint: searchResult.endpoint,
          result_count: searchLinks.length,
          strategy: "model_directive",
          searched_at: searchedAt,
          web_searched: true,
          two_pass_search: false,
          sources: searchLinks,
          items: searchItems,
        };
        searchUsed = true;

        try {
          const synthesized = await runGroundedSynthesisPass({
            instructionText,
            runtimeContextInstruction,
            history,
            latestUserMessage,
            searchPayload: toolPayload.search,
            baseSummary: [finalReply, searchSummary].filter(Boolean).join("\n\n"),
            model: aiControls.model,
            modelPreset: aiControls.modelPreset,
          });
          if (synthesized?.result?.content) {
            effectiveAiResult = synthesized.result;
            searchGrounding = synthesized.grounding;
            usedTwoPassSearch = true;
            toolsUsed.push("grounded_synthesis");
            toolPayload.search = {
              ...toolPayload.search,
              two_pass_search: true,
              searched_at: synthesized.grounding?.searchedAt || searchedAt,
              synthesized_at: new Date().toISOString(),
              synthesized_model: String(synthesized.result.model || "").trim() || null,
            };
            finalReply = String(synthesized.result.content || "").trim() || [finalReply, searchSummary].filter(Boolean).join("\n\n").trim();
          } else {
            finalReply = [finalReply, searchSummary].filter(Boolean).join("\n\n").trim();
          }
        } catch {
          finalReply = [finalReply, searchSummary].filter(Boolean).join("\n\n").trim();
        }
      } catch (searchError) {
        const searchErrorMessage =
          searchError instanceof Error && searchError.message
            ? searchError.message
            : "Search request failed.";
        toolPayload.search = {
          mode: searchDirective.mode || "text",
          query: searchDirective.query || "",
          strategy: "model_directive",
          web_searched: false,
          two_pass_search: false,
          error: searchErrorMessage,
        };
        const fallbackSearchMessage = `Search failed: ${searchErrorMessage}`;
        finalReply = [finalReply, fallbackSearchMessage].filter(Boolean).join("\n\n").trim();
      }
    }

    if (directive.hasDirective) {
      toolsUsed.push("send_message_directive");
      const target = contacts.find((contact) => contact.username === directive.username) || null;
      if (!target) {
        finalReply = `I could not find @${directive.username}. Use a valid username from your contacts.`;
      } else if (!directive.sendText) {
        finalReply = `I found @${directive.username}, but the message body is empty. Tell me what to send.`;
      } else {
        toolPayload.sent_to_username = target.username;
        toolPayload.sent_to_uuid = target.uuid;
        await createAndEmitMessage(io, {
          senderUuid: userUuid,
          receiverUuid: target.uuid,
          content: directive.sendText,
        });
        await notifyUserForForwardedMessage({
          sender: currentUser,
          receiverUuid: target.uuid,
          content: directive.sendText,
        });
        finalReply = `Sent to ${target.displayName}.`;
      }
    }

    const safeReply = finalReply.trim() || "Done.";
    const modelLinks = Array.isArray(effectiveAiResult?.links)
      ? effectiveAiResult.links.filter((entry) => typeof entry === "string" && entry.trim())
      : [];
    const mergedLinks = Array.from(new Set([...modelLinks, ...searchLinks])).slice(0, 8);
    const enrichedMetrics = toSafeMetrics({
      ...(effectiveAiResult?.metrics || {}),
      web_searched: searchUsed,
      web_searched_at:
        String(toolPayload.search?.searched_at || searchGrounding?.searchedAt || "").trim() || null,
      two_pass_search: usedTwoPassSearch,
      search_strategy: String(toolPayload.search?.strategy || "").trim() || null,
      search_query: String(toolPayload.search?.query || "").trim() || null,
      search_mode: String(toolPayload.search?.mode || "").trim() || null,
      search_result_count: Number.isFinite(Number(toolPayload.search?.result_count))
        ? Number(toolPayload.search.result_count)
        : null,
      search_sources_count: Array.isArray(toolPayload.search?.sources)
        ? toolPayload.search.sources.length
        : null,
      model_preset: String(aiControls.modelPreset || "").trim() || null,
    });
    const aiMeta = {
      thinking: String(effectiveAiResult?.thinking || "").trim() || null,
      model: String(effectiveAiResult?.model || "").trim() || null,
      links: mergedLinks,
      tools_used: toolsUsed,
      tool_payload: Object.keys(toolPayload).length > 0 ? toolPayload : null,
      metrics: enrichedMetrics,
    };
    if (!isRunActive(userUuid, runId)) {
      return;
    }

    emitStatus("streaming", {
      model: aiMeta.model || null,
      message: "Preparing response...",
      metrics: aiMeta.metrics,
    });
    emitAiMetrics(io, userUuid, {
      streamId,
      metrics: aiMeta.metrics,
    });

    await createAndEmitMessage(io, {
      senderUuid: AI_ASSISTANT_UUID,
      receiverUuid: userUuid,
      content: safeReply,
      aiMeta,
    });

    try {
    await recordAiTurnUsage({
        userUuid,
        controls: aiControls,
        provider: effectiveAiResult?.provider || null,
        model: aiMeta.model,
        modelPreset: aiControls.modelPreset,
        inputChars: String(latestUserMessage || "").length,
        outputChars: safeReply.length + String(aiMeta.thinking || "").length,
        searchUsed,
        toolOnly: false,
        metrics: aiMeta.metrics,
      });
    } catch {
      // Keep AI reply delivery non-blocking if usage accounting fails.
    }

    emitStatus("done", {
      model: aiMeta.model || null,
      message: "Response sent",
      metrics: aiMeta.metrics,
    });
  } catch (error) {
    if (!isRunActive(userUuid, runId)) {
      return;
    }

    const errorMessage =
      error instanceof Error && error.message
        ? error.message
        : "Could not generate a response right now.";

    emitAiStreamState(io, userUuid, {
      streamId,
      content: "",
      thinking: "",
      model: null,
      done: true,
      error: errorMessage,
      metrics: null,
    });
    emitStatus("error", {
      message: "AI request failed",
      error: errorMessage,
      metrics: null,
    });
    emitAiMetrics(io, userUuid, {
      streamId,
      metrics: null,
    });

    const fallbackMessage = `I could not generate a response right now (${errorMessage}).`;
    await createAndEmitMessage(io, {
      senderUuid: AI_ASSISTANT_UUID,
      receiverUuid: userUuid,
      content: fallbackMessage,
      aiMeta: {
        thinking: null,
        model: null,
        links: [],
        tools_used: [],
        tool_payload: null,
        metrics: null,
      },
    });
  } finally {
    if (isRunActive(userUuid, runId)) {
      emitAiTyping(io, userUuid, false);
      activeRunsByUser.delete(userUuid);
    }
  }
};
