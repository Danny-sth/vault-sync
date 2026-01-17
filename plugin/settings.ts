import { App, PluginSettingTab, Setting } from "obsidian";
import VaultSyncPlugin from "./main";

export interface VaultSyncSettings {
  serverUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
  autoConnect: boolean;
  syncOnStart: boolean;
  debounceMs: number;
}

export const DEFAULT_SETTINGS: VaultSyncSettings = {
  serverUrl: "wss://90.156.230.49:8443/ws",
  token: "",
  deviceId: generateDeviceId(),
  deviceName: getPlatformName(),
  autoConnect: true,
  syncOnStart: true,
  debounceMs: 500,
};

function generateDeviceId(): string {
  return "device-" + Math.random().toString(36).substring(2, 10);
}

function getPlatformName(): string {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win")) return "Windows";
  if (platform.includes("mac")) return "Mac";
  if (platform.includes("linux")) return "Linux";
  if (platform.includes("android") || /android/i.test(navigator.userAgent))
    return "Android";
  if (platform.includes("iphone") || platform.includes("ipad")) return "iOS";
  return "Unknown";
}

export class VaultSyncSettingTab extends PluginSettingTab {
  plugin: VaultSyncPlugin;

  constructor(app: App, plugin: VaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Vault Sync Settings" });

    // Connection settings
    containerEl.createEl("h3", { text: "Connection" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("WebSocket server address (wss://...)")
      .addText((text) =>
        text
          .setPlaceholder("wss://example.com:8443/ws")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Authentication Token")
      .setDesc("Token for authenticating with the server")
      .addText((text) => {
        text
          .setPlaceholder("Enter token")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    // Device settings
    containerEl.createEl("h3", { text: "Device" });

    new Setting(containerEl)
      .setName("Device Name")
      .setDesc("Friendly name for this device")
      .addText((text) =>
        text
          .setPlaceholder("My Device")
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Device ID")
      .setDesc("Unique identifier for this device (auto-generated)")
      .addText((text) => {
        text.setValue(this.plugin.settings.deviceId).setDisabled(true);
      });

    // Sync settings
    containerEl.createEl("h3", { text: "Sync Behavior" });

    new Setting(containerEl)
      .setName("Auto Connect")
      .setDesc("Automatically connect to server on startup")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoConnect)
          .onChange(async (value) => {
            this.plugin.settings.autoConnect = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync on Start")
      .setDesc("Request full sync when connecting")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStart)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStart = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Debounce (ms)")
      .setDesc("Wait time after file change before syncing (reduces server load)")
      .addText((text) =>
        text
          .setPlaceholder("500")
          .setValue(String(this.plugin.settings.debounceMs))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.debounceMs = num;
              await this.plugin.saveSettings();
            }
          })
      );

    // Actions
    containerEl.createEl("h3", { text: "Actions" });

    new Setting(containerEl)
      .setName("Connection Status")
      .setDesc(this.plugin.isConnected() ? "Connected" : "Disconnected")
      .addButton((button) =>
        button
          .setButtonText(this.plugin.isConnected() ? "Disconnect" : "Connect")
          .onClick(async () => {
            if (this.plugin.isConnected()) {
              this.plugin.disconnect();
            } else {
              this.plugin.connect();
            }
            // Refresh display after a short delay
            setTimeout(() => this.display(), 500);
          })
      );

    new Setting(containerEl)
      .setName("Full Sync")
      .setDesc("Request full sync from server")
      .addButton((button) =>
        button
          .setButtonText("Sync Now")
          .setDisabled(!this.plugin.isConnected())
          .onClick(async () => {
            this.plugin.requestFullSync();
          })
      );
  }
}
