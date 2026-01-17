package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type AuthManager struct {
	masterToken  string
	deviceTokens map[string]*DeviceToken
	mu           sync.RWMutex
}

type DeviceToken struct {
	Token     string    `json:"token"`
	DeviceID  string    `json:"device_id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	LastSeen  time.Time `json:"last_seen"`
}

func NewAuthManager(masterToken string) *AuthManager {
	return &AuthManager{
		masterToken:  masterToken,
		deviceTokens: make(map[string]*DeviceToken),
	}
}

func (a *AuthManager) ValidateToken(token string) (string, bool) {
	if token == "" {
		return "", false
	}

	// Check master token first
	if a.masterToken != "" && subtle.ConstantTimeCompare([]byte(token), []byte(a.masterToken)) == 1 {
		return "master", true
	}

	// Check device tokens
	a.mu.RLock()
	defer a.mu.RUnlock()

	for _, dt := range a.deviceTokens {
		if subtle.ConstantTimeCompare([]byte(token), []byte(dt.Token)) == 1 {
			return dt.DeviceID, true
		}
	}

	return "", false
}

func (a *AuthManager) UpdateLastSeen(deviceID string) {
	a.mu.Lock()
	defer a.mu.Unlock()

	for _, dt := range a.deviceTokens {
		if dt.DeviceID == deviceID {
			dt.LastSeen = time.Now()
			return
		}
	}
}

func (a *AuthManager) GenerateDeviceToken(deviceID, name string) (*DeviceToken, error) {
	token, err := generateSecureToken(32)
	if err != nil {
		return nil, err
	}

	dt := &DeviceToken{
		Token:     token,
		DeviceID:  deviceID,
		Name:      name,
		CreatedAt: time.Now(),
		LastSeen:  time.Now(),
	}

	a.mu.Lock()
	a.deviceTokens[deviceID] = dt
	a.mu.Unlock()

	return dt, nil
}

func (a *AuthManager) RevokeDeviceToken(deviceID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()

	if _, exists := a.deviceTokens[deviceID]; exists {
		delete(a.deviceTokens, deviceID)
		return true
	}
	return false
}

func (a *AuthManager) ListDevices() []*DeviceToken {
	a.mu.RLock()
	defer a.mu.RUnlock()

	devices := make([]*DeviceToken, 0, len(a.deviceTokens))
	for _, dt := range a.deviceTokens {
		// Return copy without token for security
		devices = append(devices, &DeviceToken{
			DeviceID:  dt.DeviceID,
			Name:      dt.Name,
			CreatedAt: dt.CreatedAt,
			LastSeen:  dt.LastSeen,
		})
	}
	return devices
}

func generateSecureToken(length int) (string, error) {
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

func hashToken(token string) string {
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
}

// HTTP handler for token generation (master token required)
func (a *AuthManager) HandleGenerateToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Require master token for generating device tokens
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" || authHeader != "Bearer "+a.masterToken {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	var req struct {
		DeviceID string `json:"device_id"`
		Name     string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if req.DeviceID == "" {
		http.Error(w, "device_id is required", http.StatusBadRequest)
		return
	}

	dt, err := a.GenerateDeviceToken(req.DeviceID, req.Name)
	if err != nil {
		http.Error(w, fmt.Sprintf("Failed to generate token: %v", err), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(dt)
}

// HTTP handler for listing devices (master token required)
func (a *AuthManager) HandleListDevices(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	authHeader := r.Header.Get("Authorization")
	if authHeader == "" || authHeader != "Bearer "+a.masterToken {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(a.ListDevices())
}
