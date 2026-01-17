package main

import (
	"os"
	"strconv"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server  ServerConfig  `yaml:"server"`
	Storage StorageConfig `yaml:"storage"`
	Auth    AuthConfig    `yaml:"auth"`
	Sync    SyncConfig    `yaml:"sync"`
}

type ServerConfig struct {
	Port int       `yaml:"port"`
	TLS  TLSConfig `yaml:"tls"`
}

type TLSConfig struct {
	Enabled bool   `yaml:"enabled"`
	Cert    string `yaml:"cert"`
	Key     string `yaml:"key"`
}

type StorageConfig struct {
	Path string `yaml:"path"`
}

type AuthConfig struct {
	MasterToken string `yaml:"master_token"`
}

type SyncConfig struct {
	ConflictResolution string `yaml:"conflict_resolution"`
	DebounceMs         int    `yaml:"debounce_ms"`
	MaxFileSizeMB      int    `yaml:"max_file_size_mb"`
}

func LoadConfig(path string) (*Config, error) {
	config := &Config{
		Server: ServerConfig{
			Port: 8443,
			TLS: TLSConfig{
				Enabled: false,
			},
		},
		Storage: StorageConfig{
			Path: "/opt/sombra/obsidian-vault",
		},
		Auth: AuthConfig{},
		Sync: SyncConfig{
			ConflictResolution: "last_write_wins",
			DebounceMs:         500,
			MaxFileSizeMB:      50,
		},
	}

	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			if !os.IsNotExist(err) {
				return nil, err
			}
		} else {
			if err := yaml.Unmarshal(data, config); err != nil {
				return nil, err
			}
		}
	}

	// Override with environment variables
	if token := os.Getenv("VAULT_SYNC_TOKEN"); token != "" {
		config.Auth.MasterToken = token
	}
	if port := os.Getenv("VAULT_SYNC_PORT"); port != "" {
		if p, err := strconv.Atoi(port); err == nil {
			config.Server.Port = p
		}
	}
	if storagePath := os.Getenv("VAULT_SYNC_STORAGE"); storagePath != "" {
		config.Storage.Path = storagePath
	}
	if tlsCert := os.Getenv("VAULT_SYNC_TLS_CERT"); tlsCert != "" {
		config.Server.TLS.Cert = tlsCert
		config.Server.TLS.Enabled = true
	}
	if tlsKey := os.Getenv("VAULT_SYNC_TLS_KEY"); tlsKey != "" {
		config.Server.TLS.Key = tlsKey
	}

	return config, nil
}
