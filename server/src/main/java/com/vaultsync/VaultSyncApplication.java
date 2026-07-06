package com.vaultsync;

import java.util.List;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.context.properties.bind.Bindable;
import org.springframework.boot.context.properties.bind.Binder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.core.env.Environment;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class VaultSyncApplication {

    public static void main(String[] args) {
        ConfigurableApplicationContext primary = SpringApplication.run(VaultSyncApplication.class, args);
        startExtraVaults(primary.getEnvironment());
    }

    /**
     * Опциональные ДОПОЛНИТЕЛЬНЫЕ волты в рамках этого же приложения.
     *
     * <p>Каждый доп. волт поднимается как самостоятельный Spring-контекст в том же JVM-процессе:
     * свой встроенный Tomcat + свой watcher-поток + своя H2-БД + свой storage-path и токены.
     * Включается списком {@code vault-sync.extra-vaults} в конфиге; по умолчанию список пуст —
     * работает только основной волт (владельца), поведение не меняется.
     *
     * <p>Так доп. волт (например, члена семьи) добавляется БЕЗ отдельного процесса/сервиса и БЕЗ
     * правок остального кода: существующие бины (FileStorageService, VaultWatcherService, sync,
     * datasource) инстанцируются в дочернем контексте с переопределёнными {@code vault-sync.*} и
     * {@code server.port}. Изоляция полная — отдельный поток и отдельная БД на волт.
     */
    static void startExtraVaults(Environment env) {
        List<ExtraVault> vaults = Binder.get(env)
                .bind("vault-sync.extra-vaults", Bindable.listOf(ExtraVault.class))
                .orElse(List.of());
        for (ExtraVault v : vaults) {
            // token/mcpToken included: without them toArgs() would pass the literal string
            // "null" as the auth token — an accidentally guessable credential.
            if (v.id() == null || v.port() == 0 || v.storagePath() == null
                    || v.token() == null || v.mcpToken() == null) {
                continue;
            }
            new SpringApplicationBuilder(VaultSyncApplication.class)
                    .run(v.toArgs());
        }
    }
}
