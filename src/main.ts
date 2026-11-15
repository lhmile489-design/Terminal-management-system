// 渲染层入口。原版 src/renderer/src/main.tsx 的搬运从 S26 开始；
// 这一版只把适配层接上，验证 `mile` 可用（类型断言在 src/lib/mile.ts 里）。

import { mile } from "./lib/mile";

const root = document.getElementById("root");
if (root) {
  root.textContent = "Mile Console";
}

void mile.app.info().then((info) => {
  document.title = info.name;
  if (root) root.textContent = `${info.name} ${info.version}`;
});

// 页面订阅完成后告诉 Go：可以把排队的事件补投了（契约 §2）
void mile.app.ready();
