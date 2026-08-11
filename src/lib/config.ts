/**
 * 集中式配置：环境变量解析 + 模型路由。
 * 设计原则：任何外部依赖缺失都能优雅回退到 mock，保证"开箱即跑"。
 */

export type ModelKey = "opus" | "sonnet" | "glm" | "glm5v" | "kimiK3" | "deepseek" | "deepseekPro";

/** 管线中需要用到模型的环节 */
export type RouteStage = "clarify" | "structure" | "generate" | "editSmall" | "editLarge";

function env(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function envList(name: string): string[] {
  return env(name)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const forceMock = env("YOUDESIGN_FORCE_MOCK", "true").toLowerCase() === "true";

export const config = {
  forceMock,

  /** 本地运行时数据目录（users.json、prices.json、stage-timing.jsonl）。 */
  data: {
    dir: env("YOUDESIGN_DATA_DIR", "data"),
  },

  /** MySQL 用量明细库；密码只允许通过服务端环境变量注入。 */
  mysql: {
    host: env("YOUDESIGN_MYSQL_HOST"),
    port: Number(env("YOUDESIGN_MYSQL_PORT", "3306")) || 3306,
    database: env("YOUDESIGN_MYSQL_DATABASE", "youdesign"),
    user: env("YOUDESIGN_MYSQL_USER"),
    password: env("YOUDESIGN_MYSQL_PASSWORD"),
    connectionLimit: Number(env("YOUDESIGN_MYSQL_CONNECTION_LIMIT", "5")) || 5,
    connectTimeoutMs: Number(env("YOUDESIGN_MYSQL_CONNECT_TIMEOUT_MS", "5000")) || 5000,
  },

  /** 登录/会话：secret 签名 cookie；sharedPassword 为无用户表时的单口令回退；sessionTtlSec 会话有效期 */
  auth: {
    mode: (env("YOUDESIGN_AUTH_MODE", "auto") as "auto" | "shared" | "users"),
    secret: env("YOUDESIGN_AUTH_SECRET"),
    sharedPassword: env("YOUDESIGN_ACCESS_PASSWORD"),
    sessionTtlSec: Number(env("YOUDESIGN_SESSION_TTL_SEC", "604800")) || 604800, // 7 天
  },

  /** 费用折算：Anthropic 官价 USD，按 fxRate 折 CNY；DeepSeek/智谱为 CNY 直价 */
  billing: {
    fxRate: Number(env("YOUDESIGN_FX_RATE", "7.2")) || 7.2,
  },

  anthropic: {
    apiKey: env("ANTHROPIC_API_KEY"),
    baseUrl: env("ANTHROPIC_BASE_URL", "https://api.anthropic.com"),
    models: {
      opus: env("ANTHROPIC_MODEL_OPUS", "claude-opus-5"),
      sonnet: env("ANTHROPIC_MODEL_SONNET", "claude-sonnet-5"),
    },
  },

  /** GLM：智谱官方 OpenAI-compatible 端点 */
  glm: {
    apiKey: env("GLM_API_KEY"),
    baseUrl: env("GLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"),
    model: env("GLM_MODEL", "glm-5.2"),
  },

  /** GLM-5V：智谱视觉模型，上传图片生成原型时可选 */
  glm5v: {
    apiKey: env("GLM5V_API_KEY", env("GLM_API_KEY", env("ZHIPU_API_KEY"))),
    baseUrl: env("GLM5V_BASE_URL", env("GLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4")),
    model: env("GLM5V_MODEL", "glm-5v-turbo"),
    maxOutputTokens: Number(env("GLM5V_MAX_OUTPUT_TOKENS", "128000")) || 128000,
  },

  /** Kimi K3：火山方舟 Agent Plan（Anthropic 兼容端点 /v1/messages + Bearer），支持文本与图片 */
  kimiK3: {
    apiKey: env("KIMI_API_KEY", env("MOONSHOT_API_KEY")),
    baseUrl: env("KIMI_BASE_URL", "https://ark.cn-beijing.volces.com/api/plan"),
    model: env("KIMI_K3_MODEL", "kimi-k3"),
    maxOutputTokens: Number(env("KIMI_K3_MAX_OUTPUT_TOKENS", "128000")) || 128000,
  },

  /** 智谱 OpenAI 风格端点：仅用于 embedding（中转站不提供 embedding）。无 key 时 RAG 走本地词法兜底 */
  zhipu: {
    apiKey: env("ZHIPU_API_KEY"),
    baseUrl: env("ZHIPU_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"),
    model: env("ZHIPU_MODEL", "glm-4.6"),
    embedModel: env("ZHIPU_EMBED_MODEL", "embedding-3"),
  },

  /** 组件检索 RAG 配置 */
  rag: {
    /** 召回候选数 */
    topK: Number(env("RAG_TOP_K", "15")) || 15,
    /** augment=候选作为"优先参考"叠加在全量目录上；restrict=只给候选（目录大时用） */
    mode: (env("RAG_MODE", "augment") as "augment" | "restrict"),
  },

  /** 生成后轻量自评审：flash 检查是否满足需求，有明显缺漏才定向优化一次。SELF_REVIEW=false 关闭 */
  selfReview: env("SELF_REVIEW", "true").toLowerCase() !== "false",

  deepseek: {
    apiKey: env("DEEPSEEK_API_KEY"),
    baseUrl: env("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    /** flash（deepseek-v4-flash + 关闭 thinking，非推理、快）：澄清/小改/大改用 */
    model: env("DEEPSEEK_MODEL", "deepseek-v4-flash"),
    /** pro（deepseek-v4-pro，推理、慢但质量高）：结构化/生成用 */
    proModel: env("DEEPSEEK_PRO_MODEL", "deepseek-v4-pro"),
    /** 输出 token 上限，请求超限会被夹紧避免 400（实测 v4 可接受到 131072；pro 含推理消耗） */
    maxOutputTokens: Number(env("DEEPSEEK_MAX_OUTPUT_TOKENS", "131072")) || 131072,
  },

  /** 各环节默认走哪个模型，可被 .env 覆盖。生成用 pro 保质量；结构化默认 flash、仅复杂需求升 pro；其余 flash 提速 */
  routes: {
    clarify: (env("ROUTE_CLARIFY", "deepseek") as ModelKey),
    structure: (env("ROUTE_STRUCTURE", "deepseek") as ModelKey),
    generate: (env("ROUTE_GENERATE", "deepseekPro") as ModelKey),
    editSmall: (env("ROUTE_EDIT_SMALL", "deepseek") as ModelKey),
    editLarge: (env("ROUTE_EDIT_LARGE", "deepseek") as ModelKey),
  } satisfies Record<RouteStage, ModelKey>,

  /** 结构化按复杂度分流：复杂需求改用该模型（默认 deepseekPro），简单走 routes.structure(flash) */
  structureComplexModel: env("ROUTE_STRUCTURE_COMPLEX", "deepseekPro") as ModelKey,

  /** 用量明细存储：jsonl（默认，append 写 ${data.dir}/${usage.file}）或 mysql（需 YOUDESIGN_MYSQL_*） */
  usage: {
    store: (env("YOUDESIGN_USAGE_STORE", "jsonl") as "jsonl" | "mysql"),
    file: env("YOUDESIGN_USAGE_FILE", "usage.jsonl"),
  },
};

/** 该 model key 是否具备真实调用所需的密钥 */
export function modelHasCredentials(key: ModelKey): boolean {
  switch (key) {
    case "opus":
    case "sonnet":
      return Boolean(config.anthropic.apiKey);
    case "glm":
      return Boolean(config.glm.apiKey);
    case "glm5v":
      return Boolean(config.glm5v.apiKey);
    case "kimiK3":
      return Boolean(config.kimiK3.apiKey);
    case "deepseek":
    case "deepseekPro":
      return Boolean(config.deepseek.apiKey);
  }
}
