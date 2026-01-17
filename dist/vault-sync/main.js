var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => VaultSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// settings.ts
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  serverUrl: "wss://90.156.230.49:8443/ws",
  token: "",
  deviceId: generateDeviceId(),
  deviceName: getPlatformName(),
  autoConnect: true,
  syncOnStart: true,
  debounceMs: 500
};
function generateDeviceId() {
  return "device-" + Math.random().toString(36).substring(2, 10);
}
function getPlatformName() {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("win"))
    return "Windows";
  if (platform.includes("mac"))
    return "Mac";
  if (platform.includes("linux"))
    return "Linux";
  if (platform.includes("android") || /android/i.test(navigator.userAgent))
    return "Android";
  if (platform.includes("iphone") || platform.includes("ipad"))
    return "iOS";
  return "Unknown";
}
var VaultSyncSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Vault Sync Settings" });
    containerEl.createEl("h3", { text: "Connection" });
    new import_obsidian.Setting(containerEl).setName("Server URL").setDesc("WebSocket server address (wss://...)").addText(
      (text) => text.setPlaceholder("wss://example.com:8443/ws").setValue(this.plugin.settings.serverUrl).onChange(async (value) => {
        this.plugin.settings.serverUrl = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Authentication Token").setDesc("Token for authenticating with the server").addText((text) => {
      text.setPlaceholder("Enter token").setValue(this.plugin.settings.token).onChange(async (value) => {
        this.plugin.settings.token = value;
        await this.plugin.saveSettings();
      });
      text.inputEl.type = "password";
    });
    containerEl.createEl("h3", { text: "Device" });
    new import_obsidian.Setting(containerEl).setName("Device Name").setDesc("Friendly name for this device").addText(
      (text) => text.setPlaceholder("My Device").setValue(this.plugin.settings.deviceName).onChange(async (value) => {
        this.plugin.settings.deviceName = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Device ID").setDesc("Unique identifier for this device (auto-generated)").addText((text) => {
      text.setValue(this.plugin.settings.deviceId).setDisabled(true);
    });
    containerEl.createEl("h3", { text: "Sync Behavior" });
    new import_obsidian.Setting(containerEl).setName("Auto Connect").setDesc("Automatically connect to server on startup").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoConnect).onChange(async (value) => {
        this.plugin.settings.autoConnect = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Sync on Start").setDesc("Request full sync when connecting").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.syncOnStart).onChange(async (value) => {
        this.plugin.settings.syncOnStart = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Debounce (ms)").setDesc("Wait time after file change before syncing (reduces server load)").addText(
      (text) => text.setPlaceholder("500").setValue(String(this.plugin.settings.debounceMs)).onChange(async (value) => {
        const num = parseInt(value, 10);
        if (!isNaN(num) && num >= 0) {
          this.plugin.settings.debounceMs = num;
          await this.plugin.saveSettings();
        }
      })
    );
    containerEl.createEl("h3", { text: "Actions" });
    new import_obsidian.Setting(containerEl).setName("Connection Status").setDesc(this.plugin.isConnected() ? "Connected" : "Disconnected").addButton(
      (button) => button.setButtonText(this.plugin.isConnected() ? "Disconnect" : "Connect").onClick(async () => {
        if (this.plugin.isConnected()) {
          this.plugin.disconnect();
        } else {
          this.plugin.connect();
        }
        setTimeout(() => this.display(), 500);
      })
    );
    new import_obsidian.Setting(containerEl).setName("Full Sync").setDesc("Request full sync from server").addButton(
      (button) => button.setButtonText("Sync Now").setDisabled(!this.plugin.isConnected()).onClick(async () => {
        this.plugin.requestFullSync();
      })
    );
  }
};

// sync.ts
var import_obsidian2 = require("obsidian");
var SyncManager = class {
  constructor(app, settings) {
    this.ws = null;
    this.pendingChanges = /* @__PURE__ */ new Map();
    this.localHashes = /* @__PURE__ */ new Map();
    this.isProcessingRemote = false;
    this.reconnectTimeout = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.onConnectionChange = null;
    this.app = app;
    this.settings = settings;
  }
  updateSettings(settings) {
    this.settings = settings;
  }
  isConnected() {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
  connect() {
    if (this.ws) {
      this.ws.close();
    }
    if (!this.settings.serverUrl || !this.settings.token) {
      new import_obsidian2.Notice("Vault Sync: Server URL and token are required");
      return;
    }
    const url = new URL(this.settings.serverUrl);
    url.searchParams.set("token", this.settings.token);
    url.searchParams.set("device_id", this.settings.deviceId);
    try {
      this.ws = new WebSocket(url.toString());
    } catch (e) {
      new import_obsidian2.Notice(`Vault Sync: Failed to create WebSocket: ${e}`);
      return;
    }
    this.ws.onopen = () => {
      var _a;
      this.reconnectAttempts = 0;
      new import_obsidian2.Notice("Vault Sync: Connected");
      (_a = this.onConnectionChange) == null ? void 0 : _a.call(this, true);
      if (this.settings.syncOnStart) {
        this.requestFullSync();
      }
    };
    this.ws.onclose = (event) => {
      var _a;
      (_a = this.onConnectionChange) == null ? void 0 : _a.call(this, false);
      if (!event.wasClean && this.reconnectAttempts < this.maxReconnectAttempts) {
        const delay = Math.min(1e3 * Math.pow(2, this.reconnectAttempts), 3e4);
        this.reconnectAttempts++;
        new import_obsidian2.Notice(`Vault Sync: Reconnecting in ${delay / 1e3}s...`);
        this.reconnectTimeout = setTimeout(() => this.connect(), delay);
      } else if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        new import_obsidian2.Notice("Vault Sync: Max reconnect attempts reached");
      }
    };
    this.ws.onerror = (error) => {
      console.error("Vault Sync WebSocket error:", error);
    };
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleServerMessage(msg);
      } catch (e) {
        console.error("Vault Sync: Failed to parse message:", e);
      }
    };
  }
  disconnect() {
    var _a;
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    this.reconnectAttempts = this.maxReconnectAttempts;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    new import_obsidian2.Notice("Vault Sync: Disconnected");
    (_a = this.onConnectionChange) == null ? void 0 : _a.call(this, false);
  }
  requestFullSync() {
    this.send({
      type: "request_full_sync",
      deviceId: this.settings.deviceId,
      timestamp: Date.now(),
      payload: null
    });
  }
  async queueFileChange(file) {
    if (this.isProcessingRemote)
      return;
    const existing = this.pendingChanges.get(file.path);
    if (existing)
      clearTimeout(existing);
    this.pendingChanges.set(
      file.path,
      setTimeout(async () => {
        await this.sendFileChange(file);
        this.pendingChanges.delete(file.path);
      }, this.settings.debounceMs)
    );
  }
  async queueFileDelete(path) {
    if (this.isProcessingRemote)
      return;
    const existing = this.pendingChanges.get(path);
    if (existing)
      clearTimeout(existing);
    this.pendingChanges.set(
      path,
      setTimeout(() => {
        this.sendFileDelete(path);
        this.pendingChanges.delete(path);
      }, this.settings.debounceMs)
    );
  }
  async sendFileChange(file) {
    if (!this.isConnected())
      return;
    try {
      const content = await this.app.vault.read(file);
      const hash = await this.hashContent(content);
      const previousHash = this.localHashes.get(file.path);
      this.localHashes.set(file.path, hash);
      const payload = {
        path: file.path,
        content: this.encodeBase64(content),
        mtime: file.stat.mtime,
        hash,
        previousHash
      };
      this.send({
        type: "file_change",
        deviceId: this.settings.deviceId,
        timestamp: Date.now(),
        payload
      });
    } catch (e) {
      console.error(`Vault Sync: Failed to send file change for ${file.path}:`, e);
    }
  }
  sendFileDelete(path) {
    if (!this.isConnected())
      return;
    this.localHashes.delete(path);
    this.send({
      type: "file_delete",
      deviceId: this.settings.deviceId,
      timestamp: Date.now(),
      payload: { path }
    });
  }
  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
  async handleServerMessage(msg) {
    if (msg.originDevice === this.settings.deviceId)
      return;
    switch (msg.type) {
      case "file_changed":
        await this.handleRemoteFileChange(msg.payload);
        break;
      case "file_deleted":
        await this.handleRemoteFileDelete(msg.payload);
        break;
      case "full_sync":
        await this.handleFullSync(msg.payload);
        break;
      case "conflict":
        this.handleConflict(msg.payload);
        break;
      case "pong":
        break;
    }
  }
  async handleRemoteFileChange(payload) {
    this.isProcessingRemote = true;
    try {
      const content = this.decodeBase64(payload.content);
      const path = payload.path;
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) {
        const existingFolder = this.app.vault.getAbstractFileByPath(dir);
        if (!existingFolder) {
          await this.app.vault.createFolder(dir);
        }
      }
      const existingFile = this.app.vault.getAbstractFileByPath(path);
      if (existingFile instanceof import_obsidian2.TFile) {
        await this.app.vault.modify(existingFile, content);
      } else {
        await this.app.vault.create(path, content);
      }
      this.localHashes.set(path, payload.hash);
      console.log(`Vault Sync: Applied remote change to ${path}`);
    } catch (e) {
      console.error(`Vault Sync: Failed to apply remote change:`, e);
      new import_obsidian2.Notice(`Vault Sync: Failed to sync ${payload.path}`);
    } finally {
      this.isProcessingRemote = false;
    }
  }
  async handleRemoteFileDelete(payload) {
    this.isProcessingRemote = true;
    try {
      const file = this.app.vault.getAbstractFileByPath(payload.path);
      if (file) {
        await this.app.vault.delete(file);
        this.localHashes.delete(payload.path);
        console.log(`Vault Sync: Deleted ${payload.path}`);
      }
    } catch (e) {
      console.error(`Vault Sync: Failed to delete ${payload.path}:`, e);
    } finally {
      this.isProcessingRemote = false;
    }
  }
  async handleFullSync(payload) {
    new import_obsidian2.Notice(`Vault Sync: Syncing ${payload.files.length} files...`);
    const serverFiles = new Set(payload.files.map((f) => f.path));
    const localFiles = this.app.vault.getFiles();
    const localFileMap = /* @__PURE__ */ new Map();
    for (const file of localFiles) {
      localFileMap.set(file.path, file);
    }
    for (const serverFile of payload.files) {
      const localFile = localFileMap.get(serverFile.path);
      if (!localFile) {
        continue;
      }
      const content = await this.app.vault.read(localFile);
      const localHash = await this.hashContent(content);
      this.localHashes.set(serverFile.path, localHash);
      if (localHash !== serverFile.hash) {
        await this.sendFileChange(localFile);
      }
    }
    for (const [path, file] of localFileMap) {
      if (!serverFiles.has(path) && !path.startsWith(".")) {
        await this.sendFileChange(file);
      }
    }
    new import_obsidian2.Notice("Vault Sync: Sync complete");
  }
  handleConflict(payload) {
    new import_obsidian2.Notice(
      `Vault Sync: Conflict detected in ${payload.path}. Server version was used.`
    );
    console.warn("Vault Sync conflict:", payload);
  }
  async hashContent(content) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  encodeBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
  decodeBase64(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }
};

// main.ts
var VaultSyncPlugin = class extends import_obsidian3.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.syncManager = null;
    this.statusBarItem = null;
  }
  async onload() {
    await this.loadSettings();
    this.syncManager = new SyncManager(this.app, this.settings);
    this.syncManager.onConnectionChange = (connected) => {
      this.updateStatusBar(connected);
    };
    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar(false);
    this.addSettingTab(new VaultSyncSettingTab(this.app, this));
    this.addCommand({
      id: "vault-sync-connect",
      name: "Connect to server",
      callback: () => this.connect()
    });
    this.addCommand({
      id: "vault-sync-disconnect",
      name: "Disconnect from server",
      callback: () => this.disconnect()
    });
    this.addCommand({
      id: "vault-sync-full-sync",
      name: "Request full sync",
      callback: () => this.requestFullSync()
    });
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        var _a;
        if (file instanceof import_obsidian3.TFile) {
          (_a = this.syncManager) == null ? void 0 : _a.queueFileChange(file);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => {
        var _a;
        if (file instanceof import_obsidian3.TFile) {
          (_a = this.syncManager) == null ? void 0 : _a.queueFileChange(file);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        var _a;
        if (file instanceof import_obsidian3.TFile) {
          (_a = this.syncManager) == null ? void 0 : _a.queueFileDelete(file.path);
        }
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        var _a, _b;
        if (file instanceof import_obsidian3.TFile) {
          (_a = this.syncManager) == null ? void 0 : _a.queueFileDelete(oldPath);
          (_b = this.syncManager) == null ? void 0 : _b.queueFileChange(file);
        }
      })
    );
    if (this.settings.autoConnect && this.settings.token) {
      setTimeout(() => this.connect(), 1e3);
    }
  }
  onunload() {
    var _a;
    (_a = this.syncManager) == null ? void 0 : _a.disconnect();
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    var _a;
    await this.saveData(this.settings);
    (_a = this.syncManager) == null ? void 0 : _a.updateSettings(this.settings);
  }
  connect() {
    var _a;
    (_a = this.syncManager) == null ? void 0 : _a.connect();
  }
  disconnect() {
    var _a;
    (_a = this.syncManager) == null ? void 0 : _a.disconnect();
  }
  isConnected() {
    var _a, _b;
    return (_b = (_a = this.syncManager) == null ? void 0 : _a.isConnected()) != null ? _b : false;
  }
  requestFullSync() {
    var _a;
    (_a = this.syncManager) == null ? void 0 : _a.requestFullSync();
  }
  updateStatusBar(connected) {
    if (this.statusBarItem) {
      this.statusBarItem.setText(connected ? "Sync: \u25CF" : "Sync: \u25CB");
      this.statusBarItem.setAttribute(
        "aria-label",
        connected ? "Vault Sync: Connected" : "Vault Sync: Disconnected"
      );
    }
  }
};
