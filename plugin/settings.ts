import { App, Platform, PluginSettingTab, Setting } from 'obsidian';
import VaultSyncPlugin from './main';
import { VaultSyncSettings, DEFAULT_SETTINGS } from './types';

export type { VaultSyncSettings };
export { DEFAULT_SETTINGS };

function generateDeviceId(): string {
    return 'device-' + Math.random().toString(36).substring(2, 10);
}

function getPlatformName(): string {
    if (Platform.isWin) return 'Windows';
    if (Platform.isMacOS) return 'Mac';
    if (Platform.isLinux) return 'Linux';
    if (Platform.isAndroidApp) return 'Android';
    if (Platform.isIosApp) return 'iOS';
    if (Platform.isMobile) return 'Mobile';
    return 'Desktop';
}

export function initializeSettings(settings: Partial<VaultSyncSettings>): VaultSyncSettings {
    return {
        ...DEFAULT_SETTINGS,
        ...settings,
        deviceId: settings.deviceId || generateDeviceId(),
    };
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

        // Connection
        new Setting(containerEl).setName('Connection').setHeading();

        new Setting(containerEl)
            .setName('Server URL')
            .setDesc('HTTP URL of the sync server (e.g., http://90.156.230.49:8080)')
            .addText((text) =>
                text
                    .setPlaceholder('http://example.com:8080')
                    .setValue(this.plugin.settings.serverUrl)
                    .onChange(async (value) => {
                        this.plugin.settings.serverUrl = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Authentication token')
            .setDesc('Token for authenticating with the server')
            .addText((text) => {
                text
                    .setPlaceholder('Enter token')
                    .setValue(this.plugin.settings.authToken)
                    .onChange(async (value) => {
                        this.plugin.settings.authToken = value;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.type = 'password';
            });

        // Device settings
        new Setting(containerEl).setName('Device').setHeading();

        new Setting(containerEl)
            .setName('Device ID')
            .setDesc('Unique identifier for this device (auto-generated)')
            .addText((text) => {
                text.setValue(this.plugin.settings.deviceId).setDisabled(true);
            });

        // Sync settings
        new Setting(containerEl).setName('Sync behavior').setHeading();

        new Setting(containerEl)
            .setName('Enable sync')
            .setDesc('Enable automatic sync')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.enabled)
                    .onChange(async (value) => {
                        this.plugin.settings.enabled = value;
                        await this.plugin.saveSettings();
                        if (value) {
                            this.plugin.connect();
                        } else {
                            this.plugin.disconnect();
                        }
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName('Debounce (ms)')
            .setDesc('Wait time after file change before syncing (reduces server load)')
            .addText((text) =>
                text
                    .setPlaceholder('500')
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
        new Setting(containerEl).setName('Actions').setHeading();

        const status = this.plugin.getStatus();
        new Setting(containerEl)
            .setName('Connection status')
            .setDesc(status)
            .addButton((button) =>
                button
                    .setButtonText(status === 'connected' || status === 'synced' ? 'Disconnect' : 'Connect')
                    .setDisabled(!this.plugin.settings.enabled)
                    .onClick(() => {
                        if (status === 'connected' || status === 'synced') {
                            this.plugin.disconnect();
                        } else {
                            this.plugin.connect();
                        }
                        setTimeout(() => this.display(), 500);
                    })
            );

        new Setting(containerEl)
            .setName('Full resync')
            .setDesc('Reset local state and sync from server')
            .addButton((button) =>
                button
                    .setButtonText('Resync')
                    .setDisabled(status !== 'connected' && status !== 'synced')
                    .onClick(async () => {
                        await this.plugin.fullResync();
                    })
            );
    }
}
