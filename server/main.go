package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for Obsidian plugin
	},
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lshortfile)
	log.Println("Starting vault-sync server...")

	// Load configuration
	cfg := LoadConfig()
	log.Printf("Config: port=%s, vault=%s, ttl=%d days", cfg.Port, cfg.VaultPath, cfg.TTLDays)

	// Initialize storage
	storage, err := NewStorage(cfg.VaultPath, cfg.TTLDays)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}

	// Initialize hub
	hub := NewHub()
	go hub.Run()

	// Initialize sync handler
	syncHandler := NewSyncHandler(storage, hub)

	// Initialize file watcher
	watcher, err := NewWatcher(cfg.VaultPath, storage, syncHandler)
	if err != nil {
		log.Fatalf("Failed to initialize watcher: %v", err)
	}
	if err := watcher.Start(); err != nil {
		log.Fatalf("Failed to start watcher: %v", err)
	}

	// Setup HTTP routes
	mux := http.NewServeMux()

	// Health check (no auth)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":   "ok",
			"sequence": storage.GetSequence(),
			"files":    len(storage.GetAllFiles()),
			"clients":  len(hub.GetConnectedDevices()),
		})
	})

	// WebSocket endpoint (with auth)
	mux.HandleFunc("/ws", AuthMiddleware(cfg.AuthToken, func(w http.ResponseWriter, r *http.Request) {
		handleWebSocket(w, r, hub, syncHandler)
	}))

	// Status endpoint (with auth)
	mux.HandleFunc("/status", AuthMiddleware(cfg.AuthToken, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"sequence":  storage.GetSequence(),
			"files":     len(storage.GetAllFiles()),
			"clients":   hub.GetConnectedDevices(),
			"vaultPath": cfg.VaultPath,
		})
	}))

	// Create server
	server := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	// Graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan

		log.Println("Shutting down...")

		// Stop watcher
		watcher.Stop()

		// Shutdown HTTP server
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(ctx)
	}()

	// Start server
	log.Printf("Server listening on :%s", cfg.Port)
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatalf("Server error: %v", err)
	}

	log.Println("Server stopped")
}

func handleWebSocket(w http.ResponseWriter, r *http.Request, hub *Hub, syncHandler *SyncHandler) {
	// Get device ID from query
	deviceID := r.URL.Query().Get("device")
	if deviceID == "" {
		http.Error(w, "device parameter required", http.StatusBadRequest)
		return
	}

	// Upgrade connection
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}

	// Create client
	client := &Client{
		conn:     conn,
		deviceID: deviceID,
		send:     make(chan []byte, 256),
	}

	// Register client
	hub.register <- client

	// Start pumps
	go client.WritePump()
	client.ReadPump(hub, syncHandler)
}
