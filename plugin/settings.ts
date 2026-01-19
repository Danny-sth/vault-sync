import { App, Platform, PluginSettingTab, Setting } from "obsidian";
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
  if (Platform.isWin) return "Windows";
  if (Platform.isMacOS) return "Mac";
  if (Platform.isLinux) return "Linux";
  if (Platform.isAndroidApp) return "Android";
  if (Platform.isIosApp) return "iOS";
  if (Platform.isMobile) return "Mobile";
  return "Desktop";
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

    new Setting(containerEl).setName("Vault sync settings").setHeading();

    // Connection settings
    new Setting(containerEl).setName("Connection").setHeading();

    new Setting(containerEl)
      .setName("Server url")
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
      .setName("Authentication token")
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
    new Setting(containerEl).setName("Device").setHeading();

    new Setting(containerEl)
      .setName("Device name")
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
      .setName("Device id")
      .setDesc("Unique identifier for this device (auto-generated)")
      .addText((text) => {
        text.setValue(this.plugin.settings.deviceId).setDisabled(true);
      });

    // Sync settings
    new Setting(containerEl).setName("Sync behavior").setHeading();

    new Setting(containerEl)
      .setName("Auto connect")
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
      .setName("Sync on start")
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
    new Setting(containerEl).setName("Actions").setHeading();

    new Setting(containerEl)
      .setName("Connection status")
      .setDesc(this.plugin.isConnected() ? "Connected" : "Disconnected")
      .addButton((button) =>
        button
          .setButtonText(this.plugin.isConnected() ? "Disconnect" : "Connect")
          .onClick(() => {
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
      .setName("Full sync")
      .setDesc("Request full sync from server")
      .addButton((button) =>
        button
          .setButtonText("Sync now")
          .setDisabled(!this.plugin.isConnected())
          .onClick(() => {
            this.plugin.requestFullSync();
          })
      );
  }
}
