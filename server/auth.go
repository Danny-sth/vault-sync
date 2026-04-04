package main

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// AuthManager handles authentication and device tracking
type AuthManager struct {
	masterToken string
	devices     map[string]time.Time // deviceID -> lastSeen
	mu          sync.RWMutex
}

// NewAuthManager creates a new auth manager
func NewAuthManager(masterToken string) *AuthManager {
	return &AuthManager{
		masterToken: masterToken,
		devices:     make(map[string]time.Time),
	}
}

// ValidateToken validates a token and returns the device ID
// If using master token, returns "master" - caller should get device_id from request
func (a *AuthManager) ValidateToken(token string) (string, bool) {
	if subtle.ConstantTimeCompare([]byte(token), []byte(a.masterToken)) == 1 {
		return "master", true
	}
	return "", false
}

// UpdateLastSeen updates the last seen time for a device
func (a *AuthManager) UpdateLastSeen(deviceID string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.devices[deviceID] = time.Now()
}

// HandleGenerateToken generates a new token (in this simple version, returns the master token)
func (a *AuthManager) HandleGenerateToken(w http.ResponseWriter, r *http.Request) {
	// Verify admin authentication (master token required)
	token := r.Header.Get("X-Auth-Token")
	if subtle.ConstantTimeCompare([]byte(token), []byte(a.masterToken)) != 1 {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// In this simple version, we just return the master token
	// In production, you'd generate device-specific tokens
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"token":"` + a.masterToken + `"}`))
}

// HandleListDevices returns the list of connected devices
func (a *AuthManager) HandleListDevices(w http.ResponseWriter, r *http.Request) {
	// Verify admin authentication
	token := r.Header.Get("X-Auth-Token")
	if subtle.ConstantTimeCompare([]byte(token), []byte(a.masterToken)) != 1 {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	a.mu.RLock()
	devices := make([]map[string]interface{}, 0, len(a.devices))
	for id, lastSeen := range a.devices {
		devices = append(devices, map[string]interface{}{
			"id":       id,
			"lastSeen": lastSeen.Unix(),
		})
	}
	a.mu.RUnlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"devices": devices})
}

// AuthMiddleware validates the auth token
func AuthMiddleware(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Get token from query parameter or header
		reqToken := r.URL.Query().Get("token")
		if reqToken == "" {
			reqToken = r.Header.Get("Authorization")
			if len(reqToken) > 7 && reqToken[:7] == "Bearer " {
				reqToken = reqToken[7:]
			}
		}

		// Constant-time comparison to prevent timing attacks
		if subtle.ConstantTimeCompare([]byte(reqToken), []byte(token)) != 1 {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		next(w, r)
	}
}

// ValidateToken checks if token is valid
func ValidateToken(token, expected string) bool {
	return subtle.ConstantTimeCompare([]byte(token), []byte(expected)) == 1
}
