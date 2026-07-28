import { Component, Show, createMemo, createResource, createSignal } from "solid-js"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { ProxyConfig, ProxyMode } from "@/context/platform"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"

type ModeOption = { value: ProxyMode; label: string }

const DEFAULT_CONFIG: ProxyConfig = { mode: "system", custom: null }

function parseBypassList(input: string): string[] {
  return input
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatBypassList(list?: string[]): string {
  return (list ?? []).join(",")
}

function isValidProxyUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed) return false
  try {
    const parsed = new URL(trimmed)
    const protocol = parsed.protocol.replace(/:$/, "").toLowerCase()
    return ["http", "https", "socks5", "socks4", "socks"].includes(protocol)
  } catch {
    return false
  }
}

export const SettingsProxySection: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()

  const [config, { mutate: mutateConfig }] = createResource(
    () => (platform.getProxyConfig ? true : false),
    () => Promise.resolve(platform.getProxyConfig?.() ?? DEFAULT_CONFIG).catch(() => DEFAULT_CONFIG),
    { initialValue: DEFAULT_CONFIG },
  )

  const [bypassInput, setBypassInput] = createSignal("")
  const [urlInput, setUrlInput] = createSignal("")
  const [usernameInput, setUsernameInput] = createSignal("")
  const [passwordInput, setPasswordInput] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [pendingRestart, setPendingRestart] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  let lastSyncedUrl = ""
  let lastSyncedBypass = ""
  let lastSyncedUsername = ""
  let lastSyncedPassword = ""

  const syncInputs = (next: ProxyConfig) => {
    const url = next.custom?.url ?? ""
    const bypass = formatBypassList(next.custom?.bypassList)
    const username = next.custom?.username ?? ""
    const password = next.custom?.password ?? ""
    if (url !== lastSyncedUrl) {
      setUrlInput(url)
      lastSyncedUrl = url
    }
    if (bypass !== lastSyncedBypass) {
      setBypassInput(bypass)
      lastSyncedBypass = bypass
    }
    if (username !== lastSyncedUsername) {
      setUsernameInput(username)
      lastSyncedUsername = username
    }
    if (password !== lastSyncedPassword) {
      setPasswordInput(password)
      lastSyncedPassword = password
    }
    setError(null)
  }

  // Initialise once the resource resolves.
  createResource(
    () => config.latest,
    (latest) => {
      syncInputs(latest)
      return Promise.resolve()
    },
  )

  if (platform.onProxyConfigChanged) {
    platform.onProxyConfigChanged((next) => {
      mutateConfig(next)
      syncInputs(next)
    })
  }

  const modeOptions = createMemo<ModeOption[]>(() => [
    { value: "none", label: language.t("settings.proxy.mode.none") },
    { value: "system", label: language.t("settings.proxy.mode.system") },
    { value: "custom", label: language.t("settings.proxy.mode.custom") },
  ])

  const currentMode = createMemo<ProxyMode>(() => config.latest.mode ?? "system")
  const currentModeOption = createMemo(
    () => modeOptions().find((option) => option.value === currentMode()) ?? modeOptions()[1],
  )

  const customUrlValid = createMemo(() => isValidProxyUrl(urlInput()))

  const save = async (next: ProxyConfig) => {
    if (!platform.setProxyConfig) return
    setSaving(true)
    setError(null)
    try {
      const result = await platform.setProxyConfig(next)
      setPendingRestart(result?.needsRestart ?? false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleModeChange = (mode: ProxyMode) => {
    const next: ProxyConfig =
      mode === "custom"
        ? {
            mode,
            custom: config.latest.custom ?? {
              url: urlInput(),
              bypassList: parseBypassList(bypassInput()),
              username: usernameInput(),
              password: passwordInput(),
            },
          }
        : { mode, custom: null }
    mutateConfig(next)
    void save(next)
  }

  const handleApplyCustom = () => {
    if (!customUrlValid()) {
      setError(language.t("settings.proxy.error.invalidUrl"))
      return
    }
    const next: ProxyConfig = {
      mode: "custom",
      custom: {
        url: urlInput().trim(),
        bypassList: parseBypassList(bypassInput()),
        username: usernameInput().trim() || undefined,
        password: passwordInput() || undefined,
      },
    }
    mutateConfig(next)
    void save(next)
  }

  const handleRestart = () => {
    void platform.restart?.()
  }

  return (
    <div class="settings-v2-section">
      <h3 class="settings-v2-section-title">{language.t("settings.proxy.section.title")}</h3>

      <SettingsListV2>
        <SettingsRowV2
          title={language.t("settings.proxy.mode.title")}
          description={language.t("settings.proxy.mode.description")}
        >
          <SelectV2
            appearance="inline"
            data-action="settings-proxy-mode"
            options={modeOptions()}
            current={currentModeOption()}
            placement="bottom-end"
            gutter={6}
            value={(o) => o.value}
            label={(o) => o.label}
            onSelect={(option) => option && handleModeChange(option.value)}
          />
        </SettingsRowV2>

        <Show when={currentMode() === "custom"}>
          <SettingsRowV2
            title={language.t("settings.proxy.url.title")}
            description={language.t("settings.proxy.url.description")}
          >
            <div class="w-full sm:w-[260px]">
              <TextInputV2
                data-action="settings-proxy-url"
                type="text"
                appearance="base"
                value={urlInput()}
                onInput={(e) => setUrlInput(e.currentTarget.value)}
                placeholder="http://127.0.0.1:7890"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                aria-label={language.t("settings.proxy.url.title")}
              />
            </div>
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.proxy.username.title")}
            description={language.t("settings.proxy.username.description")}
          >
            <div class="w-full sm:w-[220px]">
              <TextInputV2
                data-action="settings-proxy-username"
                type="text"
                appearance="base"
                value={usernameInput()}
                onInput={(e) => setUsernameInput(e.currentTarget.value)}
                placeholder="user"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                aria-label={language.t("settings.proxy.username.title")}
              />
            </div>
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.proxy.password.title")}
            description={language.t("settings.proxy.password.description")}
          >
            <div class="w-full sm:w-[220px]">
              <TextInputV2
                data-action="settings-proxy-password"
                type="password"
                appearance="base"
                value={passwordInput()}
                onInput={(e) => setPasswordInput(e.currentTarget.value)}
                placeholder="••••••"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                aria-label={language.t("settings.proxy.password.title")}
              />
            </div>
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.proxy.bypass.title")}
            description={language.t("settings.proxy.bypass.description")}
          >
            <div class="w-full sm:w-[260px]">
              <TextInputV2
                data-action="settings-proxy-bypass"
                type="text"
                appearance="base"
                value={bypassInput()}
                onInput={(e) => setBypassInput(e.currentTarget.value)}
                placeholder="localhost,*.internal"
                spellcheck={false}
                autocorrect="off"
                autocomplete="off"
                autocapitalize="off"
                aria-label={language.t("settings.proxy.bypass.title")}
              />
            </div>
          </SettingsRowV2>

          <SettingsRowV2
            title={language.t("settings.proxy.apply.title")}
            description={language.t("settings.proxy.apply.description")}
          >
            <ButtonV2
              size="normal"
              variant="neutral"
              data-action="settings-proxy-apply"
              disabled={!customUrlValid() || saving()}
              onClick={handleApplyCustom}
            >
              {language.t("settings.proxy.apply.button")}
            </ButtonV2>
          </SettingsRowV2>
        </Show>

        <Show when={error()}>
          <p class="settings-v2-proxy-error" role="alert">
            {error()}
          </p>
        </Show>

        <Show when={pendingRestart()}>
          <SettingsRowV2
            title={language.t("settings.proxy.restart.title")}
            description={language.t("settings.proxy.restart.description")}
          >
            <ButtonV2
              size="normal"
              variant="contrast"
              data-action="settings-proxy-restart"
              onClick={handleRestart}
            >
              {language.t("settings.proxy.restart.button")}
            </ButtonV2>
          </SettingsRowV2>
        </Show>
      </SettingsListV2>
    </div>
  )
}
