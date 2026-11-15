// 给 S17 预检（internal/precheck）用的出口：原版 PrecheckService.ts 自己 readFile + JSON.parse 读 package.json，
// 用的是同一套 node 语义（UTF-8 解码、V8 的 JSON.parse 报错文案、win32 path），这些已在本包逐行移植，这里只开出口，
// 不另写一份。

package detect

import (
	"os"

	"mile-console/internal/contract"
)

// PackageJSON 一次 JSON.parse(readFile(pkgPath, 'utf8')) 的结果。
type PackageJSON struct{ v *jsValue }

// ReadPackageJSON 即原版 `JSON.parse(await readFile(pkgPath, 'utf8'))`。
// 读或解析失败时 msg 是原版 catch 里的 err.message（读失败为 EISDIR 文案或 Go 的错误文本，见 §6「读 package.json 失败的提示」）。
func ReadPackageJSON(pkgPath string) (pkg *PackageJSON, msg string) {
	b, err := os.ReadFile(pkgPath)
	if err != nil {
		return nil, readErrorMessage(err)
	}
	v, perr := jsonParse(jsDecodeUTF8(b))
	if perr != "" {
		return nil, perr
	}
	return &PackageJSON{v: v}, ""
}

// IsNull 解析结果是 JSON null。原版随后读 `pkg.scripts` 会抛 TypeError（已知原版问题 I8）。
func (p *PackageJSON) IsNull() bool { return p.v.kind == jsNull }

// StringRecord 即原版 PrecheckService 的 `stringRecord(pkg[key])`：只收值为字符串的键，非对象（含数组、null）得空表，
// `__proto__` 键被丢掉。与本包 toStringRecord 同一套规则，键序按 JS 对象顺序。
func (p *PackageJSON) StringRecord(key string) contract.Scripts { return toStringRecord(p.v.get(key)) }

// Join 即 node 的 path.win32.join。
func Join(args ...string) string { return jsJoin(args...) }

// IsAbsolute 即 node 的 path.win32.isAbsolute（node 22 lib/path.js）。
func IsAbsolute(path string) bool {
	if path == "" {
		return false
	}
	c := path[0]
	return isPathSep(c) || (len(path) > 2 && isDeviceRoot(c) && path[1] == ':' && isPathSep(path[2]))
}
