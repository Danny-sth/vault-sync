import { App, Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, Menu, TAbstractFile } from 'obsidian';
import { SyncManager } from './sync/SyncManager';
import { FileIcons } from './icons/FileIcons';
import { IconPickerModal } from './icons/IconPickerModal';
import { CommandExecutor } from './commands/CommandExecutor';
import { PdfProgress } from './pdf/PdfProgress';
import { ReadingDashboard } from './pdf/ReadingDashboard';
import { VaultSyncSettings, DEFAULT_SETTINGS } from './types';

export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = DEFAULT_SETTINGS;
  syncManager: SyncManager | null = null;
  fileIcons: FileIcons | null = null;
  commandExecutor: CommandExecutor | null = null;
  pdfProgress: PdfProgress | null = null;
  statusBarItem: HTMLElement | null = null;

  async onload(): Promise<void> {
    console.debug('[VaultSync] ========================================');
    console.debug('[VaultSync] Loading plugin v2.0');
    console.debug('[VaultSync] ========================================');

    try {
      await this.loadSettings();
      console.debug('[VaultSync] Settings loaded:', JSON.stringify(this.settings, null, 2));

      this.addSettingTab(new VaultSyncSettingTab(this.app, this));

      this.statusBarItem = this.addStatusBarItem();
      this.updateStatusBar(false);

      this.addCommand({
        id: 'vault-sync-connect',
        name: 'Connect',
        callback: () => { this.connect().catch(e => console.error('[VaultSync] Connect failed:', e)); },
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

      this.addCommand({
        id: 'vault-sync-create-daily',
        name: 'Sync Daily Note (pull from server)',
        callback: () => this.syncManager?.requestFullSync(),
      });

      this.commandExecutor = new CommandExecutor(this.app, this.settings);

      this.registerDynamicCommands();

      console.debug('[VaultSync] Creating SyncManager...');
      this.syncManager = new SyncManager(this.app, this.settings);
      this.syncManager.onConnectionChange = (connected) => {
        console.debug('[VaultSync] Connection state changed:', connected);
        this.updateStatusBar(connected);
      };

      console.debug('[VaultSync] Initializing SyncManager...');
      await this.syncManager.init();
      console.debug('[VaultSync] SyncManager initialized');

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

      this.fileIcons = new FileIcons(this.app);

      this.pdfProgress = new PdfProgress(this);
      this.pdfProgress.start();

      new ReadingDashboard(this).start();

      this.app.workspace.onLayoutReady(async () => {
        console.debug('[VaultSync] Workspace ready, initializing modules...');
        await this.fileIcons?.init();
      });

      this.registerEvent(
        this.app.metadataCache.on('changed', (file) => {
          this.fileIcons?.refreshFile(file.path);
        })
      );

      this.registerEvent(
        this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
          if (file instanceof TFile) {
            const cache = this.app.metadataCache.getFileCache(file);
            const currentIcon = cache?.frontmatter?.icon as string | undefined;

            menu.addItem((item) => {
              item
                .setTitle('Set Icon')
                .setIcon('image')
                .onClick(() => {
                  new IconPickerModal(this.app, currentIcon || null, async (iconName) => {
                    await this.setFileIcon(file, iconName);
                  }).open();
                });
            });
          } else if (file instanceof TFolder) {
            const currentIcon = this.fileIcons?.getFolderIcon(file.path) || null;

            menu.addItem((item) => {
              item
                .setTitle('Set Icon')
                .setIcon('image')
                .onClick(() => {
                  new IconPickerModal(this.app, currentIcon, async (iconName) => {
                    await this.fileIcons?.setFolderIcon(file.path, iconName);
                    new Notice(iconName ? `Folder icon set: ${iconName}` : 'Folder icon removed');
                  }).open();
                });
            });
          }
        })
      );

      console.debug('[VaultSync] AutoConnect:', this.settings.autoConnect, 'Token exists:', !!this.settings.token);
      if (this.settings.autoConnect && this.settings.token) {
        console.debug('[VaultSync] Will auto-connect in 2 seconds...');
        setTimeout(() => {
          console.debug('[VaultSync] Auto-connect triggered');
          this.connect().catch(e => console.error('[VaultSync] Auto-connect failed:', e));
        }, 2000);
      }

      this.registerDomEvent(document, 'visibilitychange', () => {
        console.debug('[VaultSync] Visibility changed:', document.visibilityState);
        if (document.visibilityState === 'visible' && this.settings.autoConnect) {
          console.debug('[VaultSync] App visible, forcing reconnect check...');
          setTimeout(() => {
            if (!this.syncManager?.isConnected()) {
              console.debug('[VaultSync] Not connected, reconnecting...');
              this.connect().catch(e => console.error('[VaultSync] Reconnect failed:', e));
            } else {
              console.debug('[VaultSync] Connected, requesting full sync...');
              this.syncManager?.requestFullSync();
            }
          }, 500);
        }
      });

      this.registerInterval(
        window.setInterval(() => {
          if (this.settings.autoConnect && !this.syncManager?.isConnected()) {
            console.debug('[VaultSync] Periodic check: not connected, reconnecting...');
            this.connect().catch(e => console.error('[VaultSync] Periodic reconnect failed:', e));
          }
        }, 30000)
      );

      console.debug('[VaultSync] Plugin loaded successfully');
    } catch (error) {
      console.error('[VaultSync] FATAL ERROR during plugin load:', error);
      new Notice('Vault Sync: Failed to load plugin');
    }
  }

  onunload(): void {
    console.debug('[VaultSync] Unloading plugin');
    this.syncManager?.destroy();
    this.fileIcons?.destroy();
    this.pdfProgress?.destroy();
  }

  /**
   * Register commands dynamically from server whitelist.
   */
  async registerDynamicCommands(): Promise<void> {
    if (!this.commandExecutor) {
      return;
    }

    try {
      console.debug('[VaultSync] Fetching available commands from server...');
      const commands = await this.commandExecutor.getAvailableCommands();
      console.debug('[VaultSync] Available commands:', commands);

      commands.forEach((commandName) => {
        const commandId = `vault-sync-execute-${commandName}`;
        const commandTitle = `Execute: ${commandName}`;

        this.addCommand({
          id: commandId,
          name: commandTitle,
          callback: () => this.commandExecutor?.executeCommand(commandName),
        });

        console.debug(`[VaultSync] Registered command: ${commandId}`);
      });

      console.debug(`[VaultSync] ${commands.length} commands registered`);
    } catch (error) {
      console.error('[VaultSync] Failed to register dynamic commands:', error);
    }
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

  /**
   * Set or remove icon in file frontmatter.
   */
  async setFileIcon(file: TFile, iconName: string | null): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const newContent = this.updateFrontmatterIcon(content, iconName);

      if (newContent !== content) {
        await this.app.vault.modify(file, newContent);
        new Notice(iconName ? `Icon set: ${iconName}` : 'Icon removed');
      }
    } catch (e) {
      console.error('[VaultSync] Failed to set icon:', e);
      new Notice('Failed to set icon');
    }
  }

  /**
   * Update or add icon property in frontmatter.
   */
  private updateFrontmatterIcon(content: string, iconName: string | null): string {
    const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
    const match = content.match(frontmatterRegex);

    if (match) {
      let frontmatter = match[1];
      const iconRegex = /^icon:\s*.+$/m;

      if (iconName) {
        if (iconRegex.test(frontmatter)) {
          frontmatter = frontmatter.replace(iconRegex, `icon: ${iconName}`);
        } else {
          frontmatter = `icon: ${iconName}\n${frontmatter}`;
        }
      } else {
        frontmatter = frontmatter.replace(/^icon:\s*.+\n?/m, '');
      }

      return content.replace(frontmatterRegex, `---\n${frontmatter}\n---`);
    } else if (iconName) {
      return `---\nicon: ${iconName}\n---\n\n${content}`;
    }

    return content;
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

    new Setting(containerEl).setName('Vault Sync settings').setHeading();

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

    new Setting(containerEl).setName('Actions').setHeading();

    new Setting(containerEl)
      .setName('Connect')
      .setDesc('Connect to the sync server')
      .addButton((button) =>
        button.setButtonText('Connect').onClick(() => {
          this.plugin.connect().catch(e => console.error('[VaultSync] Connect failed:', e));
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
