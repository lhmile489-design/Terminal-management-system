// 对拍覆盖不到的分支：真实目录造不出来，或 win32 平台上恒为空的条件。期望值来自原版代码的逐行推导，注明出处。

package detect

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"mile-console/internal/contract"
	"mile-console/internal/platform"
)

// 原版 uniapp 分支 `basename(path) || path`：basename 为空（盘根 "C:\\"）时退回整个路径；普通分支没有 `|| path`。
// 用 hasPackageJson + uniapp 标记建在一个目录里，再从盘根形式的路径读不到——所以直接测 name 的取值逻辑：
// 构造 path 末尾带分隔符时 basename 仍非空，只有盘根才为空。这里用真实盘根以外的方式验证不了，改测 jsBasename 本身。
func TestBasenameDriveRootIsEmpty(t *testing.T) {
	for in, want := range map[string]string{`C:\`: "", `C:`: "", `\`: "", `C:\a\`: "a", `a/b`: "b", `\\srv\share\x`: "x"} {
		if got := jsBasename(in); got != want {
			t.Errorf("basename(%q) = %q want %q", in, got, want)
		}
	}
}

// fallback 分支的名字：basename 为空时用 path（原版三处 `basename(path) || path`）。
func TestFallbackNameOnDriveRootLikePath(t *testing.T) {
	svc := New(fakePlatform{})
	r := svc.fallback(`Z:\`, nil)
	if r.Name != `Z:\` {
		t.Fatalf("name %q", r.Name)
	}
}

type darwinLike struct{ fakePlatform }

func (darwinLike) UnsupportedLaunchModes() map[contract.LaunchMode]bool {
	return map[contract.LaunchMode]bool{contract.LaunchModeCppExe: true}
}

// sortByte 按字节序排序，只给变异测试当「换掉区域排序」的替身用（放在测试文件里，不进产物）。
func sortByte(names []string) { slices.Sort(names) }

var _ = sortByte

var _ Platform = darwinLike{}
var _ = platform.WrapperFiles{}

// 原版 `platform.unsupportedLaunchModes.has(mode)` 为真时落到仅登记分支（macOS 的 cpp-exe）。win32 上集合为空，对拍走不到。
func TestUnsupportedLaunchModeFallsBackToRegisterOnly(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "CMakeLists.txt"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	r := New(darwinLike{}).Detect(dir)
	if !r.RegisterOnly || r.DetectedLaunchMode != "" || r.Framework != contract.FrameworkCpp {
		t.Fatalf("%+v", r)
	}
	if want := []string{"识别为 C++ 项目，仅登记不推断启动命令"}; !slices.Equal(r.Warnings, want) {
		t.Fatalf("warnings %q", r.Warnings)
	}
	if r2 := New(fakePlatform{}).Detect(dir); r2.RegisterOnly || r2.DetectedLaunchMode != contract.LaunchModeCppExe {
		t.Fatalf("win32 %+v", r2)
	}
}

// 相同主权重、只差大小写或重音的名字靠次级 / 三级权重定序。期望值是 node 22 zh-CN 实测：
// zh 规则把带声调的 a（ā á ǎ à）排在 a 之前，小写在大写之前，符号与空格按次级权重。
func TestLocaleSecondaryLevels(t *testing.T) {
	names := []string{"Á", "b", "á", "A", "a", "ä", "Ä", "à", "ā", "ǎ", "Ab", "ab", "aB", "a-b", "a_b", "ab "}
	sortLocale(names)
	want := []string{"ā", "á", "Á", "ǎ", "à", "a", "A", "ä", "Ä", "a_b", "a-b", "ab", "aB", "Ab", "ab ", "b"}
	if !slices.Equal(names, want) {
		t.Fatalf("got  %q / want %q", names, want)
	}
}

// 汉字排在数字之后、拉丁字母之前（node zh-CN 实测 ['1','啊','中','a','Z']）。
func TestLocaleHanBetweenDigitsAndLatin(t *testing.T) {
	names := []string{"Z", "中", "a", "1", "啊"}
	sortLocale(names)
	if want := []string{"1", "啊", "中", "a", "Z"}; !slices.Equal(names, want) {
		t.Fatalf("got %q want %q", names, want)
	}
}

// 下标键按数值插入，相等时（不会发生：键已去重）与更大值之间的位置。
func TestInsertJSKeyOrder(t *testing.T) {
	var keys []string
	for _, k := range []string{"b", "10", "2", "a", "0", "4294967294", "01"} {
		keys = contract.InsertJSKey(keys, k)
	}
	if want := []string{"0", "2", "10", "4294967294", "b", "a", "01"}; !slices.Equal(keys, want) {
		t.Fatalf("got %q want %q", keys, want)
	}
}

// 原版 JSON.parse 的对象键顺序：数组下标键在前。
func TestJSONParseObjectKeyOrder(t *testing.T) {
	v, msg := jsonParse(`{"b":1,"2":2,"a":3,"1":4}`)
	if msg != "" {
		t.Fatal(msg)
	}
	if want := []string{"1", "2", "b", "a"}; !slices.Equal(v.keys, want) {
		t.Fatalf("got %q", v.keys)
	}
}

// 原版 tryReadIcon：`if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null`。
// 对拍场景里 root 外的文件不存在，守卫是否生效看不出来；这里在 root 外真的放文件，
// 包括与 root 同前缀的兄弟目录（app 与 app2），守卫必须挡住。
func TestFaviconEscapeGuardWithRealOutsideFiles(t *testing.T) {
	base := t.TempDir()
	root := filepath.Join(base, "app")
	for p, c := range map[string]string{
		filepath.Join(base, "outside.png"):   "o",
		filepath.Join(base, "app2", "x.png"): "x",
		filepath.Join(root, "index.html"):    `<link rel="icon" href="../outside.png"><link rel="icon" href="../app2/x.png">`,
	} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	svc := New(fakePlatform{})
	if got := svc.ReadFavicon(root); got != nil {
		t.Fatalf("escaped root: %+v", got)
	}
	if got := svc.tryReadIcon(root, "../app2/x.png"); got != nil {
		t.Fatalf("sibling prefix escaped: %+v", got)
	}
}
