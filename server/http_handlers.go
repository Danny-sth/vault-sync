package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

// SSE client connection
type SSEClient struct {
	deviceID string
	channel  chan string
}

// SSE broker manages all SSE connections
type SSEBroker struct {
	clients map[string]*SSEClient
	mu      sync.RWMutex
}

func NewSSEBroker() *SSEBroker {
	return &SSEBroker{
		clients: make(map[string]*SSEClient),
	}
}

func (b *SSEBroker) AddClient(deviceID string, client *SSEClient) {
	b.mu.Lock()
	defer b.mu.Unlock()
	
	// Remove old client if exists
	if old, exists := b.clients[deviceID]; exists {
		close(old.channel)
	}
	
	b.clients[deviceID] = client
	log.Printf("SSE client added: %s (total: %d)", deviceID, len(b.clients))
}

func (b *SSEBroker) RemoveClient(deviceID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	
	if client, exists := b.clients[deviceID]; exists {
		close(client.channel)
		delete(b.clients, deviceID)
		log.Printf("SSE client removed: %s (total: %d)", deviceID, len(b.clients))
	}
}

func (b *SSEBroker) Broadcast(originDeviceID string, event string, data map[string]interface{}) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	
	jsonData, _ := json.Marshal(data)
	message := fmt.Sprintf("event: %s\ndata: %s\n\n", event, string(jsonData))
	
	for deviceID, client := range b.clients {
		if deviceID != originDeviceID {
			select {
			case client.channel <- message:
			default:
				log.Printf("SSE client %s channel full, skipping message", deviceID)
			}
		}
	}
}

// HTTP Handlers
type HTTPHandler struct {
	storage *Storage
	auth    *AuthManager
	broker  *SSEBroker
}

func NewHTTPHandler(storage *Storage, auth *AuthManager, broker *SSEBroker) *HTTPHandler {
	return &HTTPHandler{
		storage: storage,
		auth:    auth,
		broker:  broker,
	}
}

// SSE endpoint
func (h *HTTPHandler) HandleSSE(w http.ResponseWriter, r *http.Request) {
	// Validate auth
	token := r.URL.Query().Get("token")
	if token == "" {
		token = r.Header.Get("X-Auth-Token")
	}
	
	deviceID, ok := h.auth.ValidateToken(token)
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	
	if deviceID == "master" {
		deviceID = r.URL.Query().Get("device_id")
		if deviceID == "" {
			http.Error(w, "device_id required", http.StatusBadRequest)
			return
		}
	}
	
	// Set SSE headers
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
		return
	}
	
	// Create client
	client := &SSEClient{
		deviceID: deviceID,
		channel:  make(chan string, 100),
	}
	
	h.broker.AddClient(deviceID, client)
	defer h.broker.RemoveClient(deviceID)
	
	// Send initial connection message
	fmt.Fprintf(w, "event: connected\ndata: {\"deviceId\":\"%s\"}\n\n", deviceID)
	flusher.Flush()

	// Send immediate ping to keep connection alive on mobile
	fmt.Fprint(w, ": ping\n\n")
	flusher.Flush()

	// Update last seen
	h.auth.UpdateLastSeen(deviceID)

	// Stream events - ping every 2 seconds to keep connection alive
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	
	for {
		select {
		case msg := <-client.channel:
			fmt.Fprint(w, msg)
			flusher.Flush()
			h.auth.UpdateLastSeen(deviceID)
			
		case <-ticker.C:
			// Send ping to keep connection alive
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
			
		case <-r.Context().Done():
			return
		}
	}
}

// Upload file
func (h *HTTPHandler) HandleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	
	// Auth
	token := r.Header.Get("X-Auth-Token")
	deviceID, ok := h.auth.ValidateToken(token)
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	
	if deviceID == "master" {
		deviceID = r.URL.Query().Get("device_id")
		if deviceID == "" {
			http.Error(w, "device_id required", http.StatusBadRequest)
			return
		}
	}
	
	// Parse multipart form
	err := r.ParseMultipartForm(100 << 20) // 100MB max
	if err != nil {
		http.Error(w, "Failed to parse form", http.StatusBadRequest)
		return
	}
	
	path := r.FormValue("path")
	mtimeStr := r.FormValue("mtime")
	hash := r.FormValue("hash")
	
	if path == "" || hash == "" {
		http.Error(w, "Missing path or hash", http.StatusBadRequest)
		return
	}
	
	var mtime int64
	fmt.Sscanf(mtimeStr, "%d", &mtime)
	
	// Get file content
	file, _, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Missing file", http.StatusBadRequest)
		return
	}
	defer file.Close()
	
	content, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "Failed to read file", http.StatusInternalServerError)
		return
	}
	
	// Save file
	err = h.storage.WriteFile(path, content, mtime)
	if err != nil {
		log.Printf("Failed to save file %s: %v", path, err)
		http.Error(w, "Failed to save file", http.StatusInternalServerError)
		return
	}
	
	log.Printf("File uploaded: %s from %s (%d bytes)", path, deviceID, len(content))
	
	// Broadcast to other clients
	h.broker.Broadcast(deviceID, "file_changed", map[string]interface{}{
		"path":  path,
		"hash":  hash,
		"mtime": mtime,
		"size":  len(content),
	})
	
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// Download file
func (h *HTTPHandler) HandleDownload(w http.ResponseWriter, r *http.Request) {
	// Auth
	token := r.URL.Query().Get("token")
	if token == "" {
		token = r.Header.Get("X-Auth-Token")
	}
	
	_, ok := h.auth.ValidateToken(token)
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	
	// Get path from URL
	path := strings.TrimPrefix(r.URL.Path, "/api/download/")
	if path == "" {
		http.Error(w, "Missing path", http.StatusBadRequest)
		return
	}
	
	// Read file
	content, err := h.storage.ReadFile(path)
	if err != nil {
		log.Printf("Failed to read file %s: %v", path, err)
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}
	
	// Get file info for metadata
	fileInfo, err := h.storage.GetFileInfo(path)

	// Return file with metadata in headers
	w.Header().Set("Content-Type", "application/octet-stream")
	if err == nil && fileInfo != nil {
		w.Header().Set("X-File-Hash", fileInfo.Hash)
		w.Header().Set("X-File-Mtime", fmt.Sprintf("%d", fileInfo.ModTime))
	}
	w.Header().Set("Content-Length", fmt.Sprintf("%d", len(content)))
	
	w.WriteHeader(http.StatusOK)
	w.Write(content)
}

// Delete file
func (h *HTTPHandler) HandleDelete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	
	// Auth
	token := r.Header.Get("X-Auth-Token")
	deviceID, ok := h.auth.ValidateToken(token)
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	
	if deviceID == "master" {
		deviceID = r.URL.Query().Get("device_id")
		if deviceID == "" {
			http.Error(w, "device_id required", http.StatusBadRequest)
			return
		}
	}
	
	// Get path from URL
	path := strings.TrimPrefix(r.URL.Path, "/api/delete/")
	if path == "" {
		http.Error(w, "Missing path", http.StatusBadRequest)
		return
	}
	
	// Delete file
	err := h.storage.DeleteFile(path)
	if err != nil {
		log.Printf("Failed to delete file %s: %v", path, err)
		http.Error(w, "Failed to delete file", http.StatusInternalServerError)
		return
	}
	
	log.Printf("File deleted: %s by %s", path, deviceID)
	
	// Broadcast to other clients
	h.broker.Broadcast(deviceID, "file_deleted", map[string]interface{}{
		"path": path,
	})
	
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// List all files (for full sync)
func (h *HTTPHandler) HandleList(w http.ResponseWriter, r *http.Request) {
	// Auth
	token := r.URL.Query().Get("token")
	if token == "" {
		token = r.Header.Get("X-Auth-Token")
	}
	
	_, ok := h.auth.ValidateToken(token)
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	
	files := h.storage.GetAllFiles()
	tombstones := h.storage.GetTombstones()
	
	response := map[string]interface{}{
		"files":      files,
		"tombstones": tombstones,
	}
	
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}
