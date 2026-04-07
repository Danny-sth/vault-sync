import { App, Plugin, PluginSettingTab, Setting, Notice, TFile } from 'obsidian';
import { SyncManager } from './sync/SyncManager';
import { VaultSyncSettings, DEFAULT_SETTINGS } from './types';

export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = DEFAULT_SETTINGS;
  syncManager: SyncManager | null = null;
  statusBarItem: HTMLElement | null = null;

  async onload(): Promise<void> {
    console.debug('[VaultSync] ========================================');
    console.debug('[VaultSync] Loading plugin v2.0');
    console.debug('[VaultSync] ========================================');
    new Notice('VaultSync: Loading plugin...');

    try {
      await this.loadSettings();
      console.debug('[VaultSync] Settings loaded:', JSON.stringify(this.settings, null, 2));

      this.addSettingTab(new VaultSyncSettingTab(this.app, this));

      // Status bar
      this.statusBarItem = this.addStatusBarItem();
      this.updateStatusBar(false);

      // Commands
      this.addCommand({
        id: 'vault-sync-connect',
        name: 'Connect',
        callback: () => this.connect(),
      });

      this.addCommand({
        id: 'vault-sync-disconnect',
        name: 'Disconnect',
        callback: () => this.disconnect(),
      });

      this.addCommand({
        id: 'vault-sync-full-sync',
        name: 'Full Sync',
        callback: () => this.syncManager?.requestFullSync(),
      });

      // Initialize sync manager
      console.debug('[VaultSync] Creating SyncManager...');
      this.syncManager = new SyncManager(this.app, this.settings);
      this.syncManager.onConnectionChange = (connected) => {
        console.debug('[VaultSync] Connection state changed:', connected);
        this.updateStatusBar(connected);
      };

      console.debug('[VaultSync] Initializing SyncManager...');
      await this.syncManager.init();
      console.debug('[VaultSync] SyncManager initialized');

      // Register vault events
      this.registerEvent(
        this.app.vault.on('create', (file) => {
          if (file instanceof TFile) {
            this.syncManager?.queueFileChange(file);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('modify', (file) => {
          if (file instanceof TFile) {
            this.syncManager?.queueFileChange(file);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('delete', (file) => {
          if (file instanceof TFile) {
            this.syncManager?.queueFileDelete(file.path);
          }
        })
      );

      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          if (file instanceof TFile) {
            this.syncManager?.queueFileRename(file, oldPath);
          }
        })
      );

      // Auto-connect
      console.debug('[VaultSync] AutoConnect:', this.settings.autoConnect, 'Token exists:', !!this.settings.token);
      if (this.settings.autoConnect && this.settings.token) {
        console.debug('[VaultSync] Will auto-connect in 2 seconds...');
        setTimeout(() => {
          console.debug('[VaultSync] Auto-connect triggered');
          this.connect();
        }, 2000);
      }

      // Reconnect on window focus (for mobile)
      this.registerDomEvent(document, 'visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.settings.autoConnect) {
          if (!this.syncManager?.isConnected()) {
            this.connect();
          }
        }
      });

      console.debug('[VaultSync] Plugin loaded successfully');
    } catch (error) {
      console.error('[VaultSync] FATAL ERROR during plugin load:', error);
      new Notice('Vault Sync: Failed to load plugin');
    }
  }

  onunload(): void {
    console.debug('[VaultSync] Unloading plugin');
    this.syncManager?.destroy();
  }

  async connect(): Promise<void> {
    console.debug('[VaultSync] connect() called');
    console.debug('[VaultSync] Server URL:', this.settings.serverUrl);
    console.debug('[VaultSync] Token:', this.settings.token ? '[set]' : '[not set]');

    if (!this.settings.token) {
      console.debug('[VaultSync] No token configured');
      new Notice('Vault Sync: Please configure token in settings');
      return;
    }

    try {
      console.debug('[VaultSync] Calling syncManager.connect()...');
      await this.syncManager?.connect();
      console.debug('[VaultSync] syncManager.connect() completed');
    } catch (error) {
      console.error('[VaultSync] Connection error:', error);
      new Notice('Vault Sync: Connection failed - check console');
    }
  }

  disconnect(): void {
    this.syncManager?.disconnect();
    this.updateStatusBar(false);
    new Notice('Vault Sync: Disconnected');
  }

  private updateStatusBar(connected: boolean): void {
    if (this.statusBarItem) {
      this.statusBarItem.setText(connected ? '🟢 Sync' : '🔴 Sync');
      this.statusBarItem.title = connected ? 'Vault Sync: Connected' : 'Vault Sync: Disconnected';
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class VaultSyncSettingTab extends PluginSettingTab {
  plugin: VaultSyncPlugin;

  constructor(app: App, plugin: VaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Vault Sync Settings' });

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('WebSocket URL of the sync server')
      .addText((text) =>
        text
          .setPlaceholder('wss://your-server:8443/ws')
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Authentication Token')
      .setDesc('Token for server authentication')
      .addText((text) =>
        text
          .setPlaceholder('your-token')
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Device ID')
      .setDesc('Unique identifier for this device')
      .addText((text) =>
        text
          .setValue(this.plugin.settings.deviceId)
          .onChange(async (value) => {
            this.plugin.settings.deviceId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Device Name')
      .setDesc('Human-readable name for this device')
      .addText((text) =>
        text
          .setPlaceholder('My Laptop')
          .setValue(this.plugin.settings.deviceName)
          .onChange(async (value) => {
            this.plugin.settings.deviceName = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auto Connect')
      .setDesc('Automatically connect when Obsidian starts')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoConnect)
          .onChange(async (value) => {
            this.plugin.settings.autoConnect = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Sync on Start')
      .setDesc('Perform full sync when connected')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.syncOnStart)
          .onChange(async (value) => {
            this.plugin.settings.syncOnStart = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Debounce (ms)')
      .setDesc('Delay before syncing changes (prevents rapid uploads)')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.debounceMs))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.debounceMs = num;
              await this.plugin.saveSettings();
            }
          })
      );

    containerEl.createEl('h3', { text: 'Actions' });

    new Setting(containerEl)
      .setName('Connect')
      .setDesc('Connect to the sync server')
      .addButton((button) =>
        button.setButtonText('Connect').onClick(() => {
          this.plugin.connect();
        })
      );

    new Setting(containerEl)
      .setName('Disconnect')
      .setDesc('Disconnect from the sync server')
      .addButton((button) =>
        button.setButtonText('Disconnect').onClick(() => {
          this.plugin.disconnect();
        })
      );

    new Setting(containerEl)
      .setName('Full Sync')
      .setDesc('Force a full synchronization')
      .addButton((button) =>
        button.setButtonText('Sync Now').onClick(() => {
          this.plugin.syncManager?.requestFullSync();
        })
      );
  }
}
