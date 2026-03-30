import { Plugin, TFile, TAbstractFile } from 'obsidian';
import { VaultSyncSettings, DEFAULT_SETTINGS } from './types';
import { VaultSyncSettingTab, initializeSettings } from './settings';
import { SyncClient } from './sync';

export default class VaultSyncPlugin extends Plugin {
    settings: VaultSyncSettings = DEFAULT_SETTINGS;
    private syncClient: SyncClient | null = null;
    private statusBarItem: HTMLElement | null = null;
    private status: string = 'disconnected';

    async onload() {
        await this.loadSettings();

        this.syncClient = new SyncClient(this.app, this.settings, (status) => {
            this.status = status;
            this.updateStatusBar();
        });

        // Status bar
        this.statusBarItem = this.addStatusBarItem();
        this.updateStatusBar();

        // Settings tab
        this.addSettingTab(new VaultSyncSettingTab(this.app, this));

        // Commands
        this.addCommand({
            id: 'vault-sync-connect',
            name: 'Connect to server',
            callback: () => this.connect(),
        });

        this.addCommand({
            id: 'vault-sync-disconnect',
            name: 'Disconnect from server',
            callback: () => this.disconnect(),
        });

        this.addCommand({
            id: 'vault-sync-resync',
            name: 'Full resync',
            callback: () => this.fullResync(),
        });

        // File event handlers
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                void this.syncClient?.onFileModify(file);
            })
        );

        this.registerEvent(
            this.app.vault.on('create', (file) => {
                void this.syncClient?.onFileCreate(file);
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', (file) => {
                void this.syncClient?.onFileDelete(file);
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
                void this.syncClient?.onFileRename(file, oldPath);
            })
        );

        // Auto-connect on load
        if (this.settings.enabled && this.settings.serverUrl && this.settings.authToken) {
            setTimeout(() => this.connect(), 1000);
        }
    }

    onunload() {
        this.syncClient?.disconnect();
    }

    async loadSettings() {
        const data = await this.loadData();
        this.settings = initializeSettings(data || {});
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    connect() {
        void this.syncClient?.connect();
    }

    disconnect() {
        this.syncClient?.disconnect();
    }

    getStatus(): string {
        return this.status;
    }

    async fullResync() {
        await this.syncClient?.fullResync();
    }

    private updateStatusBar() {
        if (this.statusBarItem) {
            let icon = '○';
            let label = 'Disconnected';

            switch (this.status) {
                case 'connected':
                    icon = '◐';
                    label = 'Connected';
                    break;
                case 'synced':
                    icon = '●';
                    label = 'Synced';
                    break;
                case 'disconnected':
                default:
                    icon = '○';
                    label = 'Disconnected';
            }

            this.statusBarItem.setText(`Sync: ${icon}`);
            this.statusBarItem.setAttribute('aria-label', `Vault Sync: ${label}`);
        }
    }
}
