import { VaultSyncSettings, DEFAULT_SETTINGS } from './types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Настройки из data.json поверх умолчаний. deviceId — UUID: у нового устройства его нет,
 * у старых он прежнего формата («linux-desktop», «device-xxxx») — в обоих случаях выдаётся
 * crypto.randomUUID(), и `save` требует записать его сразу, чтобы id не менялся между запусками
 * (по нему клиент отбрасывает эхо своих правок).
 */
export function resolveSettings(stored: Partial<VaultSyncSettings> | null): { settings: VaultSyncSettings; save: boolean } {
  const settings = Object.assign({}, DEFAULT_SETTINGS, stored);
  if (isUuid(settings.deviceId)) return { settings, save: false };
  return { settings: { ...settings, deviceId: crypto.randomUUID() }, save: true };
}
