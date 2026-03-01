import { AiMemory } from "../../server/models/AiMemory.js";
import { AiTask } from "../../server/models/AiTask.js";
import { executeSerperSearch } from "./search.js";

const TOOL_SOURCE = "agent_tool";

const normalizeUsernamePart = (value = "") =>
  String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");

const extractQuotedText = (value) => {
  const source = String(value || "").trim();
  const quoted = source.match(/"([^"]{3,})"/);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }
  return "";
};

const parseRelativeDueAt = (text) => {
  const source = String(text || "").toLowerCase();
  const inAmount = source.match(/\bin\s+(\d+)\s*(minute|minutes|min|hour|hours|day|days)\b/);
  if (inAmount) {
    const amount = Number(inAmount[1]);
    const unit = inAmount[2];
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    let multiplier = 0;
    if (unit.startsWith("min")) {
      multiplier = 60 * 1000;
    } else if (unit.startsWith("hour")) {
      multiplier = 60 * 60 * 1000;
    } else if (unit.startsWith("day")) {
      multiplier = 24 * 60 * 60 * 1000;
    }

    if (multiplier > 0) {
      return new Date(Date.now() + amount * multiplier);
    }
  }

  const explicitIso = source.match(/\b(20\d{2}-\d{2}-\d{2})(?:[ t](\d{2}:\d{2}))?\b/);
  if (explicitIso?.[1]) {
    const candidate = explicitIso[2] ? `${explicitIso[1]}T${explicitIso[2]}:00` : `${explicitIso[1]}T09:00:00`;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const tomorrow = source.match(/\btomorrow(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?\b/);
  if (tomorrow) {
    const now = new Date();
    const next = new Date(now);
    next.setDate(now.getDate() + 1);
    let hours = 9;
    let minutes = 0;

    if (tomorrow[1]) {
      hours = Number(tomorrow[1]);
      minutes = tomorrow[2] ? Number(tomorrow[2]) : 0;
      const meridiem = String(tomorrow[3] || "").toLowerCase();
      if (meridiem === "pm" && hours < 12) {
        hours += 12;
      }
      if (meridiem === "am" && hours === 12) {
        hours = 0;
      }
    }

    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
      next.setHours(hours, minutes, 0, 0);
      return next;
    }
  }

  return null;
};

const detectContactIntent = (input, contacts) => {
  const text = String(input || "").trim();
  if (!text) {
    return null;
  }

  const byMention = text.match(/@([a-z0-9_]+)\b/i);
  const byVerb = text.match(/\b(?:send|message|text)\s+([a-z0-9_]+)\b/i);
  const rawUser = byMention?.[1] || byVerb?.[1] || "";
  if (!rawUser) {
    return null;
  }

  const username = normalizeUsernamePart(rawUser);
  const target = contacts.find((contact) => normalizeUsernamePart(contact.username) === username);
  if (!target) {
    return {
      type: "missing-contact",
      username,
    };
  }

  const quotedBody = extractQuotedText(text);
  if (quotedBody) {
    return {
      type: "send",
      target,
      messageBody: quotedBody,
    };
  }

  const afterColon = text.split(":").slice(1).join(":").trim();
  if (afterColon) {
    return {
      type: "send",
      target,
      messageBody: afterColon,
    };
  }

  const afterThat = text.replace(/\b(?:send|message|text)\b.+?\b(?:that|saying)\b/i, "").trim();
  if (afterThat.length > 3) {
    return {
      type: "send",
      target,
      messageBody: afterThat,
    };
  }

  return {
    type: "missing-body",
    target,
  };
};

const parseMemoryStoreIntent = (input) => {
  const text = String(input || "").trim();
  const rememberMatch = text.match(/\bremember(?:\s+that)?\s+(.+)$/i);
  if (!rememberMatch?.[1]) {
    return null;
  }

  const clause = rememberMatch[1].trim();
  if (clause.length < 4) {
    return null;
  }

  const keyValue = clause.match(/^(.+?)\s+is\s+(.+)$/i);
  if (keyValue?.[1] && keyValue?.[2]) {
    return {
      key: keyValue[1].trim().toLowerCase().slice(0, 80),
      value: keyValue[2].trim().slice(0, 400),
    };
  }

  return {
    key: clause.slice(0, 80).toLowerCase(),
    value: clause.slice(0, 400),
  };
};

const parseMemoryRecallIntent = (input) => {
  const text = String(input || "").trim();
  const match = text.match(/\b(?:what do you remember about|recall|remember about)\s+(.+)$/i);
  if (!match?.[1]) {
    return null;
  }

  return match[1].trim().toLowerCase().slice(0, 80);
};

const parseTaskCreateIntent = (input) => {
  const text = String(input || "").trim();

  const reminder = text.match(/\bremind me to\s+(.+)$/i);
  if (reminder?.[1]) {
    return {
      title: reminder[1].trim().slice(0, 180),
      dueAt: parseRelativeDueAt(text),
      kind: "reminder",
    };
  }

  const todo = text.match(/\b(?:add task|create task|todo)\s+(.+)$/i);
  if (todo?.[1]) {
    return {
      title: todo[1].trim().slice(0, 180),
      dueAt: parseRelativeDueAt(text),
      kind: "task",
    };
  }

  return null;
};

const parseTaskListIntent = (input) => /\b(?:show|list|what are)\b.*\b(?:tasks|reminders)\b/i.test(String(input || ""));

const parseTaskCompleteIntent = (input) => {
  const text = String(input || "").trim();
  const match = text.match(/\b(?:complete|done|finish|close)\s+(?:task|reminder)\s+(\d+)\b/i);
  if (!match?.[1]) {
    return null;
  }

  const index = Number(match[1]);
  if (!Number.isFinite(index) || index <= 0) {
    return null;
  }
  return index;
};

const parseWebSearchIntent = (input) => {
  const text = String(input || "").trim();
  if (text.startsWith("/web ")) {
    return text.slice(5).trim();
  }

  return "";
};

const stripSearchLeadIn = (input) => {
  let next = String(input || "").trim();
  if (!next) {
    return "";
  }

  next = next
    .replace(/^\/web\s+/i, "")
    .replace(/^\/search\s+/i, "")
    .replace(/^please\s+/i, "")
    .replace(/^(?:can you|could you)\s+/i, "")
    .replace(/^(?:search|find|look\s*up|lookup|google)\s+(?:for\s+)?/i, "")
    .replace(/^show\s+me\s+/i, "")
    .replace(/^(?:i\s+need|give\s+me)\s+(?:info|information|details)\s+about\s+/i, "")
    .replace(/^tell\s+me\s+about\s+/i, "")
    .replace(/^what\s+is\s+/i, "")
    .replace(/^who\s+is\s+/i, "")
    .replace(/^latest\s+/i, "")
    .trim();

  next = next
    .replace(/\b(?:with\s+sources?|source\s+links?|citations?)\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+(?:please|for\s+me)\s*$/i, "")
    .trim();
  return next;
};

const inferSearchModeFromText = (input) => {
  const text = String(input || "").toLowerCase();
  if (/https?:\/\//i.test(text)) {
    return "webpage";
  }
  if (/\b(image|images|photo|photos|picture|pictures|wallpaper|logo)\b/i.test(text)) {
    return "image";
  }
  if (/\b(video|videos|youtube|yt|reel|reels|clip|clips)\b/i.test(text)) {
    return "videos";
  }
  if (/\b(news|headline|headlines|breaking)\b/i.test(text)) {
    return "news";
  }
  if (/\b(map|maps|directions|route)\b/i.test(text)) {
    return "maps";
  }
  if (/\b(place|places|near me|nearby|restaurant|restaurants|hotel|hotels)\b/i.test(text)) {
    return "places";
  }
  if (/\b(buy|price|deal|deals|shop|shopping)\b/i.test(text)) {
    return "shopping";
  }
  return "text";
};

const isNonSearchTask = (input) => {
  const text = String(input || "").toLowerCase();
  return (
    /\b(?:remember|what do you remember|recall|remind me|add task|create task|todo|show tasks|complete task)\b/.test(text) ||
    /<\/message\?user=/.test(text) ||
    /\b(?:write code|debug|fix this code|refactor|translate|rewrite|draft a message)\b/.test(text)
  );
};

const parseNaturalSearchIntent = (input) => {
  const text = String(input || "").trim();
  if (!text || isNonSearchTask(text)) {
    return null;
  }

  const explicitSlash = text.match(/^\/(?:web|search)\s+(.+)$/i);
  if (explicitSlash?.[1]) {
    const mode = inferSearchModeFromText(text);
    const query = stripSearchLeadIn(text) || explicitSlash[1].trim();
    return query ? { mode, query, strategy: "slash_command" } : null;
  }

  const explicitSearchVerb = /\b(?:search|find|look\s*up|lookup|google)\b/i.test(text);
  const liveInfoSignal = /\b(?:latest|current|today|recent|news|headline|price|stock|trending|update|updates)\b/i.test(text);
  const infoAboutEntity = /\b(?:info|information|details)\s+about\b/i.test(text) || /\btell me about\b/i.test(text);
  const companySignal = /\b(?:company|startup|brand|business|organization|firm)\b/i.test(text);
  const sourceSignal = /\b(?:with sources|sources?|source links?|citations?)\b/i.test(text);

  const shouldSearch = explicitSearchVerb || liveInfoSignal || sourceSignal || (infoAboutEntity && companySignal);
  if (!shouldSearch) {
    return null;
  }

  const mode = inferSearchModeFromText(text);
  let query = stripSearchLeadIn(text);
  if (!query) {
    query = text;
  }

  if (mode === "videos") {
    query = query.replace(/\b(?:youtube\s+videos?|videos?)\b/gi, "").replace(/^about\s+/i, "").trim() || query;
  }

  if (mode === "news") {
    query = query.replace(/\bnews\b/gi, "").replace(/^about\s+/i, "").trim() || query;
  }

  query = query.replace(/^about\s+/i, "").trim();
  if (!query || query.length < 2) {
    return null;
  }

  return {
    mode,
    query,
    strategy: explicitSearchVerb ? "explicit_search" : "auto_grounding",
  };
};

const toSearchToolPayload = (searchResult, strategy = "direct") => {
  const items = Array.isArray(searchResult?.items)
    ? searchResult.items.slice(0, 8).map((item) => ({
        title: String(item?.title || "").trim(),
        snippet: String(item?.snippet || "").trim(),
        link: String(item?.link || "").trim(),
        source: String(item?.source || "").trim(),
        image_url: String(item?.image_url || "").trim(),
        published_at: String(item?.published_at || "").trim(),
      }))
    : [];

  const sources = Array.isArray(searchResult?.links)
    ? searchResult.links.filter((value) => /^https?:\/\//i.test(String(value || "").trim()))
    : [];

  const searchedAt = new Date().toISOString();

  return {
    search: {
      mode: String(searchResult?.mode || "text").trim(),
      query: String(searchResult?.query || "").trim(),
      endpoint: String(searchResult?.endpoint || "").trim(),
      result_count: sources.length,
      strategy,
      searched_at: searchedAt,
      web_searched: true,
      two_pass_search: false,
      sources,
      items,
    },
  };
};

const formatDueAt = (date) => {
  if (!date) {
    return "no due date";
  }

  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) {
    return "no due date";
  }

  return parsed.toISOString().replace("T", " ").slice(0, 16);
};

export const runAgentTools = async ({
  userUuid,
  latestUserMessage,
  contacts,
  sendMessageToContact,
  beforeWebSearch,
}) => {
  const text = String(latestUserMessage || "").trim();
  if (!text) {
    return { handled: false };
  }

  const contactIntent = detectContactIntent(text, contacts);
  if (contactIntent?.type === "missing-contact") {
    return {
      handled: true,
      reply: `I could not find @${contactIntent.username}. Use a valid username from your contacts.`,
      toolsUsed: ["contact_intent_classifier"],
    };
  }

  if (contactIntent?.type === "missing-body") {
    return {
      handled: true,
      reply: `I found @${contactIntent.target.username}. What message should I send?`,
      toolsUsed: ["contact_intent_classifier"],
    };
  }

  if (contactIntent?.type === "send") {
    await sendMessageToContact(contactIntent.target.uuid, contactIntent.messageBody);
    return {
      handled: true,
      reply: `Sent to ${contactIntent.target.displayName}.`,
      toolsUsed: ["contact_intent_classifier", "send_message"],
      payload: {
        sent_to_uuid: contactIntent.target.uuid,
        sent_to_username: contactIntent.target.username,
      },
    };
  }

  const taskCreate = parseTaskCreateIntent(text);
  if (taskCreate) {
    const created = await AiTask.create({
      userUuid,
      title: taskCreate.title,
      dueAt: taskCreate.dueAt || null,
      source: TOOL_SOURCE,
      status: "pending",
    });
    return {
      handled: true,
      reply: `${taskCreate.kind === "reminder" ? "Reminder" : "Task"} saved: "${created.title}" (${formatDueAt(
        created.dueAt,
      )}).`,
      toolsUsed: ["task_queue", "reminders"],
      payload: {
        task_id: String(created._id),
      },
    };
  }

  const completeIndex = parseTaskCompleteIntent(text);
  if (completeIndex) {
    const tasks = await AiTask.find({ userUuid, status: "pending" }).sort({ createdAt: 1 }).limit(50);
    const target = tasks[completeIndex - 1];
    if (!target) {
      return {
        handled: true,
        reply: `I could not find pending task #${completeIndex}. Ask me to list tasks first.`,
        toolsUsed: ["task_queue"],
      };
    }

    target.status = "done";
    await target.save();
    return {
      handled: true,
      reply: `Done. Marked "${target.title}" as completed.`,
      toolsUsed: ["task_queue"],
      payload: {
        task_id: String(target._id),
      },
    };
  }

  if (parseTaskListIntent(text)) {
    const tasks = await AiTask.find({ userUuid, status: "pending" }).sort({ dueAt: 1, createdAt: 1 }).limit(8);
    if (tasks.length === 0) {
      return {
        handled: true,
        reply: "You have no pending tasks or reminders.",
        toolsUsed: ["task_queue"],
      };
    }

    const lines = ["Pending tasks:"];
    tasks.forEach((task, index) => {
      lines.push(`${index + 1}. ${task.title} (${formatDueAt(task.dueAt)})`);
    });
    lines.push('To complete one, say: "complete task <number>".');
    return {
      handled: true,
      reply: lines.join("\n"),
      toolsUsed: ["task_queue"],
    };
  }

  const memoryStore = parseMemoryStoreIntent(text);
  if (memoryStore) {
    await AiMemory.findOneAndUpdate(
      { userUuid, key: memoryStore.key },
      {
        $set: {
          value: memoryStore.value,
          confidence: 0.85,
          source: TOOL_SOURCE,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return {
      handled: true,
      reply: `Saved memory: ${memoryStore.key}.`,
      toolsUsed: ["memory_store"],
      payload: {
        memory_key: memoryStore.key,
      },
    };
  }

  const memoryRecallKey = parseMemoryRecallIntent(text);
  if (memoryRecallKey) {
    const memory = await AiMemory.findOne({ userUuid, key: memoryRecallKey });
    if (!memory) {
      return {
        handled: true,
        reply: `I do not have saved memory for "${memoryRecallKey}".`,
        toolsUsed: ["memory_recall"],
      };
    }

    return {
      handled: true,
      reply: `Memory for "${memoryRecallKey}": ${memory.value}`,
      toolsUsed: ["memory_recall"],
      payload: {
        memory_key: memoryRecallKey,
      },
    };
  }

  const webQuery = parseWebSearchIntent(text);
  if (webQuery) {
    if (typeof beforeWebSearch === "function") {
      await beforeWebSearch({ mode: inferSearchModeFromText(text), query: webQuery, strategy: "slash_command" });
    }
    const searchMode = inferSearchModeFromText(text);
    const searchResult = await executeSerperSearch({
      mode: searchMode,
      query: webQuery,
    });
    return {
      handled: true,
      reply: searchResult.summary,
      toolsUsed: ["web_retrieval"],
      payload: toSearchToolPayload(searchResult, "slash_command"),
    };
  }

  const naturalSearch = parseNaturalSearchIntent(text);
  if (naturalSearch) {
    if (typeof beforeWebSearch === "function") {
      await beforeWebSearch(naturalSearch);
    }
    const searchResult = await executeSerperSearch({
      mode: naturalSearch.mode,
      query: naturalSearch.query,
    });
    return {
      handled: true,
      reply: searchResult.summary,
      toolsUsed: ["web_retrieval", "search_intent_classifier"],
      payload: toSearchToolPayload(searchResult, naturalSearch.strategy),
    };
  }

  return { handled: false };
};
