// S24 单测：四个大绑定的「未接入」错误与几处转发行为（真实服务在各自包里已有测试）。

package app

import (
	"context"
	"strings"
	"testing"
)

func TestLargeBindingsReportUnwired(t *testing.T) {
	ctx := context.Background()
	if _, err := NewEntryService(nil, nil, nil).List(ctx); err == nil {
		t.Fatal("条目服务未接入应报错")
	}
	if _, err := NewPlannerService(nil).Get(ctx); err == nil {
		t.Fatal("进度服务未接入应报错")
	}
	if _, err := NewSessionService(nil).List(ctx); err == nil {
		t.Fatal("会话服务未接入应报错")
	}
	if _, err := NewScannerService(nil, nil).Snapshot(ctx); err == nil {
		t.Fatal("扫描器未接入应报错")
	}
	if _, err := NewEntryService(nil, nil, nil).HealthList(ctx); err == nil {
		t.Fatal("健康检查未接入应报错")
	}
}

func TestEntryServiceNativeIntegrationsAreExplicit(t *testing.T) {
	svc := NewEntryService(nil, nil, nil)
	if ok, err := svc.RevealLastJar(context.Background(), "e1"); ok || err == nil {
		t.Fatal("定位产物应明确报未接入")
	}
	if err := svc.OpenExternalTerminal(context.Background(), "e1"); err == nil || !strings.Contains(err.Error(), "S32") {
		t.Fatalf("外部终端应明确报未接入：%v", err)
	}
}

func TestPlannerServicePassesRawJSON(t *testing.T) {
	// 未接入时不应因为 json 参数而 panic
	svc := NewPlannerService(nil)
	if _, err := svc.AddBoard(context.Background(), []byte(`"g1"`)); err == nil {
		t.Fatal("未接入应报错")
	}
}

func TestSessionBindingsValidateIDs(t *testing.T) {
	svc := NewSessionService(nil)
	if _, err := svc.History(context.Background(), "x"); err == nil {
		t.Fatal("未接入应报错")
	}
	if err := svc.Write(context.Background(), "x", "data"); err == nil {
		t.Fatal("未接入应报错")
	}
	if err := svc.Resize(context.Background(), "x", 80, 24); err == nil {
		t.Fatal("未接入应报错")
	}
	if err := svc.Stop(context.Background(), "x"); err == nil {
		t.Fatal("未接入应报错")
	}
}

func TestScannerBindingsGuardNil(t *testing.T) {
	svc := NewScannerService(nil, nil)
	ctx := context.Background()
	for _, err := range []error{
		svc.Refresh(ctx),
		svc.SetVisible(ctx, true),
		svc.Ignore(ctx, "node.exe", 3000),
		svc.HideOnce(ctx, 1, 3000),
		svc.SetGroup(ctx, "node.exe", nil),
	} {
		if err == nil {
			t.Fatal("未接入应报错")
		}
	}
	if _, err := svc.WatchedKeywords(ctx); err == nil {
		t.Fatal("配置未接入应报错")
	}
	if _, err := svc.SetWatchedKeywords(ctx, []string{"x"}); err == nil {
		t.Fatal("未接入应报错")
	}
}
