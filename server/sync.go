package main

import (
	"encoding/base64"
	"log"
	"sync"
)

// Client -> Server messages
type SyncMessage struct {
	Type        string            `json:"type"`
	DeviceID    string            `json:"deviceId"`
	Timestamp   int64             `json:"timestamp"`
	VectorClock map[string]int64  `json:"vectorClock"`
	Payload     interface{}       `json:"payload"`
}

type FileChangePayload struct {
	Path         string `json:"path"`
	Content      string `json:"content"` // Base64 encoded
	MTime        int64  `json:"mtime"`
	Hash         string `json:"hash"`
	PreviousHash string `json:"previousHash,omitempty"`
}

type FileDeletePayload struct {
	Path string `json:"path"`
}

type FileMovePayload struct {
	OldPath string `json:"oldPath"`
	NewPath string `json:"newPath"`
	Content string `json:"content"` // Base64 encoded
	MTime   int64  `json:"mtime"`
	Hash    string `json:"hash"`
}

// Server -> Client messages
type ServerMessage struct {
	Type         string      `json:"type"`
	OriginDevice string      `json:"originDevice"`
	Payload      interface{} `json:"payload"`
}

type FullSyncPayload struct {
	Files       []*FileInfo   `json:"files"`
	Tombstones  []*Tombstone  `json:"tombstones"`
	VectorClock map[string]int64 `json:"vectorClock"`
}

type ConflictPayload struct {
	Path          string             `json:"path"`
	ServerVersion *FileChangePayload `json:"serverVersion"`
	ClientVersion *FileChangePayload `json:"clientVersion"`
	Resolution    string             `json:"resolution"`
}

type SyncManager struct {
	storage            *Storage
	hub                *Hub
	conflictResolution string
	vectorClock        map[string]int64
	mu                 sync.RWMutex
}

func NewSyncManager(storage *Storage, hub *Hub, conflictResolution string) *SyncManager {
	return &SyncManager{
		storage:            storage,
		hub:                hub,
		conflictResolution: conflictResolution,
		vectorClock:        make(map[string]int64),
	}
}

// Vector clock operations
func (s *SyncManager) updateVectorClock(deviceID string, clientClock map[string]int64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Merge client's vector clock with server's
	for device, clock := range clientClock {
		if clock > s.vectorClock[device] {
			s.vectorClock[device] = clock
		}
	}

	// Increment for this device
	s.vectorClock[deviceID]++
}

func (s *SyncManager) getVectorClock() map[string]int64 {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make(map[string]int64)
	for k, v := range s.vectorClock {
		result[k] = v
	}
	return result
}

func compareVectorClocks(a, b map[string]int64) string {
	if a == nil || b == nil {
		return "unknown"
	}

	aGreater := false
	bGreater := false

	allDevices := make(map[string]bool)
	for device := range a {
		allDevices[device] = true
	}
	for device := range b {
		allDevices[device] = true
	}

	for device := range allDevices {
		aVal := a[device]
		bVal := b[device]

		if aVal > bVal {
			aGreater = true
		}
		if bVal > aVal {
			bGreater = true
		}
	}

	if aGreater && !bGreater {
		return "after" // a is newer
	}
	if bGreater && !aGreater {
		return "before" // b is newer
	}
	return "concurrent" // conflict
}

func (s *SyncManager) HandleMessage(deviceID string, msg *SyncMessage) {
	// Update vector clock
	if msg.VectorClock != nil {
		s.updateVectorClock(deviceID, msg.VectorClock)
	}
	switch msg.Type {
	case "file_change":
		s.handleFileChange(deviceID, msg)
	case "file_delete":
		s.handleFileDelete(deviceID, msg)
	case "file_move":
		s.handleFileMove(deviceID, msg)
	case "request_full_sync":
		s.sendFullSync(deviceID)
	case "request_file":
		s.handleRequestFile(deviceID, msg)
	case "ping":
		s.hub.SendTo(deviceID, ServerMessage{Type: "pong"})
	default:
		log.Printf("Unknown message type from %s: %s", deviceID, msg.Type)
	}
}

func (s *SyncManager) handleFileChange(deviceID string, msg *SyncMessage) {
	payload, ok := s.extractFileChangePayload(msg.Payload)
	if !ok {
		log.Printf("Invalid file_change payload from %s", deviceID)
		return
	}

	// Decode content
	content, err := base64.StdEncoding.DecodeString(payload.Content)
	if err != nil {
		log.Printf("Failed to decode content from %s: %v", deviceID, err)
		return
	}

	// Check for conflicts
	existingHash := s.storage.GetFileHash(payload.Path)
	if existingHash != "" && payload.PreviousHash != "" && existingHash != payload.PreviousHash {
		// Conflict detected
		s.handleConflict(deviceID, payload, existingHash)
		return
	}

	// Save file
	if err := s.storage.WriteFile(payload.Path, content, payload.MTime); err != nil {
		log.Printf("Failed to write file %s: %v", payload.Path, err)
		return
	}

	log.Printf("File saved: %s (from %s)", payload.Path, deviceID)

	// Broadcast to other devices
	s.hub.Broadcast(deviceID, ServerMessage{
		Type:         "file_changed",
		OriginDevice: deviceID,
		Payload:      payload,
	})
}

func (s *SyncManager) handleFileDelete(deviceID string, msg *SyncMessage) {
	payload, ok := s.extractFileDeletePayload(msg.Payload)
	if !ok {
		log.Printf("Invalid file_delete payload from %s", deviceID)
		return
	}

	// Delete physical file
	if err := s.storage.DeleteFile(payload.Path); err != nil {
		log.Printf("Failed to delete file %s: %v", payload.Path, err)
		// Continue anyway - file might not exist
	}

	// Create tombstone with current vector clock
	currentClock := s.getVectorClock()
	s.storage.CreateTombstone(payload.Path, deviceID, currentClock)

	log.Printf("File deleted: %s (from %s), tombstone created", payload.Path, deviceID)

	// Broadcast to other devices
	s.hub.Broadcast(deviceID, ServerMessage{
		Type:         "file_deleted",
		OriginDevice: deviceID,
		Payload:      payload,
	})
}

func (s *SyncManager) handleFileMove(deviceID string, msg *SyncMessage) {
	payload, ok := s.extractFileMovePayload(msg.Payload)
	if !ok {
		log.Printf("Invalid file_move payload from %s", deviceID)
		return
	}

	// Decode content
	content, err := base64.StdEncoding.DecodeString(payload.Content)
	if err != nil {
		log.Printf("Failed to decode content from %s: %v", deviceID, err)
		return
	}

	// Delete old file first
	if err := s.storage.DeleteFile(payload.OldPath); err != nil {
		log.Printf("Failed to delete old file %s during move: %v", payload.OldPath, err)
		// Continue anyway - file might not exist on server
	}

	// Write new file
	if err := s.storage.WriteFile(payload.NewPath, content, payload.MTime); err != nil {
		log.Printf("Failed to write new file %s during move: %v", payload.NewPath, err)
		return
	}

	log.Printf("File moved: %s -> %s (from %s)", payload.OldPath, payload.NewPath, deviceID)

	// Broadcast to other devices
	s.hub.Broadcast(deviceID, ServerMessage{
		Type:         "file_moved",
		OriginDevice: deviceID,
		Payload:      payload,
	})
}

func (s *SyncManager) handleConflict(deviceID string, clientVersion *FileChangePayload, serverHash string) {
	log.Printf("Conflict detected for %s from %s", clientVersion.Path, deviceID)

	switch s.conflictResolution {
	case "last_write_wins":
		// Get server file mtime to compare
		serverInfo, err := s.storage.GetFileInfo(clientVersion.Path)
		if err != nil {
			log.Printf("Failed to get server file info for %s: %v", clientVersion.Path, err)
			return
		}

		// Compare mtimes - only accept client version if it's actually newer
		if clientVersion.MTime <= serverInfo.ModTime {
			log.Printf("Conflict resolved (server wins - newer mtime %d > %d): %s",
				serverInfo.ModTime, clientVersion.MTime, clientVersion.Path)

			// Send server version back to client
			serverContent, err := s.storage.ReadFile(clientVersion.Path)
			if err != nil {
				log.Printf("Failed to read server file: %v", err)
				return
			}

			serverVersion := &FileChangePayload{
				Path:    clientVersion.Path,
				Content: base64.StdEncoding.EncodeToString(serverContent),
				MTime:   serverInfo.ModTime,
				Hash:    serverHash,
			}

			// Send updated version to the client that had old data
			s.hub.SendTo(deviceID, ServerMessage{
				Type:         "file_changed",
				OriginDevice: "server",
				Payload:      serverVersion,
			})
			return
		}

		// Client version is newer - accept it
		content, _ := base64.StdEncoding.DecodeString(clientVersion.Content)
		if err := s.storage.WriteFile(clientVersion.Path, content, clientVersion.MTime); err != nil {
			log.Printf("Failed to resolve conflict for %s: %v", clientVersion.Path, err)
			return
		}

		log.Printf("Conflict resolved (client wins - newer mtime %d > %d): %s",
			clientVersion.MTime, serverInfo.ModTime, clientVersion.Path)

		// Broadcast to other devices
		s.hub.Broadcast(deviceID, ServerMessage{
			Type:         "file_changed",
			OriginDevice: deviceID,
			Payload:      clientVersion,
		})

	case "manual":
		// Read server version
		serverContent, err := s.storage.ReadFile(clientVersion.Path)
		if err != nil {
			log.Printf("Failed to read server version for conflict: %v", err)
			return
		}

		serverInfo, _ := s.storage.GetFileInfo(clientVersion.Path)

		serverVersion := &FileChangePayload{
			Path:    clientVersion.Path,
			Content: base64.StdEncoding.EncodeToString(serverContent),
			MTime:   serverInfo.ModTime,
			Hash:    serverHash,
		}

		// Send conflict to client for resolution
		s.hub.SendTo(deviceID, ServerMessage{
			Type: "conflict",
			Payload: ConflictPayload{
				Path:          clientVersion.Path,
				ServerVersion: serverVersion,
				ClientVersion: clientVersion,
				Resolution:    "manual",
			},
		})
	}
}

func (s *SyncManager) sendFullSync(deviceID string) {
	files, err := s.storage.ListFiles()
	if err != nil {
		log.Printf("Failed to list files for full sync: %v", err)
		return
	}

	tombstones := s.storage.ListTombstones()
	vectorClock := s.getVectorClock()

	log.Printf("Sending full sync to %s: %d files, %d tombstones", deviceID, len(files), len(tombstones))

	s.hub.SendTo(deviceID, ServerMessage{
		Type: "full_sync",
		Payload: FullSyncPayload{
			Files:       files,
			Tombstones:  tombstones,
			VectorClock: vectorClock,
		},
	})
}

func (s *SyncManager) handleRequestFile(deviceID string, msg *SyncMessage) {
	payload, ok := s.extractFileDeletePayload(msg.Payload) // Same structure - just path
	if !ok {
		log.Printf("Invalid request_file payload from %s", deviceID)
		return
	}

	content, err := s.storage.ReadFile(payload.Path)
	if err != nil {
		log.Printf("Failed to read file %s for %s: %v", payload.Path, deviceID, err)
		return
	}

	fileInfo, err := s.storage.GetFileInfo(payload.Path)
	if err != nil {
		log.Printf("Failed to get file info %s for %s: %v", payload.Path, deviceID, err)
		return
	}

	log.Printf("Sending file %s to %s (%d bytes)", payload.Path, deviceID, len(content))

	s.hub.SendTo(deviceID, ServerMessage{
		Type:         "file_changed",
		OriginDevice: "server",
		Payload: &FileChangePayload{
			Path:    payload.Path,
			Content: base64.StdEncoding.EncodeToString(content),
			MTime:   fileInfo.ModTime,
			Hash:    fileInfo.Hash,
		},
	})
}

func (s *SyncManager) extractFileChangePayload(payload interface{}) (*FileChangePayload, bool) {
	if payload == nil {
		return nil, false
	}

	// Handle map conversion
	data, ok := payload.(map[string]interface{})
	if !ok {
		return nil, false
	}

	result := &FileChangePayload{}

	if path, ok := data["path"].(string); ok {
		result.Path = path
	} else {
		return nil, false
	}

	if content, ok := data["content"].(string); ok {
		result.Content = content
	} else {
		return nil, false
	}

	if mtime, ok := data["mtime"].(float64); ok {
		result.MTime = int64(mtime)
	}

	if hash, ok := data["hash"].(string); ok {
		result.Hash = hash
	}

	if prevHash, ok := data["previousHash"].(string); ok {
		result.PreviousHash = prevHash
	}

	return result, true
}

func (s *SyncManager) extractFileDeletePayload(payload interface{}) (*FileDeletePayload, bool) {
	if payload == nil {
		return nil, false
	}

	data, ok := payload.(map[string]interface{})
	if !ok {
		return nil, false
	}

	result := &FileDeletePayload{}

	if path, ok := data["path"].(string); ok {
		result.Path = path
	} else {
		return nil, false
	}

	return result, true
}

func (s *SyncManager) extractFileMovePayload(payload interface{}) (*FileMovePayload, bool) {
	if payload == nil {
		return nil, false
	}

	data, ok := payload.(map[string]interface{})
	if !ok {
		return nil, false
	}

	result := &FileMovePayload{}

	if oldPath, ok := data["oldPath"].(string); ok {
		result.OldPath = oldPath
	} else {
		return nil, false
	}

	if newPath, ok := data["newPath"].(string); ok {
		result.NewPath = newPath
	} else {
		return nil, false
	}

	if content, ok := data["content"].(string); ok {
		result.Content = content
	} else {
		return nil, false
	}

	if mtime, ok := data["mtime"].(float64); ok {
		result.MTime = int64(mtime)
	}

	if hash, ok := data["hash"].(string); ok {
		result.Hash = hash
	}

	return result, true
}
