// scanChildren 的目录名排序：原版 `names.sort((a, b) => a.localeCompare(b))`。
//
// localeCompare 不带参数时用运行时默认区域（本机 node 是 zh-CN），走 ICU 的 zh 排序规则：
// 汉字按拼音、排在数字与拉丁字母之间。用户 2026-11-15 选定用 golang.org/x/text/collate 实现。
//
// x/text 的 zh 表里汉字的拼音顺序已经在，但它没实现 CLDR 的脚本重排（collate 包里的 TODO），
// 汉字整块排在拉丁字母之后。这里把主权重重映射回 ICU 的位置：
//   - p < 0x15ef（拉丁 a 之前：空白、标点、符号、数字）：不动
//   - 0x160000 <= p < 0x16b000（汉字拼音块）：挪到 a 之前，即 0x15ef + (p - 0x160000)
//   - 其余（拉丁、希腊、西里尔……）：整体后移，给汉字块让位
// 次级、三级权重原样比较。2764 个 BMP 名字（拉丁、汉字、标点、数字混排）与 node 结果逐个一致。
//
// 已知差异（登记在 docs/MIGRATION-PLAN.md §6「scanChildren 目录排序」）：增补平面汉字、假名 / 谚文 / 注音的
// 相对位置、部首与带圈汉字、生僻字之间的拼音先后（两边 CLDR 版本不同）。只影响「批量导入」列表的显示顺序。

package detect

import (
	"bytes"
	"slices"
	"sync"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

const (
	primaryLatinA  = 0x15ef
	primaryHanLow  = 0x160000
	primaryHanHigh = 0x16b000
)

var (
	collMu sync.Mutex
	coll   = collate.New(language.Chinese)
	collB  collate.Buffer
)

// collKey 一个字符串的排序键：重映射后的主权重序列，加上主权重之后的原始字节（次级、三级）。
type collKey struct {
	primary []int
	rest    []byte
}

func remapPrimary(p int) int {
	switch {
	case p < primaryLatinA:
		return p
	case p >= primaryHanLow && p < primaryHanHigh:
		return primaryLatinA + (p - primaryHanLow)
	}
	return p + (primaryHanHigh - primaryHanLow)
}

func keyOf(s string) collKey {
	collMu.Lock()
	collB.Reset()
	k := slices.Clone(coll.KeyFromString(&collB, s))
	collMu.Unlock()
	var out collKey
	i := 0
	for i+1 < len(k) {
		if k[i] == 0 && k[i+1] == 0 {
			break
		}
		// x/text 的主权重编码：不超过 0x7FFF 写两字节，否则三字节并置最高位
		if k[i]&0x80 != 0 && i+2 < len(k) {
			out.primary = append(out.primary, remapPrimary(int(k[i]&0x7f)<<16|int(k[i+1])<<8|int(k[i+2])))
			i += 3
		} else {
			out.primary = append(out.primary, remapPrimary(int(k[i])<<8|int(k[i+1])))
			i += 2
		}
	}
	out.rest = k[i:]
	return out
}

func compareKeys(a, b collKey) int {
	if c := slices.Compare(a.primary, b.primary); c != 0 {
		return c
	}
	return bytes.Compare(a.rest, b.rest)
}

// localeCompare 即 a.localeCompare(b) 在 zh-CN 下的符号。
func localeCompare(a, b string) int { return compareKeys(keyOf(a), keyOf(b)) }

// sortLocale 即 names.sort((a, b) => a.localeCompare(b))。V8 的 sort 是稳定排序，比较为 0 的保持原序。
func sortLocale(names []string) {
	keys := make(map[string]collKey, len(names))
	for _, n := range names {
		if _, ok := keys[n]; !ok {
			keys[n] = keyOf(n)
		}
	}
	slices.SortStableFunc(names, func(a, b string) int {
		if a == b {
			return 0
		}
		return compareKeys(keys[a], keys[b])
	})
}
