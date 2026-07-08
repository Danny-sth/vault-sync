import { TFile, TFolder } from 'obsidian';

/**
 * In-memory vault: a real file store (adapter = FS truth) plus a separately
 * tracked vault INDEX (what Obsidian has indexed). The split exists on purpose —
 * the mobile delete→resurrect bug lived exactly in the gap between the two, so
 * tests must be able to open that gap (`indexLag = true`) and close it
 * (`indexNow()`) deterministically.
 */
export interface FakeFsStore {
  files: Map<string, { data: Uint8Array; mtime: number }>;
  folders: Set<string>;
}

export function makeFsStore(): FakeFsStore {
  return { files: new Map(), folders: new Set() };
}

function parentDirs(path: string): string[] {
  const dirs: string[] = [];
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join('/'));
  }
  return dirs;
}

function isVaultVisible(path: string): boolean {
  // Obsidian's index skips dot-files and dot-folders.
  return !path.split('/').some((seg) => seg.startsWith('.'));
}

/** Copy a Uint8Array into a plain ArrayBuffer (never SharedArrayBuffer-typed). */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(data);
  return out;
}

export class FakeApp {
  readonly fs: FakeFsStore;
  /** When true, new files do NOT enter the vault index until indexNow(). */
  indexLag = false;
  private indexed = new Set<string>();

  readonly vault: any;
  readonly workspace = { onLayoutReady: (cb: () => void) => cb() };

  constructor(fs: FakeFsStore = makeFsStore()) {
    this.fs = fs;
    for (const p of fs.files.keys()) {
      if (isVaultVisible(p)) this.indexed.add(p);
    }

    const self = this;
    const adapter = {
      async exists(path: string): Promise<boolean> {
        return self.fs.files.has(path) || self.fs.folders.has(path) || path === '';
      },
      async stat(path: string): Promise<{ mtime: number; size: number } | null> {
        const f = self.fs.files.get(path);
        return f ? { mtime: f.mtime, size: f.data.byteLength } : null;
      },
      async readBinary(path: string): Promise<ArrayBuffer> {
        const f = self.fs.files.get(path);
        if (!f) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
        return toArrayBuffer(f.data);
      },
      async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
        self.putFile(path, new Uint8Array(content.slice(0)));
      },
      async write(path: string, content: string): Promise<void> {
        self.putFile(path, new TextEncoder().encode(content));
      },
      async remove(path: string): Promise<void> {
        self.fs.files.delete(path);
        self.indexed.delete(path);
      },
      async mkdir(path: string): Promise<void> {
        self.fs.folders.add(path);
      },
      async rmdir(path: string, _recursive: boolean): Promise<void> {
        self.fs.folders.delete(path);
      },
      async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
        const prefix = dir === '' ? '' : dir + '/';
        const files: string[] = [];
        const folders = new Set<string>();
        for (const p of self.fs.files.keys()) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          if (rest === '') continue;
          const slash = rest.indexOf('/');
          if (slash === -1) files.push(p);
          else folders.add(prefix + rest.slice(0, slash));
        }
        for (const f of self.fs.folders) {
          if (!f.startsWith(prefix) || f === dir) continue;
          const rest = f.slice(prefix.length);
          if (rest !== '' && !rest.includes('/')) folders.add(f);
        }
        return { files, folders: [...folders] };
      },
    };

    this.vault = {
      adapter,
      getFiles: (): TFile[] =>
        [...this.indexed].filter((p) => this.fs.files.has(p)).map((p) => this.tfile(p)),
      getAbstractFileByPath: (path: string): TFile | TFolder | null => {
        if (this.indexed.has(path) && this.fs.files.has(path)) return this.tfile(path);
        if (this.fs.folders.has(path)) return this.tfolder(path);
        return null;
      },
      getRoot: (): TFolder => this.tfolder(''),
      readBinary: async (file: TFile): Promise<ArrayBuffer> => adapter.readBinary(file.path),
      createBinary: async (path: string, content: ArrayBuffer): Promise<TFile> => {
        if (this.fs.files.has(path)) throw new Error('File already exists');
        this.putFile(path, new Uint8Array(content.slice(0)));
        return this.tfile(path);
      },
      modifyBinary: async (file: TFile, content: ArrayBuffer): Promise<void> => {
        this.putFile(file.path, new Uint8Array(content.slice(0)));
      },
      createFolder: async (path: string): Promise<void> => {
        if (this.fs.folders.has(path)) throw new Error('Folder already exists');
        this.fs.folders.add(path);
      },
      delete: async (file: TFile | TFolder): Promise<void> => {
        if (file instanceof TFolder) {
          this.fs.folders.delete(file.path);
          return;
        }
        if (!this.fs.files.has(file.path)) {
          throw Object.assign(new Error(`ENOENT: ${file.path}`), { code: 'ENOENT' });
        }
        this.fs.files.delete(file.path);
        this.indexed.delete(file.path);
      },
    };
  }

  private putFile(path: string, data: Uint8Array): void {
    for (const d of parentDirs(path)) this.fs.folders.add(d);
    const existed = this.fs.files.has(path);
    this.fs.files.set(path, { data, mtime: Date.now() });
    if (isVaultVisible(path) && (existed ? this.indexed.has(path) || !this.indexLag : !this.indexLag)) {
      this.indexed.add(path);
    }
  }

  /** Bring the vault index up to date with the FS (ends an indexLag window). */
  indexNow(): void {
    for (const p of this.fs.files.keys()) {
      if (isVaultVisible(p)) this.indexed.add(p);
    }
  }

  /** Drop a path from the index while keeping it on disk (simulates index lag). */
  deindex(path: string): void {
    this.indexed.delete(path);
  }

  tfile(path: string): TFile {
    const f = new TFile();
    f.path = path;
    f.name = path.split('/').pop()!;
    const rec = this.fs.files.get(path);
    f.stat = { mtime: rec?.mtime ?? 0, size: rec?.data.byteLength ?? 0, ctime: rec?.mtime ?? 0 };
    return f;
  }

  private tfolder(path: string): TFolder {
    const f = new TFolder();
    f.path = path;
    f.name = path.split('/').pop() ?? '';
    const prefix = path === '' ? '' : path + '/';
    const children: (TFile | TFolder)[] = [];
    for (const d of this.fs.folders) {
      if (!d.startsWith(prefix) || d === path) continue;
      const rest = d.slice(prefix.length);
      if (!rest.includes('/')) children.push(this.tfolder(d));
    }
    for (const p of this.indexed) {
      if (!p.startsWith(prefix) || !this.fs.files.has(p)) continue;
      const rest = p.slice(prefix.length);
      if (!rest.includes('/')) children.push(this.tfile(p));
    }
    f.children = children;
    return f;
  }
}
