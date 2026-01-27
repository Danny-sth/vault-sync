package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var (
	ErrPathTraversal = errors.New("path traversal detected")
	ErrFileTooLarge  = errors.New("file too large")
	ErrInvalidPath   = errors.New("invalid file path")
)

type Storage struct {
	basePath      string
	maxFileSizeMB int
	hashes        map[string]string
	tombstones    map[string]*Tombstone
	mu            sync.RWMutex
}

type FileInfo struct {
	Path        string            `json:"path"`
	Hash        string            `json:"hash"`
	Size        int64             `json:"size"`
	ModTime     int64             `json:"mtime"`
	VectorClock map[string]int64  `json:"vectorClock,omitempty"`
}

type Tombstone struct {
	Path        string            `json:"path"`
	DeletedAt   int64             `json:"deletedAt"`
	DeletedBy   string            `json:"deletedBy"`
	VectorClock map[string]int64  `json:"vectorClock"`
	TTL         int64             `json:"ttl"`
}

func NewStorage(basePath string, maxFileSizeMB int) (*Storage, error) {
	absPath, err := filepath.Abs(basePath)
	if err != nil {
		return nil, err
	}

	if err := os.MkdirAll(absPath, 0755); err != nil {
		return nil, err
	}

	s := &Storage{
		basePath:      absPath,
		maxFileSizeMB: maxFileSizeMB,
		hashes:        make(map[string]string),
		tombstones:    make(map[string]*Tombstone),
	}

	// Build initial hash cache
	if err := s.rebuildHashCache(); err != nil {
		return nil, err
	}

	return s, nil
}

func (s *Storage) validatePath(path string) (string, error) {
	// Prevent empty paths
	if path == "" {
		return "", ErrInvalidPath
	}

	// Clean the path
	cleanPath := filepath.Clean(path)

	// Check for path traversal
	if strings.Contains(cleanPath, "..") {
		return "", ErrPathTraversal
	}

	// Build full path
	fullPath := filepath.Join(s.basePath, cleanPath)

	// Ensure the path is still within basePath
	if !strings.HasPrefix(fullPath, s.basePath) {
		return "", ErrPathTraversal
	}

	return fullPath, nil
}

func (s *Storage) WriteFile(path string, content []byte, mtime int64) error {
	fullPath, err := s.validatePath(path)
	if err != nil {
		return err
	}

	// Check file size
	maxSize := int64(s.maxFileSizeMB) * 1024 * 1024
	if int64(len(content)) > maxSize {
		return ErrFileTooLarge
	}

	// Ensure directory exists
	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	// Write file
	if err := os.WriteFile(fullPath, content, 0644); err != nil {
		return err
	}

	// Set modification time if provided
	if mtime > 0 {
		modTime := time.Unix(0, mtime*int64(time.Millisecond))
		if err := os.Chtimes(fullPath, modTime, modTime); err != nil {
			// Non-fatal error, just log it
		}
	}

	// Update hash cache
	hash := s.computeHash(content)
	s.mu.Lock()
	s.hashes[path] = hash
	s.mu.Unlock()

	return nil
}

func (s *Storage) ReadFile(path string) ([]byte, error) {
	fullPath, err := s.validatePath(path)
	if err != nil {
		return nil, err
	}

	return os.ReadFile(fullPath)
}

func (s *Storage) DeleteFile(path string) error {
	fullPath, err := s.validatePath(path)
	if err != nil {
		return err
	}

	if err := os.Remove(fullPath); err != nil && !os.IsNotExist(err) {
		return err
	}

	// Remove from hash cache
	s.mu.Lock()
	delete(s.hashes, path)
	s.mu.Unlock()

	// Try to remove empty parent directories
	s.cleanEmptyDirs(filepath.Dir(fullPath))

	return nil
}

func (s *Storage) GetFileHash(path string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.hashes[path]
}

func (s *Storage) GetFileInfo(path string) (*FileInfo, error) {
	fullPath, err := s.validatePath(path)
	if err != nil {
		return nil, err
	}

	stat, err := os.Stat(fullPath)
	if err != nil {
		return nil, err
	}

	s.mu.RLock()
	hash := s.hashes[path]
	s.mu.RUnlock()

	return &FileInfo{
		Path:    path,
		Hash:    hash,
		Size:    stat.Size(),
		ModTime: stat.ModTime().UnixMilli(),
	}, nil
}

func (s *Storage) ListFiles() ([]*FileInfo, error) {
	var files []*FileInfo

	err := filepath.WalkDir(s.basePath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		// Skip directories
		if d.IsDir() {
			// Skip hidden directories (like .obsidian)
			if strings.HasPrefix(d.Name(), ".") && d.Name() != "." {
				return filepath.SkipDir
			}
			return nil
		}

		// Skip hidden files
		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}

		// Get relative path
		relPath, err := filepath.Rel(s.basePath, path)
		if err != nil {
			return err
		}

		// Use forward slashes for consistency
		relPath = filepath.ToSlash(relPath)

		info, err := d.Info()
		if err != nil {
			return err
		}

		s.mu.RLock()
		hash := s.hashes[relPath]
		s.mu.RUnlock()

		files = append(files, &FileInfo{
			Path:    relPath,
			Hash:    hash,
			Size:    info.Size(),
			ModTime: info.ModTime().UnixMilli(),
		})

		return nil
	})

	if err != nil {
		return nil, err
	}

	return files, nil
}

func (s *Storage) rebuildHashCache() error {
	return filepath.WalkDir(s.basePath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		if d.IsDir() {
			if strings.HasPrefix(d.Name(), ".") && d.Name() != "." {
				return filepath.SkipDir
			}
			return nil
		}

		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}

		content, err := os.ReadFile(path)
		if err != nil {
			return nil // Skip unreadable files
		}

		relPath, err := filepath.Rel(s.basePath, path)
		if err != nil {
			return nil
		}

		relPath = filepath.ToSlash(relPath)
		hash := s.computeHash(content)

		s.mu.Lock()
		s.hashes[relPath] = hash
		s.mu.Unlock()

		return nil
	})
}

func (s *Storage) computeHash(content []byte) string {
	hash := sha256.Sum256(content)
	return hex.EncodeToString(hash[:])
}

func (s *Storage) cleanEmptyDirs(dir string) {
	for dir != s.basePath && strings.HasPrefix(dir, s.basePath) {
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) > 0 {
			break
		}
		os.Remove(dir)
		dir = filepath.Dir(dir)
	}
}

// Tombstone management
func (s *Storage) CreateTombstone(path, deviceID string, vectorClock map[string]int64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().Unix()
	s.tombstones[path] = &Tombstone{
		Path:        path,
		DeletedAt:   now,
		DeletedBy:   deviceID,
		VectorClock: vectorClock,
		TTL:         now + (30 * 24 * 60 * 60), // 30 days
	}
}

func (s *Storage) GetTombstone(path string) *Tombstone {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.tombstones[path]
}

func (s *Storage) DeleteTombstone(path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.tombstones, path)
}

func (s *Storage) ListTombstones() []*Tombstone {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]*Tombstone, 0, len(s.tombstones))
	for _, tomb := range s.tombstones {
		result = append(result, tomb)
	}
	return result
}

func (s *Storage) CleanupExpiredTombstones() int {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().Unix()
	count := 0

	for path, tomb := range s.tombstones {
		if tomb.TTL < now {
			delete(s.tombstones, path)
			count++
		}
	}

	return count
}
