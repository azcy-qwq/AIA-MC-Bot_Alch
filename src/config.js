const number = (value, fallback, min = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback;
};

export function loadConfig(env = process.env) {
  return {
    api: {
      baseUrl: env.MC_API_BASE_URL || "http://127.0.0.1:18900/api/v1",
      username: env.MC_USERNAME || "",
      password: env.MC_PASSWORD || ""
    },
    llm: {
      baseUrl: env.LLM_BASE_URL || "",
      apiKey: env.LLM_API_KEY || "",
      model: env.LLM_MODEL || "",
      timeoutMs: number(env.LLM_TIMEOUT_MS, 60000, 1000),
      conversationFile: env.LLM_CONVERSATION_FILE || "data/llm-conversations.json",
      conversationMaxTurns: number(env.LLM_CONVERSATION_MAX_TURNS, 6, 1),
      conversationMaxChars: number(env.LLM_CONVERSATION_MAX_CHARS, 90000, 10000)
    },
    sessionBudget: {
      sessionFile: env.LLM_SESSION_FILE || "data/debug-session.json",
      ledgerFile: env.LLM_LEDGER_FILE || "data/llm-session-budget.json"
    },
    intervals: {
      strategyMs: number(env.DISTRIBUTION_INTERVAL_MS || env.STRATEGY_INTERVAL_MS, 10000, 3000),
      strategyMinReplanMs: number(env.DISTRIBUTION_MIN_REPLAN_MS || env.STRATEGY_MIN_REPLAN_MS, 5000, 3000),
      strategyPrethinkMs: number(env.DISTRIBUTION_PRETHINK_INTERVAL_MS || env.STRATEGY_PRETHINK_INTERVAL_MS, 5000, 3000),
      strategicMs: number(env.STRATEGIC_INTERVAL_MS, 240000, 30000),
      strategicMinReplanMs: number(env.STRATEGIC_MIN_REPLAN_MS, 240000, 30000),
      reflectionMs: number(env.REFLECTION_INTERVAL_MS, 180000, 10000),
      reflectionMinMs: number(env.REFLECTION_MIN_INTERVAL_MS, 90000, 10000),
      reflectionDebounceMs: number(env.REFLECTION_DEBOUNCE_MS, 18000, 1000),
      actionRetryDelayMs: number(env.ACTION_RETRY_DELAY_MS, 100, 0),
      observationMs: number(env.OBSERVATION_INTERVAL_MS, 1000, 100),
      tacMs: number(env.TAC_INTERVAL_MS, 250, 50)
    },
    debug: {
      enabled: env.DEBUG_UI !== "0",
      host: env.DEBUG_UI_HOST || "127.0.0.1",
      port: number(env.DEBUG_UI_PORT, 4173, 0)
    },
    routes: {
      filePath: env.ROUTE_MEMORY_FILE || "data/routes.json"
    },
    memory: {
      filePath: env.STRATEGY_MEMORY_FILE || "data/strategy-memory.json"
    },
    memoryArchive: {
      filePath: env.MEMORY_ARCHIVE_FILE || "data/memory-archive.json"
    },
    distributionState: {
      filePath: env.DISTRIBUTION_STATE_FILE || "data/distribution-state.json"
    },
    runtimeState: {
      filePath: env.RUNTIME_STATE_FILE || "data/runtime-state.json"
    },
    native: {
      stateFile: env.NATIVE_STATE_FILE || "data/native-state.json"
    },
    timing: {
      filePath: env.TASK_TIMING_MODEL_FILE || "data/task-timing-model.json",
      journalPath: env.TASK_TIMING_SAMPLES_FILE || "data/task-timing-samples.jsonl"
    }
  };
}

export function assertCredentials(config) {
  if (!config.api.username || !config.api.password) {
    throw new Error("MC_USERNAME and MC_PASSWORD are required to connect the runtime");
  }
}
