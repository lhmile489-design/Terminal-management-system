// 对应 src/main/services/OwnershipService.ts
//
// 三重凭据归属识别，PRD §6。能否终止一个进程只由这里决定（红线 2）：
// 启动来源、分组名、进程名都只用于展示，本包不 import internal/scanner，也不看它们。
//
// 凭据 1（运行 token）来自本进程的会话登记表：注入 MILE_RUN_TOKEN 时就知道根 PID 与 token 的对应关系，
// 无需回读目标进程环境块。对非根进程凭据 1 记为 unknown，由凭据 2、3 共同定案。
// 这个方向只会漏判（把自己的判成 external），不会误判（把外部的判成 owned），符合「宁可不停也不误杀」。
//
// 运行 token 只存在本包内，不出现在任何返回值里（contract.OwnershipVerdict 没有 token 字段）。
package ownership

import (
	"crypto/rand"
	"fmt"
	"sync"
	"time"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

// MaxAscent 沿父链最多上溯几层。
const MaxAscent = 12

// RegisterSlackMs 根进程创建时间可以比登记时刻晚多少（同机时钟的读数抖动）。
const RegisterSlackMs = 5000

// SameProcessMs 同一进程两次读出的创建时间允许的差（CIM 时间换算的精度）。
const SameProcessMs = 1000

type tracked struct {
	sessionID string
	rootPid   int
	runToken  string // 只登记，不读出；保留与原版同形
	// registeredAt 登记时刻。根进程由我们 spawn，它的 OS 创建时间只会早于这个时刻（留时钟抖动余量）。
	registeredAt int64
	// rootCreatedAt 根进程的 OS 创建时间，首次在进程表里看到时钉住。之后同一 PID 的创建时间变了，
	// 就是根进程已退出、PID 被系统分给了别的进程。
	rootCreatedAt *int64
}

// Service 即原版 OwnershipService。并发安全：Verify 会钉住 rootCreatedAt，所以读也要加锁。
type Service struct {
	mu sync.Mutex
	// tracked 按 sessionId 登记，保持 JS Map 的插入顺序：重复 register 同一会话位置不变、值被替换。
	order []*tracked
	index map[string]*tracked
	now   func() int64
}

// New 返回空登记表。now 为 nil 时用系统时钟（Unix ms），测试注入假时钟。
func New(now func() int64) *Service {
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	return &Service{index: map[string]*tracked{}, now: now}
}

// IssueToken 即原版 randomUUID()。
func (s *Service) IssueToken() string {
	var b [16]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read 不会返回错误（Go 1.24 起失败直接崩溃）
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// Register 登记会话的根 PID 与运行 token。
func (s *Service) Register(sessionID string, rootPid int, runToken string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := &tracked{sessionID: sessionID, rootPid: rootPid, runToken: runToken, registeredAt: s.now()}
	if old, ok := s.index[sessionID]; ok {
		for i, x := range s.order {
			if x == old {
				s.order[i] = t
				break
			}
		}
	} else {
		s.order = append(s.order, t)
	}
	s.index[sessionID] = t
}

// Unregister 移除会话登记。
func (s *Service) Unregister(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	old, ok := s.index[sessionID]
	if !ok {
		return
	}
	delete(s.index, sessionID)
	for i, x := range s.order {
		if x == old {
			s.order = append(s.order[:i], s.order[i+1:]...)
			break
		}
	}
}

// Verify 判定单个 PID。table 由扫描器一次采集后复用，避免逐个起子进程。
// 原版签名收 ProcessTable，只用到 byPid 与 mine，这里收它嵌入的 ProcessMeta。
func (s *Service) Verify(pid int, table platform.ProcessMeta) contract.OwnershipVerdict {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.verifyLocked(pid, table)
}

func (s *Service) verifyLocked(pid int, table platform.ProcessMeta) contract.OwnershipVerdict {
	sameUser := contract.CredentialMiss
	if _, ok := table.Mine[pid]; ok {
		sameUser = contract.CredentialHit
	}

	root := s.findOwningRoot(pid, table)
	processGroup := contract.CredentialMiss
	if root != nil {
		processGroup = contract.CredentialHit
	}
	token := contract.CredentialUnknown
	if root != nil && root.rootPid == pid {
		token = contract.CredentialHit
	}

	var ownership contract.Ownership
	if sameUser == contract.CredentialMiss {
		ownership = contract.OwnershipForeign
	} else if token == contract.CredentialHit || processGroup == contract.CredentialHit {
		ownership = contract.OwnershipOwned
	} else {
		ownership = contract.OwnershipExternal
	}

	v := contract.OwnershipVerdict{Pid: pid, Ownership: ownership, Token: token, ProcessGroup: processGroup, SameUser: sameUser}
	if root != nil {
		v.SessionID = root.sessionID
	}
	return v
}

// findOwningRoot 沿父链上溯，找到登记过的根就验它还是不是我们那个进程；
// 遇到 ppid <= 4（System / Idle）、自环、断链或上溯满 MaxAscent 层都停。
func (s *Service) findOwningRoot(pid int, table platform.ProcessMeta) *tracked {
	// 同一 rootPid 被多个会话登记时，按插入顺序后者覆盖前者（原版 Map.set 的语义）
	roots := map[int]*tracked{}
	for _, t := range s.order {
		roots[t.rootPid] = t
	}
	if len(roots) == 0 {
		return nil
	}
	cursor := pid
	for range MaxAscent {
		if hit, ok := roots[cursor]; ok {
			if rootStillOurs(hit, pid, table) {
				return hit
			}
			return nil
		}
		row, ok := table.ByPid[cursor]
		if !ok || row.Ppid <= 4 || row.Ppid == cursor {
			return nil
		}
		cursor = row.Ppid
	}
	return nil
}

// startedAt 原版 `table.byPid.get(x)?.startedAt` 后接 `!v`：缺行、缺字段、0 都当没有。
func startedAt(table platform.ProcessMeta, pid int) (int64, bool) {
	row, ok := table.ByPid[pid]
	if !ok || row.StartedAt == nil || *row.StartedAt == 0 {
		return 0, false
	}
	return *row.StartedAt, true
}

// rootStillOurs 命中的登记根是否仍是我们 spawn 的那个进程，且 pid 确实可能是它的后代。
// 读不到创建时间一律拒绝：「读不到就信任」会在 CIM 暂时失效时开放误杀窗口。
func rootStillOurs(hit *tracked, pid int, table platform.ProcessMeta) bool {
	rootAt, ok := startedAt(table, hit.rootPid)
	if !ok {
		return false
	}
	if hit.rootCreatedAt == nil {
		// 首次观察：我们 spawn 的根进程不可能创建得比登记还晚
		if rootAt > hit.registeredAt+RegisterSlackMs {
			return false
		}
		v := rootAt
		hit.rootCreatedAt = &v
	} else if abs(rootAt-*hit.rootCreatedAt) > SameProcessMs {
		// 同一 PID 的创建时间变了：根进程已退出，PID 被系统复用
		return false
	}
	if pid == hit.rootPid {
		return true
	}
	at, ok := startedAt(table, pid)
	// 后代不可能早于祖先创建；早于根的「子进程」只可能是 PPID 复用造成的巧合
	return ok && at >= *hit.rootCreatedAt-SameProcessMs
}

func abs(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// AssertKillable 终止前的唯一闸门：归属必须是 owned，且命中的会话就是调用方要停的会话。
// table 必须是刚采集的（≤3 秒），由调用方保证。
func (s *Service) AssertKillable(pid int, table platform.ProcessMeta, sessionID string) (contract.OwnershipVerdict, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	verdict := s.verifyLocked(pid, table)
	if verdict.Ownership != contract.OwnershipOwned {
		return verdict, fmt.Errorf("拒绝终止 PID %d：归属判定为 %s，非本应用启动", pid, verdict.Ownership)
	}
	if verdict.SessionID != sessionID {
		return verdict, fmt.Errorf("拒绝终止 PID %d：它属于会话 %s，不是要停的会话 %s", pid, verdict.SessionID, sessionID)
	}
	return verdict, nil
}

// HasTracked 登记表是否非空。
func (s *Service) HasTracked() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.order) > 0
}
