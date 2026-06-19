import { DEFAULT_CONFIG, STORAGE_KEYS } from "./constants.js";

function safeJsonParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function createId() {
  return `cfg_${Math.random().toString(36).slice(2, 10)}`;
}

function readLegacyToken(storage = localStorage) {
  return storage.getItem("penguin-alarm.github-token") || "";
}

export function readProviderTokens(storage = localStorage) {
  const tokens = safeJsonParse(storage.getItem(STORAGE_KEYS.providerTokens), {});
  const legacyToken = readLegacyToken(storage);
  if (legacyToken && !tokens.github) {
    return { ...tokens, github: legacyToken };
  }

  return tokens;
}

function buildScopedTokenKey(provider, configId) {
  return `${provider}::${configId}`;
}

export function readToken(provider = "github", configId = "", storage = localStorage) {
  const tokens = readProviderTokens(storage);
  const normalizedConfigId = String(configId || "").trim();
  if (normalizedConfigId) {
    const scopedKey = buildScopedTokenKey(provider, normalizedConfigId);
    return tokens[scopedKey] || tokens[provider] || "";
  }

  return tokens[provider] || "";
}

export function writeToken(provider, token, configId = "", storage = localStorage) {
  const tokens = readProviderTokens(storage);
  const value = String(token || "").trim();
  const normalizedConfigId = String(configId || "").trim();
  const tokenKey = normalizedConfigId ? buildScopedTokenKey(provider, normalizedConfigId) : provider;

  if (value) {
    tokens[tokenKey] = value;
  } else {
    delete tokens[tokenKey];
  }

  storage.setItem(STORAGE_KEYS.providerTokens, JSON.stringify(tokens));
}

export function clearToken(provider, configId = "", storage = localStorage) {
  const tokens = readProviderTokens(storage);
  const normalizedConfigId = String(configId || "").trim();
  const tokenKey = normalizedConfigId ? buildScopedTokenKey(provider, normalizedConfigId) : provider;
  delete tokens[tokenKey];
  storage.setItem(STORAGE_KEYS.providerTokens, JSON.stringify(tokens));
}

export function readConfigs(storage = localStorage) {
  const configs = safeJsonParse(storage.getItem(STORAGE_KEYS.configs), []);
  return Array.isArray(configs) ? configs : [];
}

export function writeConfigs(configs, storage = localStorage) {
  storage.setItem(STORAGE_KEYS.configs, JSON.stringify(configs));
}

export function normalizeConfig(config) {
  const repos = String(config.repos || "")
    .split(/\r?\n|,/)
    .map((repo) => repo.trim())
    .filter(Boolean);

  const normalizeStringList = (value) => (
    Array.isArray(value)
      ? value.map((item) => String(item || "").trim()).filter(Boolean)
      : String(value || "")
          .split(/\r?\n|,/)
          .map((item) => item.trim())
          .filter(Boolean)
  );

  const teamMembers = normalizeStringList(config.teamMembers);
  const botUsers = normalizeStringList(config.botUsers);

  const repoGroups = String(config.repoGroups || "")
    .split(/\r?\n|,/)
    .map((group) => group.trim())
    .filter(Boolean);

  return {
    ...DEFAULT_CONFIG,
    ...config,
    id: config.id || createId(),
    name: (config.name || DEFAULT_CONFIG.name).trim(),
    provider: String(config.provider || DEFAULT_CONFIG.provider),
    repos,
    teamMembers,
    botUsers,
    repoGroups,
    youtubeLivestreamUrl: String(config.youtubeLivestreamUrl || "").trim(),
    timeWindowDays: Math.max(1, Number(config.timeWindowDays) || DEFAULT_CONFIG.timeWindowDays),
    pollingMinutes: Math.max(1, Number(config.pollingMinutes) || DEFAULT_CONFIG.pollingMinutes)
  };
}

export function upsertConfig(inputConfig, storage = localStorage) {
  const config = normalizeConfig(inputConfig);
  const configs = readConfigs(storage);
  const nextConfigs = configs.some((item) => item.id === config.id)
    ? configs.map((item) => (item.id === config.id ? config : item))
    : [config, ...configs];

  writeConfigs(nextConfigs, storage);
  writeSelectedConfigId(config.id, storage);
  return config;
}

export function deleteConfig(configId, storage = localStorage) {
  const nextConfigs = readConfigs(storage).filter((config) => config.id !== configId);
  writeConfigs(nextConfigs, storage);

  const selectedId = readSelectedConfigId(storage);
  if (selectedId === configId) {
    writeSelectedConfigId(nextConfigs[0]?.id || "", storage);
  }
}

export function readSelectedConfigId(storage = localStorage) {
  return storage.getItem(STORAGE_KEYS.selectedConfigId) || "";
}

export function writeSelectedConfigId(configId, storage = localStorage) {
  if (!configId) {
    storage.removeItem(STORAGE_KEYS.selectedConfigId);
    return;
  }

  storage.setItem(STORAGE_KEYS.selectedConfigId, configId);
}

export function getSelectedConfig(storage = localStorage) {
  const configs = readConfigs(storage);
  const selectedId = readSelectedConfigId(storage);
  return configs.find((config) => config.id === selectedId) || configs[0] || null;
}

export function readRatings(storage = localStorage) {
  return safeJsonParse(storage.getItem(STORAGE_KEYS.ratings), {});
}

export function writeRating(prKey, rating, storage = localStorage) {
  const ratings = readRatings(storage);
  ratings[prKey] = rating;
  storage.setItem(STORAGE_KEYS.ratings, JSON.stringify(ratings));
}

export function readPanelOrders(storage = localStorage) {
  const orders = safeJsonParse(storage.getItem(STORAGE_KEYS.panelOrders), {});
  return orders && typeof orders === "object" ? orders : {};
}

export function readPanelOrder(pageKey, defaultOrder, storage = localStorage) {
  const storedOrder = readPanelOrders(storage)[pageKey];
  if (!Array.isArray(storedOrder)) {
    return [...defaultOrder];
  }

  const knownIds = new Set(defaultOrder);
  const normalized = storedOrder.filter((id) => knownIds.has(id));
  const missing = defaultOrder.filter((id) => !normalized.includes(id));
  return [...normalized, ...missing];
}

export function writePanelOrder(pageKey, order, storage = localStorage) {
  const orders = readPanelOrders(storage);
  orders[pageKey] = [...order];
  storage.setItem(STORAGE_KEYS.panelOrders, JSON.stringify(orders));
}

export function exportConfig(config) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(config))));
}

export function importConfig(encodedConfig) {
  const json = decodeURIComponent(escape(atob(encodedConfig)));
  return normalizeConfig(JSON.parse(json));
}
