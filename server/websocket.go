package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for now
	},
}

type Client struct {
	conn     *websocket.Conn
	deviceID string
	send     chan []byte
}

type Hub struct {
	clients    map[string]*Client
	broadcast  chan *BroadcastMessage
	register   chan *Client
	unregister chan *Client
	mu         sync.RWMutex
}

type BroadcastMessage struct {
	origin  string
	message []byte
}

func NewHub() *Hub {
	return &Hub{
		clients:    make(map[string]*Client),
		broadcast:  make(chan *BroadcastMessage, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			// Close existing connection for this device if any
			if existing, ok := h.clients[client.deviceID]; ok {
				close(existing.send)
				existing.conn.Close()
			}
			h.clients[client.deviceID] = client
			h.mu.Unlock()
			log.Printf("Device connected: %s (total: %d)", client.deviceID, len(h.clients))

		case client := <-h.unregister:
			h.mu.Lock()
			if existing, ok := h.clients[client.deviceID]; ok && existing == client {
				delete(h.clients, client.deviceID)
				close(client.send)
			}
			h.mu.Unlock()
			log.Printf("Device disconnected: %s (total: %d)", client.deviceID, len(h.clients))

		case msg := <-h.broadcast:
			h.mu.RLock()
			for deviceID, client := range h.clients {
				if deviceID != msg.origin {
					select {
					case client.send <- msg.message:
					default:
						// Client buffer full, skip
						log.Printf("Skipping message to %s: buffer full", deviceID)
					}
				}
			}
			h.mu.RUnlock()
		}
	}
}

func (h *Hub) Broadcast(origin string, msg interface{}) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	h.broadcast <- &BroadcastMessage{origin: origin, message: data}
	return nil
}

func (h *Hub) SendTo(deviceID string, msg interface{}) error {
	h.mu.RLock()
	client, ok := h.clients[deviceID]
	h.mu.RUnlock()

	if !ok {
		return nil // Client not connected
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	select {
	case client.send <- data:
	default:
		return nil // Buffer full
	}
	return nil
}

func (h *Hub) GetConnectedDevices() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	devices := make([]string, 0, len(h.clients))
	for deviceID := range h.clients {
		devices = append(devices, deviceID)
	}
	return devices
}

type WSHandler struct {
	hub     *Hub
	sync    *SyncManager
	auth    *AuthManager
	storage *Storage
}

func NewWSHandler(hub *Hub, sync *SyncManager, auth *AuthManager, storage *Storage) *WSHandler {
	return &WSHandler{
		hub:     hub,
		sync:    sync,
		auth:    auth,
		storage: storage,
	}
}

func (h *WSHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Get token from query parameter or header
	token := r.URL.Query().Get("token")
	if token == "" {
		token = r.Header.Get("X-Auth-Token")
	}

	deviceID, ok := h.auth.ValidateToken(token)
	if !ok {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Get device ID from query if not using device token
	if deviceID == "master" {
		deviceID = r.URL.Query().Get("device_id")
		if deviceID == "" {
			http.Error(w, "device_id required", http.StatusBadRequest)
			return
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("WebSocket upgrade error: %v", err)
		return
	}

	client := &Client{
		conn:     conn,
		deviceID: deviceID,
		send:     make(chan []byte, 256),
	}

	h.hub.register <- client

	go h.writePump(client)
	go h.readPump(client)
}

func (h *WSHandler) readPump(client *Client) {
	defer func() {
		h.hub.unregister <- client
		client.conn.Close()
	}()

	client.conn.SetReadLimit(50 * 1024 * 1024) // 50MB max message
	client.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	client.conn.SetPongHandler(func(string) error {
		client.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, message, err := client.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("WebSocket error from %s: %v", client.deviceID, err)
			}
			break
		}

		var msg SyncMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("Invalid message from %s: %v", client.deviceID, err)
			continue
		}

		// Update last seen
		h.auth.UpdateLastSeen(client.deviceID)

		// Handle message
		h.sync.HandleMessage(client.deviceID, &msg)
	}
}

func (h *WSHandler) writePump(client *Client) {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		client.conn.Close()
	}()

	for {
		select {
		case message, ok := <-client.send:
			client.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				client.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := client.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			client.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := client.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
