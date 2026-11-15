// 对应 src/main/services/ConfigStore.ts：配置读写、版本迁移、.bak 轮转、只读保护。
//
// 已知原版问题 C2，见 docs/MIGRATION-PLAN.md：只读模式下 persist() 静默返回，编辑看起来成功、重启后消失。
// 照原样搬，不静默修；store_test.go 有一条测试固定这个行为。

package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"mile-console/internal/contract"
)

// DirName 数据目录名（D4 定案：%APPDATA%\mile-console\，与原版 mile-terminal 分开）。
const DirName = "mile-console"

// DataDirEnv 验收沙箱用：设置后整个数据目录（config.json、planner.json、images/）都落在这里。
// 对应原版 harness 在 require 主进程之前 `app.setPath('appData', tmpdir)` 的做法，
// 避免验收脚本读写真实配置（原项目 CLAUDE.md「修改 harness 夹具时」）。
const DataDirEnv = "MILE_CONSOLE_DATA_DIR"

// DataDir 即原版 join(app.getPath('appData'), 'mile-terminal')，目录名换成 DirName。
func DataDir() (string, error) {
	if dir := os.Getenv(DataDirEnv); dir != "" {
		return dir, nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, DirName), nil
}

// Store 即原版 ConfigStore。所有方法并发安全。
type Store struct {
	dir     string
	file    string
	backup  string // 上一份良好版本，PRD §8。主文件写坏时从这里恢复
	corrupt string // 从备份恢复时，把解析失败的主文件挪到这里，供排查，不再参与读写
	now     func() time.Time

	mu    sync.Mutex
	cache contract.AppConfig
	// readOnly 只读保护，PRD §8。主配置与备份都读不到、但文件确实存在时置位。
	// 这种情况多半是被别的东西写坏或占着，此时用空配置覆盖就是把用户的条目删干净了 ——
	// 宁可这一次运行不落盘。
	readOnly bool
}

// Open 在 dir 下打开配置，即原版构造函数。只有「从备份恢复后写回主文件」失败时才返回错误
// （原版此时构造函数抛错，应用起不来）。
func Open(dir string, p TerminalPlatform) (*Store, error) {
	return open(dir, p, time.Now)
}

func open(dir string, p TerminalPlatform, now func() time.Time) (*Store, error) {
	s := &Store{
		dir:     dir,
		file:    filepath.Join(dir, "config.json"),
		backup:  filepath.Join(dir, "config.json.bak"),
		corrupt: filepath.Join(dir, "config.json.corrupt"),
		now:     now,
	}
	if err := s.boot(p); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) boot(p TerminalPlatform) error {
	if primary, ok := readObject(s.file); ok {
		s.cache = Migrate(primary, p)
		return nil
	}

	if fallback, ok := readObject(s.backup); ok {
		// 从备份恢复要立刻写回主文件，否则下次启动还得再走一遍这条路。
		// 坏主文件先挪成 .corrupt 留给排查；这一次写入跳过「备份当前主文件」——
		// 常规 persist() 会把坏主文件复制到 .bak，唯一的良好版本就没了。
		if exists(s.file) {
			_ = os.Rename(s.file, s.corrupt) // 挪不走也无妨，下面 skipBackup 已保证 .bak 不被覆盖
		}
		s.cache = Migrate(fallback, p)
		return s.persist(true)
	}

	// 两份都解析不出来但文件在：不是「首次运行」，是数据出问题了，别覆盖
	if exists(s.file) || exists(s.backup) {
		s.readOnly = true
	}
	s.cache = Defaults(p)
	return nil
}

// readObject 即原版 read()：读不到、解析失败、顶层不是对象都返回 false。
// JSON.parse 不认 BOM（U+FEFF 不是 JSON 空白），encoding/json 同样拒绝，两边一致。
func readObject(path string) (json.RawMessage, bool) {
	b, err := os.ReadFile(path)
	if err != nil || !json.Valid(b) {
		return nil, false
	}
	if rawKind(b) != '{' {
		return nil, false
	}
	return b, true
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// Get 返回当前配置的深拷贝：调用方改返回值不影响缓存，改配置走 Patch / PatchSettings。
func (s *Store) Get() contract.AppConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	return Clone(s.cache)
}

func (s *Store) IsReadOnly() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readOnly
}

// Patch 即原版 patch(partial)：fn 在缓存的副本上改，改完整体换上并落盘。
// 落盘失败时缓存已经换上（与原版一致：先赋值 cache 再 persist），返回错误。
func (s *Store) Patch(fn func(c *contract.AppConfig)) (contract.AppConfig, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := Clone(s.cache)
	fn(&next)
	s.cache = next
	err := s.persist(false)
	return Clone(s.cache), err
}

// PatchSettings 即原版 patchSettings(partial)。
func (s *Store) PatchSettings(fn func(st *contract.Settings)) (contract.AppConfig, error) {
	return s.Patch(func(c *contract.AppConfig) { fn(&c.Settings) })
}

// BackupBeforeImport 导入前的整份备份（2.3.0），与 .bak 轮转分开：.bak 下一次写入就会被覆盖，
// 这份留着让用户在导入结果不满意时手动换回。返回备份的绝对路径。
func (s *Store) BackupBeforeImport() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return "", err
	}
	stamp := s.now().Format("20060102-150405")
	target := filepath.Join(s.dir, "config.before-import-"+stamp+".json")
	for i := 2; exists(target); i++ {
		target = filepath.Join(s.dir, "config.before-import-"+stamp+"-"+strconv.Itoa(i)+".json")
	}
	if exists(s.file) {
		if err := copyFile(s.file, target); err != nil {
			return "", err
		}
		return target, nil
	}
	b, err := marshalConfig(s.cache)
	if err != nil {
		return "", err
	}
	return target, os.WriteFile(target, b, 0o644)
}

// persist 写入前先把当前良好版本留成 .bak，再临时文件 + rename 换上新版本。
// 顺序不能颠倒 —— 先 rename 再备份就会把刚写的新内容备份成「上一份良好版本」。
// 调用方持有 s.mu。
func (s *Store) persist(skipBackup bool) error {
	// 已知原版问题 C2：只读时静默返回，调用方以为写成功了
	if s.readOnly {
		return nil
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	if !skipBackup && exists(s.file) {
		_ = copyFile(s.file, s.backup) // 备份失败不该挡住正常写入，主文件本身仍是原子替换
	}
	b, err := marshalConfig(s.cache)
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", s.file, os.Getpid())
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

// marshalConfig 即 JSON.stringify(cache, null, 2)：两空格缩进、UTF-8 无 BOM、末尾无换行、不转义 < > &。
// encoding/json 仍会把 U+2028 / U+2029 写成转义，JSON.stringify 写原字符；解析后相同。
func marshalConfig(c contract.AppConfig) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(c); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// copyFile 即 fs.copyFileSync：目标存在时覆盖。
func copyFile(src, dst string) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	info, err := os.Stat(src)
	mode := fs.FileMode(0o644)
	if err == nil {
		mode = info.Mode().Perm()
	}
	if err := os.WriteFile(dst, b, mode); err != nil {
		return errors.Join(fmt.Errorf("复制 %s 失败", filepath.Base(src)), err)
	}
	return nil
}
