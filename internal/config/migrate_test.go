//go:build windows

// S09 对拍：迁移链。每组输入在原版里写成 config.json、构造 ConfigStore、读 get()；Go 跑 Migrate 比较投影后的结果。

package config

import (
	"encoding/json"
	"reflect"
	"testing"

	"mile-console/internal/contract"
)

func TestMigrateMatchesOriginal(t *testing.T) {
	c := loadCases(t)
	if len(c.Migrate) < 60 {
		t.Fatalf("迁移用例只有 %d 组", len(c.Migrate))
	}
	if c.MaxIgnored != MaxIgnoredListeners {
		t.Fatalf("MAX_IGNORED_LISTENERS：Go %d，原版 %d", MaxIgnoredListeners, c.MaxIgnored)
	}
	deviated := 0
	for i, k := range c.Migrate {
		got := Migrate(k.Input, plat)
		if got.Version != contract.ConfigVersion {
			t.Errorf("第 %d 组：version %d", i, got.Version)
		}
		g, w := tree(t, got), project(t, k.Output)
		if reflect.DeepEqual(g, w) {
			continue
		}
		if fix, ok := typeFallback(t, k.Input); ok {
			// 已接受偏差：类型不对的设置项回落到默认值。把这些字段在原版输出里换成默认值后，其余必须一致
			deviated++
			if !reflect.DeepEqual(g, tree(t, fix(projectStruct(t, k.Output)))) {
				t.Errorf("第 %d 组（类型回落）：除回落字段外仍有差异\n 输入 %s\n Go   %v\n 原版 %v", i, k.Input, g, w)
			}
			continue
		}
		t.Errorf("第 %d 组：\n 输入 %s\n Go   %v\n 原版 %v", i, k.Input, g, w)
	}
	if deviated != 1 {
		t.Errorf("类型回落用例命中 %d 组，生成器里应恰好有 1 组", deviated)
	}
	t.Logf("%d 组迁移输入与原版一致（其中 %d 组是登记的类型回落偏差）", len(c.Migrate), deviated)
}

func projectStruct(t *testing.T, raw json.RawMessage) contract.AppConfig {
	t.Helper()
	var c contract.AppConfig
	if !decodeLoose(raw, &c) {
		t.Fatalf("不是对象：%s", raw)
	}
	return c
}

// typeFallback 识别生成器里那组「settings 字段类型不对」的输入，返回把这些字段换成 Go 回落值的函数。
func typeFallback(t *testing.T, input json.RawMessage) (func(contract.AppConfig) contract.AppConfig, bool) {
	t.Helper()
	var in struct {
		Settings map[string]json.RawMessage `json:"settings"`
	}
	if json.Unmarshal(input, &in) != nil || string(in.Settings["scanIntervalMs"]) != `"fast"` {
		return nil, false
	}
	d := Defaults(plat).Settings
	return func(c contract.AppConfig) contract.AppConfig {
		c.Settings.ScanIntervalMs = d.ScanIntervalMs // 原版留着 "fast"
		c.Settings.CloseToTray = d.CloseToTray       // 原版留着 "yes"
		return c
	}, true
}

// 版本链的几条关键行为，独立于对拍数据再断言一遍，方便反向对照时定位。
func TestMigrateKeySteps(t *testing.T) {
	m := func(s string) contract.AppConfig { return Migrate(json.RawMessage(s), plat) }

	// 缺 version 当 v1：v1→v2 清空 groupOverrides / watchedKeywords
	if c := m(`{"groupOverrides":[{"processName":"x","group":"mine"}],"watchedKeywords":["a"]}`); len(c.GroupOverrides) != 0 || len(c.WatchedKeywords) != 0 {
		t.Errorf("v1 应清空 groupOverrides / watchedKeywords：%+v %+v", c.GroupOverrides, c.WatchedKeywords)
	}
	// v13 手塞的 autoRestart 丢掉，v14 保留
	if c := m(`{"version":13,"entries":[{"id":"a","autoRestart":true}]}`); c.Entries[0].AutoRestart != nil {
		t.Error("v13 的 autoRestart 应被丢掉")
	}
	if c := m(`{"version":14,"entries":[{"id":"a","autoRestart":true}]}`); c.Entries[0].AutoRestart == nil || !*c.Entries[0].AutoRestart {
		t.Error("v14 的 autoRestart 应保留")
	}
	// v14 的非布尔 pinned 丢掉
	if c := m(`{"version":14,"groups":[{"id":"g","pinned":"yes"}]}`); c.Groups[0].Pinned != nil {
		t.Error("v14 的非布尔 pinned 应被丢掉")
	}
	// v15 起的日程开关：v15 一律设成默认开，v16 保留用户的关
	if c := m(`{"version":15,"settings":{"plannerNotify":false}}`); !c.Settings.PlannerNotify {
		t.Error("v15→v16 应把 plannerNotify 设成默认开")
	}
	if c := m(`{"version":16,"settings":{"plannerNotify":false}}`); c.Settings.PlannerNotify {
		t.Error("v16 应保留 plannerNotify=false")
	}
	// 外部终端每次都按平台收：v16 的 iterm 也回落到 wt
	if c := m(`{"version":16,"settings":{"externalTerminal":"iterm"}}`); c.Settings.ExternalTerminal != contract.TerminalWT {
		t.Errorf("iterm 应回落到 wt，得到 %q", c.Settings.ExternalTerminal)
	}
	// 幂等：迁移结果再迁移一次不变
	first := m(`{"version":3,"entries":[{"id":"a","icon":"x","category":"  W  ","autoRestart":true}],"settings":{"theme":"neon"}}`)
	b, _ := json.Marshal(first)
	if again := Migrate(b, plat); !reflect.DeepEqual(tree(t, again), tree(t, first)) {
		t.Errorf("迁移不幂等：\n 一次 %+v\n 两次 %+v", first, again)
	}
}
