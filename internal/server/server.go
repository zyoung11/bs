package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"bs/internal/store"
)

const maxBodyBytes = 32 << 20

const maxEntriesPerPush = 10000

const maxReadBytes = 1 << 20

const (
	writeWait   = 10 * time.Second
	pongWait    = 70 * time.Second
	pingPeriod  = 30 * time.Second
)

// Server exposes the two operation logs over HTTP and WebSocket.
type Server struct {
	store    *store.Store
	token    string
	hub      *hub
	upgrader websocket.Upgrader
}

// New builds a server around st. token is the config token that
// authorizes auth token registration.
func New(st *store.Store, token string) *Server {
	return &Server{
		store: st,
		token: token,
		hub:   newHub(),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin:     allowOrigin,
		},
	}
}

// allowOrigin accepts every handshake origin because the browser
// extension origin never matches the request host and the token check
// already authenticates the client.
func allowOrigin(r *http.Request) bool {
	return true
}

// Handler returns the HTTP mux of the server.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/register", s.handleRegister)
	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/ops", s.handleOps)
	mux.HandleFunc("/api/reset", s.handleReset)
	mux.HandleFunc("/api/ws", s.handleWS)
	return mux
}

// handleStatus reports whether an auth token is registered. It needs
// no credentials so a fresh client can tell if it must register first.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	hash := s.storedAuthHash()
	writeJSON(w, http.StatusOK, statusResult{Registered: len(hash) > 0})
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.configTokenOK(r) {
		writeError(w, http.StatusUnauthorized, "bad config token")
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := readBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(body.Token) < 16 || len(body.Token) > 512 {
		writeError(w, http.StatusBadRequest, "token must be 16 to 512 characters")
		return
	}
	hash := sha256.Sum256([]byte(body.Token))
	if err := s.store.SetAuthHash(hash[:]); err != nil {
		writeError(w, http.StatusInternalServerError, "failed to store auth hash")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleOps(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.pushOps(w, r)
	case http.MethodGet:
		s.pullOps(w, r)
	default:
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	}
}

func (s *Server) pushOps(w http.ResponseWriter, r *http.Request) {
	if !s.authed(r) {
		writeError(w, http.StatusUnauthorized, "not authorized")
		return
	}
	var body struct {
		Log     string        `json:"log"`
		Entries []store.Entry `json:"entries"`
	}
	if err := readBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !store.ValidLog(body.Log) {
		writeError(w, http.StatusBadRequest, "unknown log")
		return
	}
	if len(body.Entries) == 0 || len(body.Entries) > maxEntriesPerPush {
		writeError(w, http.StatusBadRequest, "entries must be 1 to 10000 items")
		return
	}
	for _, e := range body.Entries {
		if e.ID == "" || e.Data == "" {
			writeError(w, http.StatusBadRequest, "every entry needs id and data")
			return
		}
	}
	stored, err := s.store.Append(body.Log, body.Entries)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to append entries")
		return
	}
	gen, latest, err := s.store.Status(body.Log)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read status")
		return
	}
	for _, e := range stored {
		s.broadcast(opMessage(body.Log, e))
	}
	writeJSON(w, http.StatusOK, pushResult{Gen: gen, Latest: latest, Entries: stored})
}

func (s *Server) pullOps(w http.ResponseWriter, r *http.Request) {
	if !s.authed(r) {
		writeError(w, http.StatusUnauthorized, "not authorized")
		return
	}
	q := r.URL.Query()
	log := q.Get("log")
	if !store.ValidLog(log) {
		writeError(w, http.StatusBadRequest, "unknown log")
		return
	}
	since, err := strconv.ParseUint(q.Get("since"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "since must be a sequence number")
		return
	}
	entries, err := s.store.List(log, since)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list entries")
		return
	}
	gen, latest, err := s.store.Status(log)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to read status")
		return
	}
	writeJSON(w, http.StatusOK, pushResult{Gen: gen, Latest: latest, Entries: entries})
}

func (s *Server) handleReset(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.authed(r) {
		writeError(w, http.StatusUnauthorized, "not authorized")
		return
	}
	var body struct {
		Log string `json:"log"`
	}
	if err := readBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !store.ValidLog(body.Log) {
		writeError(w, http.StatusBadRequest, "unknown log")
		return
	}
	gen, err := s.store.Reset(body.Log)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to reset log")
		return
	}
	s.broadcast(resetMessage(body.Log, gen))
	writeJSON(w, http.StatusOK, resetResult{Gen: gen})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if !s.authed(r) {
		writeError(w, http.StatusUnauthorized, "not authorized")
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	hello := helloMessage()
	for _, name := range store.LogNames() {
		gen, latest, err := s.store.Status(name)
		if err != nil {
			conn.Close()
			return
		}
		hello.Logs[name] = logStatus{Gen: gen, Latest: latest}
	}
	c := &client{conn: conn, send: make(chan []byte, 64)}
	helloData, err := json.Marshal(hello)
	if err != nil {
		conn.Close()
		return
	}
	if err := c.conn.WriteMessage(websocket.TextMessage, helloData); err != nil {
		c.closeConn()
		return
	}
	s.hub.add(c)
	go c.writePump()
	go s.readPump(c)
}

func (s *Server) readPump(c *client) {
	defer func() {
		s.hub.remove(c)
		c.closeConn()
	}()
	c.conn.SetReadLimit(maxReadBytes)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (s *Server) authed(r *http.Request) bool {
	return s.hashOK(r, s.storedAuthHash)
}

func (s *Server) configTokenOK(r *http.Request) bool {
	return s.hashOK(r, func() []byte {
		sum := sha256.Sum256([]byte(s.token))
		return sum[:]
	})
}

func (s *Server) storedAuthHash() []byte {
	hash, err := s.store.AuthHash()
	if err != nil {
		return nil
	}
	return hash
}

func (s *Server) hashOK(r *http.Request, want func() []byte) bool {
	presented := presentedToken(r)
	if presented == "" {
		return false
	}
	expected := want()
	if len(expected) == 0 {
		return false
	}
	got := sha256.Sum256([]byte(presented))
	return subtle.ConstantTimeCompare(got[:], expected) == 1
}

func presentedToken(r *http.Request) string {
	const prefix = "Bearer "
	auth := r.Header.Get("Authorization")
	if len(auth) > len(prefix) && auth[:len(prefix)] == prefix {
		return auth[len(prefix):]
	}
	return r.URL.Query().Get("token")
}

type statusResult struct {
	Registered bool `json:"registered"`
}

type pushResult struct {
	Gen     uint64        `json:"gen"`
	Latest  uint64        `json:"latest"`
	Entries []store.Entry `json:"entries"`
}

type resetResult struct {
	Gen uint64 `json:"gen"`
}

type logStatus struct {
	Gen    uint64 `json:"gen"`
	Latest uint64 `json:"latest"`
}

type wsMessage struct {
	Type  string               `json:"type"`
	Log   string               `json:"log,omitempty"`
	Gen   uint64               `json:"gen,omitempty"`
	Entry *store.Entry         `json:"entry,omitempty"`
	Logs  map[string]logStatus `json:"logs,omitempty"`
}

func helloMessage() wsMessage {
	return wsMessage{Type: "hello", Logs: map[string]logStatus{}}
}

func opMessage(log string, e store.Entry) wsMessage {
	return wsMessage{Type: "op", Log: log, Entry: &e}
}

func resetMessage(log string, gen uint64) wsMessage {
	return wsMessage{Type: "reset", Log: log, Gen: gen}
}

type client struct {
	conn      *websocket.Conn
	send      chan []byte
	closeOnce sync.Once
}

// closeConn closes the underlying connection exactly once, so the read
// and write pumps and the hub can all call it without double closing.
func (c *client) closeConn() {
	c.closeOnce.Do(func() {
		c.conn.Close()
	})
}

func (c *client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.closeConn()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				c.conn.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

type hub struct {
	mu      sync.Mutex
	clients map[*client]struct{}
}

func newHub() *hub {
	return &hub{clients: make(map[*client]struct{})}
}

func (h *hub) add(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[c] = struct{}{}
}

func (h *hub) remove(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
}

func (h *hub) broadcast(msg []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.send <- msg:
		default:
			delete(h.clients, c)
			close(c.send)
			c.closeConn()
		}
	}
}

func (s *Server) broadcast(m wsMessage) {
	data, err := json.Marshal(m)
	if err != nil {
		return
	}
	s.hub.broadcast(data)
}

func readBody(r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
