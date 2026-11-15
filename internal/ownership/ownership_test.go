// S14 对拍：重放 testdata/ownership_cases.json（scripts/gen-ownership-cases.mjs 跑原版
// src/main/services/OwnershipService.ts 生成），逐步比较判定结果与错误文案。
// 另有几条一眼能看懂的硬项：PID 复用拒绝、会话不一致拒绝、token 格式与不进 contract、不 import scanner。

package ownership

import (
	"encoding/json"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

type caseTable struct {
	Rows [][3]*int64 `json:"rows"`
	Mine *[]int      `json:"mine"`
}

type caseStep struct {
	Clock     *int64            `json:"clock"`
	Op        string            `json:"op"`
	Args      []json.RawMessage `json:"args"`
	Pid       int               `json:"pid"`
	Table     caseTable         `json:"table"`
	SessionID string            `json:"sessionId"`
	Result    json.RawMessage   `json:"result"`
	Error     *string           `json:"error"`
}

type caseFile struct {
	TokenSample string `json:"tokenSample"`
	Cases       []struct {
		Name  string     `json:"name"`
		Clock int64      `json:"clock"`
		Steps []caseStep `json:"steps"`
	} `json:"cases"`
}

func loadCases(t *testing.T) caseFile {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "ownership_cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f caseFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

func (c caseTable) meta() platform.ProcessMeta {
	m := platform.ProcessMeta{ByPid: map[int]platform.ProcessRow{}, Mine: map[int]struct{}{}}
	for _, r := range c.Rows {
		pid, ppid := int(*r[0]), int(*r[1])
		m.ByPid[pid] = platform.ProcessRow{Pid: pid, Ppid: ppid, Name: "x", StartedAt: r[2]}
		if c.Mine == nil {
			m.Mine[pid] = struct{}{}
		}
	}
	if c.Mine != nil {
		for _, p := range *c.Mine {
			m.Mine[p] = struct{}{}
		}
	}
	return m
}

func TestServiceMatchesOriginal(t *testing.T) {
	f := loadCases(t)
	if len(f.Cases) == 0 {
		t.Fatal("没有用例")
	}
	seenOps := map[string]int{}
	steps := 0
	for _, c := range f.Cases {
		clock := c.Clock
		svc := New(func() int64 { return clock })
		for i, st := range c.Steps {
			if st.Clock != nil {
				clock = *st.Clock
				continue
			}
			steps++
			seenOps[st.Op]++
			where := c.Name + " #" + strconv.Itoa(i) + " " + st.Op
			switch st.Op {
			case "register":
				var sid, tok string
				var pid int
				mustUnmarshal(t, st.Args[0], &sid)
				mustUnmarshal(t, st.Args[1], &pid)
				mustUnmarshal(t, st.Args[2], &tok)
				svc.Register(sid, pid, tok)
			case "unregister":
				var sid string
				mustUnmarshal(t, st.Args[0], &sid)
				svc.Unregister(sid)
			case "hasTracked":
				var want bool
				mustUnmarshal(t, st.Result, &want)
				if got := svc.HasTracked(); got != want {
					t.Errorf("%s：Go %v，原版 %v", where, got, want)
				}
			case "verify":
				var want contract.OwnershipVerdict
				mustUnmarshal(t, st.Result, &want)
				if got := svc.Verify(st.Pid, st.Table.meta()); got != want {
					t.Errorf("%s pid %d：\n  Go   %+v\n  原版 %+v", where, st.Pid, got, want)
				}
			case "assertKillable":
				got, err := svc.AssertKillable(st.Pid, st.Table.meta(), st.SessionID)
				if st.Error != nil {
					if err == nil || err.Error() != *st.Error {
						t.Errorf("%s pid %d：Go 错误 %v，原版 %q", where, st.Pid, err, *st.Error)
					}
					continue
				}
				var want contract.OwnershipVerdict
				mustUnmarshal(t, st.Result, &want)
				if err != nil || got != want {
					t.Errorf("%s pid %d：Go %+v / %v，原版 %+v", where, st.Pid, got, err, want)
				}
			default:
				t.Fatalf("%s：未知操作", where)
			}
		}
	}
	for _, op := range []string{"register", "unregister", "verify", "assertKillable", "hasTracked"} {
		if seenOps[op] == 0 {
			t.Errorf("对拍数据没覆盖 %s", op)
		}
	}
	t.Logf("%d 个场景，%d 步，%v", len(f.Cases), steps, seenOps)
}

func mustUnmarshal(t *testing.T, b json.RawMessage, v any) {
	t.Helper()
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("解析 %s：%v", b, err)
	}
}

func meta(rows ...[3]int64) platform.ProcessMeta {
	m := platform.ProcessMeta{ByPid: map[int]platform.ProcessRow{}, Mine: map[int]struct{}{}}
	for _, r := range rows {
		m.ByPid[int(r[0])] = platform.ProcessRow{Pid: int(r[0]), Ppid: int(r[1]), StartedAt: new(r[2])}
		m.Mine[int(r[0])] = struct{}{}
	}
	return m
}

// TestPidReuseRejected：验收卡硬项。钉住根的创建时间后，同一 PID 换成 30 秒后创建的进程，根与其子进程都不可停。
func TestPidReuseRejected(t *testing.T) {
	t0 := int64(1_700_000_000_000)
	svc := New(func() int64 { return t0 })
	svc.Register("s1", 5000, "tok")
	if _, err := svc.AssertKillable(5000, meta([3]int64{5000, 1000, t0 - 200}), "s1"); err != nil {
		t.Fatalf("前提失败：原根进程应可停：%v", err)
	}
	reused := meta([3]int64{5000, 1000, t0 + 30_000}, [3]int64{5100, 5000, t0 + 31_000})
	for _, pid := range []int{5000, 5100} {
		v, err := svc.AssertKillable(pid, reused, "s1")
		if err == nil || v.Ownership == contract.OwnershipOwned {
			t.Errorf("PID %d 被复用后仍放行：%+v", pid, v)
		}
	}
}

// TestSessionMismatchRejected：验收卡硬项。PID 落在别的会话树里，停 A 不能因此放行。
func TestSessionMismatchRejected(t *testing.T) {
	t0 := int64(1_700_000_000_000)
	svc := New(func() int64 { return t0 })
	svc.Register("s1", 5000, "tok")
	svc.Register("s2", 6000, "tok2")
	tb := meta([3]int64{5000, 1000, t0 - 200}, [3]int64{6000, 1000, t0 - 100})
	_, err := svc.AssertKillable(6000, tb, "s1")
	if err == nil || err.Error() != "拒绝终止 PID 6000：它属于会话 s2，不是要停的会话 s1" {
		t.Errorf("会话不一致应拒绝：%v", err)
	}
	if _, err := svc.AssertKillable(6000, tb, "s2"); err != nil {
		t.Errorf("会话一致应放行：%v", err)
	}
}

var uuidV4 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// TestIssueToken：格式与原版 randomUUID 一致，且每次不同。
func TestIssueToken(t *testing.T) {
	f := loadCases(t)
	if !uuidV4.MatchString(f.TokenSample) {
		t.Fatalf("原版样本不是 v4 UUID：%q", f.TokenSample)
	}
	svc := New(nil)
	seen := map[string]bool{}
	for range 100 {
		tok := svc.IssueToken()
		if !uuidV4.MatchString(tok) {
			t.Fatalf("格式不对：%q", tok)
		}
		if seen[tok] {
			t.Fatalf("重复 token：%q", tok)
		}
		seen[tok] = true
	}
}

// TestTokenNeverInVerdict：红线配套。判定结果里没有任何字段装得下 token，登记的 token 也不会出现在序列化结果里。
func TestTokenNeverInVerdict(t *testing.T) {
	for f := range reflect.TypeFor[contract.OwnershipVerdict]().Fields() {
		name := strings.ToLower(f.Name)
		if strings.Contains(name, "runtoken") {
			t.Errorf("OwnershipVerdict 不应有 %s 字段", name)
		}
	}
	t0 := int64(1_700_000_000_000)
	svc := New(func() int64 { return t0 })
	const secret = "secret-run-token-value"
	svc.Register("s1", 5000, secret)
	v, _ := svc.AssertKillable(5000, meta([3]int64{5000, 1000, t0}), "s1")
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), secret) {
		t.Errorf("判定结果泄露了 token：%s", b)
	}
	if v.Token != contract.CredentialHit {
		t.Errorf("token 凭据应为 hit：%+v", v)
	}
}

// TestDoesNotImportScanner：红线 2，与 internal/scanner 的同名测试互为镜像，防止任一侧被删后检查失效。
func TestDoesNotImportScanner(t *testing.T) {
	ents, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		f, err := parser.ParseFile(token.NewFileSet(), e.Name(), nil, parser.ImportsOnly)
		if err != nil {
			t.Fatal(err)
		}
		checked++
		for _, im := range f.Imports {
			p, _ := strconv.Unquote(im.Path.Value)
			if p != "crypto/rand" && p != "fmt" && p != "sync" && p != "time" &&
				p != "mile-console/internal/contract" && p != "mile-console/internal/platform" {
				t.Errorf("%s import 了 %s：归属判定只允许依赖 contract 与 platform 的数据结构", e.Name(), p)
			}
		}
	}
	if checked == 0 {
		t.Fatal("没有检查到源文件")
	}
}

// TestConcurrentVerify：Verify 会钉住 rootCreatedAt，并发调用不应出现数据竞争导致的 panic（本机无 cgo，-race 不可用）。
func TestConcurrentVerify(t *testing.T) {
	t0 := int64(1_700_000_000_000)
	svc := New(func() int64 { return t0 })
	tb := meta([3]int64{5000, 1000, t0 - 200}, [3]int64{5100, 5000, t0})
	done := make(chan struct{})
	for g := range 8 {
		go func() {
			defer func() { done <- struct{}{} }()
			for i := range 500 {
				sid := "s" + strconv.Itoa(g)
				svc.Register(sid, 5000, "tok")
				_ = svc.Verify(5100, tb)
				_, _ = svc.AssertKillable(5000, tb, sid)
				if i%3 == 0 {
					svc.Unregister(sid)
				}
				_ = svc.HasTracked()
			}
		}()
	}
	for range 8 {
		<-done
	}
}
