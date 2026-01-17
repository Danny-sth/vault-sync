package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	configPath := flag.String("config", "", "Path to config file")
	flag.Parse()

	// Load configuration
	config, err := LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	// Validate master token
	if config.Auth.MasterToken == "" {
		log.Fatal("VAULT_SYNC_TOKEN environment variable is required")
	}

	// Initialize storage
	storage, err := NewStorage(config.Storage.Path, config.Sync.MaxFileSizeMB)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}
	log.Printf("Storage initialized: %s", config.Storage.Path)

	// Initialize auth
	auth := NewAuthManager(config.Auth.MasterToken)

	// Initialize hub
	hub := NewHub()
	go hub.Run()

	// Initialize sync manager
	syncManager := NewSyncManager(storage, hub, config.Sync.ConflictResolution)

	// Initialize WebSocket handler
	wsHandler := NewWSHandler(hub, syncManager, auth, storage)

	// Setup HTTP routes
	mux := http.NewServeMux()

	// WebSocket endpoint
	mux.Handle("/ws", wsHandler)

	// Health check
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":    "ok",
			"devices":   len(hub.GetConnectedDevices()),
			"storage":   config.Storage.Path,
		})
	})

	// Debug: list files (requires auth)
	mux.HandleFunc("/api/files", func(w http.ResponseWriter, r *http.Request) {
		token := r.Header.Get("Authorization")
		if token != "Bearer "+config.Auth.MasterToken {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		files, err := storage.ListFiles()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(files)
	})

	// Token management
	mux.HandleFunc("/api/token", auth.HandleGenerateToken)
	mux.HandleFunc("/api/devices", auth.HandleListDevices)

	// Create server
	addr := fmt.Sprintf(":%d", config.Server.Port)
	server := &http.Server{
		Addr:    addr,
		Handler: logMiddleware(mux),
	}

	// Graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan
		log.Println("Shutting down...")
		server.Close()
	}()

	// Start server
	if config.Server.TLS.Enabled {
		log.Printf("Starting TLS server on %s", addr)
		err = server.ListenAndServeTLS(config.Server.TLS.Cert, config.Server.TLS.Key)
	} else {
		log.Printf("Starting server on %s (TLS disabled)", addr)
		err = server.ListenAndServe()
	}

	if err != nil && err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}
}

func logMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s %s", r.Method, r.URL.Path, r.RemoteAddr)
		next.ServeHTTP(w, r)
	})
}
