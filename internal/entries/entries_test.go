// S21a 对拍：读 testdata/entry_cases.json（由 scripts/gen-entry-cases.mjs 跑原版 EntryService.ts 生成），
// 在 Go 实现上逐步重放，逐项比对 result / error / calls / events。

package entries

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

// recorder 记录调用与广播。Remove 会在后台协程里终止会话，所以读写都加锁。
type recorder struct {
	mu     sync.Mutex
	calls  []any
	events []any
}

func (r *recorder) add(v any) {
	r.mu.Lock()
	r.calls = append(r.calls, v)
	r.mu.Unlock()
}

func (r *recorder) event(v any) {
	r.mu.Lock()
	r.events = append(r.events, v)
	r.mu.Unlock()
}

func (r *recorder) callsSince(n int) []any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]any{}, r.calls[n:]...)
}

func (r *recorder) eventsSince(n int) []any {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]any{}, r.events[n:]...)
}

// fakeStore 即原版构造参数 config 上实际用到的 get / patch。
type fakeStore struct {
	mu  sync.Mutex
	cfg contract.AppConfig
	rec *recorder
}

func (f *fakeStore) Get() contract.AppConfig {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cfg
}

func (f *fakeStore) Patch(fn func(c *contract.AppConfig)) (contract.AppConfig, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(&f.cfg)
	if f.rec != nil {
		f.rec.add([]any{"config.patch", map[string]any{"entries": f.cfg.Entries}})
	}
	return f.cfg, nil
}

// fakePlatform 与 scripts/platform-stub-entry.mjs 同一算法。
type fakePlatform struct{}

func (fakePlatform) PathKey(p string) string {
	p = strings.ReplaceAll(p, "/", `\`)
	p = strings.TrimRight(p, `\`)
	return strings.ToLower(p)
}

func (fakePlatform) UnsupportedLaunchModes() map[contract.LaunchMode]bool {
	return map[contract.LaunchMode]bool{contract.LaunchModeDjango: true}
}

func (fakePlatform) RequiresExecBit() bool { return false }

func (fakePlatform) ReadListenPorts(context.Context) ([]platform.ListenRow, error) { return nil, nil }

func (fakePlatform) Binaries() map[platform.BinaryName][]string {
	return map[platform.BinaryName][]string{
		platform.BinaryNpm:    {"npm.cmd", "npm.exe"},
		platform.BinaryPnpm:   {"pnpm.cmd", "pnpm.exe"},
		platform.BinaryYarn:   {"yarn.cmd", "yarn.exe"},
		platform.BinaryBun:    {"bun.exe"},
		platform.BinaryJava:   {"java.exe"},
		platform.BinaryMvn:    {"mvn.cmd", "mvn.bat", "mvn"},
		platform.BinaryGradle: {"gradle.cmd", "gradle.bat", "gradle"},
		platform.BinaryPython: {"python.exe", "python3.exe", "py.exe", "python", "python3"},
		platform.BinaryGo:     {"go.exe", "go"},
		platform.BinaryCargo:  {"cargo.exe", "cargo"},
	}
}

func (fakePlatform) WrapperFile() platform.WrapperFiles {
	return platform.WrapperFiles{Maven: "mvnw.cmd", Gradle: "gradlew.bat"}
}

func (fakePlatform) HBuilderXCandidates() []string { return nil }

func (fakePlatform) WrapBatch(file string, args []string) (string, []string) {
	return "cmd.exe", append([]string{"/d", "/s", "/c", file}, args...)
}

type fakeSessions struct {
	rec  *recorder
	mu   sync.Mutex
	data []func(contract.SessionDataEvent)
	exit []func(contract.SessionExitEvent)
	hist map[string]string
}

func (f *fakeSessions) OnData(fn func(contract.SessionDataEvent)) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.data = append(f.data, fn)
	return func() {}
}

func (f *fakeSessions) OnExit(fn func(contract.SessionExitEvent)) func() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.exit = append(f.exit, fn)
	return func() {}
}

func (f *fakeSessions) Stop(id string) {
	if f.rec != nil {
		f.rec.add([]any{"sessions.stop", id})
	}
}

func (f *fakeSessions) History(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hist[id]
}

func (f *fakeSessions) emitData(id, chunk string) {
	f.mu.Lock()
	fns := append([]func(contract.SessionDataEvent){}, f.data...)
	f.mu.Unlock()
	for _, fn := range fns {
		fn(contract.SessionDataEvent{ID: id, Chunk: chunk})
	}
}

func (f *fakeSessions) emitExit(id string, code int) {
	f.mu.Lock()
	fns := append([]func(contract.SessionExitEvent){}, f.exit...)
	f.mu.Unlock()
	for _, fn := range fns {
		fn(contract.SessionExitEvent{ID: id, ExitCode: code})
	}
}

func (f *fakeSessions) Create(in contract.CreateSessionInput) (contract.SessionMeta, error) {
	if f.rec != nil {
		f.rec.add([]any{"sessions.create", in})
	}
	return contract.SessionMeta{ID: "sess-1", Pid: 4000, StartedAt: 1_700_000_000_000}, nil
}

func (f *fakeSessions) Kill(_ context.Context, id string) {
	if f.rec != nil {
		f.rec.add([]any{"sessions.kill", id})
	}
}

type entryStep struct {
	Op            string          `json:"op"`
	ID            string          `json:"id"`
	Status        string          `json:"status"`
	Input         json.RawMessage `json:"input"`
	Patch         json.RawMessage `json:"patch"`
	IDs           []string        `json:"ids"`
	Chunk         string          `json:"chunk"`
	Code          int             `json:"code"`
	StoppedByUser bool            `json:"stoppedByUser"`
	P             string          `json:"p"`
	GroupID       *string         `json:"groupId"`
	Deps          []string        `json:"deps"`
}

// norm 经 JSON 往返统一数字类型，再递归去掉值为 null 的键。
func norm(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return stripNull(out)
}

func stripNull(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, vv := range x {
			if vv == nil {
				delete(x, k)
				continue
			}
			x[k] = stripNull(vv)
		}
		return x
	case []any:
		for i := range x {
			x[i] = stripNull(x[i])
		}
		return x
	}
	return v
}

func showJSON(v any) string {
	b, _ := json.Marshal(v)
	s := string(b)
	if len(s) > 1200 {
		s = s[:1200] + "..."
	}
	return s
}

func TestEntryGolden(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "entry_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	fix := t.TempDir()
	for _, d := range []string{"proj", "proj2"} {
		if err := os.MkdirAll(filepath.Join(fix, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// JSON 里的 <FIX> 是占位符；替换成这台机器的临时目录（反斜杠要按 JSON 转义）
	text := strings.ReplaceAll(string(raw), "<FIX>", strings.ReplaceAll(fix, `\`, `\\`))

	var file struct {
		Cases []struct {
			Name    string                  `json:"name"`
			Entries []contract.LaunchEntry  `json:"entries"`
			Groups  []contract.ProjectGroup `json:"groups"`
			Steps   []json.RawMessage       `json:"steps"`
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
		t.Run(c.Name, func(t *testing.T) {
			runEntryCase(t, c.Name, c.Entries, c.Groups, c.Steps)
		})
	}
	t.Logf("对拍场景 %d 个，步骤 %d 步", len(file.Cases), steps)
}

func runEntryCase(t *testing.T, name string, entries []contract.LaunchEntry, groups []contract.ProjectGroup, steps []json.RawMessage) {
	rec := &recorder{}
	store := &fakeStore{cfg: contract.AppConfig{Entries: entries, Groups: groups}, rec: rec}
	var idSeq int
	svc := New(context.Background(), store, fakePlatform{}, &fakeSessions{rec: rec}, Options{
		Now:   func() time.Time { return time.UnixMilli(1_700_000_000_000) },
		NewID: func() string { idSeq++; return "id-" + strconv.Itoa(idSeq) },
		OnChanged: func(list []contract.LaunchEntry) {
			rec.event(list)
		},
	})

	callsN, eventsN := 0, 0
	for i, rawStep := range steps {
		var st entryStep
		if err := json.Unmarshal(rawStep, &st); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		var want map[string]any
		if err := json.Unmarshal(rawStep, &want); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
		var result any
		var stepErr error
		hasResult := false

		switch st.Op {
		case "add":
			var in contract.NewLaunchEntry
			if err := json.Unmarshal(st.Input, &in); err != nil {
				t.Fatalf("step %d add input: %v", i, err)
			}
			var e contract.LaunchEntry
			e, stepErr = svc.Add(in)
			result, hasResult = e, true
		case "edit":
			var p contract.EntryEdit
			if err := json.Unmarshal(st.Patch, &p); err != nil {
				t.Fatalf("step %d edit patch: %v", i, err)
			}
			var e contract.LaunchEntry
			e, stepErr = svc.Edit(st.ID, p)
			result, hasResult = e, true
		case "sanitize":
			target, ok := svc.Get(st.ID)
			if !ok {
				t.Fatalf("step %d: 种子条目 %s 不存在", i, st.ID)
			}
			var p contract.EntryEdit
			if err := json.Unmarshal(st.Patch, &p); err != nil {
				t.Fatalf("step %d sanitize patch: %v", i, err)
			}
			var clean contract.EntryEdit
			clean, stepErr = svc.SanitizeEdit(target, p)
			result, hasResult = ApplyEdit(target, clean), true
		case "runtime":
			svc.putRuntime(contract.EntryRuntime{EntryID: st.ID, Status: contract.EntryStatus(st.Status)})
		case "remove":
			stepErr = svc.Remove(st.ID)
		case "reorder":
			var list []contract.LaunchEntry
			list, stepErr = svc.Reorder(st.IDs)
			result, hasResult = list, true
		case "list":
			result, hasResult = svc.List(), true
		case "capturePort":
			port, ok := CapturePort(st.Chunk)
			if ok {
				result = port
			}
			hasResult = true
		case "taskStatus":
			result, hasResult = TaskStatus(st.Code, st.StoppedByUser), true
		case "isSafeRelative":
			result, hasResult = IsSafeRelative(st.P), true
		case "normalizePath":
			result, hasResult = NormalizePath(fakePlatform{}, st.P), true
		case "groupEnv":
			g := ""
			if st.GroupID != nil {
				g = *st.GroupID
			}
			result, hasResult = svc.GroupEnv(g), true
		case "startAfter":
			stepErr = svc.AssertStartAfter(st.ID, st.Deps)
		default:
			t.Fatalf("step %d: 未知 op %q", i, st.Op)
		}

		label := name + "#" + st.Op
		wantErrText, wantErr := want["error"].(string)
		if wantErr {
			if stepErr == nil || stepErr.Error() != wantErrText {
				t.Errorf("step %d %s error: got %v want %q", i, label, stepErr, wantErrText)
			}
			// 原版抛错时不产生返回值，Go 侧的零值不参与比对
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
