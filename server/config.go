package main

import (
	"encoding/json"
	"os"
	"strconv"
)

// Config holds server configuration
type Config struct {
	Server  ServerConfig  `json:"server"`
	Storage StorageConfig `json:"storage"`
	Auth    AuthConfig    `json:"auth"`
	Sync    SyncConfig    `json:"sync"`
}

type ServerConfig struct {
	Port int       `json:"port"`
	TLS  TLSConfig `json:"tls"`
}

type TLSConfig struct {
	Enabled bool   `json:"enabled"`
	Cert    string `json:"cert"`
	Key     string `json:"key"`
}

type StorageConfig struct {
	Path string `json:"path"`
}

type AuthConfig struct {
	MasterToken string `json:"masterToken"`
}

type SyncConfig struct {
	MaxFileSizeMB int `json:"maxFileSizeMB"`
	TTLDays       int `json:"ttlDays"`
}

// LoadConfig loads configuration from file or environment variables
func LoadConfig(configPath string) (*Config, error) {
	cfg := &Config{
		Server: ServerConfig{
			Port: getEnvInt("PORT", 8443),
			TLS: TLSConfig{
				Enabled: getEnvBool("TLS_ENABLED", false),
				Cert:    getEnv("TLS_CERT", ""),
				Key:     getEnv("TLS_KEY", ""),
			},
		},
		Storage: StorageConfig{
			Path: getEnv("VAULT_PATH", "/data"),
		},
		Auth: AuthConfig{
			MasterToken: getEnv("VAULT_SYNC_TOKEN", ""),
		},
		Sync: SyncConfig{
			MaxFileSizeMB: getEnvInt("MAX_FILE_SIZE_MB", 100),
			TTLDays:       getEnvInt("TTL_DAYS", 14),
		},
	}

	// Try to load from config file if provided
	if configPath != "" {
		data, err := os.ReadFile(configPath)
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(data, cfg); err != nil {
			return nil, err
		}
	}

	// Environment variables override config file
	if token := os.Getenv("VAULT_SYNC_TOKEN"); token != "" {
		cfg.Auth.MasterToken = token
	}

	return cfg, nil
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

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		if b, err := strconv.ParseBool(value); err == nil {
			return b
		}
	}
	return defaultValue
}
