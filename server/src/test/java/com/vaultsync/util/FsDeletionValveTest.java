package com.vaultsync.util;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Инцидент 2026-07-09: rekey на живом сервере → вотчер натворил 781 tombstone для
 * файлов, которые никто не удалял. Клапан обязан душить такие всплески, но не мешать
 * штучным legitimate-удалениям с диска.
 */
class FsDeletionValveTest {

    // Сценарий инцидента: reconcile видит 781 «пропавший» файл → батч отклонён.
    @Test
    void reconcileBatchOfIncidentSizeIsRefused() {
        FsDeletionValve valve = new FsDeletionValve(60_000, 20);
        assertFalse(valve.batchAllowed(781));
    }

    @Test
    void smallReconcileBatchIsAllowed() {
        FsDeletionValve valve = new FsDeletionValve(60_000, 20);
        assertTrue(valve.batchAllowed(20));
        assertTrue(valve.batchAllowed(0));
        assertFalse(valve.batchAllowed(21));
    }

    // rm -rf приходит не батчем, а штучными inotify-событиями — окно должно закрыться.
    @Test
    void eventStormIsCappedWithinWindow() {
        FsDeletionValve valve = new FsDeletionValve(60_000, 20);
        long t = 1_000_000;
        for (int i = 0; i < 20; i++) {
            assertTrue(valve.allowOne(t + i), "удаление #" + i + " в пределах бюджета");
        }
        assertFalse(valve.allowOne(t + 21), "21-е удаление за окно — подавлено");
        assertFalse(valve.allowOne(t + 22));
    }

    @Test
    void windowResetsAfterExpiry() {
        FsDeletionValve valve = new FsDeletionValve(60_000, 20);
        long t = 1_000_000;
        for (int i = 0; i < 20; i++) assertTrue(valve.allowOne(t));
        assertFalse(valve.allowOne(t + 1));
        // окно истекло → бюджет восстановлен
        assertTrue(valve.allowOne(t + 60_001));
    }

    @Test
    void tripIsLoggedExactlyOncePerWindow() {
        FsDeletionValve valve = new FsDeletionValve(60_000, 1);
        long t = 5_000_000;
        assertTrue(valve.allowOne(t));
        assertFalse(valve.allowOne(t + 1));
        assertTrue(valve.shouldLogTrip(), "первый трип окна — логируем");
        assertFalse(valve.shouldLogTrip(), "повторно в том же окне — молчим");
        // новое окно → снова можно логировать при новом трипе
        assertTrue(valve.allowOne(t + 60_001));
        assertFalse(valve.allowOne(t + 60_002));
        assertTrue(valve.shouldLogTrip());
    }
}
