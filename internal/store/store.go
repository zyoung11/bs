package store

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"slices"

	bolt "go.etcd.io/bbolt"
)

var logNames = []string{"bookmarks", "passwords"}

var metaBucket = []byte("meta")

// Entry is one operation record in a log. Data holds client side
// ciphertext. Seq is assigned by the server on append.
type Entry struct {
	Seq  uint64 `json:"seq"`
	ID   string `json:"id"`
	Data string `json:"data"`
}

// Store wraps the bbolt database holding both operation logs and the
// auth token hash.
type Store struct {
	db *bolt.DB
}

// ValidLog reports whether name is a known log name.
func ValidLog(name string) bool {
	return slices.Contains(logNames, name)
}

// LogNames returns the known log names.
func LogNames() []string {
	return logNames
}

// Open opens or creates the database at path and makes sure every
// bucket exists.
func Open(path string) (*Store, error) {
	db, err := bolt.Open(path, 0600, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to open database %s: %w", path, err)
	}
	s := &Store{db: db}
	if err := s.init(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the database file.
func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) init() error {
	return s.db.Update(func(tx *bolt.Tx) error {
		if _, err := tx.CreateBucketIfNotExists(metaBucket); err != nil {
			return err
		}
		for _, name := range logNames {
			if _, err := tx.CreateBucketIfNotExists([]byte(name)); err != nil {
				return err
			}
		}
		return nil
	})
}

// Append assigns sequence numbers to entries and stores them in the
// log. It returns the entries with their sequence numbers filled.
func (s *Store) Append(log string, entries []Entry) ([]Entry, error) {
	out := make([]Entry, len(entries))
	err := s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte(log))
		m := tx.Bucket(metaBucket)
		seq := readCounter(m, "seq:"+log)
		for i, e := range entries {
			seq++
			e.Seq = seq
			val, err := json.Marshal(e)
			if err != nil {
				return err
			}
			if err := b.Put(seqKey(seq), val); err != nil {
				return err
			}
			out[i] = e
		}
		return writeCounter(m, "seq:"+log, seq)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// List returns the entries with a sequence number greater than since
// in ascending order.
func (s *Store) List(log string, since uint64) ([]Entry, error) {
	var out []Entry
	err := s.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket([]byte(log)).Cursor()
		for k, v := c.Seek(seqKey(since + 1)); k != nil; k, v = c.Next() {
			var e Entry
			if err := json.Unmarshal(v, &e); err != nil {
				return err
			}
			out = append(out, e)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Reset truncates the log and bumps its generation. It returns the new
// generation number.
func (s *Store) Reset(log string) (uint64, error) {
	var gen uint64
	err := s.db.Update(func(tx *bolt.Tx) error {
		if err := tx.DeleteBucket([]byte(log)); err != nil {
			return err
		}
		if _, err := tx.CreateBucket([]byte(log)); err != nil {
			return err
		}
		m := tx.Bucket(metaBucket)
		gen = readCounter(m, "gen:"+log) + 1
		if err := writeCounter(m, "gen:"+log, gen); err != nil {
			return err
		}
		return writeCounter(m, "seq:"+log, 0)
	})
	if err != nil {
		return 0, err
	}
	return gen, nil
}

// Status returns the generation number and the highest sequence number
// of the log.
func (s *Store) Status(log string) (uint64, uint64, error) {
	var gen, seq uint64
	err := s.db.View(func(tx *bolt.Tx) error {
		m := tx.Bucket(metaBucket)
		gen = readCounter(m, "gen:"+log)
		seq = readCounter(m, "seq:"+log)
		return nil
	})
	return gen, seq, err
}

// SetAuthHash stores the auth token hash, replacing any previous one.
func (s *Store) SetAuthHash(hash []byte) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(metaBucket).Put([]byte("auth"), hash)
	})
}

// AuthHash returns the stored auth token hash, nil when none is set.
func (s *Store) AuthHash() ([]byte, error) {
	var out []byte
	err := s.db.View(func(tx *bolt.Tx) error {
		out = append(out, tx.Bucket(metaBucket).Get([]byte("auth"))...)
		return nil
	})
	return out, err
}

func seqKey(seq uint64) []byte {
	return counterBytes(seq)
}

func counterBytes(v uint64) []byte {
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, v)
	return buf
}

func readCounter(m *bolt.Bucket, key string) uint64 {
	raw := m.Get([]byte(key))
	if len(raw) != 8 {
		return 0
	}
	return binary.BigEndian.Uint64(raw)
}

func writeCounter(m *bolt.Bucket, key string, v uint64) error {
	return m.Put([]byte(key), counterBytes(v))
}
