import { config } from "../../server/config.js";

const SEARCH_MODE_ALIASES = {
  text: "text",
  search: "text",
  web: "text",
  image: "image",
  images: "image",
  img: "image",
  video: "videos",
  videos: "videos",
  vid: "videos",
  place: "places",
  places: "places",
  map: "maps",
  maps: "maps",
  review: "reviews",
  reviews: "reviews",
  news: "news",
  shopping: "shopping",
  shop: "shopping",
  lens: "lens",
  scholar: "scholar",
  patent: "patents",
  patents: "patents",
  autocomplete: "autocomplete",
  suggestion: "autocomplete",
  suggestions: "autocomplete",
  webpage: "webpage",
  page: "webpage",
  scrape: "webpage",
};

const MODE_LABELS = {
  text: "Web search",
  image: "Image search",
  videos: "Video search",
  places: "Places search",
  maps: "Maps search",
  reviews: "Reviews search",
  news: "News search",
  shopping: "Shopping search",
  lens: "Lens search",
  scholar: "Scholar search",
  patents: "Patents search",
  autocomplete: "Autocomplete search",
  webpage: "Webpage scrape",
};

const SERPER_ENDPOINT_BY_MODE = {
  text: "/search",
  image: "/images",
  videos: "/videos",
  places: "/places",
  maps: "/maps",
  reviews: "/reviews",
  news: "/news",
  shopping: "/shopping",
  lens: "/lens",
  scholar: "/scholar",
  patents: "/patents",
  autocomplete: "/autocomplete",
};

const unique = (values) => Array.from(new Set(values.filter(Boolean)));

const clip = (value, max = 220) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max - 1).trimEnd()}...`;
};

const stripDelimiters = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  let next = raw;
  if (next.startsWith("{") && next.endsWith("}")) {
    next = next.slice(1, -1).trim();
  }
  if ((next.startsWith('"') && next.endsWith('"')) || (next.startsWith("'") && next.endsWith("'"))) {
    next = next.slice(1, -1).trim();
  }
  return next.trim();
};

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || "").trim());

const normalizeMode = (mode) => {
  const key = String(mode || "").trim().toLowerCase();
  return SEARCH_MODE_ALIASES[key] || "text";
};

const normalizeQuery = (query) => stripDelimiters(query);

const formatModeLabel = (mode) => MODE_LABELS[mode] || `${mode} search`;

const createTimedSignal = (timeoutMs) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
};

const callSerper = async (url, body) => {
  if (!config.searchApiKey) {
    throw new Error("SEARCH_API_KEY is not configured");
  }

  const { signal, clear } = createTimedSignal(config.searchTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal,
      headers: {
        "X-API-KEY": config.searchApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const rawText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const errorMessage =
        (payload && (payload.message || payload.error)) ||
        rawText.replace(/\s+/g, " ").slice(0, 240) ||
        `Serper request failed (${response.status})`;
      throw new Error(String(errorMessage));
    }

    if (!payload || typeof payload !== "object") {
      throw new Error("Serper returned invalid JSON payload");
    }

    return payload;
  } finally {
    clear();
  }
};

const normalizeTimestamp = (value) => {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return clip(raw, 32);
  }
  return new Date(parsed).toISOString().slice(0, 10);
};

const itemToSummary = (item, mode) => {
  if (typeof item === "string") {
    return {
      title: item,
      snippet: "",
      link: "",
      source: "",
      imageUrl: "",
      publishedAt: "",
    };
  }

  if (!item || typeof item !== "object") {
    return {
      title: "",
      snippet: "",
      link: "",
      source: "",
      imageUrl: "",
      publishedAt: "",
    };
  }

  const entry = item;
  const title = clip(
    String(
      entry.title ||
        entry.query ||
        entry.keyword ||
        entry.name ||
        entry.channel ||
        entry.source ||
        "",
    ).trim(),
    180,
  );
  const snippet = clip(
    String(
      entry.snippet ||
        entry.description ||
        entry.body ||
        entry.content ||
        entry.answer ||
        entry.summary ||
        "",
    ).trim(),
    360,
  );
  const link = String(
    entry.link ||
      entry.url ||
      entry.sourceUrl ||
      entry.webSearchUrl ||
      "",
  ).trim();
  const source = clip(
    String(
      entry.source ||
        entry.site ||
        entry.domain ||
        entry.channel ||
        entry.publisher ||
        "",
    ).trim(),
    80,
  );
  const imageUrl = String(
    entry.imageUrl ||
      entry.thumbnailUrl ||
      entry.image ||
      entry.thumbnail ||
      "",
  ).trim();
  const publishedAt = normalizeTimestamp(
    entry.date || entry.publishedDate || entry.published_at || entry.datePublished || "",
  );

  if (mode === "autocomplete" && !title) {
    return {
      title: clip(String(entry.value || "").trim(), 180),
      snippet: "",
      link,
      source,
      imageUrl,
      publishedAt,
    };
  }

  return {
    title,
    snippet,
    link,
    source,
    imageUrl,
    publishedAt,
  };
};

const getPrimaryItems = (mode, payload) => {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const byMode = {
    text: payload.organic,
    image: payload.images,
    videos: payload.videos,
    places: payload.places,
    maps: payload.places,
    reviews: payload.reviews,
    news: payload.news,
    shopping: payload.shopping,
    lens: payload.organic || payload.images,
    scholar: payload.organic,
    patents: payload.organic,
    autocomplete: payload.suggestions,
  };

  const modeItems = byMode[mode];
  if (Array.isArray(modeItems)) {
    return modeItems;
  }

  const fallbackArrays = [
    payload.organic,
    payload.news,
    payload.images,
    payload.videos,
    payload.shopping,
    payload.places,
  ];
  return fallbackArrays.find(Array.isArray) || [];
};

const extractStructuredItems = (mode, payload) =>
  getPrimaryItems(mode, payload)
    .slice(0, 8)
    .map((item) => {
      const normalized = itemToSummary(item, mode);
      return {
        title: normalized.title || "",
        snippet: normalized.snippet || "",
        link: normalized.link || "",
        source: normalized.source || "",
        image_url: normalized.imageUrl || "",
        published_at: normalized.publishedAt || "",
      };
    })
    .filter(
      (item) =>
        item.title || item.snippet || item.link || item.image_url,
    );

const formatWebpageSummary = ({ query, payload }) => {
  const text = String(payload?.text || "").trim();
  const sourceUrl = String(payload?.metadata?.url || payload?.metadata?.source || "").trim();
  if (!text) {
    return `No webpage content extracted for "${query}".`;
  }

  const clipped = clip(text, 1800);
  const lines = [
    "### Webpage Extract",
    `**Query:** \`${query}\``,
  ];
  if (sourceUrl) {
    lines.push(`**Source:** ${sourceUrl}`);
  }
  lines.push("");
  lines.push(clipped);
  return lines.join("\n");
};

const formatSearchSummary = ({ mode, query, items, payload }) => {
  if (!items || items.length === 0) {
    return `No strong ${mode} results found for "${query}".`;
  }

  const lines = [
    `### ${formatModeLabel(mode)}`,
    `**Query:** \`${query}\``,
    "",
  ];

  items.slice(0, 6).forEach((item, index) => {
    const title = item.title || `Result ${index + 1}`;
    const primaryLink = item.link || item.image_url || "";
    lines.push(
      primaryLink
        ? `${index + 1}. [${title}](${primaryLink})`
        : `${index + 1}. ${title}`,
    );

    const metaParts = [
      item.source ? `source: ${item.source}` : "",
      item.published_at ? `date: ${item.published_at}` : "",
    ].filter(Boolean);
    if (metaParts.length > 0) {
      lines.push(`   - ${metaParts.join(" | ")}`);
    }

    if (item.snippet) {
      lines.push(`   - ${item.snippet}`);
    }

    if (mode === "image" && item.image_url && item.image_url !== primaryLink) {
      lines.push(`   - image: ${item.image_url}`);
    }
  });

  const directAnswer = clip(
    String(payload?.answerBox?.answer || payload?.answerBox?.snippet || "").trim(),
    220,
  );
  if (directAnswer) {
    lines.push("");
    lines.push(`**Quick answer:** ${directAnswer}`);
  }

  return lines.join("\n");
};

const formatSerperSummary = ({ mode, query, payload, items }) => {
  if (mode === "webpage") {
    return formatWebpageSummary({ query, payload });
  }
  return formatSearchSummary({ mode, query, items, payload });
};

const extractLinks = (mode, payload, items) => {
  if (mode === "webpage") {
    const source = String(payload?.metadata?.url || payload?.metadata?.source || "").trim();
    return source ? [source] : [];
  }

  const structuredLinks = Array.isArray(items)
    ? items
        .flatMap((item) => [item.link, item.image_url])
        .filter((value) => /^https?:\/\//i.test(String(value || "").trim()))
    : [];

  const rawLinks = getPrimaryItems(mode, payload)
    .flatMap((item) => [
      String(item?.link || item?.url || "").trim(),
      String(item?.imageUrl || item?.thumbnailUrl || "").trim(),
    ])
    .filter((value) => /^https?:\/\//i.test(value));

  return unique([...structuredLinks, ...rawLinks]).slice(0, 12);
};

const parseReviewQuery = (query) => {
  const raw = String(query || "").trim();
  const match = raw.match(/\b(fid|cid|placeid)\s*[:=]\s*([a-z0-9:_-]+)/i);
  if (!match) {
    return null;
  }

  const field = match[1].toLowerCase();
  const value = match[2].trim();
  if (!value) {
    return null;
  }

  if (field === "placeid") {
    return { placeId: value };
  }
  if (field === "cid") {
    return { cid: value };
  }
  return { fid: value };
};

export const executeSerperSearch = async ({ mode, query }) => {
  const normalizedMode = normalizeMode(mode);
  const normalizedQuery = normalizeQuery(query);

  if (!normalizedQuery) {
    throw new Error("Search query is empty");
  }

  if (normalizedMode === "webpage") {
    if (!isHttpUrl(normalizedQuery)) {
      throw new Error("Webpage mode requires a full URL (http/https)");
    }
    const payload = await callSerper(config.scrapeBaseUrl, { url: normalizedQuery });
    const items = [];
    return {
      mode: normalizedMode,
      query: normalizedQuery,
      endpoint: config.scrapeBaseUrl,
      payload,
      items,
      summary: formatSerperSummary({
        mode: normalizedMode,
        query: normalizedQuery,
        payload,
        items,
      }),
      links: extractLinks(normalizedMode, payload, items),
    };
  }

  const endpointPath = SERPER_ENDPOINT_BY_MODE[normalizedMode] || "/search";
  const endpoint = `${String(config.searchBaseUrl || "").replace(/\/+$/, "")}${endpointPath}`;

  let body = { q: normalizedQuery };
  if (normalizedMode === "reviews") {
    const reviewBody = parseReviewQuery(normalizedQuery);
    if (!reviewBody) {
      throw new Error('Reviews mode requires one of: "fid:<id>", "cid:<id>", or "placeId:<id>"');
    }
    body = reviewBody;
  } else if (normalizedMode === "lens") {
    body = isHttpUrl(normalizedQuery) ? { url: normalizedQuery } : { q: normalizedQuery };
  }

  const payload = await callSerper(endpoint, body);
  const items = extractStructuredItems(normalizedMode, payload);

  return {
    mode: normalizedMode,
    query: normalizedQuery,
    endpoint,
    payload,
    items,
    summary: formatSerperSummary({
      mode: normalizedMode,
      query: normalizedQuery,
      payload,
      items,
    }),
    links: extractLinks(normalizedMode, payload, items),
  };
};
