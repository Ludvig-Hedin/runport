package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

type forgejo struct {
	mu   sync.Mutex
	proc *os.Process
	done chan error
}

func (f *forgejo) start() error {
	cmd := exec.Command("su-exec", "git", "forgejo", "web")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	f.proc = cmd.Process
	f.done = make(chan error, 1)
	go func(done chan error) { done <- cmd.Wait() }(f.done)
	return nil
}

func (f *forgejo) stop() error {
	if f.proc == nil {
		return nil
	}
	err := f.proc.Signal(syscall.SIGTERM)
	if err != nil && !errors.Is(err, os.ErrProcessDone) {
		return err
	}
	select {
	case err := <-f.done:
		f.proc = nil
		return err
	case <-time.After(60 * time.Second):
		return errors.New("Forgejo did not stop in time")
	}
}

func main() {
	token := os.Getenv("GIT_BACKUP_TOKEN")
	if token == "" {
		log.Fatal("GIT_BACKUP_TOKEN is missing")
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	app := &forgejo{}
	if err := app.start(); err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /backup", func(w http.ResponseWriter, r *http.Request) {
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if !app.mu.TryLock() {
			http.Error(w, "backup already running", http.StatusConflict)
			return
		}
		file, err := os.CreateTemp("", "runport-git-*.tar.gz")
		if err != nil {
			app.mu.Unlock()
			log.Printf("creating backup file: %v", err)
			http.Error(w, "could not create backup", http.StatusInternalServerError)
			return
		}
		defer os.Remove(file.Name())
		defer file.Close()
		err = app.snapshot(r.Context(), file.Name())
		app.mu.Unlock()
		if err != nil {
			log.Printf("creating backup: %v", err)
			http.Error(w, "could not create backup", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/gzip")
		http.ServeContent(w, r, "runport-git.tar.gz", time.Time{}, file)
	})

	// Railway's private network supports IPv6. Only port 3000 is public.
	server := &http.Server{
		Addr: "[::]:8081", Handler: mux,
		ReadHeaderTimeout: 5 * time.Second, WriteTimeout: 8 * time.Minute,
		BaseContext: func(net.Listener) context.Context { return ctx },
	}
	go func() {
		if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			log.Printf("backup listener: %v", err)
			cancel()
		}
	}()

	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			server.Close()
			app.mu.Lock()
			defer app.mu.Unlock()
			if err := app.stop(); err != nil {
				log.Printf("stopping Forgejo: %v", err)
			}
			return
		case <-ticker.C:
			if app.mu.TryLock() {
				app.recover()
				app.mu.Unlock()
			}
		}
	}
}

func (f *forgejo) recover() {
	if f.proc != nil {
		select {
		case err := <-f.done:
			log.Printf("Forgejo exited: %v", err)
			f.proc = nil
		default:
			return
		}
	}
	if err := f.start(); err != nil {
		log.Printf("starting Forgejo: %v", err)
	}
}

func (f *forgejo) snapshot(parent context.Context, path string) (err error) {
	// Stop writes while copying SQLite, repositories and Forgejo's config.
	if err := f.stop(); err != nil {
		return err
	}
	// Restart even if the archive or the request fails.
	defer func() { err = errors.Join(err, f.start()) }()
	ctx, cancel := context.WithTimeout(parent, 4*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "tar", "-czf", path, "-C", "/data", "gitea", "git")
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
