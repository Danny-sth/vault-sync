package main

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Client represents a connected WebSocket client
type Client struct {
	conn     *websocket.Conn
	deviceID string
	send     chan []byte
}

// Hub manages WebSocket connections
type Hub struct {
	clients    map[string]*Client
	register   chan *Client
	unregister chan *Client
	broadcast  chan []byte
	mu         sync.RWMutex
}

// NewHub creates a new hub
func NewHub() *Hub {
	return &Hub{
		clients:    make(map[string]*Client),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan []byte, 256),
	}
}

// Run starts the hub
func (h *Hub) Run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			// Close existing connection for this device
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

		case message := <-h.broadcast:
			h.mu.RLock()
			for _, client := range h.clients {
				select {
				case client.send <- message:
				default:
					// Buffer full, skip
				}
			}
			h.mu.RUnlock()
		}
	}
}

// BroadcastJSON sends a message to all connected clients
func (h *Hub) BroadcastJSON(msg interface{}) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	h.broadcast <- data
	return nil
}

// BroadcastExcept sends to all clients except one
func (h *Hub) BroadcastExcept(deviceID string, msg interface{}) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for id, client := range h.clients {
		if id != deviceID {
			select {
			case client.send <- data:
			default:
			}
		}
	}
	return nil
}

// SendTo sends a message to a specific client
func (h *Hub) SendTo(deviceID string, msg interface{}) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}

	h.mu.RLock()
	client, ok := h.clients[deviceID]
	h.mu.RUnlock()

	if !ok {
		return nil // Client not connected
	}

	select {
	case client.send <- data:
	default:
	}
	return nil
}

// GetConnectedDevices returns list of connected device IDs
func (h *Hub) GetConnectedDevices() []string {
	h.mu.RLock()
	defer h.mu.RUnlock()

	devices := make([]string, 0, len(h.clients))
	for id := range h.clients {
		devices = append(devices, id)
	}
	return devices
}

// WritePump handles sending messages to the client
func (c *Client) WritePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if err := c.conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
