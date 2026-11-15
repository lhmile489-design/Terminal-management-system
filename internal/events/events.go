// 对应 BINDINGS-CONTRACT §2 的就绪握手与「队列容量与合并策略在 internal/events 一处实现」。
//
// 页面加载前或导航中 Emit 的事件，在业务上等于丢失（页面还没订阅）。所以：
//
//	页面挂载 → 订阅全部事件 → App.Ready()
//	Go：未就绪期间事件进队列（只保留最近一次同类意图）→ Ready 后按序投递
//	导航开始 → 置未就绪 → 队列重新开始收集
//
// 关窗期间 Send 返回错误表示窗口已关，发送循环应退出。

package events

import (
	"errors"
	"sync"
)

// ErrClosed 窗口已关（或应用正在退出），发送循环据此退出。
var ErrClosed = errors.New("窗口已关闭，事件不再投递")

// maxQueued 未就绪期间最多留多少个不同的待投递事件。
// 队列按事件名合并，所以正常情况下只会有「每种事件一条」，这个上限是防御性的。
const maxQueued = 64

// SendFunc 把一条事件投给页面。窗口已关时返回 ErrClosed。
type SendFunc func(name string, payload any) error

// Bus 事件出口：未就绪时排队，就绪后按序投递。
type Bus struct {
	mu     sync.Mutex
	send   SendFunc
	ready  bool
	closed bool
	order  []string
	queued map[string]any
}

// New 构造事件总线。
func New(send SendFunc) *Bus {
	return &Bus{send: send, queued: map[string]any{}}
}

// SetSend 换发送实现（窗口重建后用）。
func (b *Bus) SetSend(send SendFunc) {
	b.mu.Lock()
	b.send = send
	b.mu.Unlock()
}

// Ready 即 App.Ready：页面订阅完成，把排队的事件按序投递出去。
func (b *Bus) Ready() error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return ErrClosed
	}
	b.ready = true
	pending := make([]string, 0, len(b.order))
	payloads := make(map[string]any, len(b.queued))
	for _, name := range b.order {
		if v, ok := b.queued[name]; ok {
			pending = append(pending, name)
			payloads[name] = v
		}
	}
	b.order = nil
	b.queued = map[string]any{}
	send := b.send
	b.mu.Unlock()

	if send == nil {
		return nil
	}
	for _, name := range pending {
		if err := send(name, payloads[name]); err != nil {
			return err
		}
	}
	return nil
}

// Navigate 即导航开始（OnWillNavigate）：置未就绪，队列重新开始收集。
func (b *Bus) Navigate() {
	b.mu.Lock()
	b.ready = false
	b.order = nil
	b.queued = map[string]any{}
	b.mu.Unlock()
}

// Close 关窗：之后 Emit 一律返回 ErrClosed。
func (b *Bus) Close() {
	b.mu.Lock()
	b.closed = true
	b.queued = map[string]any{}
	b.order = nil
	b.mu.Unlock()
}

// Emit 发一条事件。未就绪时按事件名合并（只留最近一次），就绪后立即投递。
func (b *Bus) Emit(name string, payload any) error {
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return ErrClosed
	}
	if !b.ready {
		if _, exists := b.queued[name]; !exists {
			if len(b.order) >= maxQueued {
				// 防御性上限：丢掉最早排队的那条，保留最近的意图
				oldest := b.order[0]
				b.order = b.order[1:]
				delete(b.queued, oldest)
			}
			b.order = append(b.order, name)
		}
		b.queued[name] = payload
		b.mu.Unlock()
		return nil
	}
	send := b.send
	b.mu.Unlock()
	if send == nil {
		return nil
	}
	if err := send(name, payload); err != nil {
		if errors.Is(err, ErrClosed) {
			b.Close()
		}
		return err
	}
	return nil
}

// Queued 当前排队的事件名（按排队顺序），供测试与诊断用。
func (b *Bus) Queued() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string{}, b.order...)
}

// IsReady 是否已就绪。
func (b *Bus) IsReady() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.ready
}
