package logx

import (
	"fmt"
	"io"
	"os"
)

const (
	colorBlue   = "\x1b[38;2;138;173;244m"
	colorGreen  = "\x1b[38;2;166;218;149m"
	colorYellow = "\x1b[38;2;238;212;159m"
	colorRed    = "\x1b[38;2;237;135;150m"
	colorReset  = "\x1b[0m"
)

var out io.Writer = os.Stdout

// SetOutput redirects all log lines to w.
func SetOutput(w io.Writer) {
	out = w
}

func printf(color, prefix, format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintf(out, "%s%s %s%s\n", color, prefix, msg, colorReset)
}

// Info prints a status line.
func Info(format string, args ...any) {
	printf(colorBlue, "[i]", format, args...)
}

// Success prints a success line.
func Success(format string, args ...any) {
	printf(colorGreen, "[+]", format, args...)
}

// Warn prints a warning line.
func Warn(format string, args ...any) {
	printf(colorYellow, "[!]", format, args...)
}

// Error prints an error line.
func Error(format string, args ...any) {
	printf(colorRed, "[-]", format, args...)
}
