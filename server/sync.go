package main

import (
	"encoding/base64"
	"encoding/json"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

// Message types
const (
	MsgTypeSync       = "sync"
	MsgTypeFileChange = "file_change"
	MsgTypeFileDelete = "file_delete"

	MsgTypeSyncResponse = "sync_response"
	MsgTypeChange       = "change"
	MsgTypeDelete       = "delete"
	MsgTypeConflict     = "conflict"
	MsgTypeError        = "error"
)

// Incoming messages (Client → Server)

type IncomingMessage struct {
	Type string `json:"type"`
}

type SyncRequest struct {
	Type    string `json:"type"`
	LastSeq uint64 `json:"lastSeq"`
}

type FileChangeRequest struct {
	Type    string `json:"type"`
	Path    string `json:"path"`
	Content string `json:"content"` // base64 encoded
	MTime   int64  `json:"mtime"`   // Unix milliseconds
	Hash    string `json:"hash"`    // SHA-256 of content
}

type FileDeleteRequest struct {
	Type string `json:"type"`
	Path string `json:"path"`
}

// Outgoing messages (Server → Client)

type SyncResponse struct {
	Type       string       `json:"type"`
	CurrentSeq uint64       `json:"currentSeq"`
	Changes    []ChangeItem `json:"changes"`
}

type ChangeItem struct {
	Type    string `json:"type"` // "change" or "delete"
	Path    string `json:"path"`
	Content string `json:"content,omitempty"` // base64, only for "change"
	MTime   int64  `json:"mtime,omitempty"`   // only for "change"
	Seq     uint64 `json:"seq"`
}

type ChangeMessage struct {
	Type     string `json:"type"`
	Path     string `json:"path"`
	Content  string `json:"content"` // base64
	MTime    int64  `json:"mtime"`
	Seq      uint64 `json:"seq"`
	DeviceID string `json:"deviceId,omitempty"` // source device
}

type DeleteMessage struct {
	Type     string `json:"type"`
	Path     string `json:"path"`
	Seq      uint64 `json:"seq"`
	DeviceID string `json:"deviceId,omitempty"`
}

type ConflictMessage struct {
	Type          string `json:"type"`
	Path          string `json:"path"`
	ServerContent string `json:"serverContent"` // base64
	ServerMTime   int64  `json:"serverMtime"`
	ServerSeq     uint64 `json:"serverSeq"`
}

type ErrorMessage struct {
	Type    string `json:"type"`
	Message string `json:"message"`
}

// SyncHandler handles sync logic
type SyncHandler struct {
	storage *Storage
	hub     *Hub
}

// NewSyncHandler creates a new sync handler
func NewSyncHandler(storage *Storage, hub *Hub) *SyncHandler {
	return &SyncHandler{
		storage: storage,
		hub:     hub,
	}
}

// HandleMessage processes incoming WebSocket messages
func (s *SyncHandler) HandleMessage(client *Client, raw []byte) {
	var msg IncomingMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		s.sendError(client, "Invalid JSON")
		return
	}

	switch msg.Type {
	case MsgTypeSync:
		s.handleSync(client, raw)
	case MsgTypeFileChange:
		s.handleFileChange(client, raw)
	case MsgTypeFileDelete:
		s.handleFileDelete(client, raw)
	default:
		s.sendError(client, "Unknown message type: "+msg.Type)
	}
}

// handleSync processes sync request
func (s *SyncHandler) handleSync(client *Client, raw []byte) {
	var req SyncRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		s.sendError(client, "Invalid sync request")
		return
	}

	log.Printf("[%s] Sync request: lastSeq=%d", client.deviceID, req.LastSeq)

	files, deletions := s.storage.GetChangesSince(req.LastSeq)
	currentSeq := s.storage.GetSequence()

	changes := make([]ChangeItem, 0, len(files)+len(deletions))

	// Add file changes
	for _, f := range files {
		content, err := s.storage.ReadFile(f.Path)
		if err != nil {
			log.Printf("Error reading file %s: %v", f.Path, err)
			continue
		}

		changes = append(changes, ChangeItem{
			Type:    MsgTypeChange,
			Path:    f.Path,
			Content: base64.StdEncoding.EncodeToString(content),
			MTime:   f.MTime,
			Seq:     f.Seq,
		})
	}

	// Add deletions
	for _, d := range deletions {
		changes = append(changes, ChangeItem{
			Type: MsgTypeDelete,
			Path: d.Path,
			Seq:  d.Seq,
		})
	}

	resp := SyncResponse{
		Type:       MsgTypeSyncResponse,
		CurrentSeq: currentSeq,
		Changes:    changes,
	}

	s.sendToClient(client, resp)
	log.Printf("[%s] Sync response: currentSeq=%d, changes=%d (files=%d, deletions=%d)",
		client.deviceID, currentSeq, len(changes), len(files), len(deletions))
}

// handleFileChange processes file change from client
func (s *SyncHandler) handleFileChange(client *Client, raw []byte) {
	var req FileChangeRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		s.sendError(client, "Invalid file_change request")
		return
	}

	content, err := base64.StdEncoding.DecodeString(req.Content)
	if err != nil {
		s.sendError(client, "Invalid base64 content")
		return
	}

	log.Printf("[%s] File change: %s (size=%d, mtime=%d)", client.deviceID, req.Path, len(content), req.MTime)

	// Check for conflict
	existing := s.storage.GetFile(req.Path)
	if existing != nil && existing.Hash != req.Hash && existing.Hash != computeHash(content) {
		// Content differs - check mtime for Last-Write-Wins
		if req.MTime <= existing.MTime {
			// Server wins - send conflict response
			serverContent, err := s.storage.ReadFile(req.Path)
			if err != nil {
				s.sendError(client, "Error reading server file")
				return
			}

			conflict := ConflictMessage{
				Type:          MsgTypeConflict,
				Path:          req.Path,
				ServerContent: base64.StdEncoding.EncodeToString(serverContent),
				ServerMTime:   existing.MTime,
				ServerSeq:     existing.Seq,
			}
			s.sendToClient(client, conflict)
			log.Printf("[%s] Conflict: %s (client mtime=%d <= server mtime=%d)", client.deviceID, req.Path, req.MTime, existing.MTime)
			return
		}
		// Client wins - proceed with save
		log.Printf("[%s] Client wins conflict: %s (client mtime=%d > server mtime=%d)", client.deviceID, req.Path, req.MTime, existing.MTime)
	}

	// Save file
	seq, err := s.storage.WriteFile(req.Path, content, req.MTime)
	if err != nil {
		s.sendError(client, "Error writing file: "+err.Error())
		return
	}

	// Broadcast to other clients
	change := ChangeMessage{
		Type:     MsgTypeChange,
		Path:     req.Path,
		Content:  req.Content,
		MTime:    req.MTime,
		Seq:      seq,
		DeviceID: client.deviceID,
	}
	s.hub.BroadcastExcept(client.deviceID, change)

	log.Printf("[%s] File saved: %s (seq=%d)", client.deviceID, req.Path, seq)
}

// handleFileDelete processes file deletion from client
func (s *SyncHandler) handleFileDelete(client *Client, raw []byte) {
	var req FileDeleteRequest
	if err := json.Unmarshal(raw, &req); err != nil {
		s.sendError(client, "Invalid file_delete request")
		return
	}

	log.Printf("[%s] File delete: %s", client.deviceID, req.Path)

	seq, err := s.storage.DeleteFile(req.Path)
	if err != nil {
		s.sendError(client, "Error deleting file: "+err.Error())
		return
	}

	// Broadcast to other clients
	del := DeleteMessage{
		Type:     MsgTypeDelete,
		Path:     req.Path,
		Seq:      seq,
		DeviceID: client.deviceID,
	}
	s.hub.BroadcastExcept(client.deviceID, del)

	log.Printf("[%s] File deleted: %s (seq=%d)", client.deviceID, req.Path, seq)
}

// BroadcastChange broadcasts a file change to all clients
func (s *SyncHandler) BroadcastChange(path string, content []byte, mtime int64, seq uint64) {
	change := ChangeMessage{
		Type:     MsgTypeChange,
		Path:     path,
		Content:  base64.StdEncoding.EncodeToString(content),
		MTime:    mtime,
		Seq:      seq,
		DeviceID: "server",
	}
	s.hub.BroadcastJSON(change)
}

// BroadcastDelete broadcasts a file deletion to all clients
func (s *SyncHandler) BroadcastDelete(path string, seq uint64) {
	del := DeleteMessage{
		Type:     MsgTypeDelete,
		Path:     path,
		Seq:      seq,
		DeviceID: "server",
	}
	s.hub.BroadcastJSON(del)
}

// sendToClient sends a message to a specific client
func (s *SyncHandler) sendToClient(client *Client, msg interface{}) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Error marshaling message: %v", err)
		return
	}

	select {
	case client.send <- data:
	default:
		log.Printf("[%s] Send buffer full, dropping message", client.deviceID)
	}
}

// sendError sends an error message to client
func (s *SyncHandler) sendError(client *Client, message string) {
	s.sendToClient(client, ErrorMessage{
		Type:    MsgTypeError,
		Message: message,
	})
}

// ReadPump reads messages from WebSocket
func (c *Client) ReadPump(hub *Hub, handler *SyncHandler) {
	defer func() {
		hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(50 * 1024 * 1024) // 50MB max message
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("[%s] WebSocket error: %v", c.deviceID, err)
			}
			break
		}

		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		handler.HandleMessage(c, message)
	}
}
