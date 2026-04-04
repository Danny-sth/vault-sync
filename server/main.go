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
	"time"
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

	// Initialize SSE broker
	broker := NewSSEBroker()

	// Start tombstone cleanup goroutine (runs daily)
	go func() {
		ticker := time.NewTicker(24 * time.Hour)
		defer ticker.Stop()

		for range ticker.C {
			count := storage.CleanupExpiredTombstones()
			if count > 0 {
				log.Printf("Cleaned up %d expired tombstones", count)
			}
		}
	}()

	// Initialize HTTP handler
	httpHandler := NewHTTPHandler(storage, auth, broker)

	// Setup HTTP routes
	mux := http.NewServeMux()

	// SSE endpoint for real-time notifications
	mux.HandleFunc("/api/events", httpHandler.HandleSSE)

	// File operations
	mux.HandleFunc("/api/upload", httpHandler.HandleUpload)
	mux.HandleFunc("/api/download/", httpHandler.HandleDownload)
	mux.HandleFunc("/api/delete/", httpHandler.HandleDelete)
	mux.HandleFunc("/api/list", httpHandler.HandleList)

	// Health check
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":  "ok",
			"clients": len(broker.clients),
			"storage": config.Storage.Path,
		})
	})

	// Token management
	mux.HandleFunc("/api/token", auth.HandleGenerateToken)
	mux.HandleFunc("/api/devices", auth.HandleListDevices)

	// Create server
	addr := fmt.Sprintf(":%d", config.Server.Port)
	server := &http.Server{
		Addr:    addr,
		Handler: corsMiddleware(logMiddleware(mux)),
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

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Auth-Token")
		
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		
		next.ServeHTTP(w, r)
	})
}
