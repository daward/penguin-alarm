export const STORAGE_KEYS = {
  providerTokens: "penguin-alarm.provider-tokens",
  configs: "penguin-alarm.configs",
  selectedConfigId: "penguin-alarm.selected-config-id",
  ratings: "penguin-alarm.merge-ratings",
  panelOrders: "penguin-alarm.panel-orders"
};

export const DEFAULT_CONFIG = {
  id: "",
  name: "My Review Set",
  provider: "github",
  repos: [],
  teamMembers: [],
  botUsers: [],
  repoGroups: [],
  youtubeLivestreamUrl: "",
  timeWindowDays: 14,
  queueFilter: "all",
  pollingMinutes: 5
};

export const DEFAULT_APP_STATE = {
  isLoading: false,
  lastUpdatedAt: "",
  error: "",
  rateLimit: null,
  profile: null,
  queueItems: [],
  mergedItems: [],
  stats: null,
  leaderboard: [],
  repos: []
};

export const PROVIDERS = [
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
  { value: "bitbucket", label: "Bitbucket" }
];

export const QUEUE_FILTERS = [
  { value: "all", label: "All open PRs" },
  { value: "requested", label: "Requested for me" },
  { value: "participating", label: "Mentioned or commented" }
];
