# 鸿蒙功能对齐与验收准备记录

本轮目标是离线可完成的功能对齐、设备自检和真机验收准备。真实手机运行、系统授权、录屏及定位部署仍留到下一阶段。本记录不替代真机通过报告。

## 要求与证据

| 要求 | 交付 | 验证方式 |
|---|---|---|
| 逐工具、逐参数对照 | `platform-parity.md`、人工后端说明 `platform-audit-notes.json`、嵌套参数说明 | 从实际 MCP 列表提取 42 个 mobile 工具、116 个顶层参数；生成器检查遗漏/过期参数；CI 校验生成文件未漂移 |
| 截图缩放、转换、质量 | `screenshot-transform.ts`、HarmonyRobot 与两个截图工具接入 | 真正编码/解码 PNG/JPEG，验证尺寸、颜色、质量差异、无放大、优先级、损坏数据和原格式保留；MCP 保存与返回图片测试 |
| 应用显示名称 | `harmony-apps.ts`，应用列表与前台应用接入 | 中文标签、重复包名、标签冲突、资源描述符、权限或版本失败回退测试 |
| 其他可离线补齐项 | DPAD 与最近应用键码 | 按官方 KeyEvent 常量核对并检查发出的 UITest 命令；手机实际响应仍未验证 |
| 设备能力自检 | `mobile_get_harmony_capabilities` | 命令/功能/权限/组件分项状态；测试确认 help 不升级写权限、读取成功范围、明确拒绝与未知失败、失联短路、组件静态检查及 MCP 接口 |
| 统一验收入口与场景 | `npm run harmony:accept`、`acceptance/harmony.template.json` | 默认不操作手机；实际 CLI 运行计划校验，7 场景全部 not_run、3 人工项 pending；模拟客户端验证真实执行分支、预期错误、失败即停、中断、截图与报告保存 |
| 文档与交付 | 三语 README、功能说明、对照表、自检及验收说明 | 核对全部 42 个工具在三语 README、鸿蒙功能表和逐参数对照中出现；推送 OpenHarmony 后检查对应提交的 CI |

本地构建、lint 和对照表检查通过；完整测试结果为 **315 项通过**（含此前测试与本轮新增的 29 项）。真机测试数量仍为零。

## 验证命令

```sh
npm run build
npm run lint
npm run audit:platforms:check
npm test
mkdir -p acceptance-runs
npm run harmony:accept -- \
  --device harmony:NOT_CONNECTED \
  --config acceptance/harmony.template.json \
  --output acceptance-runs/alignment-plan-verified
```

计划校验实际输出 mode=plan、status=not_run。这个命令没有 `--execute`，不需要 HDC 或手机，也不能算真机测试通过。报告保存位置默认被 Git 忽略，仓库保留可复现入口和模板。

本轮将截图验证从只读文件头加强为完整解码，发现并替换了旧模拟测试中损坏的 PNG 样本；没有通过降低解码校验来保留错误图片。

新增依赖 sharp 0.35.5，Node.js 最低版本明确为 20.9.0。平台预编译 optional dependencies 需要随 npm 安装；没有改变录屏、定位原生组件源码或增加手机侧图像依赖。

## 仍未对等的范围

- 默认 iOS/Android 包装器的“传入参数”不等于外部 mobilecli 所有设备都能执行；旧后端还有独立限制，对照表分别标注。
- 鸿蒙启动语言覆盖、精确折叠角度、HiLog 的 process/category 筛选未实现；缺少等价已确认接口时明确保留差异。
- 日志缓冲区和超时、引用有效期、方向与折叠状态检查等仍有平台语义差异。
- 鸿蒙云设备没有提供；鸿蒙模拟器没有验证。
- 命令存在、帮助声明、组件文件格式通过，均不能证明系统服务授权或真实应用效果。
- 录屏/定位部署与授权、剪贴板/故障日志的商业系统权限、真实中文输入和手势效果仍待手机验收。
- 统一验收模板需要按受控测试应用调整控件标识、坐标和成功标记。自动场景通过且仍有人工作业时，报告为 needs_manual，不能宣称完整验收通过。
