package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// FileRecord represents a synced file
type FileRecord struct {
	Path  string `json:"path"`
	Hash  string `json:"hash"`
	MTime int64  `json:"mtime"` // Unix milliseconds
	Size  int64  `json:"size"`
	Seq   uint64 `json:"seq"` // sequence when last modified
}

// DeletionEntry represents a deleted file in the deletion log
type DeletionEntry struct {
	Path      string `json:"path"`
	Seq       uint64 `json:"seq"`
	DeletedAt int64  `json:"deletedAt"` // Unix timestamp for TTL cleanup
}

// StorageState is persisted to disk
type StorageState struct {
	Sequence  uint64           `json:"sequence"`
	Files     []*FileRecord    `json:"files"`
	Deletions []DeletionEntry  `json:"deletions"`
	UpdatedAt int64            `json:"updatedAt"`
}

// Storage manages files and sync state
type Storage struct {
	basePath     string
	metadataPath string

	mu        sync.RWMutex
	sequence  uint64
	files     map[string]*FileRecord // path -> record
	deletions []DeletionEntry

	saveChan chan struct{}
	ttlDays  int
}

// NewStorage creates a new storage instance
func NewStorage(basePath string, ttlDays int) (*Storage, error) {
	absPath, err := filepath.Abs(basePath)
	if err != nil {
		return nil, err
	}

	if err := os.MkdirAll(absPath, 0755); err != nil {
		return nil, err
	}

	s := &Storage{
		basePath:     absPath,
		metadataPath: filepath.Join(absPath, ".vault-sync.json"),
		files:        make(map[string]*FileRecord),
		deletions:    make([]DeletionEntry, 0),
		saveChan:     make(chan struct{}, 1),
		ttlDays:      ttlDays,
	}

	// Load state from disk
	if err := s.loadState(); err != nil {
		log.Printf("Warning: could not load state: %v (starting fresh)", err)
	}

	// Scan files and reconcile with stored state
	if err := s.scanFiles(); err != nil {
		return nil, err
	}

	// Start background saver
	go s.backgroundSaver()

	// Start TTL cleanup (every hour)
	go s.ttlCleanup()

	return s, nil
}

// loadState loads state from disk
func (s *Storage) loadState() error {
	data, err := os.ReadFile(s.metadataPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}

	var state StorageState
	if err := json.Unmarshal(data, &state); err != nil {
		return err
	}

	s.sequence = state.Sequence
	for _, f := range state.Files {
		s.files[f.Path] = f
	}
	s.deletions = state.Deletions

	log.Printf("Loaded state: seq=%d, files=%d, deletions=%d", s.sequence, len(s.files), len(s.deletions))
	return nil
}

// saveState persists state to disk
func (s *Storage) saveState() error {
	s.mu.RLock()
	files := make([]*FileRecord, 0, len(s.files))
	for _, f := range s.files {
		files = append(files, f)
	}
	state := StorageState{
		Sequence:  s.sequence,
		Files:     files,
		Deletions: s.deletions,
		UpdatedAt: time.Now().Unix(),
	}
	s.mu.RUnlock()

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(s.metadataPath, data, 0644)
}

// triggerSave schedules a debounced save
func (s *Storage) triggerSave() {
	select {
	case s.saveChan <- struct{}{}:
	default:
	}
}

// backgroundSaver handles debounced saves
func (s *Storage) backgroundSaver() {
	for range s.saveChan {
		time.Sleep(100 * time.Millisecond)
		// Drain pending
		for {
			select {
			case <-s.saveChan:
			default:
				goto save
			}
		}
	save:
		if err := s.saveState(); err != nil {
			log.Printf("Error saving state: %v", err)
		}
	}
}

// ttlCleanup removes expired deletions
func (s *Storage) ttlCleanup() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for range ticker.C {
		s.cleanupExpiredDeletions()
	}
}

func (s *Storage) cleanupExpiredDeletions() {
	s.mu.Lock()
	defer s.mu.Unlock()

	cutoff := time.Now().Unix() - int64(s.ttlDays*24*60*60)
	kept := make([]DeletionEntry, 0)
	removed := 0

	for _, d := range s.deletions {
		if d.DeletedAt > cutoff {
			kept = append(kept, d)
		} else {
			removed++
		}
	}

	if removed > 0 {
		s.deletions = kept
		log.Printf("TTL cleanup: removed %d expired deletions", removed)
		s.triggerSave()
	}
}

// scanFiles scans the vault and reconciles with stored state
func (s *Storage) scanFiles() error {
	currentFiles := make(map[string]bool)

	err := filepath.WalkDir(s.basePath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // skip errors
		}

		// Skip hidden files and directories
		name := d.Name()
		if strings.HasPrefix(name, ".") {
			if d.IsDir() && name != "." {
				return filepath.SkipDir
			}
			return nil
		}

		if d.IsDir() {
			return nil
		}

		relPath, err := filepath.Rel(s.basePath, path)
		if err != nil {
			return nil
		}
		relPath = filepath.ToSlash(relPath)
		currentFiles[relPath] = true

		// Check if file changed
		info, err := d.Info()
		if err != nil {
			return nil
		}

		existing := s.files[relPath]
		mtime := info.ModTime().UnixMilli()
		size := info.Size()

		if existing == nil || existing.MTime != mtime || existing.Size != size {
			// File is new or changed, compute hash
			content, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			hash := computeHash(content)

			s.mu.Lock()
			s.sequence++
			s.files[relPath] = &FileRecord{
				Path:  relPath,
				Hash:  hash,
				MTime: mtime,
				Size:  size,
				Seq:   s.sequence,
			}
			s.mu.Unlock()
		}

		return nil
	})

	if err != nil {
		return err
	}

	// Find deleted files
	s.mu.Lock()
	for path := range s.files {
		if !currentFiles[path] {
			// File was deleted
			s.sequence++
			s.deletions = append(s.deletions, DeletionEntry{
				Path:      path,
				Seq:       s.sequence,
				DeletedAt: time.Now().Unix(),
			})
			delete(s.files, path)
			log.Printf("Detected deleted file: %s (seq=%d)", path, s.sequence)
		}
	}
	s.mu.Unlock()

	s.triggerSave()
	log.Printf("Scan complete: %d files, seq=%d", len(s.files), s.sequence)
	return nil
}

// GetSequence returns current sequence
func (s *Storage) GetSequence() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sequence
}

// GetFile returns a file record
func (s *Storage) GetFile(path string) *FileRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.files[path]
}

// GetAllFiles returns all file records
func (s *Storage) GetAllFiles() []*FileRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()

	result := make([]*FileRecord, 0, len(s.files))
	for _, f := range s.files {
		result = append(result, f)
	}
	return result
}

// GetChangesSince returns all changes (files + deletions) since given sequence
func (s *Storage) GetChangesSince(seq uint64) ([]*FileRecord, []DeletionEntry) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	files := make([]*FileRecord, 0)
	for _, f := range s.files {
		if f.Seq > seq {
			files = append(files, f)
		}
	}

	deletions := make([]DeletionEntry, 0)
	for _, d := range s.deletions {
		if d.Seq > seq {
			deletions = append(deletions, d)
		}
	}

	return files, deletions
}

// WriteFile saves a file and returns the new sequence
func (s *Storage) WriteFile(path string, content []byte, mtime int64) (uint64, error) {
	fullPath := filepath.Join(s.basePath, filepath.FromSlash(path))

	// Create directory if needed
	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return 0, err
	}

	// Write file
	if err := os.WriteFile(fullPath, content, 0644); err != nil {
		return 0, err
	}

	// Set mtime
	if mtime > 0 {
		t := time.UnixMilli(mtime)
		os.Chtimes(fullPath, t, t)
	}

	hash := computeHash(content)
	info, _ := os.Stat(fullPath)

	s.mu.Lock()
	s.sequence++
	seq := s.sequence
	s.files[path] = &FileRecord{
		Path:  path,
		Hash:  hash,
		MTime: info.ModTime().UnixMilli(),
		Size:  info.Size(),
		Seq:   seq,
	}
	// Remove from deletions if present
	s.removeDeletion(path)
	s.mu.Unlock()

	s.triggerSave()
	return seq, nil
}

// DeleteFile removes a file and returns the new sequence
func (s *Storage) DeleteFile(path string) (uint64, error) {
	fullPath := filepath.Join(s.basePath, filepath.FromSlash(path))

	// Remove physical file
	if err := os.Remove(fullPath); err != nil && !os.IsNotExist(err) {
		return 0, err
	}

	s.mu.Lock()
	s.sequence++
	seq := s.sequence
	delete(s.files, path)
	s.deletions = append(s.deletions, DeletionEntry{
		Path:      path,
		Seq:       seq,
		DeletedAt: time.Now().Unix(),
	})
	s.mu.Unlock()

	s.triggerSave()

	// Clean empty directories
	s.cleanEmptyDirs(filepath.Dir(fullPath))

	return seq, nil
}

// ReadFile reads file content
func (s *Storage) ReadFile(path string) ([]byte, error) {
	fullPath := filepath.Join(s.basePath, filepath.FromSlash(path))
	return os.ReadFile(fullPath)
}

func (s *Storage) removeDeletion(path string) {
	kept := make([]DeletionEntry, 0, len(s.deletions))
	for _, d := range s.deletions {
		if d.Path != path {
			kept = append(kept, d)
		}
	}
	s.deletions = kept
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

func computeHash(content []byte) string {
	hash := sha256.Sum256(content)
	return hex.EncodeToString(hash[:])
}

// GetAllFiles returns all file metadata
func (s *Storage) GetAllFiles() []FileInfo {
	s.mu.RLock()
	paths := make([]string, 0, len(s.knownFiles))
	for path := range s.knownFiles {
		paths = append(paths, path)
	}
	s.mu.RUnlock()

	result := make([]FileInfo, 0, len(paths))
	for _, path := range paths {
		info, err := s.GetFileInfo(path)
		if err != nil {
			// File might have been deleted, skip it
			continue
		}
		result = append(result, *info)
	}
	return result
}

// GetTombstones returns all tombstones
func (s *Storage) GetTombstones() []*Tombstone {
	return s.ListTombstones()
}
