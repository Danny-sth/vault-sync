package main

import (
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// Watcher monitors filesystem changes
type Watcher struct {
	basePath    string
	storage     *Storage
	syncHandler *SyncHandler
	watcher     *fsnotify.Watcher

	// Debouncing
	mu       sync.Mutex
	pending  map[string]*pendingEvent
	debounce time.Duration
}

type pendingEvent struct {
	op     fsnotify.Op
	timer  *time.Timer
	isDir  bool
}

// NewWatcher creates a new file watcher
func NewWatcher(basePath string, storage *Storage, syncHandler *SyncHandler) (*Watcher, error) {
	fsWatcher, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	w := &Watcher{
		basePath:    basePath,
		storage:     storage,
		syncHandler: syncHandler,
		watcher:     fsWatcher,
		pending:     make(map[string]*pendingEvent),
		debounce:    100 * time.Millisecond,
	}

	return w, nil
}

// Start begins watching for filesystem changes
func (w *Watcher) Start() error {
	// Add all existing directories
	if err := w.addDirectories(); err != nil {
		return err
	}

	// Start event loop
	go w.eventLoop()

	log.Printf("File watcher started for: %s", w.basePath)
	return nil
}

// Stop stops the watcher
func (w *Watcher) Stop() error {
	return w.watcher.Close()
}

// addDirectories adds all directories to the watcher
func (w *Watcher) addDirectories() error {
	return filepath.WalkDir(w.basePath, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}

		// Skip hidden directories
		if d.IsDir() {
			name := d.Name()
			if strings.HasPrefix(name, ".") && name != "." {
				return filepath.SkipDir
			}

			if err := w.watcher.Add(path); err != nil {
				log.Printf("Warning: could not watch directory %s: %v", path, err)
			}
		}

		return nil
	})
}

// eventLoop processes filesystem events
func (w *Watcher) eventLoop() {
	for {
		select {
		case event, ok := <-w.watcher.Events:
			if !ok {
				return
			}
			w.handleEvent(event)

		case err, ok := <-w.watcher.Errors:
			if !ok {
				return
			}
			log.Printf("Watcher error: %v", err)
		}
	}
}

// handleEvent processes a single filesystem event with debouncing
func (w *Watcher) handleEvent(event fsnotify.Event) {
	path := event.Name

	// Skip hidden files/directories
	name := filepath.Base(path)
	if strings.HasPrefix(name, ".") {
		return
	}

	// Get relative path
	relPath, err := filepath.Rel(w.basePath, path)
	if err != nil {
		return
	}
	relPath = filepath.ToSlash(relPath)

	// Check if it's a directory
	info, err := os.Stat(path)
	isDir := err == nil && info.IsDir()

	// Handle new directories
	if isDir && (event.Op&fsnotify.Create != 0) {
		if err := w.watcher.Add(path); err != nil {
			log.Printf("Warning: could not watch new directory %s: %v", path, err)
		}
		return
	}

	// Skip directories for file operations
	if isDir {
		return
	}

	// Debounce events
	w.mu.Lock()
	if pending, ok := w.pending[relPath]; ok {
		pending.timer.Stop()
		pending.op = event.Op
	} else {
		w.pending[relPath] = &pendingEvent{op: event.Op}
	}

	w.pending[relPath].timer = time.AfterFunc(w.debounce, func() {
		w.processEvent(relPath, event.Op)
	})
	w.mu.Unlock()
}

// processEvent handles the debounced event
func (w *Watcher) processEvent(relPath string, op fsnotify.Op) {
	w.mu.Lock()
	delete(w.pending, relPath)
	w.mu.Unlock()

	fullPath := filepath.Join(w.basePath, filepath.FromSlash(relPath))

	// Check if file exists
	info, err := os.Stat(fullPath)
	fileExists := err == nil

	if !fileExists {
		// File was deleted or renamed away
		w.handleDelete(relPath)
	} else if op&(fsnotify.Create|fsnotify.Write) != 0 {
		// File was created or modified
		w.handleChange(relPath, fullPath, info)
	}
}

// handleChange processes a file creation or modification
func (w *Watcher) handleChange(relPath, fullPath string, info os.FileInfo) {
	// Read content
	content, err := os.ReadFile(fullPath)
	if err != nil {
		log.Printf("Watcher: error reading %s: %v", relPath, err)
		return
	}

	hash := computeHash(content)
	mtime := info.ModTime().UnixMilli()

	// Check if actually changed
	existing := w.storage.GetFile(relPath)
	if existing != nil && existing.Hash == hash {
		return // No actual change
	}

	// Save to storage
	seq, err := w.storage.WriteFile(relPath, content, mtime)
	if err != nil {
		log.Printf("Watcher: error saving %s: %v", relPath, err)
		return
	}

	// Broadcast to all clients
	w.syncHandler.BroadcastChange(relPath, content, mtime, seq)
	log.Printf("Watcher: file changed: %s (seq=%d)", relPath, seq)
}

// handleDelete processes a file deletion
func (w *Watcher) handleDelete(relPath string) {
	// Check if we knew about this file
	existing := w.storage.GetFile(relPath)
	if existing == nil {
		return // We didn't track this file
	}

	// Delete from storage
	seq, err := w.storage.DeleteFile(relPath)
	if err != nil {
		log.Printf("Watcher: error deleting %s: %v", relPath, err)
		return
	}

	// Broadcast to all clients
	w.syncHandler.BroadcastDelete(relPath, seq)
	log.Printf("Watcher: file deleted: %s (seq=%d)", relPath, seq)
}
