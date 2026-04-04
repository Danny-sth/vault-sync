package main

import (
	"log"
	"os"
	"strconv"
)

// Config holds server configuration
type Config struct {
	Port       string
	VaultPath  string
	AuthToken  string
	TTLDays    int
}

// LoadConfig loads configuration from environment variables
func LoadConfig() *Config {
	cfg := &Config{
		Port:      getEnv("PORT", "8080"),
		VaultPath: getEnv("VAULT_PATH", "./vault"),
		AuthToken: getEnv("AUTH_TOKEN", ""),
		TTLDays:   getEnvInt("TTL_DAYS", 14),
	}

	// Validate required config
	if cfg.AuthToken == "" {
		log.Fatal("AUTH_TOKEN environment variable is required")
	}

	return cfg
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if i, err := strconv.Atoi(value); err == nil {
			return i
		}
	}
	return defaultValue
}
