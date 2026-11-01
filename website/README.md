# Mile Terminal 官网

Mile Terminal 的独立中文产品官网，使用 React 19、TypeScript 与 Vite 构建。站点不依赖 Electron 运行时，可部署到任意静态托管服务。

## 本地开发

需要 Node.js 20+。

```bash
cd website
npm install
npm run dev
```

## 构建与预览

```bash
npm run build
npm run preview
```

生产文件输出到 `website/dist/`。构建命令会先执行 TypeScript 校验，再生成静态资源。

## 内容维护

导航、功能、FAQ、技术栈与外部链接集中在 `src/data/content.ts`。修改产品信息时，请同步核对项目根目录的 `package.json`、`README.md` 与当前应用导航，避免展示过期能力。
