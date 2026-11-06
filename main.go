package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"bs/internal/config"
	"bs/internal/logx"
	"bs/internal/server"
	"bs/internal/service"
	"bs/internal/store"
)

const version = "0.1.0"

const (
	colorMauve  = "\x1b[38;2;198;160;246m"
	colorBlue   = "\x1b[38;2;138;173;244m"
	colorGreen  = "\x1b[38;2;166;218;149m"
	colorYellow = "\x1b[38;2;238;212;159m"
	colorBold   = "\x1b[1m"
	colorReset  = "\x1b[0m"
)

type command struct {
	name    string
	summary string
	usage   string
	options [][2]string
	run     func(args []string) int
}

var commandExamples = map[string][]string{
	"run":       {"bs run --config config.json"},
	"install":   {"sudo bs install --config config.json"},
	"uninstall": {"sudo bs uninstall"},
	"status":    {"bs status", "bs status --config config.json"},
}

var commands = []command{
	{
		name: "run", summary: "Run in foreground for debugging",
		usage: "bs run [--config <path>]",
		options: [][2]string{
			{"--config <path>", "config file path"},
		},
		run: runCmd,
	},
	{
		name: "install", summary: "Start the daemon and enable auto-start",
		usage: "bs install [--config <path>]",
		options: [][2]string{
			{"--config <path>", "config file path"},
		},
		run: installCmd,
	},
	{
		name: "uninstall", summary: "Stop the daemon and disable auto-start",
		usage: "bs uninstall",
		run:   uninstallCmd,
	},
	{
		name: "status", summary: "Show daemon and service health",
		usage: "bs status [--config <path>]",
		options: [][2]string{
			{"--config <path>", "config file path"},
		},
		run: statusCmd,
	},
	{
		name: "version", summary: "Show version",
		usage: "bs version",
		run:   versionCmd,
	},
}

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}
	name := os.Args[1]
	switch name {
	case "-v", "-V", "--version":
		name = "version"
	case "-h", "--help", "help":
		printUsage()
		os.Exit(0)
	}
	for _, c := range commands {
		if c.name == name {
			if len(os.Args) > 2 && isHelpArg(os.Args[2]) {
				printCommandUsage(c)
				os.Exit(0)
			}
			os.Exit(c.run(os.Args[2:]))
		}
	}
	logx.Error("unknown command %s", name)
	printUsage()
	os.Exit(1)
}

func isHelpArg(s string) bool {
	return s == "-h" || s == "--help" || s == "help"
}

func runCmd(args []string) int {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	fs.Usage = func() {
		printCommandUsage(command{
			name: "run", summary: "Run in foreground for debugging",
			usage: "bs run [--config <path>]",
			options: [][2]string{
				{"--config <path>", "config file path"},
			},
		})
	}
	cfgPath := fs.String("config", config.DefaultPath(), "config file path")
	fs.Parse(args)

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		logx.Error("%v", err)
		return 1
	}
	if err := cfg.Validate(); err != nil {
		logx.Error("invalid config: %v", err)
		return 1
	}
	if cfg.Token == "" {
		token, err := config.GenerateToken()
		if err != nil {
			logx.Error("%v", err)
			return 1
		}
		cfg.Token = token
		if err := cfg.Save(*cfgPath); err != nil {
			logx.Error("%v", err)
			return 1
		}
		logx.Success("generated config token %s", token)
		logx.Info("it authorizes auth token registration, keep it secret")
	}

	st, err := store.Open(config.DataPath(*cfgPath))
	if err != nil {
		logx.Error("%v", err)
		return 1
	}
	defer st.Close()

	srv := server.New(st, cfg.Token)
	httpServer := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		logx.Info("listening on port %d", cfg.Port)
		logx.Info("database %s", config.DataPath(*cfgPath))
		errCh <- httpServer.ListenAndServe()
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	select {
	case sig := <-sigCh:
		logx.Info("received %s, shutting down", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(ctx); err != nil {
			logx.Warn("shutdown: %v", err)
		}
		return 0
	case err := <-errCh:
		logx.Error("%v", err)
		return 1
	}
}

func installCmd(args []string) int {
	fs := flag.NewFlagSet("install", flag.ExitOnError)
	fs.Usage = func() {
		printCommandUsage(command{
			name: "install", summary: "Start the daemon and enable auto-start",
			usage: "bs install [--config <path>]",
			options: [][2]string{
				{"--config <path>", "config file path"},
			},
		})
	}
	cfgPath := fs.String("config", config.DefaultPath(), "config file path")
	fs.Parse(args)
	if err := service.Install(*cfgPath); err != nil {
		logx.Error("%v", err)
		return 1
	}
	logx.Success("daemon started and auto-start enabled")
	return 0
}

func uninstallCmd(_ []string) int {
	if err := service.Uninstall(); err != nil {
		logx.Error("%v", err)
		return 1
	}
	logx.Success("daemon stopped and auto-start disabled")
	return 0
}

func statusCmd(args []string) int {
	fs := flag.NewFlagSet("status", flag.ExitOnError)
	fs.Usage = func() {
		printCommandUsage(command{
			name: "status", summary: "Show daemon and service health",
			usage: "bs status [--config <path>]",
			options: [][2]string{
				{"--config <path>", "config file path"},
			},
		})
	}
	cfgPath := fs.String("config", config.DefaultPath(), "config file path")
	fs.Parse(args)

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		logx.Error("config: %v", err)
		return 1
	}
	if err := cfg.Validate(); err != nil {
		logx.Error("config: %v", err)
		return 1
	}
	logx.Info("config %s", *cfgPath)

	dataPath := config.DataPath(*cfgPath)
	if _, err := os.Stat(dataPath); err != nil {
		logx.Warn("database %s missing", dataPath)
	} else {
		logx.Info("database %s", dataPath)
	}

	state, err := service.ServiceState()
	if err != nil {
		logx.Warn("service: %v", err)
	} else {
		logx.Info("service %s", state)
	}

	health := probeHealth(cfg.Port)
	if !health.reachable {
		logx.Error("daemon not answering on port %d", cfg.Port)
		return 1
	}
	logx.Success("daemon answering on port %d", cfg.Port)
	if health.registered {
		logx.Info("auth token registered")
	} else {
		logx.Warn("no auth token yet, connect a client to register")
	}
	return 0
}

type healthResult struct {
	reachable  bool
	registered bool
}

func probeHealth(port int) healthResult {
	url := fmt.Sprintf("http://127.0.0.1:%d/api/status", port)
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return healthResult{}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return healthResult{reachable: true}
	}
	var body struct {
		Registered bool `json:"registered"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return healthResult{reachable: true}
	}
	return healthResult{reachable: true, registered: body.Registered}
}

func versionCmd(_ []string) int {
	fmt.Printf("%sbs%s %s%s%s\n", colorBlue, colorReset, colorGreen, version, colorReset)
	return 0
}

func printUsage() {
	fmt.Printf(
		"\n%s%sbs%s — bookmark and password sync server\n\n"+
			"%sUSAGE:%s\n"+
			"  %sbs%s <command>\n\n"+
			"%sCOMMANDS:%s\n",
		colorBold, colorBlue, colorReset,
		colorBold+colorMauve, colorReset,
		colorBlue, colorReset,
		colorBold+colorMauve, colorReset,
	)
	for _, c := range commands {
		fmt.Printf("  %s%-10s%s %s\n", colorGreen, c.name, colorReset, c.summary)
	}
	fmt.Println()
}

func printCommandUsage(c command) {
	fmt.Printf(
		"\n%s%sbs %s%s — %s%s\n\n"+
			"%sUSAGE:%s\n"+
			"  %s%s%s\n",
		colorBold, colorBlue, c.name, colorReset, c.summary, colorReset,
		colorBold+colorMauve, colorReset,
		colorBlue, c.usage, colorReset,
	)
	if len(c.options) > 0 {
		fmt.Printf("\n%sOPTIONS:%s\n", colorBold+colorMauve, colorReset)
		width := 0
		for _, o := range c.options {
			if len(o[0]) > width {
				width = len(o[0])
			}
		}
		for _, o := range c.options {
			fmt.Printf("  %s%s%s %s\n", colorYellow,
				o[0]+strings.Repeat(" ", width-len(o[0])), colorReset, o[1])
		}
	}
	if examples := commandExamples[c.name]; len(examples) > 0 {
		fmt.Printf("\n%sEXAMPLES:%s\n", colorBold+colorMauve, colorReset)
		for _, e := range examples {
			fmt.Printf("  %s%s%s\n", colorBlue, e, colorReset)
		}
	}
	fmt.Println()
}
