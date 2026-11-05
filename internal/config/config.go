package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	DefaultPort    = 8000
	ConfigFileName = "config.json"
	DataFileName   = "data.db"
)

type Config struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

// DefaultPath returns the config path next to the running binary.
func DefaultPath() string {
	exe, err := os.Executable()
	if err != nil {
		return ConfigFileName
	}
	return filepath.Join(filepath.Dir(exe), ConfigFileName)
}

// DataPath returns the database path next to the config file.
func DataPath(cfgPath string) string {
	return filepath.Join(filepath.Dir(cfgPath), DataFileName)
}

// Load reads the config file at path and fills defaults.
// A missing file yields the defaults so the first start works without setup.
func Load(path string) (*Config, error) {
	cfg := &Config{Port: DefaultPort}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, fmt.Errorf("failed to read config %s: %w", path, err)
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("failed to parse config %s: %w", path, err)
	}
	return cfg, nil
}

// Validate checks every field and reports the first problem found.
func (c *Config) Validate() error {
	if c.Port < 1 || c.Port > 65535 {
		return fmt.Errorf("field port must be 1 to 65535, got %d", c.Port)
	}
	return nil
}

// Save writes the config file with 0600 permissions.
func (c *Config) Save(path string) error {
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to encode config: %w", err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(path, data, 0600); err != nil {
		return fmt.Errorf("failed to write config %s: %w", path, err)
	}
	return nil
}

// GenerateToken returns a fresh random config token.
func GenerateToken() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}
	return hex.EncodeToString(buf), nil
}
