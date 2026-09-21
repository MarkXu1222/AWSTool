# AWSTool — 项目指令入口

本项目的开发与维护规则统一放在 `.kiro/steering/`。以下文件为**强制遵守**，每次会话自动加载：

@.kiro/steering/project-context.md
@.kiro/steering/development-methodology.md
@.kiro/steering/coding-standards.md
@.kiro/steering/deployment.md
@.kiro/steering/heartbeat.md
@.kiro/steering/todo-domain.md

## 优先级

1. `deployment.md` 的数据安全红线 —— 最高优先级，任何情况不可违反
2. `coding-standards.md` 的编码与前端样式规范
3. `development-methodology.md` 的工作流程
4. `heartbeat.md` 的心跳汇报格式

## 事实来源（重要）

**`README.md` 是项目结构与实现细节的权威来源**，维护得比 `.kiro/steering/project-context.md`
更及时（README 对齐 `APP_VERSION 0.37.3`，project-context 停在 0.34.1）。

涉及目录结构、页面清单、接口清单、权限守卫、AWS 访问链路、关键实现踩坑记录时，
**先读 `README.md` 对应章节**；两者冲突一律以 README 为准，并顺手把 project-context 补齐。

## 维护约定

- 新增或调整功能后，**同步更新 `README.md`** 的对应章节（功能模块表 / 目录结构 / 接口清单 / 关键实现 / 已知待办），再同步 `project-context.md`
- 架构决策记录在 `project-context.md` 第十节
- 发布前递增 `web/client/src/version.ts` 的 `APP_VERSION`
- `.kiro/skills/` 下的技能为 Kiro 格式，Claude Code 不自动加载；需要时手动阅读对应 `SKILL.md` 再执行
