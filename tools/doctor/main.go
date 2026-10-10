// rtb-doctor checks the backbone's config and its Valkey or Redis backplane.
//
//	rtb-doctor [--config path] [--json]   run the checks and exit 0 (pass), 1 (warnings) or 2 (failure)
//	rtb-doctor exec -- <command> [args]   image entrypoint: check per RTB_DOCTOR, then exec the command
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"text/tabwriter"
	"time"
)

const defaultConfig = "/centrifugo/config.json"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "exec" {
		os.Exit(execMode(os.Args[2:]))
	}
	fs := flag.NewFlagSet("rtb-doctor", flag.ExitOnError)
	path := fs.String("config", envOr("RTB_CONFIG", defaultConfig), "Centrifugo JSON config file")
	asJSON := fs.Bool("json", false, "print results as JSON")
	_ = fs.Parse(os.Args[1:])

	results, err := run(*path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "rtb-doctor:", err)
		os.Exit(2)
	}
	if *asJSON {
		_ = json.NewEncoder(os.Stdout).Encode(results)
	} else {
		printTable(os.Stdout, results)
	}
	os.Exit(ExitCode(results))
}

func run(path string) ([]Result, error) {
	cfg, err := LoadConfig(path, os.LookupEnv)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return RunAll(ctx, cfg), nil
}

func execMode(args []string) int {
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "rtb-doctor exec: no command given")
		return 2
	}
	mode := envOr("RTB_DOCTOR", "warn")
	if filepath.Base(args[0]) == "centrifugo" && mode != "off" {
		results, err := run(configFromArgs(args))
		if err != nil {
			fmt.Fprintln(os.Stderr, "rtb-doctor:", err)
			if mode == "strict" {
				return 2
			}
		} else {
			fmt.Println("rtb-doctor: checking backbone config and backplane (RTB_DOCTOR=" + mode + ")")
			printTable(os.Stdout, results)
			if mode == "strict" && ExitCode(results) == 2 {
				fmt.Fprintln(os.Stderr, "rtb-doctor: failures found, not starting (RTB_DOCTOR=strict)")
				return 2
			}
		}
	}
	bin, err := exec.LookPath(args[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, "rtb-doctor exec:", err)
		return 127
	}
	err = syscall.Exec(bin, args, os.Environ())
	fmt.Fprintln(os.Stderr, "rtb-doctor exec:", err)
	return 126
}

// configFromArgs finds Centrifugo's -c/--config flag, the same file it will load.
func configFromArgs(args []string) string {
	for i, a := range args {
		switch {
		case (a == "-c" || a == "--config") && i+1 < len(args):
			return args[i+1]
		case len(a) > 9 && a[:9] == "--config=":
			return a[9:]
		case len(a) > 3 && a[:3] == "-c=":
			return a[3:]
		}
	}
	return envOr("RTB_CONFIG", "config.json")
}

func printTable(w io.Writer, results []Result) {
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "STATUS\tCHECK\tTARGET\tDETAIL")
	for _, r := range results {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", r.Status, r.Check, r.Target, r.Detail)
	}
	_ = tw.Flush()
}

func envOr(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}
