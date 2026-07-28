export type ProxyMode = "none" | "system" | "custom"

export interface CustomProxyConfig {
  url: string
  bypassList?: string[]
  username?: string
  password?: string
}

export interface ProxyConfig {
  mode: ProxyMode
  custom?: CustomProxyConfig | null
}

export type ResolvedProxy = {
  http?: string
  https?: string
  all?: string
  noProxy: string[]
}

export type SessionProxyOptions = {
  mode: "direct" | "system" | "custom"
  proxyRules?: string
  proxyBypassRules?: string
}

export const DEFAULT_LOOPBACK_BYPASS = ["127.0.0.1", "localhost", "::1"]
export const DEFAULT_CONFIG: ProxyConfig = { mode: "system", custom: null }

const ACCEPTED_PROTOCOLS = ["http", "https", "socks5", "socks4", "socks"]

export type ProxyConfigStore = {
  mode?: ProxyMode
  custom?: CustomProxyConfig | null
}

export function normalizeConfig(stored: ProxyConfigStore | null | undefined): ProxyConfig {
  if (!stored) return { ...DEFAULT_CONFIG }
  const mode: ProxyMode = stored.mode === "none" || stored.mode === "custom" ? stored.mode : "system"
  const custom = stored.custom ?? null
  if (mode !== "custom") return { mode, custom: null }
  return { mode, custom: custom ? { ...custom } : null }
}

export function isProxyConfigEqual(a: ProxyConfig, b: ProxyConfig): boolean {
  if (a.mode !== b.mode) return false
  if (a.mode !== "custom") return true
  const ca = a.custom
  const cb = b.custom
  if (!ca && !cb) return true
  if (!ca || !cb) return false
  return (
    ca.url === cb.url &&
    (ca.username ?? "") === (cb.username ?? "") &&
    (ca.password ?? "") === (cb.password ?? "") &&
    JSON.stringify(sortList(ca.bypassList)) === JSON.stringify(sortList(cb.bypassList))
  )
}

function sortList(list?: string[]): string[] {
  return [...(list ?? [])].filter((v) => Boolean(v?.trim())).sort()
}

export function isValidProxyUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    const protocol = parsed.protocol.replace(/:$/, "").toLowerCase()
    return ACCEPTED_PROTOCOLS.includes(protocol)
  } catch {
    return false
  }
}

export function mergeBypassList(userList?: string[]): string[] {
  const merged = new Set<string>(DEFAULT_LOOPBACK_BYPASS)
  for (const item of userList ?? []) {
    const trimmed = item?.trim()
    if (trimmed) merged.add(trimmed)
  }
  return [...merged]
}

function parseProxyUrl(url: string): { protocol: string; host: string; port: string } | null {
  try {
    const parsed = new URL(url)
    return { protocol: parsed.protocol.replace(/:$/, ""), host: parsed.hostname, port: parsed.port }
  } catch {
    return null
  }
}

export function resolveEnvProxy(config: ProxyConfig): ResolvedProxy {
  const noProxy = mergeBypassList(config.custom?.bypassList)
  if (config.mode === "none") return { noProxy }
  if (config.mode === "custom") {
    const custom = config.custom
    if (!custom?.url || !isValidProxyUrl(custom.url)) return { noProxy }
    const parsed = parseProxyUrl(custom.url)
    if (!parsed) return { noProxy }
    const auth =
      custom.username || custom.password
        ? `${encodeURIComponent(custom.username ?? "")}:${encodeURIComponent(custom.password ?? "")}@`
        : ""
    const credentials = `${auth}${parsed.host}${parsed.port ? ":" + parsed.port : ""}`
    const fullUrl = `${parsed.protocol}://${credentials}`
    if (parsed.protocol === "http") return { http: fullUrl, https: fullUrl, noProxy }
    if (parsed.protocol === "https") return { https: fullUrl, noProxy }
    return { all: fullUrl, noProxy }
  }
  return { noProxy }
}

export async function buildSessionProxyOptions(
  config: ProxyConfig,
  systemResolver: () => Promise<SessionProxyOptions> = async () => ({ mode: "system" }),
): Promise<SessionProxyOptions> {
  if (config.mode === "none") return { mode: "direct" }
  if (config.mode === "system") return systemResolver()
  const resolved = resolveEnvProxy(config)
  const rules = resolved.all ?? resolved.https ?? resolved.http
  if (!rules) return { mode: "direct" }
  return {
    mode: "custom",
    proxyRules: rules,
    proxyBypassRules: mergeBypassList(config.custom?.bypassList).join(","),
  }
}

export function buildEnvVars(resolved: ResolvedProxy): Record<string, string | undefined> {
  const vars: Record<string, string | undefined> = {
    HTTP_PROXY: resolved.http,
    http_proxy: resolved.http,
    HTTPS_PROXY: resolved.https,
    https_proxy: resolved.https,
    ALL_PROXY: resolved.all,
    all_proxy: resolved.all,
  }
  const noProxy = mergeBypassList(resolved.noProxy)
  vars.NO_PROXY = noProxy.join(",")
  vars.no_proxy = noProxy.join(",")
  return vars
}
