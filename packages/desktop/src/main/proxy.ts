import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { safeStorage, session } from "electron"
import { getStore } from "./store"
import { PROXY_CONFIG_KEY } from "./store-keys"
import {
  buildEnvVars,
  buildSessionProxyOptions as buildSessionProxyOptionsBase,
  DEFAULT_CONFIG,
  type ProxyConfig,
  type ProxyConfigStore,
  type ResolvedProxy,
  type SessionProxyOptions,
  mergeBypassList,
  normalizeConfig,
  resolveEnvProxy,
} from "./proxy-util"

const execFileAsync = promisify(execFile)

export type {
  CustomProxyConfig,
  ProxyConfig,
  ProxyMode,
  ResolvedProxy,
  SessionProxyOptions,
} from "./proxy-util"

const PROXY_ENV_KEYS = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]

export function getProxyConfig(): ProxyConfig {
  try {
    const raw = getStore().get(PROXY_CONFIG_KEY) as unknown
    return normalizeConfig((raw ?? null) as ProxyConfigStore | null)
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function setProxyConfig(config: ProxyConfig): void {
  const normalized = normalizeConfig(config)
  getStore().set(PROXY_CONFIG_KEY, normalized)
}

export async function resolveSystemProxy(): Promise<ResolvedProxy> {
  if (process.platform === "darwin") return readMacosSystemProxy()
  if (process.platform === "win32") return readWindowsSystemProxy()
  return { noProxy: mergeBypassList() }
}

export async function resolveProxyForMode(config: ProxyConfig): Promise<ResolvedProxy> {
  if (config.mode === "system") return resolveSystemProxy()
  return resolveEnvProxy(config)
}

async function readMacosSystemProxy(): Promise<ResolvedProxy> {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/scutil", ["--proxy"])
    const http = extractScutilValue(stdout, "HTTPEnable") === "1" ? buildScutilProxy(stdout, "HTTP") : undefined
    const https = extractScutilValue(stdout, "HTTPSEnable") === "1" ? buildScutilProxy(stdout, "HTTPS") : undefined
    const noProxyRaw = extractScutilArray(stdout, "ExceptionsList")
    return {
      http,
      https: https ?? http,
      noProxy: mergeBypassList(noProxyRaw),
    }
  } catch {
    return { noProxy: mergeBypassList() }
  }
}

function extractScutilValue(stdout: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m").exec(stdout)
  return match?.[1]?.trim()
}

function buildScutilProxy(stdout: string, prefix: string): string | undefined {
  const host = extractScutilValue(stdout, `${prefix}Proxy`)
  const port = extractScutilValue(stdout, `${prefix}Port`)
  if (!host) return undefined
  return `http://${host}${port ? ":" + port : ""}`
}

function extractScutilArray(stdout: string, key: string): string[] {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*([\\s\\S]*?)(?=^\\s*\\w+\\s*:)`, "m").exec(stdout)
  if (!match) return []
  return match[1]
    .split("\n")
    .map((line) => line.replace(/[{}]/g, "").trim())
    .filter(Boolean)
}

async function readWindowsSystemProxy(): Promise<ResolvedProxy> {
  try {
    const enabled = await readWindowsProxyEnabled()
    if (!enabled) return { noProxy: mergeBypassList() }
    const { stdout } = await execFileAsync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v",
      "ProxyServer",
    ])
    const match = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/.exec(stdout)
    if (!match) return { noProxy: mergeBypassList() }
    const server = match[1].trim()
    // Registry stores ProxyServer in two formats:
    //   1. "host:port" — single proxy for all protocols (Windows Settings default)
    //   2. "http=host:port;https=host:port;ftp=host:port;socks=host:port" — per-protocol (Internet Options)
    // Splitting on "=" blindly drops format #1 because value is undefined.
    const entries = server.split(";")
    let http: string | undefined
    let https: string | undefined
    for (const entry of entries) {
      const trimmed = entry.trim()
      if (!trimmed) continue
      const eqIdx = trimmed.indexOf("=")
      const scheme = eqIdx > 0 ? trimmed.slice(0, eqIdx).toLowerCase() : undefined
      const valuePart = (eqIdx > 0 ? trimmed.slice(eqIdx + 1) : trimmed).trim()
      if (!valuePart) continue
      const url = valuePart.includes("://") ? valuePart : `http://${valuePart}`
      if (scheme === "https") https = url
      else if (scheme === "http") http = url
      else if (!http) http = url
    }
    if (http && !https) https = http
    return {
      http,
      https,
      noProxy: mergeBypassList(await readWindowsProxyBypass()),
    }
  } catch (error) {
    console.warn("failed to read windows system proxy", error)
    return { noProxy: mergeBypassList() }
  }
}

async function readWindowsProxyEnabled(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v",
      "ProxyEnable",
    ])
    return /ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)
  } catch (error) {
    console.warn("failed to read windows ProxyEnable", error)
    return false
  }
}

async function readWindowsProxyBypass(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v",
      "ProxyOverride",
    ])
    const match = /ProxyOverride\s+REG_SZ\s+([^\r\n]+)/.exec(stdout)
    if (!match) return []
    return match[1].split(";").map((v) => v.trim()).filter(Boolean)
  } catch (error) {
    console.warn("failed to read windows ProxyOverride", error)
    return []
  }
}

export async function buildSessionProxyOptions(config: ProxyConfig): Promise<SessionProxyOptions> {
  // For system mode, defer to Chromium's native system proxy support. It handles
  // Windows registry formats, PAC, WPAD, and bypass lists correctly; manual parsing
  // stays only for seeding HTTP_PROXY env vars for the sidecar process.
  if (config.mode === "system") return { mode: "system" }
  return buildSessionProxyOptionsBase(config)
}

export function applyProxyToSessionSync(options: SessionProxyOptions): Promise<void> {
  const defaultSession = session?.defaultSession
  if (!defaultSession) return Promise.resolve()
  if (options.mode === "direct") return defaultSession.setProxy({ proxyRules: "direct://" })
  if (options.mode === "system") return defaultSession.setProxy({ mode: "system" })
  return defaultSession.setProxy({
    proxyRules: options.proxyRules,
    proxyBypassRules: options.proxyBypassRules,
  })
}

export function applyProxyToEnv(resolved: ResolvedProxy): void {
  for (const key of PROXY_ENV_KEYS) delete process.env[key]
  const vars = buildEnvVars(resolved)
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) continue
    process.env[key] = value
  }
}

const ENCRYPTION_PREFIX = "enc:"

export function encryptSecret(secret: string): string {
  if (!secret) return ""
  try {
    if (!safeStorage.isEncryptionAvailable()) return secret
    const buffer = safeStorage.encryptString(secret)
    return `${ENCRYPTION_PREFIX}${buffer.toString("base64")}`
  } catch {
    return secret
  }
}

export function decryptSecret(stored: string | undefined): string {
  if (!stored) return ""
  if (!stored.startsWith(ENCRYPTION_PREFIX)) return stored
  try {
    if (!safeStorage.isEncryptionAvailable()) return ""
    const buffer = Buffer.from(stored.slice(ENCRYPTION_PREFIX.length), "base64")
    return safeStorage.decryptString(buffer)
  } catch {
    return ""
  }
}

export async function applyProxyConfig(config: ProxyConfig): Promise<{
  session: SessionProxyOptions
  resolved: ResolvedProxy
}> {
  const resolved = await resolveProxyForMode(config)
  applyProxyToEnv(resolved)
  const sessionOptions = await buildSessionProxyOptions(config)
  await applyProxyToSessionSync(sessionOptions)
  lastResolved = config.mode === "system" ? resolved : undefined
  return { session: sessionOptions, resolved }
}

type ProxyEnvUpdater = (env: Record<string, string>) => void

let sidecarProxyUpdater: ProxyEnvUpdater | undefined
let watcherTimer: NodeJS.Timeout | undefined
let lastResolved: ResolvedProxy | undefined

export function setSidecarProxyUpdater(updater: ProxyEnvUpdater | undefined) {
  sidecarProxyUpdater = updater
}

function isResolvedEqual(a: ResolvedProxy | undefined, b: ResolvedProxy): boolean {
  if (!a) return false
  return (
    a.http === b.http &&
    a.https === b.https &&
    a.all === b.all &&
    a.noProxy.length === b.noProxy.length &&
    a.noProxy.every((value, index) => value === b.noProxy[index])
  )
}

function buildSidecarProxyEnv(resolved: ResolvedProxy): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(buildEnvVars(resolved))) {
    env[key] = value ?? ""
  }
  return env
}

async function applyResolvedToProcesses(resolved: ResolvedProxy): Promise<void> {
  applyProxyToEnv(resolved)
  await applyProxyToSessionSync({ mode: "system" })
  sidecarProxyUpdater?.(buildSidecarProxyEnv(resolved))
}

async function watcherTick(getConfig: () => ProxyConfig): Promise<void> {
  try {
    const config = getConfig()
    if (config.mode !== "system") {
      lastResolved = undefined
      return
    }
    const resolved = await resolveSystemProxy()
    if (isResolvedEqual(lastResolved, resolved)) return
    lastResolved = resolved
    await applyResolvedToProcesses(resolved)
  } catch (error) {
    console.warn("system proxy watcher tick failed", error)
  }
}

export function startSystemProxyWatcher(getConfig: () => ProxyConfig, intervalMs = 30_000): void {
  stopSystemProxyWatcher()
  const tick = () => {
    void watcherTick(getConfig)
  }
  watcherTimer = setInterval(tick, intervalMs)
  watcherTimer.unref?.()
  tick()
}

export function stopSystemProxyWatcher(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer)
    watcherTimer = undefined
  }
}

export { isProxyConfigEqual, isValidProxyUrl } from "./proxy-util"
