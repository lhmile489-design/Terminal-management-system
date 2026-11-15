//go:build windows

// 测试用的假系统依赖与对拍数据加载。场景结构与 scripts/gen-win32-platform-cases.mjs 一致。

package win32

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

type call struct {
	fn        string
	file      string
	args      []string
	dir       string
	maxBuffer int
	timeout   time.Duration
	hasTimout bool
}

type reply struct {
	stdout, stderr string
	err            error
}

type fakeSys struct {
	env    map[string]string
	cwd    string
	exists map[string]bool
	lstat  map[string]bool
	calls  []call
	reply  reply
}

func (f *fakeSys) deps() sysDeps {
	return sysDeps{
		getenv: func(k string) (string, bool) {
			// `=C:` 这类驱动器当前目录变量：node 的 process.env 读不到也设不进（实测设置后读回 undefined），
			// Go 的 os.LookupEnv 同样读不到。生成器里给的 `=D:` 因此对原版不生效，这里照样看不见
			if strings.HasPrefix(k, "=") {
				return "", false
			}
			// Windows 的 process.env 不区分大小写
			for key, v := range f.env {
				if strings.EqualFold(key, k) {
					return v, true
				}
			}
			return "", false
		},
		getwd:  func() string { return f.cwd },
		exists: func(p string) bool { return f.exists[p] },
		lstat:  func(p string) bool { return f.lstat[p] },
		run: func(ctx context.Context, file string, args []string, maxBuffer int) ([]byte, []byte, error) {
			c := call{fn: "execFile", file: file, args: append([]string(nil), args...), maxBuffer: maxBuffer}
			if dl, ok := ctx.Deadline(); ok {
				// 截到最近的 100ms：deadline 是 now + timeout，减去流逝的一点时间
				c.timeout = time.Until(dl).Round(100 * time.Millisecond)
				c.hasTimout = true
			}
			f.calls = append(f.calls, c)
			return []byte(f.reply.stdout), []byte(f.reply.stderr), f.reply.err
		},
		start: func(ctx context.Context, file string, args []string, dir string) error {
			if ctx.Done() != nil {
				return errors.New("外部终端的 ctx 不该带取消")
			}
			f.calls = append(f.calls, call{fn: "spawn", file: file, args: append([]string(nil), args...), dir: dir})
			return nil
		},
		now: func() int64 { return 42 },
	}
}

func set2(xs []string) map[string]bool {
	m := map[string]bool{}
	for _, x := range xs {
		m[x] = true
	}
	return m
}

// scenarioIn 即生成器里的 scenario 入参。env 里 null 的键表示 undefined。
type scenarioIn struct {
	Env    map[string]*string `json:"env"`
	Cwd    string             `json:"cwd"`
	Exists []string           `json:"exists"`
	Lstat  []string           `json:"lstat"`
}

func (s scenarioIn) fake() *fakeSys {
	env := map[string]string{}
	for k, v := range s.Env {
		if v != nil {
			env[k] = *v
		}
	}
	cwd := s.Cwd
	if cwd == "" {
		cwd = `C:\Work\proj`
	}
	return &fakeSys{env: env, cwd: cwd, exists: set2(s.Exists), lstat: set2(s.Lstat)}
}

func loadPlatform(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	b, err := os.ReadFile("testdata/win32_platform_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func section[T any](t *testing.T, m map[string]json.RawMessage, key string, minLen int) []T {
	t.Helper()
	var xs []T
	if err := json.Unmarshal(m[key], &xs); err != nil {
		t.Fatalf("%s：%v", key, err)
	}
	if len(xs) < minLen {
		t.Fatalf("%s 只有 %d 组，至少要 %d 组", key, len(xs), minLen)
	}
	return xs
}
