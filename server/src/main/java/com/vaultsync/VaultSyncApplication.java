package com.vaultsync;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class VaultSyncApplication {
    public static void main(String[] args) {
        SpringApplication.run(VaultSyncApplication.class, args);
    }
}
