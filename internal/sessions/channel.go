// 对应 src/main/services/SessionService.ts 的 'data' / 'exit' 广播（Electron 里走 webContents.send('session:data')）。
//
// Go 版把「回放历史 + 接续实时输出」合成一次 Attach：页面传入一个 *mygo.Channel，
// 先收到 buffer 快照，再按 16ms 合并后的块持续收到新输出，会话退出且队列排空后返回。
// 页面关闭 Channel 会让调用 ctx 取消，Attach 随之返回。
//
// 每个订阅者有自己的队列：flush 只往队列里追加（永不阻塞），慢消费者超过 MaxBufferChars 时从头部丢弃，
// 与 buffer 的截断规则一致，保证一个卡住的页面拖不住会话。

package sessions

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/egoist/mygo"

	"mile-console/internal/contract"
)

// historyChunkBytes 回放历史时单块的字节上限（mygo Channel 背压阈值是 1 MiB，留足余量）。
const historyChunkBytes = 64 * 1024

// sub 是一个订阅者的待发队列。
type sub struct {
	mu     sync.Mutex
	queue  string
	exited bool
	wake   chan struct{}
}

func newSub() *sub { return &sub{wake: make(chan struct{}, 1)} }

func (b *sub) signal() {
	select {
	case b.wake <- struct{}{}:
	default:
	}
}

// push 追加一块输出；队列超过上限时丢掉最老的部分。
func (b *sub) push(chunk string) {
	b.mu.Lock()
	b.queue = truncateTail(b.queue+chunk, MaxBufferChars)
	b.mu.Unlock()
	b.signal()
}

// exit 标记会话已退出：队列排空后 Attach 就可以结束。
func (b *sub) exit() {
	b.mu.Lock()
	b.exited = true
	b.mu.Unlock()
	b.signal()
}

// take 取走整个队列；第二个返回值表示「已退出且队列已空」。
func (b *sub) take() (string, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	q := b.queue
	b.queue = ""
	return q, q == "" && b.exited
}

// Attach 把会话输出接到页面的 Channel：先回放 buffer，再持续推送，直到会话退出且输出发完、
// ctx 取消（页面关闭 Channel 或应用退出）或 Channel 已关闭。
// 会话 id 不存在返回错误；Channel 被页面关闭属于正常结束，返回 nil。
func (s *Service) Attach(ctx context.Context, id string, ch *mygo.Channel[contract.SessionDataEvent]) error {
	return s.attach(ctx, id, ch.Send)
}

// attach 是 Attach 的实现，发送函数可替换，便于单测（mygo.Channel 只能由窗口运行时创建）。
func (s *Service) attach(ctx context.Context, id string, sendFn func(contract.SessionDataEvent) error) error {
	e := s.get(id)
	if e == nil {
		return fmt.Errorf("会话不存在: %s", id)
	}

	b := newSub()
	// 快照 buffer 与登记订阅放在同一次持锁里：flush 也在同一把锁里追加 buffer 并取订阅者列表，
	// 所以每个字符要么在快照里、要么在订阅队列里，不重复也不丢。
	e.mu.Lock()
	history := e.buffer
	if isDead(e.meta.Status) {
		b.exited = true
	} else {
		e.nextSub++
		subID := e.nextSub
		e.subs[subID] = b
		defer func() {
			e.mu.Lock()
			delete(e.subs, subID)
			e.mu.Unlock()
		}()
	}
	e.mu.Unlock()

	send := func(chunk string) (bool, error) {
		if chunk == "" {
			return true, nil
		}
		if err := sendFn(contract.SessionDataEvent{ID: id, Chunk: chunk}); err != nil {
			if errors.Is(err, mygo.ErrChannelClosed) {
				return false, nil
			}
			return false, err
		}
		return true, nil
	}

	if history != "" {
		for _, part := range splitChunks(history, historyChunkBytes) {
			if ok, err := send(part); !ok || err != nil {
				return err
			}
		}
	}

	for {
		q, finished := b.take()
		if q != "" {
			for _, part := range splitChunks(q, historyChunkBytes) {
				if ok, err := send(part); !ok || err != nil {
					return err
				}
			}
			continue
		}
		if finished {
			return nil
		}
		select {
		case <-ctx.Done():
			return nil
		case <-b.wake:
		}
	}
}
