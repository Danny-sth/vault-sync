package com.vaultsync;

/**
 * Описание дополнительного волта ({@code vault-sync.extra-vaults[]}).
 *
 * <p>Каждый доп. волт изолирован: свой {@code port}, {@code storagePath}, токены и H2-БД
 * ({@code dbPath}). {@link #toArgs()} отдаёт это как command-line аргументы ({@code --key=val})
 * для дочернего Spring-контекста — именно command-line, т.к. он имеет ВЫСШИЙ приоритет и
 * перебивает {@code application.yml} из jar (а {@code SpringApplicationBuilder.properties()} —
 * это defaultProperties с НИЗШИМ приоритетом, их application.yml перекрывает).
 */
public record ExtraVault(
        String id,
        int port,
        String storagePath,
        String token,
        String mcpToken,
        String dbPath,
        String commandsPath) {

    String[] toArgs() {
        String data = dbPath != null ? dbPath : (storagePath + "/.vault-sync-meta");
        String commands = commandsPath != null ? commandsPath : (data + "/commands");
        return new String[] {
            "--server.port=" + port,
            // За nginx — plain HTTP, без своего SSL/keystore.
            "--server.ssl.enabled=false",
            "--vault-sync.storage-path=" + storagePath,
            "--vault-sync.token=" + token,
            "--vault-sync.mcp-token=" + mcpToken,
            "--spring.datasource.url=jdbc:h2:file:" + data + "/metadata;DB_CLOSE_DELAY=-1",
            "--vault-sync.commands-path=" + commands,
            "--spring.ai.mcp.server.name=vault-sync-" + id,
            // Дочерний контекст не поднимает ещё доп. волты (рекурсия) — список пуст.
            "--vault-sync.extra-vaults=",
        };
    }
}
