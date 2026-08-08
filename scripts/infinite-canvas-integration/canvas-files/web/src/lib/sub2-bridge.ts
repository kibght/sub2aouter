import { createModelChannel, useConfigStore } from "@/stores/use-config-store";
import { useThemeStore, type ThemeName } from "@/stores/use-theme-store";

const READY_MESSAGE = "INFINITE_CANVAS_READY";
const INIT_MESSAGE = "SUB2_CANVAS_INIT";
const CONFIGURED_MESSAGE = "INFINITE_CANVAS_CONFIGURED";
const BRIDGE_VERSION = 1;

type InitPayload = {
    baseUrl: string;
    apiKey: string;
    theme?: ThemeName;
    locale?: string;
};

type InitMessage = {
    type: typeof INIT_MESSAGE;
    version: typeof BRIDGE_VERSION;
    payload: InitPayload;
};

function isInitMessage(value: unknown): value is InitMessage {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<InitMessage>;
    const payload = candidate.payload as Partial<InitPayload> | undefined;
    return (
        candidate.type === INIT_MESSAGE &&
        candidate.version === BRIDGE_VERSION &&
        typeof payload?.baseUrl === "string" &&
        Boolean(payload.baseUrl.trim()) &&
        typeof payload.apiKey === "string" &&
        Boolean(payload.apiKey.trim())
    );
}

export function installSub2Bridge() {
    if (window.parent === window) return () => undefined;

    const parent = window.parent;
    const targetOrigin = window.location.origin;
    const handleMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin || event.source !== parent || !isInitMessage(event.data)) return;

        const { baseUrl, apiKey, theme } = event.data.payload;
        const state = useConfigStore.getState();
        const firstChannel = state.config.channels[0];
        state.updateConfig(
            "channels",
            firstChannel
                ? state.config.channels.map((channel, index) =>
                      index === 0 ? { ...channel, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() } : channel,
                  )
                : [createModelChannel({ id: "default", name: "默认渠道", baseUrl: baseUrl.trim(), apiKey: apiKey.trim() })],
        );
        state.updateConfig("baseUrl", baseUrl.trim());
        state.updateConfig("apiKey", apiKey.trim());
        state.openConfigDialog(false);
        if (theme === "light" || theme === "dark") useThemeStore.getState().setTheme(theme);

        parent.postMessage({ type: CONFIGURED_MESSAGE, version: BRIDGE_VERSION }, targetOrigin);
    };

    window.addEventListener("message", handleMessage);
    parent.postMessage({ type: READY_MESSAGE, version: BRIDGE_VERSION }, targetOrigin);

    return () => window.removeEventListener("message", handleMessage);
}
