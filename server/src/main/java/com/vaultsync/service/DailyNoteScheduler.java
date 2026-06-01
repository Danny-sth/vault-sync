package com.vaultsync.service;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/**
 * Creates the daily note inside the vault — fully in-process, no systemd timer.
 *
 * Runs every day at 00:01 (user timezone) and once on startup. If today's note
 * already exists it is left untouched. The created file is picked up by the
 * filesystem watcher and synced to all devices like any other change.
 *
 * Lives in the server jar (repository), so it travels with the deployment and
 * survives host migrations — unlike the old external systemd timer.
 */
@Service
public class DailyNoteScheduler {

    private static final Logger log = LoggerFactory.getLogger(DailyNoteScheduler.class);
    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("dd.MM.yyyy");

    @Value("${vault-sync.storage-path}")
    private String storagePath;

    /** Timezone in which "today" is computed. Desktop is +05, server is UTC. */
    @Value("${vault-sync.daily-note.timezone:Asia/Almaty}")
    private String timezone;

    /** On startup: create today's note if it is missing. */
    @PostConstruct
    public void onStartup() {
        createTodayNote("startup");
    }

    /** Every day at 00:01 in the configured timezone. */
    @Scheduled(cron = "0 1 0 * * *", zone = "${vault-sync.daily-note.timezone:Asia/Almaty}")
    public void scheduled() {
        createTodayNote("cron");
    }

    private void createTodayNote(String trigger) {
        try {
            LocalDate today = LocalDate.now(ZoneId.of(timezone));
            String name = today.format(DATE_FMT);
            Path dailyDir = Paths.get(storagePath, "Daily");
            Path notePath = dailyDir.resolve(name + ".md");

            if (Files.exists(notePath)) {
                log.debug("[DailyNote] ({}) already exists: {}", trigger, notePath);
                return;
            }

            Files.createDirectories(dailyDir);

            Path template = dailyDir.resolve("Templates").resolve("Daily note template.md");
            String content;
            if (Files.exists(template)) {
                content = Files.readString(template).replace("{{date:DD.MM.YYYY}}", name);
            } else {
                content = basicTemplate(name);
            }

            Files.writeString(notePath, content);
            log.info("[DailyNote] ({}) created: {}", trigger, notePath);
        } catch (Exception e) {
            log.error("[DailyNote] ({}) failed to create today's note", trigger, e);
        }
    }

    private String basicTemplate(String today) {
        return """
                ---
                date: %s
                processed: false
                icon: LiCalendarDays
                banner: "[[attachments/banner-rubber-duck.jpg]]"
                banner_icon: 📅
                banner_header: %s
                banner_y: 50.0%%
                ---

                # ✨ %s

                ## MOEX

                ## Прочее

                """.formatted(today, today, today);
    }
}
