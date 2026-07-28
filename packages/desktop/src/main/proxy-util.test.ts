import { describe, expect, test } from "bun:test"
import {
  buildEnvVars,
  buildSessionProxyOptions,
  isProxyConfigEqual,
  isValidProxyUrl,
  mergeBypassList,
  normalizeConfig,
  resolveEnvProxy,
  type ProxyConfig,
  type ProxyConfigStore,
  type ProxyMode,
} from "./proxy-util"

describe("proxy-util/isValidProxyUrl", () => {
  test("accepts http/https/socks urls", () => {
    expect(isValidProxyUrl("http://127.0.0.1:7890")).toBe(true)
    expect(isValidProxyUrl("https://proxy.example.com:8443")).toBe(true)
    expect(isValidProxyUrl("socks5://10.0.0.1:1080")).toBe(true)
    expect(isValidProxyUrl("socks4://10.0.0.1:1080")).toBe(true)
    expect(isValidProxyUrl("socks://10.0.0.1:1080")).toBe(true)
  })

  test("rejects malformed or unsupported schemes", () => {
    expect(isValidProxyUrl("")).toBe(false)
    expect(isValidProxyUrl("   ")).toBe(false)
    expect(isValidProxyUrl("not-a-url")).toBe(false)
    expect(isValidProxyUrl("ftp://example.com:21")).toBe(false)
    expect(isValidProxyUrl("file:///etc/hosts")).toBe(false)
  })
})

describe("proxy-util/mergeBypassList", () => {
  test("always includes loopback defaults", () => {
    const merged = mergeBypassList()
    expect(merged).toContain("127.0.0.1")
    expect(merged).toContain("localhost")
    expect(merged).toContain("::1")
  })

  test("merges user-provided entries and trims whitespace", () => {
    const merged = mergeBypassList([" *.internal ", "10.0.0.0/8", "127.0.0.1"])
    expect(merged).toContain("*.internal")
    expect(merged).toContain("10.0.0.0/8")
    expect(merged).toContain("127.0.0.1")
    const unique = new Set(merged)
    expect(unique.size).toBe(merged.length)
  })

  test("drops empty entries from user list", () => {
    const merged = mergeBypassList(["", "  ", "valid.host"])
    expect(merged).toContain("valid.host")
    expect(merged).not.toContain("")
    expect(merged).not.toContain("  ")
  })
})

describe("proxy-util/normalizeConfig", () => {
  test("returns default for null/undefined", () => {
    expect(normalizeConfig(null)).toEqual({ mode: "system", custom: null })
    expect(normalizeConfig(undefined)).toEqual({ mode: "system", custom: null })
  })

  test("coerces unknown modes to system", () => {
    const input: ProxyConfigStore = { mode: "garbage" as ProxyMode }
    expect(normalizeConfig(input)).toEqual({
      mode: "system",
      custom: null,
    })
  })

  test("drops custom when mode is not custom", () => {
    const result = normalizeConfig({
      mode: "none",
      custom: { url: "http://127.0.0.1:7890" },
    })
    expect(result.custom).toBeNull()
  })

  test("preserves custom when mode is custom", () => {
    const result = normalizeConfig({
      mode: "custom",
      custom: { url: "http://127.0.0.1:7890", bypassList: ["*.internal"] },
    })
    expect(result.mode).toBe("custom")
    expect(result.custom).toEqual({ url: "http://127.0.0.1:7890", bypassList: ["*.internal"] })
  })
})

describe("proxy-util/resolveEnvProxy", () => {
  test("returns empty env for none mode", () => {
    const resolved = resolveEnvProxy({ mode: "none", custom: null })
    expect(resolved.http).toBeUndefined()
    expect(resolved.https).toBeUndefined()
    expect(resolved.all).toBeUndefined()
    expect(resolved.noProxy).toContain("127.0.0.1")
  })

  test("sets both http and https for http proxies", () => {
    const resolved = resolveEnvProxy({
      mode: "custom",
      custom: { url: "http://127.0.0.1:7890" },
    })
    expect(resolved.http).toBe("http://127.0.0.1:7890")
    expect(resolved.https).toBe("http://127.0.0.1:7890")
    expect(resolved.all).toBeUndefined()
  })

  test("only sets https for https proxies", () => {
    const resolved = resolveEnvProxy({
      mode: "custom",
      custom: { url: "https://proxy.example.com:8443" },
    })
    expect(resolved.http).toBeUndefined()
    expect(resolved.https).toBe("https://proxy.example.com:8443")
    expect(resolved.all).toBeUndefined()
  })

  test("uses all_proxy for socks", () => {
    const resolved = resolveEnvProxy({
      mode: "custom",
      custom: { url: "socks5://10.0.0.1:1080" },
    })
    expect(resolved.all).toBe("socks5://10.0.0.1:1080")
    expect(resolved.http).toBeUndefined()
    expect(resolved.https).toBeUndefined()
  })

  test("embeds basic auth credentials", () => {
    const resolved = resolveEnvProxy({
      mode: "custom",
      custom: { url: "http://proxy.example.com:8080", username: "user", password: "p@ss" },
    })
    expect(resolved.http).toBe("http://user:p%40ss@proxy.example.com:8080")
  })

  test("returns empty env when custom url invalid", () => {
    const resolved = resolveEnvProxy({
      mode: "custom",
      custom: { url: "not-a-url" },
    })
    expect(resolved.http).toBeUndefined()
    expect(resolved.https).toBeUndefined()
    expect(resolved.all).toBeUndefined()
  })

  test("merges user bypass list with loopback defaults", () => {
    const resolved = resolveEnvProxy({
      mode: "custom",
      custom: { url: "http://127.0.0.1:7890", bypassList: ["*.internal", "10.0.0.0/8"] },
    })
    expect(resolved.noProxy).toContain("*.internal")
    expect(resolved.noProxy).toContain("10.0.0.0/8")
    expect(resolved.noProxy).toContain("127.0.0.1")
  })
})

describe("proxy-util/isProxyConfigEqual", () => {
  test("compares mode only when not custom", () => {
    expect(isProxyConfigEqual({ mode: "none", custom: null }, { mode: "none", custom: null })).toBe(true)
    expect(isProxyConfigEqual({ mode: "none", custom: null }, { mode: "system", custom: null })).toBe(false)
  })

  test("detects custom url changes", () => {
    const a: ProxyConfig = { mode: "custom", custom: { url: "http://a:1" } }
    const b: ProxyConfig = { mode: "custom", custom: { url: "http://b:2" } }
    expect(isProxyConfigEqual(a, b)).toBe(false)
    expect(isProxyConfigEqual(a, a)).toBe(true)
  })

  test("treats undefined and empty credentials as equal", () => {
    const a: ProxyConfig = { mode: "custom", custom: { url: "http://a:1", username: undefined } }
    const b: ProxyConfig = { mode: "custom", custom: { url: "http://a:1", username: "" } }
    expect(isProxyConfigEqual(a, b)).toBe(true)
  })

  test("order-insensitive bypass list comparison", () => {
    const a: ProxyConfig = {
      mode: "custom",
      custom: { url: "http://a:1", bypassList: ["a.com", "b.com"] },
    }
    const b: ProxyConfig = {
      mode: "custom",
      custom: { url: "http://a:1", bypassList: ["b.com", "a.com"] },
    }
    expect(isProxyConfigEqual(a, b)).toBe(true)
  })
})

describe("proxy-util/buildSessionProxyOptions", () => {
  test("returns direct for none mode", async () => {
    const options = await buildSessionProxyOptions({ mode: "none", custom: null })
    expect(options.mode).toBe("direct")
  })

  test("delegates to system resolver for system mode", async () => {
    let called = false
    const options = await buildSessionProxyOptions({ mode: "system", custom: null }, async () => {
      called = true
      return { mode: "system" }
    })
    expect(called).toBe(true)
    expect(options.mode).toBe("system")
  })

  test("returns custom rules when mode is custom with valid url", async () => {
    const options = await buildSessionProxyOptions({
      mode: "custom",
      custom: { url: "http://127.0.0.1:7890", bypassList: ["*.internal"] },
    })
    expect(options.mode).toBe("custom")
    expect(options.proxyRules).toBe("http://127.0.0.1:7890")
    expect(options.proxyBypassRules).toContain("*.internal")
    expect(options.proxyBypassRules).toContain("127.0.0.1")
  })

  test("falls back to direct when custom url is invalid", async () => {
    const options = await buildSessionProxyOptions({
      mode: "custom",
      custom: { url: "bad-url" },
    })
    expect(options.mode).toBe("direct")
  })
})

describe("proxy-util/buildEnvVars", () => {
  test("lowercase and uppercase variants both set", () => {
    const vars = buildEnvVars({ http: "http://1.1.1.1:1", noProxy: [] })
    expect(vars.HTTP_PROXY).toBe("http://1.1.1.1:1")
    expect(vars.http_proxy).toBe("http://1.1.1.1:1")
  })

  test("always sets NO_PROXY merged with loopback", () => {
    const vars = buildEnvVars({ noProxy: ["10.0.0.0/8"] })
    expect(vars.NO_PROXY).toContain("127.0.0.1")
    expect(vars.NO_PROXY).toContain("10.0.0.0/8")
    expect(vars.no_proxy).toBe(vars.NO_PROXY)
  })

  test("leaves unset vars undefined", () => {
    const vars = buildEnvVars({ noProxy: [] })
    expect(vars.HTTP_PROXY).toBeUndefined()
    expect(vars.HTTPS_PROXY).toBeUndefined()
    expect(vars.ALL_PROXY).toBeUndefined()
  })
})
