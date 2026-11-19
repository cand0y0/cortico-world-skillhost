# Changelog

## 0.1.0 — 2026-11-17

首个版本。

- 扫描技能目录（默认 `<数据目录>/skillhost/skills`），读 `skill.json`、`import` 技能的 `index.js`，
  喂给它一套 `config / fetch / warn / registerTool / storage / meta` 的 api。
- 四个通用工具：`skill_list`、`skill_call`、`skill_config`、`skill_toggle`。
- 技能设置存 `<数据目录>/configs/<技能 id>.json`，改了下次调用即生效。
- 目录或开关一变就重扫（指纹比对），新技能不用重启。
- 技能的调色盘：`session`（chatKey / trigger / sent）、`selfId`、`ctx.sender.sendImage()` 走 OneBot HTTP，
  支持 `group:<群号>` / `private:<QQ号>`。
- 设置页：本体页（市场入口、已装技能管理、五项设置）+ 每个技能一页（自己的设置 + 启用开关）。
- 加载失败的技能不拖垮世界：错误原样回报给调用方。
