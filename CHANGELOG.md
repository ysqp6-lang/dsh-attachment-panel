# Changelog

本项目的版本号在 0.6.0 之前属于本机迭代（没有对外发布），这里按时间倒序把每一版做了什么浓缩记录；0.6.0 是首个公开版。

## 0.6.0 — 2026-10-26

首个公开版。功能面：

- **五个标签**：图片（发给 DSH 的图片附件）、文件（`@` 引用过的本机路径）、投送（Taildrop 发出的，按目标设备分组）、接收（Taildrop 收到的）、工具图片。
- **面板里直接投送**：选设备（`tailscale debug localapi file-targets` 实时在线状态）→ 选文件（多选）→ 带进度上传 → 宿主落临时目录后 `tailscale file cp`，发完清理；成功的记录写进 `~/.dsh/attachments/v1/panel-sends.jsonl` 并进索引，所以面板发的也能追溯。
- **接收**：`/Library/Tailscale/incoming-files` 的待接收（可一键 `tailscale file get` 收下）+ `~/Downloads` 近 14 天里既无 `com.apple.quarantine` 又无 `com.apple.provenance` 的文件（标「疑似收到」）。
- **投送历史还原**：从会话日志的 `tool/call` 里解析 `tailscale file cp [--name x] <files...> <device>:`，去重后按设备分组。
- 跨平台降级：非 macOS 时缩略图回落到原图、`xattr` 判断跳过、`open -R` 换成 `xdg-open`/`explorer /select,`，`tailscale` 可执行文件按平台候选探测（也可用 `DSH_TAILDROP_TAILSCALE` 指定）。
- 加了 `test/smoke.mjs`、LICENSE、icon.svg、发布元信息（repository/keywords/engines/peerDependencies）。

## 0.5.0 — 2026-10-26

- 「投送」标签：按目标设备分组、设备药丸筛选、`→ device` 徽标、Finder / 复制。
- 计数行加投送数；支持 `?scope=send`。

## 0.4.0 — 2026-10-26

- 删掉 `sidebar.footer.action` 的备用入口（覆盖层 + `ReactDOM.createPortal`），客户端半边从约 330 行精简到 143 行。

## 0.3.0 — 2026-10-26

- 入口改成官方主区域面板：`sidebar.panellist`（「新会话」下面那一行，和「插件」「自动化任务」并列）+ `main` 插槽（点开后的内容），两个 id/key 必须一致。

## 0.2.0 — 2026-10-26

- 「文件」标签：从用户消息里抓 `@/路径` 与 `@"带空格路径"`（白名单前缀 `/Users` `/private` `/tmp` `/Volumes` `/opt` `/var`），按 `file` / `dir` / `missing` / `denied` 标注状态。
- 新增 `reveal-path` / `open-path` 白名单路由：只有索引里出现过的路径才允许操作。
- 面板 HTML 改成按 mtime 热读取，改样式刷新页面即生效。

## 0.1.0 — 2026-10-26

- 第一版：扫描 `~/.dsh/sessions/**/session.v4.jsonl.zstd`（多帧 zstd，按 magic `28 B5 2F FD` 扫帧边界逐帧解）提取附件引用，映射到 `~/.dsh/attachments/v1/objects/<前两位>/<sha256>`，做缩略图（sips）+ 网格 + 大图查看 + Finder 定位。
