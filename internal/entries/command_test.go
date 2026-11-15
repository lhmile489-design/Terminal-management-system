// S21b 对拍：读 testdata/command_cases.json（由 scripts/gen-command-cases.mjs 跑原版 EntryService.ts 生成），
// 用与生成脚本同一份夹具目录结构重放，逐项比对命令、错误文案、会话创建与落盘。

package entries

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/detect"
	"mile-console/internal/precheck"
)

// makeCommandFixture 建出与 scripts/gen-command-cases.mjs 完全一致的目录与文件。
func makeCommandFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, b := range []string{"npm.cmd", "pnpm.cmd", "yarn.cmd", "bun.exe", "java.exe", "mvn.cmd", "gradle.bat", "python.exe", "go.exe", "cargo.exe"} {
		write(filepath.Join("bin", b), "")
	}
	for _, d := range []string{"proj/target", "proj/bin", "proj/cmd", "proj2", "outside"} {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(d)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write("proj/package.json", `{"name":"p","scripts":{"dev":"next dev","build":"next build"}}`)
	write("proj/manage.py", "")
	write("proj/mvnw.cmd", "")
	write("proj/gradlew.bat", "")
	write("proj/main.py", "")
	write("proj/target/app.jar", "")
	write("proj/bin/app.exe", "")
	write("proj/cmd/package.json", `{"name":"sub","scripts":{"dev":"next dev"}}`)
	write("proj2/package.json", `{"name":"q","scripts":{}}`)
	return root
}

// pathWhich 与 scripts 里原版 whichAny 同一口径：PATH 目录顺序、目录内候选顺序，stat 成功即命中。
func pathWhich(candidates []string) (string, bool) {
	for _, dir := range strings.Split(os.Getenv("PATH"), ";") {
		if dir == "" {
			continue
		}
		for _, name := range candidates {
			candidate := detect.Join(dir, name)
			if _, err := os.Stat(candidate); err == nil {
				return candidate, true
			}
		}
	}
	return "", false
}

type cmdStep struct {
	Op     string               `json:"op"`
	Entry  contract.LaunchEntry `json:"entry"`
	Script *string              `json:"script"`
	Kind   string               `json:"kind"`
}

func TestCommandGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "command_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	fix := makeCommandFixture(t)
	t.Setenv("PATH", filepath.Join(fix, "bin"))
	text := strings.ReplaceAll(string(raw), "<FIX>", strings.ReplaceAll(fix, `\`, `\\`))

	var file struct {
		Cases []struct {
			Name  string            `json:"name"`
			Steps []json.RawMessage `json:"steps"`
		} `json:"cases"`
	}
	if err := json.Unmarshal([]byte(text), &file); err != nil {
		t.Fatal(err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("没有用例")
	}
	steps := 0
	for _, c := range file.Cases {
		steps += len(c.Steps)
		c := c
		t.Run(c.Name, func(t *testing.T) { runCommandCase(t, c.Name, c.Steps) })
	}
	t.Logf("对拍场景 %d 个，步骤 %d 步", len(file.Cases), steps)
}

func runCommandCase(t *testing.T, name string, steps []json.RawMessage) {
	rec := &recorder{}
	store := &fakeStore{cfg: contract.AppConfig{}, rec: rec}
	svc := New(context.Background(), store, fakePlatform{}, &fakeSessions{rec: rec}, Options{
		Now:       func() time.Time { return time.UnixMilli(1_700_000_000_000) },
		Which:     pathWhich,
		OnChanged: func(list []contract.LaunchEntry) { rec.event(list) },
	})
	callsN, eventsN := 0, 0

	for i, rawStep := range steps {
		var st cmdStep
		if err := json.Unmarshal(rawStep, &st); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		var want map[string]any
		if err := json.Unmarshal(rawStep, &want); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		// store 里放这条记录，spawn 内部的 update 才有目标可改
		store.mu.Lock()
		store.cfg.Entries = []contract.LaunchEntry{st.Entry}
		store.mu.Unlock()

		var result any
		var stepErr error
		hasResult := false
		switch st.Op {
		case "build":
			cwd := resolveCwdForTest(st.Entry)
			var cmd LaunchCommand
			cmd, stepErr = svc.BuildCommand(st.Entry, cwd, st.Script)
			result, hasResult = cmd, true
		case "spawn":
			var rt contract.EntryRuntime
			rt, stepErr = svc.SpawnSession(st.Entry, st.Script, contract.SessionKind(st.Kind), nil)
			result, hasResult = rt, true
		default:
			t.Fatalf("step %d: 未知 op %q", i, st.Op)
		}

		label := name + "#" + st.Op
		wantErrText, wantErr := want["error"].(string)
		if wantErr {
			if stepErr == nil || stepErr.Error() != wantErrText {
				t.Errorf("step %d %s error: got %v want %q", i, label, stepErr, wantErrText)
			}
			hasResult = false
		} else if stepErr != nil {
			t.Errorf("step %d %s 意外错误: %v", i, label, stepErr)
		}
		if wantRes, ok := want["result"]; ok && hasResult {
			if got, w := norm(t, result), norm(t, wantRes); !reflect.DeepEqual(got, w) {
				t.Errorf("step %d %s result:\n got  %s\n want %s", i, label, showJSON(got), showJSON(w))
			}
		}

		gotCalls := rec.callsSince(callsN)
		callsN += len(gotCalls)
		if got, w := norm(t, gotCalls), norm(t, want["calls"]); !reflect.DeepEqual(got, w) {
			t.Errorf("step %d %s calls:\n got  %s\n want %s", i, label, showJSON(got), showJSON(w))
		}
		gotEvents := rec.eventsSince(eventsN)
		eventsN += len(gotEvents)
		if got, w := norm(t, gotEvents), norm(t, want["events"]); !reflect.DeepEqual(got, w) {
			t.Errorf("step %d %s events:\n got  %s\n want %s", i, label, showJSON(got), showJSON(w))
		}
	}
}

// resolveCwdForTest 直接复用 S17 移植的 resolveCwd，保持单一来源。
func resolveCwdForTest(e contract.LaunchEntry) string { return precheck.ResolveCwd(e) }
