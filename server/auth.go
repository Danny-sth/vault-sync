package main

import (
	"crypto/subtle"
	"net/http"
)

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
