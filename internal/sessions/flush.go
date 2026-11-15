// 对应 src/main/services/SessionService.ts 的 onData 合并刷新与 onExit 收尾。
//
// 读循环（pump）把 PTY 字节流解码成字符串交给 absorb；absorb 只往 pending 里攒，
// 第一次攒入时挂一个 16ms 的定时器；到点 flush 把 pending 并进 buffer（头部截断到 400000 码元）、
// starting 翻成 running，并把这一块推给所有订阅者。
// 子进程退出后 watch 收尾：等读循环排空、最后一次 flush、定状态与退出码、出退出事件。

package sessions

import (
	"mile-console/internal/contract"
)

// absorb 即原版 onData 回调：攒入 pending，并保证有一个待触发的 flush。
func (s *Service) absorb(e *entry, text string) {
	e.mu.Lock()
	e.pending += text
	if e.timer == nil {
		e.timer = s.opt.AfterFunc(FlushInterval, func() { s.flush(e) })
	}
	e.mu.Unlock()
}

// flush 即原版 flush(entry)：把 pending 并进 buffer 并广播。
// emitMu 保证两次 flush 的广播顺序与 buffer 顺序一致；
// 订阅者列表与 buffer 追加在同一次持锁里取，Attach 的「快照 + 订阅」也在 e.mu 里一次做完，既不重复也不漏。
func (s *Service) flush(e *entry) {
	e.emitMu.Lock()
	defer e.emitMu.Unlock()

	e.mu.Lock()
	if e.timer != nil {
		e.timer.Stop()
		e.timer = nil
	}
	if e.pending == "" {
		e.mu.Unlock()
		return
	}
	chunk := e.pending
	e.pending = ""
	e.buffer = truncateTail(e.buffer+chunk, MaxBufferChars)
	if e.meta.Status == contract.SessionStatusStarting {
		e.meta.Status = contract.SessionStatusRunning
	}
	subs := make([]*sub, 0, len(e.subs))
	for _, b := range e.subs {
		subs = append(subs, b)
	}
	e.mu.Unlock()

	for _, b := range subs {
		b.push(chunk)
	}

	s.mu.Lock()
	ls := make([]dataListener, len(s.onData))
	copy(ls, s.onData)
	s.mu.Unlock()
	ev := contract.SessionDataEvent{ID: e.id, Chunk: chunk}
	for _, l := range ls {
		l.fn(ev)
	}
}

// pump 读 PTY 字节流并按 UTF-8 解码：被读取边界切断的多字节字符留到下一次拼接，
// 非法字节逐个换成 U+FFFD。读到 EOF / 错误（Close 之后 Read 必然报错）即结束。
func (s *Service) pump(e *entry, done chan struct{}) {
	defer close(done)
	buf := make([]byte, readSize)
	var held []byte
	for {
		n, err := e.pty.Read(buf)
		if n > 0 {
			data := make([]byte, 0, len(held)+n)
			data = append(data, held...)
			data = append(data, buf[:n]...)
			cut := len(data) - heldTail(data)
			text := toValidString(data[:cut])
			held = append(held[:0], data[cut:]...)
			if text != "" {
				s.absorb(e, text)
			}
		}
		if err != nil {
			break
		}
	}
	// held 只可能是一个被截断的合法前缀（heldTail 保证），node StringDecoder.end() 对它只出一个 U+FFFD
	if len(held) > 0 {
		s.absorb(e, string(rune(0xFFFD)))
	}
}

// watch 即原版 onExit 回调：子进程退出后的收尾。
func (s *Service) watch(e *entry, pumpDone <-chan struct{}) {
	<-e.pty.Exited()
	code, err := e.pty.Wait()
	if err != nil && code == 0 {
		code = -1
	}
	// 关伪控制台才会让读端 EOF；之后等读循环把管道里剩下的输出读完
	_ = e.pty.Close()
	select {
	case <-pumpDone:
	case <-s.opt.After(pumpDrainTimeout):
	}
	s.flush(e)

	e.mu.Lock()
	if code == 0 {
		e.meta.Status = contract.SessionStatusStopped
	} else {
		e.meta.Status = contract.SessionStatusCrashed
	}
	c := code
	e.meta.ExitCode = &c
	subs := make([]*sub, 0, len(e.subs))
	for _, b := range e.subs {
		subs = append(subs, b)
	}
	e.mu.Unlock()

	s.own.Unregister(e.id)

	for _, b := range subs {
		b.exit()
	}
	s.mu.Lock()
	ls := make([]exitListener, len(s.onExit))
	copy(ls, s.onExit)
	s.mu.Unlock()
	ev := contract.SessionExitEvent{ID: e.id, ExitCode: code}
	for _, l := range ls {
		l.fn(ev)
	}
	close(e.done)
}
