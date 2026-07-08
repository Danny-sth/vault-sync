import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryServer } from './harness/InMemoryServer';
import { TestDevice, offlineDelete, offlineWrite } from './harness/TestDevice';
import { FileChange } from '../sync/FileWatcher';

/**
 * Протокольные сценарии «два устройства + сервер» на НАСТОЯЩИХ классах плагина
 * (SyncManager / FileWatcher / FileOperationService / ConflictResolver / TombstoneLogic).
 * Каждый пойманный в проде баг обязан оставить здесь сценарий — это анти-регрессия
 * для класса ошибок «синк потерял/воскресил файл».
 */

let server: InMemoryServer;

beforeEach(() => {
  server = new InMemoryServer();
});

async function bootDevice(id: string): Promise<TestDevice> {
  const d = new TestDevice(server, id);
  await d.start();
  await d.connectAndSync();
  return d;
}

describe('базовый обмен', () => {
  it('создание файла на A доезжает до B (live-broadcast)', async () => {
    const a = await bootDevice('A');
    const b = await bootDevice('B');

    await a.writeLocal('notes.md', 'hello');
    await a.scan();
    await b.flushDebounce();

    expect(server.livePaths()).toEqual(['notes.md']);
    expect(await b.readLocal('notes.md')).toBe('hello');
    a.stop(); b.stop();
  });

  it('live-удаление на A удаляет файл на B', async () => {
    const a = await bootDevice('A');
    await a.writeLocal('gone.md', 'x');
    await a.scan();

    const b = await bootDevice('B');
    expect(await b.readLocal('gone.md')).toBe('x');

    await a.deleteLocal('gone.md');
    await a.scan();
    await b.flushDebounce();

    expect(server.livePaths()).toEqual([]);
    expect(await b.readLocal('gone.md')).toBeNull();
    a.stop(); b.stop();
  });
});

describe('офлайн-удаления (баг 2026-07-08: чистка duq-доков не синканулась)', () => {
  it('файлы, удалённые при закрытом Obsidian, удаляются на сервере и на другом устройстве', async () => {
    const a = await bootDevice('A');
    for (const p of ['a.md', 'b.md', 'c.md']) await a.writeLocal(p, `content of ${p}`);
    await a.scan();

    const b = await bootDevice('B');
    expect(b.localPaths()).toEqual(['a.md', 'b.md', 'c.md']);

    // Obsidian закрыт → правки мимо плагина.
    a.stop();
    offlineDelete(a.fs, 'a.md');
    offlineDelete(a.fs, 'b.md');

    const a2 = new TestDevice(server, 'A', a.fs, a.local);
    await a2.start();
    await a2.connectAndSync();
    await b.flushDebounce();

    expect(server.livePaths()).toEqual(['c.md']);
    expect(server.tombstones.has('a.md')).toBe(true);
    expect(server.tombstones.has('b.md')).toBe(true);
    expect(b.localPaths()).toEqual(['c.md']);
    a2.stop(); b.stop();
  });

  it('переезд файла при закрытом Obsidian = создание нового + удаление старого', async () => {
    const a = await bootDevice('A');
    await a.writeLocal('docs/Note.md', 'важное');
    await a.scan();

    const b = await bootDevice('B');
    expect(await b.readLocal('docs/Note.md')).toBe('важное');

    a.stop();
    offlineDelete(a.fs, 'docs/Note.md');
    offlineWrite(a.fs, 'docs/archive/Note.md', 'важное');

    const a2 = new TestDevice(server, 'A', a.fs, a.local);
    await a2.start();
    await a2.emitVaultLoadCreates(); // Obsidian на старте эмитит create для всех файлов
    await a2.connectAndSync();
    await b.flushDebounce();

    expect(server.livePaths()).toEqual(['docs/archive/Note.md']);
    expect(await b.readLocal('docs/archive/Note.md')).toBe('важное');
    expect(await b.readLocal('docs/Note.md')).toBeNull();
    a2.stop(); b.stop();
  });

  it('удаление НЕ выводится из отсутствия, если сервер менял файл после нашего lastSeq', async () => {
    const a = await bootDevice('A');
    await a.writeLocal('shared.md', 'v1');
    await a.scan();

    const b = await bootDevice('B');
    a.stop();

    // A удаляет офлайн, но B тем временем ОБНОВЛЯЕТ файл (seq уходит вперёд).
    offlineDelete(a.fs, 'shared.md');
    await b.writeLocal('shared.md', 'v2 от B');
    await b.scan();

    const a2 = new TestDevice(server, 'A', a.fs, a.local);
    await a2.start();
    await a2.connectAndSync();

    // Файл в дельте → офлайн-инференс обязан промолчать; свежая версия скачивается обратно.
    expect(server.livePaths()).toEqual(['shared.md']);
    expect(await a2.readLocal('shared.md')).toBe('v2 от B');
    a2.stop(); b.stop();
  });

  it('клапан: пустая/сломанная локальная ФС не превращается в массовое удаление на сервере', async () => {
    const a = await bootDevice('A');
    const many = Array.from({ length: 30 }, (_, i) => `n/${i}.md`);
    for (const p of many) await a.writeLocal(p, p);
    await a.scan();
    expect(server.livePaths().length).toBe(30);

    a.stop();
    for (const p of many) offlineDelete(a.fs, p); // «сдохла ФС» — всё исчезло

    const a2 = new TestDevice(server, 'A', a.fs, a.local);
    await a2.start();
    await a2.connectAndSync();

    expect(server.livePaths().length).toBe(30); // сервер не тронут
    expect(server.tombstones.size).toBe(0);
    a2.stop();
  });
});

describe('ложные delete от лага индекса (баг 2026-07-08: телефон удалял и воскрешал скачанное)', () => {
  it('файл, выпавший из листингов из-за гонки индексации, НЕ удаляется на сервере', async () => {
    const seeder = await bootDevice('S');
    await seeder.writeLocal('Coding/duq/archive/Agent-Prompts.md', 'prompts');
    await seeder.scan();
    seeder.stop();

    const phone = new TestDevice(server, 'phone');
    phone.app.indexLag = true; // мобильный Obsidian индексирует с задержкой
    await phone.start();
    await phone.connectAndSync(); // скачивает файл; markProcessed кладёт его в adapter-бакет

    // Гонка из прода: индекс догоняет ПОСЛЕ построения currentFiles, но ДО
    // снапшота listAllHiddenFilesInVault — файл выпадает из обоих листингов скана.
    const origList = phone.app.vault.adapter.list.bind(phone.app.vault.adapter);
    let indexed = false;
    phone.app.vault.adapter.list = async (dir: string) => {
      if (!indexed) { indexed = true; phone.app.indexNow(); }
      return origList(dir);
    };

    const emitted: FileChange[] = [];
    const fw = (phone.sm as any).fileWatcher;
    const forward = fw.onChangesDetected!;
    fw.onChangesDetected = (changes: FileChange[]) => { emitted.push(...changes); forward(changes); };

    await phone.scan();
    await phone.scan(); // и следующий тик тоже чист

    expect(emitted.filter(c => c.type === 'delete').map(c => c.path)).toEqual([]);
    expect(server.livePaths()).toContain('Coding/duq/archive/Agent-Prompts.md');
    expect(server.tombstones.size).toBe(0);
    phone.stop();
  });

  it('контроль: реально удалённый файл всё ещё удаляется', async () => {
    const a = await bootDevice('A');
    await a.writeLocal('real-delete.md', 'x');
    await a.scan();

    await a.deleteLocal('real-delete.md');
    await a.scan();

    expect(server.tombstones.has('real-delete.md')).toBe(true);
    a.stop();
  });
});

describe('stale-устройство и tombstone-floor', () => {
  it('устройство ниже floor получает fullState и НЕ пушит удаления из отсутствия', async () => {
    const a = await bootDevice('A');
    await a.writeLocal('f1.md', 'один');
    await a.writeLocal('f2.md', 'два');
    await a.scan();

    const b = await bootDevice('B');
    a.stop(); // A надолго офлайн

    await b.deleteLocal('f2.md');
    await b.scan();
    server.pruneAllTombstones(); // TTL вычистил tombstone — floor поднялся выше lastSeq A

    const a2 = new TestDevice(server, 'A', a.fs, a.local);
    await a2.start();
    await a2.connectAndSync(); // fullState

    // Сервер как источник правды: f2 удалён и локально, f1 жив; на сервер ничего не пушилось.
    expect(server.livePaths()).toEqual(['f1.md']);
    expect(await a2.readLocal('f2.md')).toBeNull();
    expect(await a2.readLocal('f1.md')).toBe('один');
    a2.stop(); b.stop();
  });
});

describe('конфликты и resurrection', () => {
  it('удаление на B при несинкнутой правке на A сохраняет conflict-копию', async () => {
    const a = await bootDevice('A');
    await a.writeLocal('draft.md', 'база');
    await a.scan();
    const b = await bootDevice('B');

    a.stomp.disconnect(); // A офлайн
    await a.writeLocal('draft.md', 'правка A без синка');
    await a.scan(); // уйдёт в pending

    await b.deleteLocal('draft.md');
    await b.scan();

    await a.connectAndSync(); // дельта приносит tombstone

    expect(await a.readLocal('draft.md')).toBeNull();
    const conflictCopy = a.localPaths().find(p => p.includes('(conflict'));
    expect(conflictCopy).toBeDefined();
    expect(await a.readLocal(conflictCopy!)).toBe('правка A без синка');
    a.stop(); b.stop();
  });

  it('конкурентная правка: A принимает серверную версию и сохраняет свою как конфликт', async () => {
    const a = await bootDevice('A');
    await a.writeLocal('note.md', 'база');
    await a.scan();
    const b = await bootDevice('B');

    a.stomp.disconnect();
    await a.writeLocal('note.md', 'версия A');
    await a.scan(); // pending upload

    await b.writeLocal('note.md', 'версия B');
    await b.scan(); // сервер уходит вперёд

    await a.connectAndSync();

    expect(await a.readLocal('note.md')).toBe('версия B');
    const conflictCopy = a.localPaths().find(p => p.includes('(conflict'));
    expect(conflictCopy).toBeDefined();
    expect(await a.readLocal(conflictCopy!)).toBe('версия A');
    // Сервер не затёрт stale-версией
    expect(server.files.get('note.md')).toBeDefined();
    a.stop(); b.stop();
  });

  it('re-create после увиденного удаления = подлинное воскрешение (baseSeq >= tomb.seq)', async () => {
    const a = await bootDevice('A');
    await a.writeLocal('phoenix.md', 'v1');
    await a.scan();
    const b = await bootDevice('B');

    await b.deleteLocal('phoenix.md');
    await b.scan();
    await a.flushDebounce(); // A видит tombstone (запоминает его seq)
    expect(await a.readLocal('phoenix.md')).toBeNull();

    await a.writeLocal('phoenix.md', 'v2 заново');
    await a.scan();
    await b.flushDebounce();

    expect(server.livePaths()).toEqual(['phoenix.md']);
    expect(server.tombstones.has('phoenix.md')).toBe(false); // tombstone снят
    expect(await b.readLocal('phoenix.md')).toBe('v2 заново');
    a.stop(); b.stop();
  });

  it('stale re-push на затомбстоненный путь отклоняется и не воскрешает файл', async () => {
    const a = await bootDevice('A');
    await a.writeLocal('stale.md', 'v1');
    await a.scan();
    const b = await bootDevice('B');

    b.stomp.disconnect(); // B офлайн — не узнает про удаление
    await a.deleteLocal('stale.md');
    await a.scan();

    // B офлайн правит файл (queue) и, реконнектнувшись, пушит pending ДО дельты —
    // худший порядок: сервер обязан отбить (baseSeq < tomb.seq).
    await b.writeLocal('stale.md', 'правка B в пустоту');
    await b.scan();
    b.stomp.goOnline();
    await (b.sm as any).processPendingOperations();

    expect(server.livePaths()).toEqual([]); // файл НЕ воскрес
    // Правка B не потеряна — лежит conflict-копией.
    const conflictCopy = b.localPaths().find(p => p.includes('(conflict'));
    expect(conflictCopy).toBeDefined();
    expect(await b.readLocal(conflictCopy!)).toBe('правка B в пустоту');
    a.stop(); b.stop();
  });
});
