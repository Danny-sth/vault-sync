package com.vaultsync.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
    /** Daily note filename: DD.MM.YYYY.md */
    private static final Pattern NOTE_NAME = Pattern.compile("^(\\d{2})\\.(\\d{2})\\.(\\d{4})\\.md$");
    /** Icon for month-archive folders — colourful emoji (matches existing "Archive": "📦"). */
    private static final String ARCHIVE_FOLDER_ICON = "📦";
    private static final String FOLDER_ICONS_FILE = ".obsidian/folder-icons.json";
    private final ObjectMapper json = new ObjectMapper();
    /** Latin month names for archive folder naming (Cyrillic breaks path sync). */
    private static final String[] MONTH_NAMES = {
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    };

    /** Archive folder name for a given month, e.g. (5, 2026) -> "May.2026". */
    private static String monthFolder(int month, int year) {
        return MONTH_NAMES[month - 1] + "." + year;
    }

    @Value("${vault-sync.storage-path}")
    private String storagePath;

    /** Timezone in which "today" is computed. Desktop is +05, server is UTC. */
    @Value("${vault-sync.daily-note.timezone:Asia/Almaty}")
    private String timezone;

    /**
     * On startup: create today's note if missing + archive past months.
     * Runs on ApplicationReadyEvent (NOT @PostConstruct) so the sync subsystem
     * is fully up — otherwise early writes to synced files (folder-icons.json)
     * race with device reconnects and get clobbered.
     */
    @EventListener(ApplicationReadyEvent.class)
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
            LocalDate now = LocalDate.now(ZoneId.of(timezone));
            String currentMonth = monthFolder(now.getMonthValue(), now.getYear());

            List<Path> files;
            try (var stream = Files.list(dailyDir)) {
                files = stream.filter(Files::isRegularFile).toList();
            }

            int moved = 0;
            for (Path p : files) {
                Matcher m = NOTE_NAME.matcher(p.getFileName().toString());
                if (!m.matches()) {
                    continue;
                }
                String month = monthFolder(Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)));
                if (month.equals(currentMonth)) {
                    continue;
                }
                Path archiveDir = dailyDir.resolve(month);
                Files.createDirectories(archiveDir);
                setFolderIcon("Daily/" + month, ARCHIVE_FOLDER_ICON);
                Files.move(p, archiveDir.resolve(p.getFileName()), StandardCopyOption.REPLACE_EXISTING);
                moved++;
                log.info("[DailyNote] ({}) archived {} -> Daily/{}/", trigger, p.getFileName(), month);
            }
            if (moved > 0) {
                log.info("[DailyNote] ({}) archived {} past-month note(s)", trigger, moved);
            }

            try (var dirs = Files.list(dailyDir)) {
                dirs.filter(Files::isDirectory)
                    .filter(d -> isMonthFolder(d.getFileName().toString()))
                    .forEach(d -> setFolderIcon("Daily/" + d.getFileName(), ARCHIVE_FOLDER_ICON));
            }
        } catch (Exception e) {
            log.error("[DailyNote] ({}) archive failed", trigger, e);
        }
    }

    /** True for folder names like "May.2026" (Latin month name + 4-digit year). */
    private static boolean isMonthFolder(String name) {
        int dot = name.indexOf('.');
        if (dot < 0 || !name.substring(dot + 1).matches("\\d{4}")) {
            return false;
        }
        String mon = name.substring(0, dot);
        for (String m : MONTH_NAMES) {
            if (m.equals(mon)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Assign a folder icon by writing into .obsidian/folder-icons.json — the same
     * map the plugin's FileIcons reads (folderPath -> Lucide icon name).
     * Read-merge-write to avoid clobbering icons set on devices.
     */
    private void setFolderIcon(String folderPath, String iconName) {
        try {
            Path iconsFile = Paths.get(storagePath, FOLDER_ICONS_FILE);
            Map<String, String> icons = new LinkedHashMap<>();
            if (Files.exists(iconsFile)) {
                try {
                    icons = json.readValue(Files.readString(iconsFile), new TypeReference<LinkedHashMap<String, String>>() {});
                } catch (Exception e) {
                    log.warn("[DailyNote] folder-icons.json unparsable, recreating: {}", e.getMessage());
                }
            }
            if (iconName.equals(icons.get(folderPath))) {
                return;
            }
            icons.put(folderPath, iconName);
            Files.createDirectories(iconsFile.getParent());
            Files.writeString(iconsFile, json.writerWithDefaultPrettyPrinter().writeValueAsString(icons));
            log.info("[DailyNote] folder icon set: {} -> {}", folderPath, iconName);
        } catch (Exception e) {
            log.error("[DailyNote] failed to set folder icon for {}", folderPath, e);
        }
    }

    private String basicTemplate(String today) {
        return """
                ---
                date: %s
                processed: false
                icon: 📅
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
