import { Plugin, TFile, TAbstractFile } from "obsidian";
import {
  VaultSyncSettings,
  DEFAULT_SETTINGS,
  VaultSyncSettingTab,
} from "./settings";
import { SyncManager } from "./sync";

export default class VaultSyncPlugin extends Plugin {
  settings: VaultSyncSettings = DEFAULT_SETTINGS;
  private syncManager: SyncManager | null = null;
  private statusBarItem: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();

    this.syncManager = new SyncManager(this.app, this.settings);
    this.syncManager.onConnectionChange = (connected) => {
      this.updateStatusBar(connected);
    };

    // Status bar
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar(false);

    // Settings tab
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));

    // Commands
    this.addCommand({
      id: "vault-sync-connect",
      name: "Connect to server",
      callback: () => this.connect(),
    });

    this.addCommand({
      id: "vault-sync-disconnect",
      name: "Disconnect from server",
      callback: () => this.disconnect(),
    });

    this.addCommand({
      id: "vault-sync-full-sync",
      name: "Request full sync",
      callback: () => this.requestFullSync(),
    });

    // File event handlers
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) {
          this.syncManager?.queueFileChange(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile) {
          this.syncManager?.queueFileChange(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.syncManager?.queueFileDelete(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile) {
          // Use atomic file_move instead of separate delete + change
          this.syncManager?.queueFileMove(file, oldPath);
        }
      })
    );

    // Auto-connect on load
    if (this.settings.autoConnect && this.settings.token) {
      // Small delay to ensure vault is ready
      setTimeout(() => this.connect(), 1000);
    }
  }

  onunload() {
    this.syncManager?.disconnect();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.syncManager?.updateSettings(this.settings);
  }

  connect() {
    this.syncManager?.connect();
  }

  disconnect() {
    this.syncManager?.disconnect();
  }

  isConnected(): boolean {
    return this.syncManager?.isConnected() ?? false;
  }

  requestFullSync() {
    this.syncManager?.requestFullSync();
  }

  private updateStatusBar(connected: boolean) {
    if (this.statusBarItem) {
      this.statusBarItem.setText(connected ? "Sync: ●" : "Sync: ○");
      this.statusBarItem.setAttribute(
        "aria-label",
        connected ? "Vault Sync: Connected" : "Vault Sync: Disconnected"
      );
    }
  }
}
