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
import java.nio.file.StandardCopyOption;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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
    private static final DateTimeFormatter MONTH_FMT = DateTimeFormatter.ofPattern("MM.yyyy");
    /** Daily note filename: DD.MM.YYYY.md */
    private static final Pattern NOTE_NAME = Pattern.compile("^(\\d{2})\\.(\\d{2})\\.(\\d{4})\\.md$");

    @Value("${vault-sync.storage-path}")
    private String storagePath;

    /** Timezone in which "today" is computed. Desktop is +05, server is UTC. */
    @Value("${vault-sync.daily-note.timezone:Asia/Almaty}")
    private String timezone;

    /** On startup: create today's note if missing + archive past months. */
    @PostConstruct
    public void onStartup() {
        createTodayNote("startup");
        archivePastMonths("startup");
    }

    /** Every day at 00:01 in the configured timezone. */
    @Scheduled(cron = "0 1 0 * * *", zone = "${vault-sync.daily-note.timezone:Asia/Almaty}")
    public void scheduled() {
        createTodayNote("cron");
        archivePastMonths("cron");
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

    /**
     * Keep only the current month's notes in the Daily/ root. Every note from a
     * previous month is moved into a Daily/MM.YYYY/ subfolder. Idempotent — runs
     * on startup and on the daily cron, so stragglers get archived too.
     */
    private void archivePastMonths(String trigger) {
        try {
            Path dailyDir = Paths.get(storagePath, "Daily");
            if (!Files.isDirectory(dailyDir)) {
                return;
            }
            String currentMonth = LocalDate.now(ZoneId.of(timezone)).format(MONTH_FMT); // MM.yyyy

            List<Path> files;
            try (var stream = Files.list(dailyDir)) {
                files = stream.filter(Files::isRegularFile).toList();
            }

            int moved = 0;
            for (Path p : files) {
                Matcher m = NOTE_NAME.matcher(p.getFileName().toString());
                if (!m.matches()) {
                    continue; // not a daily note (Templates/, other files)
                }
                String month = m.group(2) + "." + m.group(3); // MM.YYYY from filename
                if (month.equals(currentMonth)) {
                    continue; // current month stays in the root
                }
                Path archiveDir = dailyDir.resolve(month);
                Files.createDirectories(archiveDir);
                Files.move(p, archiveDir.resolve(p.getFileName()), StandardCopyOption.REPLACE_EXISTING);
                moved++;
                log.info("[DailyNote] ({}) archived {} -> Daily/{}/", trigger, p.getFileName(), month);
            }
            if (moved > 0) {
                log.info("[DailyNote] ({}) archived {} past-month note(s)", trigger, moved);
            }
        } catch (Exception e) {
            log.error("[DailyNote] ({}) archive failed", trigger, e);
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
