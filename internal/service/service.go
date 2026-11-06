package service

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const unitName = "bs.service"

// Install registers the daemon for auto-start on boot and starts it.
func Install(cfgPath string) error {
	abs, err := filepath.Abs(cfgPath)
	if err != nil {
		return err
	}
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return fmt.Errorf("systemd is not available")
	}
	if os.Geteuid() != 0 {
		return fmt.Errorf("install requires root, run with sudo")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	unitPath := filepath.Join("/etc/systemd/system", unitName)
	if err := os.WriteFile(unitPath, []byte(unitText(exe, abs)), 0644); err != nil {
		return fmt.Errorf("failed to write %s: %w", unitPath, err)
	}
	for _, cmd := range [][]string{
		{"systemctl", "daemon-reload"},
		{"systemctl", "enable", "bs"},
		{"systemctl", "restart", "bs"},
	} {
		if out, err := exec.Command(cmd[0], cmd[1:]...).CombinedOutput(); err != nil {
			return fmt.Errorf("%s failed: %v (%s)", strings.Join(cmd, " "), err, strings.TrimSpace(string(out)))
		}
	}
	time.Sleep(time.Second)
	out, _ := exec.Command("systemctl", "is-active", "bs").Output()
	status := strings.TrimSpace(string(out))
	if status != "active" {
		return fmt.Errorf("service is %q after start, check journalctl -u bs", status)
	}
	return nil
}

// ServiceState returns the systemd active state of the bs unit.
// It returns "unavailable" when systemd is not present on the host.
func ServiceState() (string, error) {
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return "unavailable", nil
	}
	out, err := exec.Command("systemctl", "is-active", "bs").Output()
	state := strings.TrimSpace(string(out))
	if err != nil && state == "" {
		return "", err
	}
	if state == "" {
		state = "unknown"
	}
	return state, nil
}

// Uninstall stops the daemon and removes the auto-start registration.
func Uninstall() error {
	if os.Geteuid() != 0 {
		return fmt.Errorf("uninstall requires root, run with sudo")
	}
	exec.Command("systemctl", "stop", "bs").Run()
	exec.Command("systemctl", "disable", "bs").Run()
	unitPath := filepath.Join("/etc/systemd/system", unitName)
	if err := os.Remove(unitPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove %s: %w", unitPath, err)
	}
	exec.Command("systemctl", "daemon-reload").Run()
	return nil
}

func unitText(exe, cfgPath string) string {
	return fmt.Sprintf(`[Unit]
Description=bs bookmark and password sync server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=%s run --config %s
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`, exe, cfgPath)
}
