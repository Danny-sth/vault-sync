import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveSettings, isUuid } from '../settings';
import { StompClient } from '../sync/StompClient';
import { SyncApiClient } from '../sync/SyncApiClient';
import { DEFAULT_SETTINGS, ServerMessage } from '../types';
import { InMemoryServer } from './harness/InMemoryServer';
import { TestDevice, makeLocalStateStore } from './harness/TestDevice';
import { makeFsStore } from './harness/FakeApp';

/**
 * Все id плагина — UUID (требование Дениса 24.10.2026): deviceId, requestId sync-запроса,
 * uploadId чанковой загрузки. Сохранённый deviceId старого формата («linux-desktop»,
 * «device-xxxx») один раз заменяется на UUID при загрузке настроек.
 */

const requestUrl = vi.hoisted(() => vi.fn());
vi.mock('obsidian', async (orig) => ({ ...(await orig<typeof import('obsidian')>()), requestUrl }));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deviceId — UUID', () => {
  it('новое устройство получает UUID и сохраняет его сразу', () => {
    const r = resolveSettings(null);
    expect(r.settings.deviceId).toMatch(UUID);
    expect(r.save).toBe(true);
  });

  it('два новых устройства получают разные id', () => {
    expect(resolveSettings(null).settings.deviceId).not.toBe(resolveSettings(null).settings.deviceId);
  });

  it.each(['linux-desktop', 'android-phone', 'device-k3j9x0ab', ''])(
    'старый формат «%s» один раз меняется на UUID, остальные настройки целы',
    (old) => {
      const stored = { deviceId: old, serverUrl: 'wss://x/ws', token: 't', deviceName: 'ноут', encryptionEnabled: true };
      const first = resolveSettings(stored);
      expect(first.settings.deviceId).toMatch(UUID);
      expect(first.save).toBe(true);
      expect(first.settings).toMatchObject({ serverUrl: 'wss://x/ws', token: 't', deviceName: 'ноут', encryptionEnabled: true });

      const again = resolveSettings({ ...stored, deviceId: first.settings.deviceId });
      expect(again.settings.deviceId).toBe(first.settings.deviceId);
      expect(again.save).toBe(false);
    },
  );

  it('isUuid: принимает UUID любой версии, отвергает прочее', () => {
    expect(isUuid('0190b8e2-7c1a-7e3f-8a12-3456789abcde')).toBe(true);
    expect(isUuid('0190B8E2-7C1A-4E3F-8A12-3456789ABCDE')).toBe(true);
    expect(isUuid('linux-desktop')).toBe(false);
    expect(isUuid('0190b8e2-7c1a-7e3f-8a12-3456789abcdeX')).toBe(false);
  });
});

describe('requestId sync-запроса — UUID', () => {
  it('requestSync шлёт UUID и разрешается ответом с ним же', async () => {
    const stomp = new StompClient({ syncTimeoutMs: 1000 });
    const published: { destination: string; body: string }[] = [];
    (stomp as any).client = { connected: true, publish: (f: { destination: string; body: string }) => published.push(f) };
    (stomp as any).deviceId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

    const pending = stomp.requestSync(5);
    const sent = JSON.parse(published[0].body);
    expect(sent.requestId).toMatch(UUID);

    // ответ сервера приходит в /user/queue/sync — резолвит именно этот запрос
    const handlers: Record<string, (m: { body: string }) => void> = {};
    (stomp as any).client.subscribe = (dest: string, cb: (m: { body: string }) => void) => {
      handlers[dest] = cb;
      return { unsubscribe() {} };
    };
    (stomp as any).setupSubscriptions();
    handlers['/user/queue/sync']({
      body: JSON.stringify({ type: 'sync_response', requestId: sent.requestId, currentSeq: 7, files: [], tombstones: [] }),
    });
    await expect(pending).resolves.toMatchObject({ currentSeq: 7 });
  });
});

describe('эхо после смены deviceId', () => {
  it('broadcast со своим новым UUID отбрасывается, с чужим id — доходит', () => {
    const { settings } = resolveSettings({ deviceId: 'linux-desktop' });
    const stomp = new StompClient();
    const got: ServerMessage[] = [];
    stomp.setMessageHandler((m) => got.push(m));
    const handlers: Record<string, (m: { body: string }) => void> = {};
    (stomp as any).client = {
      connected: true,
      subscribe: (dest: string, cb: (m: { body: string }) => void) => {
        handlers[dest] = cb;
        return { unsubscribe() {} };
      },
    };
    (stomp as any).deviceId = settings.deviceId;
    (stomp as any).setupSubscriptions();

    const msg = (deviceId: string) => ({
      body: JSON.stringify({ type: 'file_changed', path: 'a.md', hash: 'h', mtime: 1, size: 1, seq: 9, deviceId }),
    });
    handlers['/topic/sync'](msg(settings.deviceId));
    expect(got).toHaveLength(0);
    handlers['/topic/sync'](msg('android-phone'));
    expect(got).toHaveLength(1);
  });

  it('устройство после смены id продолжает синк в обе стороны без conflict-копий', async () => {
    const server = new InMemoryServer();
    const fs = makeFsStore();
    const local = makeLocalStateStore();

    const oldId = 'linux-desktop';
    let a = new TestDevice(server, oldId, fs, local);
    await a.start();
    await a.connectAndSync();
    const b = new TestDevice(server, resolveSettings(null).settings.deviceId);
    await b.start();
    await b.connectAndSync();

    await a.writeLocal('note.md', 'v1');
    await a.scan();
    await b.flushDebounce();
    expect(await b.readLocal('note.md')).toBe('v1');
    a.stop();

    // перезапуск Obsidian: настройки мигрируют, состояние синка (lastSeq, хэши) — то же
    const migrated = resolveSettings({ deviceId: oldId }).settings.deviceId;
    a = new TestDevice(server, migrated, fs, local);
    await a.start();
    await a.connectAndSync();

    await a.writeLocal('note.md', 'v2 с ноута');
    await a.scan();
    await b.flushDebounce();
    expect(await b.readLocal('note.md')).toBe('v2 с ноута');

    await b.writeLocal('note.md', 'v3 с телефона');
    await b.scan();
    await a.flushDebounce();
    expect(await a.readLocal('note.md')).toBe('v3 с телефона');

    expect(a.localPaths()).toEqual(['note.md']);
    expect(b.localPaths()).toEqual(['note.md']);
    expect(server.livePaths()).toEqual(['note.md']);
    a.stop(); b.stop();
  });
});

describe('uploadId чанковой загрузки — UUID', () => {
  beforeEach(() => requestUrl.mockReset());

  it('все чанки и finalize одной загрузки несут один и тот же UUID', async () => {
    requestUrl.mockResolvedValue({ status: 200, json: { seq: 3 } });
    const api = new SyncApiClient({ ...DEFAULT_SETTINGS, serverUrl: 'wss://h/ws', deviceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });

    await api.upload('big.bin', new ArrayBuffer(3 * 1024 * 1024 + 1), 'hash', 1);

    const ids = requestUrl.mock.calls.map(([req]) => req.headers['X-Upload-Id']);
    expect(ids).toHaveLength(5); // 4 чанка + finalize
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(UUID);
  });
});
